import { tokensEqual } from './tokenPayment.js';
import { authorizeAccount, consumeAuthorization, isWalletSessionUnlocked, markWalletSessionUnlocked, type SecurityAccount } from './accountSecurity.js';
import {
  binToHex,
  hexToBin,
  encodeTransaction,
  decodeTransaction,
  hashTransaction,
  createVirtualMachineBCH,
  cashAddressToLockingBytecode,
  decodeAuthenticationInstructions,
  deriveHdPublicNodeChild,
  isPayToPublicKeyHash,
  SigningSerializationType,
} from "@bitauth/libauth";
import { buildWizardSignRequest } from "@cashingularity/contracts-cashscript";
import {
  type ExecutionMode,
  type UtxoDagInspection,
  type WalletUtxo,
  type WalletSyncTransaction,
  type WizardSignTransactionRequest,
  validateAndConvertCashAddr,
} from "@cashingularity/shared";
import type { DappConnectionManager } from "@wizardconnect/dapp";
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import {
  bchWalletService,
  accountDerivationPaths,
  addressFromPubkey,
  type BchWalletService,
  type LocalWalletAddresses,
} from "./bchWalletService.js";
import { WalletChainSync, type AccountChainSync, type WalletScan, type WalletSyncState } from './walletChainSync.js';
import { walletBchBalances } from './walletAssets.js';
import {
  assertCovenantMatchesPreview,
  assertPaymentMatchesReview,
  PREDICTION_SETTLEMENT_REQUIRED,
  verifyCovenantProof,
  type PreparedPayment,
} from "./paymentService.js";
export type WalletConnectionType =
  | "SANDBOX_DEMO"
  | "WIZARD_CONNECT"
  | "BROWSER_EXTENSION"
  | "BUILTIN_HD_XO"
  | "WATCH_ONLY";

export interface InjectedBchProvider {
  name: string;
  key: "paytaca" | "cashonize" | "bitcoinCash" | "wizardWallet";
  getAddresses?: () => Promise<string[]>;
  signTransaction?: (payload: unknown) => Promise<
    | string
    | { signedTransaction?: string; signedTransactionHash?: string; error?: string }
  >;
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export function detectInjectedBchProviders(): InjectedBchProvider[] {
  if (typeof window === "undefined") return [];
  const win = window as unknown as Record<string, Record<string, unknown> | undefined>;
  const candidates: Array<{
    key: InjectedBchProvider["key"];
    name: string;
  }> = [
    { key: "paytaca", name: "Paytaca Extension" },
    { key: "cashonize", name: "Cashonize Wallet" },
    { key: "bitcoinCash", name: "Bitcoin Cash Extension" },
    { key: "wizardWallet", name: "WizardConnect Extension" },
  ];
  const found: InjectedBchProvider[] = [];
  for (const c of candidates) {
    const raw = win[c.key];
    if (
      raw &&
      (typeof raw.getAddresses === "function" ||
        typeof raw.request === "function")
    ) {
      found.push({
        key: c.key,
        name: c.name,
        getAddresses:
          typeof raw.getAddresses === "function"
            ? (raw.getAddresses.bind(raw) as InjectedBchProvider["getAddresses"])
            : undefined,
        signTransaction:
          typeof raw.signTransaction === "function"
            ? (raw.signTransaction.bind(raw) as InjectedBchProvider["signTransaction"])
            : undefined,
        request:
          typeof raw.request === "function"
            ? (raw.request.bind(raw) as InjectedBchProvider["request"])
            : undefined,
      });
    }
  }
  return found;
}

export async function connectInjectedBchProvider(
  provider: InjectedBchProvider,
): Promise<{
  receiveAddress: string;
  changeAddress: string;
  network: "mainnet" | "chipnet";
}> {
  let rawAddresses: unknown;
  if (provider.request) {
    for (const method of ["bch:getAddresses", "bch_addresses", "getAddresses"]) {
      try {
        rawAddresses = await provider.request({ method });
        if (Array.isArray(rawAddresses) && rawAddresses.length > 0) break;
      } catch {
        // Try next standard method name
      }
    }
  }
  if ((!Array.isArray(rawAddresses) || rawAddresses.length === 0) && provider.getAddresses) {
    rawAddresses = await provider.getAddresses();
  }
  if (!Array.isArray(rawAddresses) || rawAddresses.length === 0) {
    throw new Error(`${provider.name} did not return any BCH addresses.`);
  }
  const first = String(rawAddresses[0]);
  const second = String(rawAddresses[1] ?? rawAddresses[0]);
  const v1 = validateAndConvertCashAddr(first);
  const v2 = validateAndConvertCashAddr(second);
  if (!v1.valid || !v1.standardAddress || !v1.network) {
    throw new Error(`${provider.name} returned an invalid CashAddr.`);
  }
  return {
    receiveAddress: v1.standardAddress,
    changeAddress: v2.valid && v2.network === v1.network && v2.standardAddress ? v2.standardAddress : v1.standardAddress,
    network: v1.network,
  };
}
export interface ConnectedWalletProfile {
  profileId?: string;
  localProfileId?: string;
  accountIndex?: number;
  securityAccount?: SecurityAccount;
  connectionType: WalletConnectionType;
  walletLabel: string;
  network: "mainnet" | "chipnet";
  isConnected: boolean;
  receiveAddress: string;
  receiveTokenAddress: string;
  changeAddress: string;
  changeTokenAddress: string;
  receiveDerivationPath: string;
  changeDerivationPath: string;
  balanceSats: bigint;
  utxos: WalletUtxo[];
  utxoSource?: string;
  chainHistory?: WalletSyncTransaction[];
  chainHeight?: number;
  totalUtxoSats?: bigint;
  externalSigningReady?: boolean;
}
type PaymentSigningIssue = {
  kind: 'connect' | 'watch' | 'locked' | 'reconnect' | 'unsupported';
  message: string;
};
export interface SignedTransactionReceipt {
  txid: string;
  signedHex: string;
  mode: ExecutionMode;
  walletType: WalletConnectionType;
  engineTrack: "CASHSCRIPT_WIZARD" | "XO_INVITATION" | "SOLIDCASH_SCASH";
  signedAtMs: number;
  wizardRequest: WizardSignTransactionRequest;
  broadcasted: boolean;
  explorerUrl?: string;
}
const exampleAddress = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const exampleTokenAddress =
  "bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m";

export function wizardProfile(receiveAddress: string, changeAddress: string, walletLabel: string, network: "mainnet" | "chipnet", signingReady: boolean): ConnectedWalletProfile {
  const receive = validateAndConvertCashAddr(receiveAddress);
  const change = validateAndConvertCashAddr(changeAddress);
  if (!receive.valid || !change.valid || receive.network !== network || change.network !== network) {
    throw new Error("Wallet address or network mismatch.");
  }
  return {
    connectionType: 'WIZARD_CONNECT', externalSigningReady: signingReady, walletLabel, network, isConnected: true,
    receiveAddress: receive.standardAddress!, receiveTokenAddress: receive.tokenAwareAddress!,
    changeAddress: change.standardAddress!, changeTokenAddress: change.tokenAwareAddress!,
    receiveDerivationPath: 'receive/0', changeDerivationPath: 'change/0',
    balanceSats: 0n, utxos: [], utxoSource: 'syncing',
  };
}
export class WalletRuntime {
  private dappManager: DappConnectionManager | null = null;
  private injectedProvider: InjectedBchProvider | null = null;
  private localWallet: BchWalletService = bchWalletService;
  private chain?: AccountChainSync;
  private wizardScan?: WalletScan;
  private activation = 0;
  private externalAuthority = 0;
  private signingRequest?: AbortController;
  private listeners = new Set<(profile: ConnectedWalletProfile) => void>();
  private profile: ConnectedWalletProfile = {
    profileId: 'sandbox',
    connectionType: "SANDBOX_DEMO",
    walletLabel: "Sandbox wallet",
    network: "mainnet",
    isConnected: false,
    receiveAddress: exampleAddress,
    receiveTokenAddress: exampleTokenAddress,
    changeAddress: exampleAddress,
    changeTokenAddress: exampleTokenAddress,
    receiveDerivationPath: "m/44'/145'/0'/0/0",
    changeDerivationPath: "m/44'/145'/0'/1/0",
    balanceSats: 250_000_000n,
    utxos: [],
    utxoSource: "sandbox",
  };
  constructor(private openChain: (wallet: WalletScan, onUpdate: (state: WalletSyncState) => void) => AccountChainSync =
    (wallet, onUpdate) => new WalletChainSync(wallet, onUpdate)) {}

  subscribe(listener: (profile: ConnectedWalletProfile) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit() { for (const listener of this.listeners) listener(this.profile); }

  private stopChain() {
    this.activation++;
    this.signingRequest?.abort(new Error('Wallet changed during signing.'));
    this.chain?.close();
    this.chain = undefined;
    this.wizardScan = undefined;
  }

  private blankChainData = { chainHistory: undefined, chainHeight: undefined, totalUtxoSats: undefined, externalSigningReady: undefined };
  getAddresses(): ConnectedWalletProfile {
    return this.profile;
  }
  getPaymentSigningIssue(): PaymentSigningIssue | undefined {
    const profile = this.profile;
    if (!profile.isConnected || profile.connectionType === 'SANDBOX_DEMO' || profile.utxoSource === 'sandbox') {
      return { kind: 'connect', message: 'Connect or unlock a signing wallet before sending BCH.' };
    }
    if (profile.connectionType === 'WATCH_ONLY') {
      return { kind: 'watch', message: 'This profile is watch-only. Enable signing or select a signing wallet.' };
    }
    if (profile.connectionType === 'BUILTIN_HD_XO') {
      const keys = this.localWallet.getAddresses();
      if (keys?.network !== profile.network || keys.receiveAddress !== profile.receiveAddress || keys.changeAddress !== profile.changeAddress) {
        return { kind: 'locked', message: 'Unlock this wallet before sending BCH.' };
      }
    }
    if (profile.connectionType === 'WIZARD_CONNECT' && (!profile.externalSigningReady || !this.dappManager?.isWalletDiscovered())) {
      return { kind: 'reconnect', message: 'External wallet offline. Open WizardConnect in your wallet to reconnect before sending.' };
    }
    if (profile.connectionType === 'BROWSER_EXTENSION' && !this.injectedProvider?.request && !this.injectedProvider?.signTransaction) {
      return { kind: 'unsupported', message: 'This browser wallet does not provide a signing method. Select a signing wallet.' };
    }
  }
  connectSandboxDemo(preserve = false): ConnectedWalletProfile {
    this.stopChain();
    if (!preserve) this.localWallet.lock();
    this.dappManager = null;
    this.profile = {
      ...this.profile,
      ...this.blankChainData,
      profileId: 'sandbox',
      accountIndex: undefined,
      securityAccount: undefined,
      localProfileId: undefined,
      connectionType: "SANDBOX_DEMO",
      walletLabel: "Sandbox wallet",
      network: "mainnet",
      isConnected: false,
      receiveAddress: exampleAddress,
      receiveTokenAddress: exampleTokenAddress,
      changeAddress: exampleAddress,
      changeTokenAddress: exampleTokenAddress,
      balanceSats: 250_000_000n,
      utxos: [],
      utxoSource: "sandbox",
    };
    return this.profile;
  }
  setLocalProfile(
    addresses: LocalWalletAddresses,
    sandbox = false,
    wallet: BchWalletService = bchWalletService,
  ): ConnectedWalletProfile {
    this.stopChain();
    this.localWallet = wallet;
    this.dappManager = null;
    this.profile = {
      ...this.profile,
      ...this.blankChainData,
      profileId: undefined,
      securityAccount: undefined,
      localProfileId: undefined,
      ...addresses,
      ...accountDerivationPaths(addresses.accountIndex),
      connectionType: "BUILTIN_HD_XO",
      walletLabel: `HD wallet (${addresses.network.toUpperCase()})`,
      isConnected: true,
      balanceSats: 0n,
      utxos: [],
      utxoSource: sandbox ? "sandbox" : "syncing",
    };
    return this.profile;
  }
  setWizardProfile(
    receiveAddress: string,
    changeAddress: string,
    walletLabel: string,
    network: "mainnet" | "chipnet",
    manager: DappConnectionManager,
    signingReady = false,
  ): ConnectedWalletProfile {
    return this.activateSavedProfile(wizardProfile(receiveAddress, changeAddress, walletLabel, network, signingReady), undefined, manager);
  }
  setExtensionProfile(
    receiveAddress: string,
    changeAddress: string,
    walletLabel: string,
    network: "mainnet" | "chipnet",
    provider: InjectedBchProvider,
  ): ConnectedWalletProfile {
    const receive = validateAndConvertCashAddr(receiveAddress),
      change = validateAndConvertCashAddr(changeAddress);
    if (
      !receive.valid ||
      !change.valid ||
      receive.network !== network ||
      change.network !== network
    )
      throw new Error("Extension address or network mismatch.");
    this.stopChain();
    this.dappManager = null;
    this.injectedProvider = provider;
    this.profile = {
      ...this.profile,
      ...this.blankChainData,
      profileId: undefined,
      accountIndex: undefined,
      securityAccount: undefined,
      localProfileId: undefined,
      connectionType: "BROWSER_EXTENSION",
      walletLabel,
      network,
      isConnected: true,
      receiveAddress: receive.standardAddress!,
      receiveTokenAddress: receive.tokenAwareAddress!,
      changeAddress: change.standardAddress!,
      changeTokenAddress: change.tokenAwareAddress!,
      balanceSats: 0n,
      utxos: [],
      utxoSource: "syncing",
    };
    return this.profile;
  }
  activateSavedProfile(
    profile: ConnectedWalletProfile,
    wallet?: BchWalletService,
    manager?: DappConnectionManager,
    provider?: InjectedBchProvider,
    externalScan?: WalletScan,
  ): ConnectedWalletProfile {
    this.stopChain();
    this.profile = {
      ...profile,
      ...(profile.isConnected && profile.utxoSource !== 'sandbox' ? {
        chainHistory: undefined, chainHeight: undefined, totalUtxoSats: undefined,
        utxos: [], balanceSats: 0n, utxoSource: 'syncing',
      } : {}),
    };
    this.localWallet = wallet ?? bchWalletService;
    this.dappManager = manager ?? null;
    this.injectedProvider = provider ?? null;
    this.wizardScan = externalScan;
    return this.profile;
  }
  getWizardManager(): DappConnectionManager | null {
    return this.dappManager;
  }
  getLocalWallet(): BchWalletService {
    return this.localWallet;
  }
  updateWizardAvailability(manager: DappConnectionManager, ready: boolean) {
    if (this.dappManager !== manager || this.profile.externalSigningReady === ready) return;
    if (!ready) {
      this.externalAuthority++;
      this.signingRequest?.abort(new Error('The external wallet disconnected during signing.'));
    }
    this.profile = { ...this.profile, externalSigningReady: ready };
    this.emit();
  }
  updateWizardScan(manager: DappConnectionManager, scan: WalletScan) {
    if (this.dappManager !== manager) return;
    this.activateSavedProfile(this.profile, undefined, manager, undefined, scan);
    this.emit();
  }
  setWatchProfile(
    address: string,
    network: "mainnet" | "chipnet",
    label: string,
  ): ConnectedWalletProfile {
    const validated = validateAndConvertCashAddr(address);
    if (
      !validated.valid ||
      validated.network !== network ||
      !validated.standardAddress ||
      !validated.tokenAwareAddress
    )
      throw new Error("Invalid address or network mismatch.");
    this.stopChain();
    this.dappManager = null;
    this.profile = {
      ...this.profile,
      ...this.blankChainData,
      profileId: undefined,
      accountIndex: undefined,
      securityAccount: undefined,
      localProfileId: undefined,
      connectionType: "WATCH_ONLY",
      walletLabel: label,
      network,
      isConnected: true,
      receiveAddress: validated.standardAddress,
      receiveTokenAddress: validated.tokenAwareAddress,
      changeAddress: validated.standardAddress,
      changeTokenAddress: validated.tokenAwareAddress,
      balanceSats: 0n,
      utxos: [],
      utxoSource: "syncing",
    };
    return this.profile;
  }
  async refreshOnChainBalance(fresh = false): Promise<ConnectedWalletProfile> {
    const profile = this.profile;
    const activation = this.activation;
    if (!profile.isConnected || profile.utxoSource === 'sandbox') throw new Error('Connect an on-chain wallet first.');
    if (!this.chain) {
      const wallet = this.localWallet;
      const manager = this.dappManager;
      const { network, connectionType, receiveAddress, changeAddress } = profile;
      let scan: WalletScan;
      if (connectionType === 'BUILTIN_HD_XO') {
        scan = { network, derive: (scope, index) => wallet.getAddress(scope, index) };
      } else if (connectionType === 'WIZARD_CONNECT' && this.wizardScan) {
        scan = this.wizardScan;
      } else if (connectionType === 'WIZARD_CONNECT' && manager) {
        const paths = { receive: manager.getXpubNode(0), change: manager.getXpubNode(1) };
        scan = { network, derive: (scope, index) => {
          const node = paths[scope];
          if (!node) throw new Error('The external wallet did not provide this BCH address path.');
          return addressFromPubkey(deriveHdPublicNodeChild(node, index).publicKey, network);
        } };
      } else {
        scan = { network, addresses: [
          { address: receiveAddress, scope: 'receive', index: 0 },
          ...(changeAddress === receiveAddress ? [] : [{ address: changeAddress, scope: 'change' as const, index: 0 }]),
        ] };
      }
      this.chain = this.openChain(scan, state => {
        if (this.activation !== activation) return;
        if (typeof state === 'string') {
          this.profile = { ...this.profile, balanceSats: 0n, totalUtxoSats: undefined, utxos: [], chainHistory: undefined, chainHeight: undefined, utxoSource: state };
        } else {
          const balance = state.utxos === this.profile.utxos
            ? { totalSats: this.profile.totalUtxoSats, spendableSats: this.profile.balanceSats }
            : walletBchBalances(state.utxos);
          this.profile = {
            ...this.profile, utxos: state.utxos, utxoSource: state.source,
            balanceSats: balance.spendableSats, totalUtxoSats: balance.totalSats, chainHistory: state.history, chainHeight: state.height,
          };
        }
        this.emit();
      });
    }
    try {
      await this.chain.refresh(fresh);
    } catch (error) {
      if (this.activation !== activation) throw new Error('Wallet changed during refresh.');
      throw new Error('Could not refresh the on-chain balance. Retry balance sync and review again.', { cause: error });
    }
    if (this.activation !== activation || !this.profile.chainHistory) throw new Error('Wallet changed during refresh.');
    return this.profile;
  }
  createSignRequestFromDag(
    dag: UtxoDagInspection,
    userPrompt: string,
  ): WizardSignTransactionRequest {
    return buildWizardSignRequest({
      transaction: {
        version: 2,
        locktime: 0,
        inputs: dag.inputs,
        outputs: dag.outputs,
      },
      inputs: dag.inputs.map((_, i) => ({
        inputIndex: i,
        scope: "receive" as const,
        addressIndex: 0,
      })),
      userPrompt,
    });
  }
  async signPreparedPayment(
    payment: PreparedPayment,
  ): Promise<SignedTransactionReceipt> {
    payment = structuredClone(payment);
    if (payment.profileId !== this.profile.profileId) throw new Error('Wallet changed. Prepare the payment again.');
    if (payment.contractType || payment.covenantTemplate) {
      if (!payment.covenantProof) {
        throw new Error("Contract signing is unavailable until the intended covenant and its on-chain state are independently verified. No funds were sent.");
      }
      const matching = payment.transaction.outputs
        .map((output, index) =>
          binToHex(output.lockingBytecode) === payment.covenantProof?.lockingBytecodeHex.toLowerCase()
            ? index
            : -1,
        )
        .filter((index) => index >= 0);
      if (matching.length !== 1) {
        throw new Error("Contract signing is unavailable: the proof must identify exactly one covenant output.");
      }
      verifyCovenantProof(
        payment.covenantProof,
        matching[0],
        payment.transaction,
        payment.dag,
        this.profile,
        this.localWallet,
      );
      if (payment.contractType === 'PREDICTION_STAKE') {
        throw new Error(PREDICTION_SETTLEMENT_REQUIRED);
      }
      throw new Error("Contract signing is unavailable until the intended covenant and its on-chain state are independently verified. No funds were sent.");
    }
    if (this.profile.network !== payment.network || this.profile.receiveAddress !== payment.receiveAddress) {
      throw new Error('Wallet changed. Prepare the payment again.');
    }
    const activation = this.activation;
    const authority = this.externalAuthority;
    const assertSigner = () => {
      if (this.activation !== activation) throw new Error('Wallet changed during signing. Review the payment again.');
      if (this.externalAuthority !== authority) throw new Error('The external wallet disconnected during signing.');
      const issue = this.getPaymentSigningIssue();
      if (issue) throw new Error(issue.message);
    };
    assertSigner();
    assertPaymentMatchesReview(payment, this.profile);
    if (this.signingRequest) throw new Error('Finish the current external signing request first.');
    const controller = new AbortController();
    this.signingRequest = controller;
    try {
      const security = this.profile.securityAccount;
      const signingProfile = this.profile;
      if (security && !isWalletSessionUnlocked(signingProfile.localProfileId, security)) {
        await authorizeAccount(security, 'sign', undefined, undefined, signingProfile.localProfileId);
        consumeAuthorization(security, 'sign', signingProfile.localProfileId);
        if (this.activation !== activation || this.profile.securityAccount?.id !== security.id || this.profile.localProfileId !== signingProfile.localProfileId) throw new Error('Wallet changed during authorization.');
        if (signingProfile.localProfileId) markWalletSessionUnlocked(signingProfile.localProfileId, security);
      }
      const assertQuote = () => {
        if (payment.quote && payment.quote.expiresAtMs <= Date.now())
          throw new Error(
            "The FX quote has expired. Refresh and review the batch again.",
          );
      };
      assertQuote();
      const revalidate = async () => {
        const current = await this.refreshOnChainBalance(true);
        assertSigner();
        for (const [index, input] of payment.inputs.entries()) {
          const live = current.utxos.find(u => u.txid === input.txid && u.vout === input.vout);
          if (!live || !tokensEqual(live.token, input.token) || live.satoshis !== input.satoshis ||
              live.address !== input.address || live.derivationScope !== input.derivationScope || live.addressIndex !== input.addressIndex) {
            throw new Error('A selected input changed or is no longer spendable. Prepare the payment again.');
          }
          const source = payment.sourceOutputs[index];
          const unsignedInput = payment.transaction.inputs[index];
          const locking = cashAddressToLockingBytecode(live.address);
          const token = source.token && {
            categoryId: binToHex(source.token.category), amount: source.token.amount,
            nft: source.token.nft && { ...source.token.nft, commitment: binToHex(source.token.nft.commitment) },
          };
          if (typeof locking === 'string' || binToHex(locking.bytecode) !== binToHex(source.lockingBytecode) ||
              source.valueSatoshis !== live.satoshis || !tokensEqual(token, live.token) ||
              binToHex(unsignedInput.outpointTransactionHash) !== live.txid ||
              unsignedInput.outpointIndex !== live.vout || unsignedInput.unlockingBytecode.length) {
            throw new Error('The prepared input does not match the live UTXO. Review the payment again.');
          }
        }
        assertQuote();
        return current;
      };
      const current = await revalidate();
      if (payment.covenantTemplate && current.connectionType === "BUILTIN_HD_XO") {
        assertCovenantMatchesPreview(payment.covenantTemplate, payment.dag, current, {
          verifiedOutputCovenant: Boolean(payment.covenantProof),
        });
      }
      let signedHex: string;
      if (current.connectionType === "BUILTIN_HD_XO") {
        const walletInputs = payment.inputs.map((u, inputIndex) => {
          if (u.derivationScope !== 'receive' && u.derivationScope !== 'change') throw new Error('Unsupported BCH address branch.');
          return { inputIndex, scope: u.derivationScope, addressIndex: u.addressIndex };
        });
        signedHex = binToHex(
          encodeTransaction(
            this.localWallet.signWalletInputs(
              payment.transaction,
              payment.sourceOutputs,
              walletInputs,
            ),
          ),
        );
      } else if (
        current.connectionType === "WIZARD_CONNECT" &&
        this.dappManager
      ) {
        const result = await this.dappManager.signTransaction({
          transaction: {
            transaction: binToHex(encodeTransaction(payment.transaction)),
            sourceOutputs: payment.sourceOutputs.map((output, i) => sourceOutputToRelay({
              ...output,
              ...payment.transaction.inputs[i],
            })),
            broadcast: false,
            userPrompt: "Review and sign the BCH payment",
          },
          inputPaths: payment.inputs.map((u, i) => [
            i,
            u.derivationScope,
            u.addressIndex,
          ]),
        }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
        assertSigner();
        if (result.error) throw new Error(result.error);
        signedHex = result.signedTransaction;
      } else if (
        current.connectionType === "BROWSER_EXTENSION" &&
        this.injectedProvider
      ) {
        const signPayload = {
          transaction: binToHex(encodeTransaction(payment.transaction)),
          sourceOutputs: payment.sourceOutputs.map((output, i) => ({
            ...output,
            ...payment.transaction.inputs[i],
          })),
          broadcast: false,
          userPrompt: "Review and sign the BCH payment",
        };
        let res: unknown;
        if (this.injectedProvider.request) {
          res = await this.injectedProvider.request({
            method: "bch:signTransaction",
            params: signPayload,
          });
        } else if (this.injectedProvider.signTransaction) {
          res = await this.injectedProvider.signTransaction(signPayload);
        } else {
          throw new Error(`${this.injectedProvider.name} does not support signing.`);
        }
        assertSigner();
        if (typeof res === "string") {
          signedHex = res;
        } else if (res && typeof res === "object") {
          const obj = res as { signedTransaction?: string; error?: string };
          if (obj.error) throw new Error(obj.error);
          if (!obj.signedTransaction) {
            throw new Error("Extension did not return a signed transaction.");
          }
          signedHex = obj.signedTransaction;
        } else {
          throw new Error("Extension returned an invalid signing response.");
        }
      } else throw new Error("An active signing wallet is required.");
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(signedHex))
        throw new Error("Wallet returned invalid transaction bytes.");
      const signedBytes = hexToBin(signedHex);
      const decoded = decodeTransaction(signedBytes);
      if (typeof decoded === "string")
        throw new Error("Wallet returned an invalid transaction.");
      const unsigned = structuredClone(decoded);
      for (const input of unsigned.inputs)
        input.unlockingBytecode = new Uint8Array();
      if (
        binToHex(encodeTransaction(unsigned)) !==
        binToHex(encodeTransaction(payment.transaction))
      )
        throw new Error(
          "Wallet changed the reviewed transaction; broadcast cancelled.",
        );
      for (const [index, input] of decoded.inputs.entries()) {
        if (!isPayToPublicKeyHash(payment.sourceOutputs[index].lockingBytecode)) continue;
        const signature = decodeAuthenticationInstructions(input.unlockingBytecode)[0];
        const flags = signature && 'data' in signature ? signature.data.at(-1) : undefined;
        if (flags !== SigningSerializationType.allOutputs && flags !== SigningSerializationType.allOutputsAllUtxos) {
          throw new Error('The wallet signature must commit to all reviewed outputs and inputs.');
        }
      }
      const verification = createVirtualMachineBCH().verify({
        transaction: decoded,
        sourceOutputs: payment.sourceOutputs,
      });
      if (verification !== true)
        throw new Error(
          `Signed transaction failed verification: ${verification}`,
        );
      if (current.connectionType !== 'BUILTIN_HD_XO') await revalidate();
      assertSigner();
      assertQuote();
      const expectedTxid = hashTransaction(signedBytes);
      const request = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawTxHex: signedHex,
          signedHex,
          network: payment.network,
        }),
        signal: AbortSignal.timeout(30000),
      };
      try {
        let response = await fetch("/api/chain/broadcast", request);
        if (response.status === 404)
          response = await fetch("/api/wallet/broadcast", request);
        const data = (await response.json()) as { txid?: string; error?: string };
        if (
          !response.ok ||
          !data.txid ||
          data.txid.toLowerCase() !== expectedTxid
        )
          throw new Error(data.error || "Unexpected response");
      } catch {
        throw new Error(
          `Broadcast result uncertain. Check transaction ${expectedTxid} on the ${payment.network} network before retrying.`,
        );
      }
      return {
        txid: expectedTxid,
        signedHex,
        mode: "MAINNET_MODE",
        walletType: current.connectionType,
        engineTrack: "CASHSCRIPT_WIZARD",
        signedAtMs: Date.now(),
        wizardRequest: {
          ...this.createSignRequestFromDag(payment.dag, "BCH payment"),
          inputPaths: payment.inputs.map((u, i) => [i, u.derivationScope, u.addressIndex]),
        },
        broadcasted: true,
        explorerUrl:
          payment.network === "chipnet"
            ? `https://chipnet.chaingraph.cash/tx/${expectedTxid}`
            : `https://blockchair.com/bitcoin-cash/transaction/${expectedTxid}`,
      };
    } finally {
      if (this.signingRequest === controller) this.signingRequest = undefined;
    }
  }
  async signAndBroadcast(params: {
    dag: UtxoDagInspection;
    mode: ExecutionMode;
    engineTrack: "CASHSCRIPT_WIZARD" | "XO_INVITATION" | "SOLIDCASH_SCASH";
    userPrompt: string;
  }): Promise<SignedTransactionReceipt> {
    const wizardRequest = this.createSignRequestFromDag(
      params.dag,
      params.userPrompt,
    );
    if (params.mode === "SANDBOX_MODE")
      return {
        txid: "",
        signedHex: "",
        mode: params.mode,
        walletType: "SANDBOX_DEMO",
        engineTrack: params.engineTrack,
        signedAtMs: Date.now(),
        wizardRequest,
        broadcasted: false,
      };
    if (!this.profile.isConnected)
      throw new Error("Connect a wallet before signing.");
    throw new Error(
      "Contract signing is unavailable: the current preparation endpoint returns an illustrative preview rather than a verified transaction. No funds were sent.",
    );
  }
}
export const wizardWalletSingleton = new WalletRuntime();
