import {
  CashAddressType,
  decodeBip39Mnemonic,
  deriveHdPath,
  deriveHdPrivateNodeChild,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  deriveHdPublicNodeChild,
  encodeBip39Mnemonic,
  encodeCashAddress,
  hash160,
  secp256k1,
  generateSigningSerializationBCH,
  sha256,
  createVirtualMachineBCH,
  cashAddressToLockingBytecode,
  binToHex,
  encodeDataPush,
  encodeTransaction,
  getDustThreshold,
  type Transaction,
  type Output,
  type HdPrivateNodeValid,
  type HdPublicNodeValid,
} from "@bitauth/libauth";
import type { WalletBranch } from './walletChainSync.js';

export type WalletNetwork = "mainnet" | "chipnet";
export interface LocalWalletAddresses {
  network: WalletNetwork;
  accountIndex?: number;
  receiveAddress: string;
  receiveTokenAddress: string;
  changeAddress: string;
  changeTokenAddress: string;
}

export function addressFromPubkey(publicKey: Uint8Array, network: WalletNetwork, token = false): string {
  return encodeCashAddress({
    prefix: network === 'chipnet' ? 'bchtest' : 'bitcoincash',
    type: token ? CashAddressType.p2pkhWithTokens : CashAddressType.p2pkh,
    payload: hash160(publicKey),
  }).address;
}

export function accountDerivationPaths(account = 0) {
  return { receiveDerivationPath: `m/44'/145'/${account}'/0/0`, changeDerivationPath: `m/44'/145'/${account}'/1/0` };
}

/** Session-only key store: no mnemonic or private key is written to storage or sent over the network. */
export class BchWalletService {
  private keys: Record<WalletBranch, HdPrivateNodeValid> | null = null;
  private publicBranches: Record<WalletBranch, HdPublicNodeValid> | null = null;
  private addresses: LocalWalletAddresses | null = null;

  createLocalWallet(): string {
    if (!globalThis.crypto?.getRandomValues || !globalThis.isSecureContext) {
      throw new Error(
        "Secure browser cryptography is required to create a wallet. Use HTTPS or localhost.",
      );
    }
    const entropy = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const result = encodeBip39Mnemonic(entropy);
    entropy.fill(0);
    if (typeof result === "string") throw new Error(result);
    return result.phrase;
  }

  importLocalWallet(
    mnemonic: string,
    network: WalletNetwork,
    accountIndex = 0,
  ): LocalWalletAddresses {
    if (typeof window !== "undefined" && !window.isSecureContext)
      throw new Error("Import requires HTTPS or localhost.");
    const phrase = mnemonic
      .normalize("NFKD")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .join(" ");
    if (![12, 24].includes(phrase.split(" ").length))
      throw new Error("Enter a 12- or 24-word BIP39 recovery phrase.");
    const decoded = decodeBip39Mnemonic(phrase);
    if (typeof decoded === "string")
      throw new Error(
        "Invalid recovery phrase: check every word and the checksum.",
      );
    decoded.fill(0);
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 0x7fffffff) throw new Error('Invalid BCH account index.');
    const root = deriveHdPrivateNodeFromBip39Mnemonic(phrase);
    try {
      const branches = {
        receive: deriveHdPath(root, `m/44'/145'/${accountIndex}'/0`),
        change: deriveHdPath(root, `m/44'/145'/${accountIndex}'/1`),
      };
      const publicBranches = { receive: deriveHdPublicNode(branches.receive), change: deriveHdPublicNode(branches.change) };
      const receive = deriveHdPublicNodeChild(publicBranches.receive, 0).publicKey;
      const change = deriveHdPublicNodeChild(publicBranches.change, 0).publicKey;
      this.lock();
      this.keys = branches;
      this.publicBranches = publicBranches;
      this.addresses = {
        network, accountIndex,
        receiveAddress: addressFromPubkey(receive, network), receiveTokenAddress: addressFromPubkey(receive, network, true),
        changeAddress: addressFromPubkey(change, network), changeTokenAddress: addressFromPubkey(change, network, true),
      };
      return this.addresses;
    } finally { root.privateKey.fill(0); root.chainCode.fill(0); }
  }

  getAddress(scope: WalletBranch, index: number): string {
    if (!this.publicBranches || !this.addresses) throw new Error('Local wallet is locked.');
    return addressFromPubkey(deriveHdPublicNodeChild(this.publicBranches[scope], index).publicKey, this.addresses.network);
  }

  private withPrivateKey<T>(scope: WalletBranch, addressIndex: number, use: (key: Uint8Array) => T): T {
    if (!this.keys) throw new Error('Local wallet is locked.');
    const child = deriveHdPrivateNodeChild(this.keys[scope], addressIndex);
    try { return use(child.privateKey); }
    finally { child.privateKey.fill(0); child.chainCode.fill(0); }
  }

  signPayment(
    transaction: Transaction,
    sourceOutputs: Output[],
    scopes: Array<"receive" | "change">,
  ): Transaction {
    if (transaction.inputs.length !== scopes.length) throw new Error("Invalid signing context.");
    return this.signWalletInputs(transaction, sourceOutputs, scopes.map((scope, inputIndex) => ({ inputIndex, scope })));
  }

  /** Sign only owned P2PKH inputs, preserving covenant unlocking bytecode. */
  signWalletInputs(
    transaction: Transaction,
    sourceOutputs: Output[],
    walletInputs: Array<{ inputIndex: number; scope: WalletBranch; addressIndex?: number }>,
  ): Transaction {
    const signed = this.signOwnedInputs(transaction, sourceOutputs, walletInputs);
    const validation = createVirtualMachineBCH().verify({ transaction: signed, sourceOutputs });
    if (validation !== true) throw new Error(`Transaction verification failed: ${validation}`);
    return signed;
  }

  /** The local Chipnet proof runner uses the 2026 limits for covenant redeem scripts. */
  async signChipnetProofInput(transaction: Transaction, sourceOutputs: Output[], inputIndex: number): Promise<Transaction> {
    if (this.addresses?.network !== 'chipnet') throw new Error('Select an unlocked Chipnet wallet.');
    const addresses = this.addresses;
    const { createVirtualMachineBch2026 } = await import('@bitauth/libauth-vm');
    if (this.addresses !== addresses) throw new Error('The Chipnet wallet changed during approval.');
    const signed = this.signOwnedInputs(transaction, sourceOutputs, [{ inputIndex, scope: 'receive', addressIndex: 0 }]);
    const validation = createVirtualMachineBch2026().verify({ transaction: signed, sourceOutputs });
    if (validation !== true) throw new Error(`Chipnet CashVM verification failed: ${validation}`);
    return signed;
  }

  private signOwnedInputs(
    transaction: Transaction,
    sourceOutputs: Output[],
    walletInputs: Array<{ inputIndex: number; scope: WalletBranch; addressIndex?: number }>,
  ): Transaction {
    if (!this.keys || !this.addresses) throw new Error("Local wallet is locked.");
    if (transaction.inputs.length !== sourceOutputs.length || walletInputs.length === 0) throw new Error("Invalid signing context.");
    const seen = new Set<number>();
    const signed = structuredClone(transaction);
    for (const { inputIndex, scope, addressIndex = 0 } of walletInputs) {
      if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= signed.inputs.length || seen.has(inputIndex) || (scope !== "receive" && scope !== "change") ||
          !Number.isInteger(addressIndex) || addressIndex < 0 || addressIndex > 0x7fffffff) throw new Error("Invalid wallet input selection.");
      seen.add(inputIndex);
      const input = signed.inputs[inputIndex];
      const source = sourceOutputs[inputIndex];
      const expected = cashAddressToLockingBytecode(this.getAddress(scope, addressIndex));
      if (typeof expected === "string" || binToHex(expected.bytecode) !== binToHex(source.lockingBytecode) || input.unlockingBytecode.length !== 0) throw new Error("Wallet input is not an unsigned P2PKH output owned by this wallet.");
      const serialization = generateSigningSerializationBCH(
        { inputIndex, sourceOutputs, transaction: signed },
        { coveredBytecode: source.lockingBytecode, signingSerializationType: Uint8Array.of(0x61) },
      );
      input.unlockingBytecode = this.withPrivateKey(scope, addressIndex, key => {
        const publicKey = secp256k1.derivePublicKeyCompressed(key);
        const signature = secp256k1.signMessageHashSchnorr(key, sha256.hash(sha256.hash(serialization)));
        if (typeof publicKey === 'string') throw new Error(publicKey);
        if (typeof signature === 'string') throw new Error(signature);
        return Uint8Array.from([65, ...signature, 0x61, 33, ...publicKey]);
      });
    }
    return signed;
  }

  getAddresses(): LocalWalletAddresses | null {
    return this.addresses;
  }

  getReceivePublicKey(): Uint8Array {
    if (!this.publicBranches) throw new Error("Local wallet is locked.");
    return deriveHdPublicNodeChild(this.publicBranches.receive, 0).publicKey;
  }

  /** Test a simple signature-based recovery path locally; no transaction is sent. */
  verifyCovenantRecovery(redeemScript: Uint8Array, source: Output, selector?: number): boolean {
    if (!this.keys || !this.addresses) throw new Error("Local wallet is locked.");
    const owner = this.getReceivePublicKey();
    const destination = cashAddressToLockingBytecode(this.addresses.receiveAddress);
    if (typeof destination === "string") return false;
    if (!globalThis.crypto?.getRandomValues) throw new Error("Secure randomness is required for recovery verification.");
    const testOutpoint = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const transaction: Transaction = {
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: testOutpoint, outpointIndex: 1, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ ...structuredClone(source), lockingBytecode: destination.bytecode }],
    };
    const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(part => [...part]));
    const vm = createVirtualMachineBCH();
    if (selector !== undefined && selector !== 0 && (selector < 0x51 || selector > 0x60 || !Number.isInteger(selector))) throw new Error("Invalid recovery path selector.");
    // Support both P2PKH-style and embedded-public-key recovery scripts.
    for (const includePublicKey of [true, false]) {
      const makeUnlock = (s: Uint8Array) => concat(encodeDataPush(s), ...(includePublicKey ? [encodeDataPush(owner)] : []), ...(selector === undefined ? [] : [Uint8Array.of(selector)]), encodeDataPush(redeemScript));
      // Schnorr signatures have a fixed length. Budget one satoshi per
      // serialized byte for this synthetic recovery before signing it.
      transaction.inputs[0].unlockingBytecode = makeUnlock(new Uint8Array(65));
      const recovery = transaction.outputs[0];
      recovery.valueSatoshis = source.valueSatoshis;
      recovery.valueSatoshis = source.valueSatoshis - BigInt(encodeTransaction(transaction).length);
      if (recovery.valueSatoshis < getDustThreshold(recovery)) continue;
      const serialization = generateSigningSerializationBCH(
        { inputIndex: 0, sourceOutputs: [source], transaction },
        { coveredBytecode: redeemScript, signingSerializationType: Uint8Array.of(0x61) },
      );
      const signature = this.withPrivateKey('receive', 0, key => secp256k1.signMessageHashSchnorr(key, sha256.hash(sha256.hash(serialization))));
      if (typeof signature === "string") throw new Error(signature);
      const sig = Uint8Array.from([...signature, 0x61]);
      transaction.inputs[0].unlockingBytecode = makeUnlock(sig);
      if (vm.verify({ transaction, sourceOutputs: [source] }) !== true) continue;
      // A signature-independent branch is not proof of wallet-controlled recovery.
      const invalid = sig.slice(); invalid[0] ^= 1;
      transaction.inputs[0].unlockingBytecode = makeUnlock(invalid);
      if (vm.verify({ transaction, sourceOutputs: [source] }) !== true) return true;
    }
    return false;
  }
  lock(): void {
    if (this.keys) for (const branch of Object.values(this.keys)) { branch.privateKey.fill(0); branch.chainCode.fill(0); }
    this.keys = null;
    this.publicBranches = null;
    this.addresses = null;
  }
}
export const bchWalletService = new BchWalletService();
