/**
 * @cashingularity/contracts-xo - Application-Level JSON-RPC & Sidecar Bridge for XO Engine
 * BCH BLAZE 2026
 *
 * Security & Architectural Rules Enforced:
 * 1. Strictly 1 open Engine singleton per process.
 * 2. Always passes `network: XO_SUPPORTED_NETWORKS.chipnet` explicitly on Engine.create.
 * 3. `addChangeToInvitation` is executed strictly BEFORE `signInvitation`.
 * 4. `serializeInvitation` / `deserializeInvitation` operate ONLY on `storedInvitation.invitation`
 *    and never sort or mutate commit JSON key order.
 * 5. Never exposes mnemonics, seeds, or `listSecretData` / `listSecretsForScriptHash` to callers or AI.
 * 6. Requires an explicit human consent token before `signInvitation` and `executeAction`.
 */

import {
  binToHex,
  CashAddressType,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  encodeCashAddress,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import {
  DUST_LIMIT_SATOSHIS,
  Engine,
  getTemplateLockingScriptOrThrow,
  listInvitationValidationIssues,
  XO_SUPPORTED_NETWORKS,
  type XONetwork,
} from '@xo-cash/engine';
import { StorageType } from '@xo-cash/state';
import type {
  XOInvitation,
  XOInvitationIdentifier,
  XOTemplateActionIntent,
  XOTemplateIdentifier,
} from '@xo-cash/types';
import {
  deserializeInvitation,
  serializeInvitation,
} from '@xo-cash/utils';
import { randomBytes } from 'node:crypto';
import {
  ALLOWED_TEMPLATE_IDENTIFIERS,
  CASHINGULARITY_PREDICTION_TEMPLATE_ID,
  cashingularityPredictionTemplate,
  P2PKH_TEMPLATE_ID,
  VALIDATED_P2PKH_TEMPLATE,
  verifyAllowedTemplateHash,
} from './templates.js';

export interface PendingDraftPlan {
  draftId: XOInvitationIdentifier;
  network: XONetwork;
  templateIdentifier: XOTemplateIdentifier;
  actionIdentifier: string;
  recipientCashAddress: string;
  recipientLockingBytecodeHex: string;
  amountSatoshis: bigint;
  feeEstimateSatoshis: bigint;
  changeSatoshis: bigint;
  changeAdded: boolean;
  humanConsentToken: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface XoBridgeRpcRequest {
  id: string | number;
  method:
    | 'wallet.openChipnetAccount'
    | 'wallet.closeAccount'
    | 'wallet.getNetworkStatus'
    | 'wallet.getReceiveAddress'
    | 'wallet.listUtxos'
    | 'wallet.listTemplates'
    | 'wallet.listActionsForOutput'
    | 'wallet.createDraftPayment'
    | 'wallet.previewPayment'
    | 'wallet.authorizeAndBroadcast'
    | 'wallet.cancelDraft'
    | 'wallet.exportInvitation'
    | 'wallet.importInvitation';
  params?: Record<string, unknown>;
}

export interface XoBridgeRpcResponse<T = unknown> {
  id: string | number;
  result?: T;
  error?: {
    code: number;
    name: string;
    message: string;
  };
}

let chipnetHeaderGuardInstalled = false;
function installChipnetElectrumHeaderGuard(): void {
  if (chipnetHeaderGuardInstalled) return;
  chipnetHeaderGuardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('claims target') && msg.includes('expected')) {
      // Known @electrum-cash/application Chipnet 20-minute min-difficulty block header target warning
      return;
    }
  });
}

export function encodeLockingBytecodeToChipnetAddress(lockingBytecodeHex: string): string {
  const encoded = lockingBytecodeToCashAddress({
    bytecode: hexToBin(lockingBytecodeHex),
    prefix: 'bchtest',
  });
  if (typeof encoded === 'string') {
    throw new Error(`Failed to encode Chipnet CashAddr: ${encoded}`);
  }
  return encoded.address;
}

export function toTokenAwareChipnetCashAddress(cashAddress: string): string {
  const decoded = decodeCashAddress(cashAddress);
  if (typeof decoded === 'string') {
    return cashAddress;
  }
  const encoded = encodeCashAddress({
    prefix: 'bchtest',
    type:
      decoded.type === CashAddressType.p2sh || decoded.type === CashAddressType.p2shWithTokens
        ? CashAddressType.p2shWithTokens
        : CashAddressType.p2pkhWithTokens,
    payload: decoded.payload,
  });
  return typeof encoded === 'string' ? cashAddress : encoded.address;
}

export function decodeChipnetAddressToLockingBytecodeHex(cashAddress: string): string {
  const trimmed = cashAddress.trim();
  if (!trimmed.toLowerCase().startsWith('bchtest:')) {
    throw new Error(
      `Network prefix mismatch: expected 'bchtest:' address for Chipnet, got '${trimmed.slice(0, 16)}...'`
    );
  }
  const decoded = cashAddressToLockingBytecode(trimmed);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid Chipnet CashAddr: ${decoded}`);
  }
  return binToHex(decoded.bytecode);
}

/**
 * Singleton Sidecar Bridge managing a single `@xo-cash/engine` instance per process.
 */
export class XoBridgeService {
  private engine: Engine | null = null;
  private activeNetwork: XONetwork = XO_SUPPORTED_NETWORKS.chipnet;
  private p2pkhTemplateId: XOTemplateIdentifier = P2PKH_TEMPLATE_ID;
  private predictionTemplateId: XOTemplateIdentifier = CASHINGULARITY_PREDICTION_TEMPLATE_ID;
  private pendingDrafts = new Map<string, PendingDraftPlan>();

  /**
   * Returns true if the Engine singleton is currently initialized.
   */
  public isOpen(): boolean {
    return this.engine !== null;
  }

  private requireEngine(): Engine {
    if (!this.engine) {
      throw new Error('XO Engine account is not open. Call wallet.openChipnetAccount first.');
    }
    return this.engine;
  }

  /**
   * Privileged IPC method: Opens the single Chipnet XO account in this process,
   * imports audited `p2pkhTemplate` and `cashingularityPredictionTemplate`, and configures default policies.
   */
  public async openChipnetAccount(params: {
    mnemonic: string;
    databasePath?: string;
    databaseFilename?: string;
    storageType?: StorageType;
    allowReopen?: boolean;
  }): Promise<{
    network: XONetwork;
    p2pkhTemplateIdentifier: XOTemplateIdentifier;
    predictionTemplateIdentifier: XOTemplateIdentifier;
    defaultPoliciesSet: boolean;
    electrumConnections: ReturnType<Engine['listElectrumConnections']>;
  }> {
    installChipnetElectrumHeaderGuard();

    if (this.engine) {
      if (params.allowReopen) {
        await this.closeAccount();
      } else {
        throw new Error(
          'XO Engine singleton is already open in this process. Call wallet.closeAccount before opening another account.'
        );
      }
    }

    const words = params.mnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      throw new Error('Invalid BIP39 test mnemonic: expected 12 or 24 words.');
    }

    const engine = await Engine.create(params.mnemonic.trim(), {
      network: XO_SUPPORTED_NETWORKS.chipnet,
      storageType: params.storageType ?? StorageType.SQLITE,
      databasePath: params.databasePath ?? './.xo-data',
      databaseFilename: params.databaseFilename ?? 'XO',
    });

    this.engine = engine;
    this.activeNetwork = engine.network;

    // Import audited P2PKH template and Cashingularity Prediction Pool template
    const importedP2pkh = await engine.importTemplate(VALIDATED_P2PKH_TEMPLATE);
    const importedPrediction = await engine.importTemplate(cashingularityPredictionTemplate);

    this.p2pkhTemplateId = importedP2pkh.templateIdentifier;
    this.predictionTemplateId = importedPrediction.templateIdentifier;

    await engine.setDefaultPolicies({
      change: { templateIdentifier: importedP2pkh.templateIdentifier },
      receive: { templateIdentifier: importedP2pkh.templateIdentifier },
      address: { templateIdentifier: importedP2pkh.templateIdentifier },
    });

    return {
      network: engine.network,
      p2pkhTemplateIdentifier: this.p2pkhTemplateId,
      predictionTemplateIdentifier: this.predictionTemplateId,
      defaultPoliciesSet: true,
      electrumConnections: engine.listElectrumConnections(),
    };
  }

  /**
   * Stops the active Engine instance and releases SQLite & Electrum connections.
   */
  public async closeAccount(): Promise<{ closed: boolean }> {
    if (this.engine) {
      try {
        await this.engine.stop();
      } catch {
        // Ignore stop errors on closed sockets
      }
      this.engine = null;
      this.pendingDrafts.clear();
    }
    return { closed: true };
  }

  /**
   * Read-only network & Electrum connection status.
   */
  public async getNetworkStatus(): Promise<{
    network: XONetwork;
    chainStatus: Awaited<ReturnType<Engine['getChainStatus']>>;
    electrumConnections: ReturnType<Engine['listElectrumConnections']>;
  }> {
    const engine = this.requireEngine();
    const chainStatus = await engine.getChainStatus();
    const electrumConnections = engine.listElectrumConnections();
    return {
      network: engine.network,
      chainStatus,
      electrumConnections,
    };
  }

  /**
   * Derives a fresh Chipnet receive CashAddr from the wallet's default 'receive' policy.
   */
  public async getReceiveAddress(): Promise<{
    network: XONetwork;
    lockingBytecodeHex: string;
    cashAddress: string;
    tokenAwareAddress: string;
    templateIdentifier: XOTemplateIdentifier;
  }> {
    const engine = this.requireEngine();
    const lockingBytecodeHex = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
    const cashAddress = encodeLockingBytecodeToChipnetAddress(lockingBytecodeHex);
    const tokenAwareAddress = toTokenAwareChipnetCashAddress(cashAddress);
    return {
      network: engine.network,
      lockingBytecodeHex,
      cashAddress,
      tokenAwareAddress,
      templateIdentifier: this.p2pkhTemplateId,
    };
  }

  /**
   * Lists tracked and spendable UTXOs with satoshis encoded as decimal strings for safe IPC transport.
   */
  public async listUtxos(): Promise<{
    allUnspent: Array<{
      outpointTransactionHash: string;
      outpointIndex: number;
      valueSatoshis: string;
      status: string;
      selectable: boolean;
      reservedBy?: string;
      scriptHash: string;
      templateIdentifier: string;
      tokenCategory?: string;
      tokenAmount?: string;
      tokenNftCapability?: string;
      tokenNftCommitment?: string;
    }>;
    spendableUnspent: Array<{
      outpointTransactionHash: string;
      outpointIndex: number;
      valueSatoshis: string;
      scriptHash: string;
      templateIdentifier: string;
    }>;
  }> {
    const engine = this.requireEngine();
    const all = await engine.listUnspentOutputs();
    const spendable = await engine.listSpendableUnspentOutputs();

    return {
      allUnspent: all.map((u) => ({
        outpointTransactionHash: u.outpointTransactionHash,
        outpointIndex: u.outpointIndex,
        valueSatoshis: BigInt(u.valueSatoshis).toString(),
        status: u.status,
        selectable: u.selectable,
        reservedBy: u.reservedBy,
        scriptHash: u.scriptHash,
        templateIdentifier: u.templateIdentifier,
        tokenCategory: u.tokenCategory,
        tokenAmount: u.tokenAmount,
        tokenNftCapability: u.tokenNftCapability,
        tokenNftCommitment: u.tokenNftCommitment,
      })),
      spendableUnspent: spendable.map((u) => ({
        outpointTransactionHash: u.outpointTransactionHash,
        outpointIndex: u.outpointIndex,
        valueSatoshis: BigInt(u.valueSatoshis).toString(),
        scriptHash: u.scriptHash,
        templateIdentifier: u.templateIdentifier,
      })),
    };
  }

  /**
   * Lists imported templates and verifies each against the audited allowlist.
   */
  public async listTemplates(): Promise<
    Array<{
      templateIdentifier: string;
      name: string;
      version: string;
      isAllowlisted: boolean;
    }>
  > {
    const engine = this.requireEngine();
    const storedTemplates = await engine.listTemplates();
    return storedTemplates.map((st) => {
      const check = verifyAllowedTemplateHash(st.template);
      return {
        templateIdentifier: check.templateIdentifier,
        name: st.template.name,
        version: st.template.version ?? '1',
        isAllowlisted: check.allowed,
      };
    });
  }

  /**
   * Resolves follow-up actions available for a tracked UTXO scriptHash
   * (e.g. `sendSatoshis`, `claimRoundPayout`, `reclaimExpiredStake`).
   */
  public async listActionsForOutput(scriptHash: string): Promise<{
    scriptHash: string;
    templateIdentifier: string;
    lockingScriptIdentifier: string;
    roleIdentifier?: string;
    actions: XOTemplateActionIntent[];
  }> {
    const engine = this.requireEngine();
    const [outputScript] = await engine.listScriptHashData({ scriptHash });
    if (!outputScript) {
      throw new Error(`No tracked ScriptHashData found for scriptHash: ${scriptHash}`);
    }

    const outputTemplate = await engine.getTemplate(outputScript.templateIdentifier);
    if (!outputTemplate) {
      throw new Error(`Template ${outputScript.templateIdentifier} not found in store`);
    }

    const lockingScript = getTemplateLockingScriptOrThrow(
      outputTemplate,
      outputScript.lockingScriptIdentifier
    );

    const roleActions =
      outputScript.roleIdentifier === undefined
        ? []
        : lockingScript.roles?.[outputScript.roleIdentifier]?.actions ?? [];

    const actions: XOTemplateActionIntent[] = [
      ...(lockingScript.actions ?? []),
      ...roleActions,
    ];

    return {
      scriptHash,
      templateIdentifier: outputScript.templateIdentifier,
      lockingScriptIdentifier: outputScript.lockingScriptIdentifier,
      roleIdentifier: outputScript.roleIdentifier,
      actions,
    };
  }

  /**
   * Creates an unsigned payment Invitation (`sendSatoshis`) and appends `transferSatoshisOutput`
   * WITHOUT signing or broadcasting.
   */
  public async createDraftPayment(params: {
    recipientCashAddress: string;
    amountSatoshis: string;
  }): Promise<{
    draftId: XOInvitationIdentifier;
    network: XONetwork;
    recipientCashAddress: string;
    amountSatoshis: string;
    selectedOutpoint: { txid: string; vout: number; valueSatoshis: string };
    missingRequirementsAfterAppend: Awaited<ReturnType<Engine['listMissingRequirements']>>;
  }> {
    const engine = this.requireEngine();
    if (!/^\d+$/.test(params.amountSatoshis)) {
      throw new Error(`amountSatoshis must be a positive decimal integer string, got: ${params.amountSatoshis}`);
    }

    const amountBigInt = BigInt(params.amountSatoshis);
    if (amountBigInt < BigInt(DUST_LIMIT_SATOSHIS)) {
      throw new Error(
        `Transfer amount (${amountBigInt.toString()} sats) is below dust limit (${DUST_LIMIT_SATOSHIS} sats).`
      );
    }

    const recipientLockingBytecodeHex = decodeChipnetAddressToLockingBytecodeHex(
      params.recipientCashAddress
    );

    const spendable = await engine.listSpendableUnspentOutputs();
    const fundedOutput = spendable.find(
      (u) => BigInt(u.valueSatoshis) > amountBigInt + 400n && !u.tokenCategory
    );
    if (!fundedOutput) {
      throw new Error(
        `Insufficient spendable Chipnet UTXOs for ${amountBigInt.toString()} sats + fee.`
      );
    }

    const template = await engine.getTemplate(this.p2pkhTemplateId);
    if (!template) {
      throw new Error('P2PKH template is not loaded in Engine.');
    }

    const lockingScript = getTemplateLockingScriptOrThrow(template, 'receivingLockingScript');
    const receiverIntents = lockingScript.roles?.receiver?.actions ?? [];
    const sendIntent = receiverIntents.find((intent) => intent.action === 'sendSatoshis');
    if (!sendIntent) {
      throw new Error('sendSatoshis intent not found on receivingLockingScript.');
    }

    const createdInvitation = await engine.createInvitation({
      templateIdentifier: this.p2pkhTemplateId,
      actionIdentifier: 'sendSatoshis',
      intent: sendIntent,
      variables: [
        {
          variableIdentifier: 'transferredSatoshis',
          roleIdentifier: 'sender',
          value: amountBigInt,
        },
        {
          variableIdentifier: 'recipientLockingscript',
          roleIdentifier: 'sender',
          value: recipientLockingBytecodeHex,
        },
      ],
      inputs: [
        {
          outpointTransactionHash: hexToBin(fundedOutput.outpointTransactionHash),
          outpointIndex: fundedOutput.outpointIndex,
        },
      ],
    });

    const invitationIdentifier = createdInvitation.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
      templateIdentifier: this.p2pkhTemplateId,
      actionIdentifier: 'sendSatoshis',
      outputs: [{ outputIdentifier: 'transferSatoshisOutput' }],
    });

    const missingRequirementsAfterAppend = await engine.listMissingRequirements(invitationIdentifier);

    const nowMs = Date.now();
    this.pendingDrafts.set(invitationIdentifier, {
      draftId: invitationIdentifier,
      network: engine.network,
      templateIdentifier: this.p2pkhTemplateId,
      actionIdentifier: 'sendSatoshis',
      recipientCashAddress: params.recipientCashAddress,
      recipientLockingBytecodeHex,
      amountSatoshis: amountBigInt,
      feeEstimateSatoshis: 0n,
      changeSatoshis: 0n,
      changeAdded: false,
      humanConsentToken: '',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 300_000,
    });

    return {
      draftId: invitationIdentifier,
      network: engine.network,
      recipientCashAddress: params.recipientCashAddress,
      amountSatoshis: amountBigInt.toString(),
      selectedOutpoint: {
        txid: fundedOutput.outpointTransactionHash,
        vout: fundedOutput.outpointIndex,
        valueSatoshis: BigInt(fundedOutput.valueSatoshis).toString(),
      },
      missingRequirementsAfterAppend,
    };
  }

  /**
   * Calculates change & fee, appends change output (`addChangeToInvitation`) strictly BEFORE signing,
   * and issues a short-lived human consent token for explicit user confirmation.
   */
  public async previewPayment(params: {
    draftId: XOInvitationIdentifier;
  }): Promise<{
    draftId: XOInvitationIdentifier;
    network: XONetwork;
    recipientCashAddress: string;
    amountSatoshis: string;
    feeEstimateSatoshis: string;
    changeSatoshis: string;
    changeAdded: boolean;
    readyToSign: boolean;
    humanConsentToken: string;
  }> {
    const engine = this.requireEngine();
    const draft = this.pendingDrafts.get(params.draftId);
    if (!draft) {
      throw new Error(`Unknown draftId: ${params.draftId}`);
    }

    const leftover = await engine.calculateChange(params.draftId);
    const estimatedFee = await engine.estimateTransactionFee(params.draftId);
    const changeSatoshis = leftover.valueSatoshis - BigInt(estimatedFee);
    const shouldAddChange =
      changeSatoshis >= BigInt(DUST_LIMIT_SATOSHIS) || leftover.tokens.length > 0;

    if (shouldAddChange && !draft.changeAdded) {
      await engine.addChangeToInvitation(params.draftId);
      draft.changeAdded = true;
    }

    draft.feeEstimateSatoshis = BigInt(estimatedFee);
    draft.changeSatoshis = changeSatoshis > 0n ? changeSatoshis : 0n;
    draft.humanConsentToken = `consent-${randomBytes(16).toString('hex')}`;
    draft.expiresAtMs = Date.now() + 180_000;

    return {
      draftId: params.draftId,
      network: draft.network,
      recipientCashAddress: draft.recipientCashAddress,
      amountSatoshis: draft.amountSatoshis.toString(),
      feeEstimateSatoshis: draft.feeEstimateSatoshis.toString(),
      changeSatoshis: draft.changeSatoshis.toString(),
      changeAdded: draft.changeAdded,
      readyToSign: true,
      humanConsentToken: draft.humanConsentToken,
    };
  }

  /**
   * Requires explicit human consent token -> signs own inputs (`listOwnInputIndexes` + `signInvitation`)
   * -> builds local preview (`buildInvitationTransactionFromMergedCommit`) -> executes action (`executeAction`).
   */
  public async authorizeAndBroadcast(params: {
    draftId: XOInvitationIdentifier;
    humanConsentToken: string;
    approvedByUser: boolean;
    broadcastTransaction?: boolean;
  }): Promise<{
    draftId: XOInvitationIdentifier;
    transactionHash: string;
    serializedTransaction: string;
    transactionByteLength: number;
    estimatedFeeSatoshis: string;
    broadcasted: boolean;
  }> {
    const engine = this.requireEngine();
    if (!params.approvedByUser) {
      throw new Error('User approval rejected: signInvitation and executeAction aborted.');
    }

    const draft = this.pendingDrafts.get(params.draftId);
    if (!draft) {
      throw new Error(`Unknown or expired draftId: ${params.draftId}`);
    }
    if (!draft.humanConsentToken || draft.humanConsentToken !== params.humanConsentToken) {
      throw new Error('Invalid humanConsentToken: AI or unauthenticated caller cannot authorize signing.');
    }
    if (Date.now() > draft.expiresAtMs) {
      throw new Error('Human consent token has expired. Re-run wallet.previewPayment.');
    }

    const ownInputIndexes = await engine.listOwnInputIndexes(params.draftId);
    for (const inputIndex of ownInputIndexes) {
      await engine.signInvitation(params.draftId, inputIndex);
    }

    const preview = await engine.buildInvitationTransactionFromMergedCommit(params.draftId);
    const broadcastFlag = params.broadcastTransaction ?? true;

    const { builtTransaction } = await engine.executeAction(params.draftId, {
      broadcastTransaction: broadcastFlag,
    });

    this.pendingDrafts.delete(params.draftId);

    return {
      draftId: params.draftId,
      transactionHash: builtTransaction.transactionHash || preview.transactionHash,
      serializedTransaction: builtTransaction.serializedTransaction || preview.serializedTransaction,
      transactionByteLength: builtTransaction.transactionByteLength,
      estimatedFeeSatoshis: BigInt(builtTransaction.estimatedFeeSatoshis).toString(),
      broadcasted: broadcastFlag,
    };
  }

  /**
   * Cancels an unbroadcast draft and releases its local UTXO reservations via `archiveInvitation`.
   */
  public async cancelDraft(draftId: XOInvitationIdentifier): Promise<{ cancelled: boolean }> {
    const engine = this.requireEngine();
    await engine.archiveInvitation(draftId);
    this.pendingDrafts.delete(draftId);
    return { cancelled: true };
  }

  /**
   * Exports ONLY the shareable `storedInvitation.invitation` using `@xo-cash/utils` `serializeInvitation()`
   * without sorting or mutating JSON key ordering.
   */
  public async exportInvitation(invitationIdentifier: XOInvitationIdentifier): Promise<{
    invitationIdentifier: XOInvitationIdentifier;
    serializedInvitation: string;
  }> {
    const engine = this.requireEngine();
    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) {
      throw new Error(`Invitation ${invitationIdentifier} not found in store.`);
    }

    const serializedInvitation = serializeInvitation(stored.invitation);
    return {
      invitationIdentifier,
      serializedInvitation,
    };
  }

  /**
   * Deserializes an incoming invitation wire payload via `deserializeInvitation()`, validates template allowlist
   * and content issues, and calls `updateInvitation` (if already stored) or `acceptInvitation` (if new).
   */
  public async importInvitation(params: {
    serializedInvitation: string;
    roleIdentifier?: string;
  }): Promise<{
    invitationIdentifier: XOInvitationIdentifier;
    templateIdentifier: XOTemplateIdentifier;
    actionIdentifier: string;
    mode: 'accepted' | 'updated';
    availableRoles: string[];
  }> {
    const engine = this.requireEngine();
    const incoming: XOInvitation = deserializeInvitation(params.serializedInvitation);

    const isAllowed = Object.values(ALLOWED_TEMPLATE_IDENTIFIERS).includes(
      incoming.templateIdentifier
    );
    if (!isAllowed) {
      throw new Error(
        `Untrusted templateIdentifier ${incoming.templateIdentifier} is not in ALLOWED_TEMPLATE_IDENTIFIERS.`
      );
    }

    const template = await engine.getTemplate(incoming.templateIdentifier);
    if (!template) {
      throw new Error(`Template ${incoming.templateIdentifier} is not loaded in store.`);
    }

    const issues = listInvitationValidationIssues(incoming, template, this.activeNetwork);
    if (issues.length > 0) {
      throw new Error(
        `Invitation validation failed: ${issues.map((e) => e.message).join('; ')}`
      );
    }

    const existing = await engine.getInvitation(incoming.invitationIdentifier);
    let stored;
    let mode: 'accepted' | 'updated';

    if (existing) {
      stored = await engine.updateInvitation(incoming);
      mode = 'updated';
    } else {
      stored = await engine.acceptInvitation(
        incoming,
        params.roleIdentifier ? { roleIdentifier: params.roleIdentifier } : undefined
      );
      mode = 'accepted';
    }

    const availableRoles = await engine.listAvailableRoles(stored.invitation);

    return {
      invitationIdentifier: stored.invitation.invitationIdentifier,
      templateIdentifier: stored.invitation.templateIdentifier,
      actionIdentifier: stored.invitation.actionIdentifier,
      mode,
      availableRoles,
    };
  }

  /**
   * Dispatches application-level JSON-RPC requests without leaking raw Engine or secret data.
   */
  public async handleJsonRpcRequest(
    request: XoBridgeRpcRequest
  ): Promise<XoBridgeRpcResponse> {
    try {
      const p = request.params ?? {};
      switch (request.method) {
        case 'wallet.openChipnetAccount':
          return {
            id: request.id,
            result: await this.openChipnetAccount({
              mnemonic: String(p.mnemonic ?? ''),
              databasePath: p.databasePath ? String(p.databasePath) : undefined,
              databaseFilename: p.databaseFilename ? String(p.databaseFilename) : undefined,
            }),
          };
        case 'wallet.closeAccount':
          return { id: request.id, result: await this.closeAccount() };
        case 'wallet.getNetworkStatus':
          return { id: request.id, result: await this.getNetworkStatus() };
        case 'wallet.getReceiveAddress':
          return { id: request.id, result: await this.getReceiveAddress() };
        case 'wallet.listUtxos':
          return { id: request.id, result: await this.listUtxos() };
        case 'wallet.listTemplates':
          return { id: request.id, result: await this.listTemplates() };
        case 'wallet.listActionsForOutput':
          return {
            id: request.id,
            result: await this.listActionsForOutput(String(p.scriptHash ?? '')),
          };
        case 'wallet.createDraftPayment':
          return {
            id: request.id,
            result: await this.createDraftPayment({
              recipientCashAddress: String(p.recipientCashAddress ?? ''),
              amountSatoshis: String(p.amountSatoshis ?? ''),
            }),
          };
        case 'wallet.previewPayment':
          return {
            id: request.id,
            result: await this.previewPayment({
              draftId: String(p.draftId ?? ''),
            }),
          };
        case 'wallet.authorizeAndBroadcast':
          return {
            id: request.id,
            result: await this.authorizeAndBroadcast({
              draftId: String(p.draftId ?? ''),
              humanConsentToken: String(p.humanConsentToken ?? ''),
              approvedByUser: Boolean(p.approvedByUser),
              broadcastTransaction:
                p.broadcastTransaction !== undefined ? Boolean(p.broadcastTransaction) : true,
            }),
          };
        case 'wallet.cancelDraft':
          return {
            id: request.id,
            result: await this.cancelDraft(String(p.draftId ?? '')),
          };
        case 'wallet.exportInvitation':
          return {
            id: request.id,
            result: await this.exportInvitation(String(p.invitationIdentifier ?? '')),
          };
        case 'wallet.importInvitation':
          return {
            id: request.id,
            result: await this.importInvitation({
              serializedInvitation: String(p.serializedInvitation ?? ''),
              roleIdentifier: p.roleIdentifier ? String(p.roleIdentifier) : undefined,
            }),
          };
        default:
          return {
            id: request.id,
            error: {
              code: -32601,
              name: 'MethodNotFound',
              message: `Unsupported XO Bridge RPC method: ${String(request.method)}`,
            },
          };
      }
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      return {
        id: request.id,
        error: {
          code: -32000,
          name: errorObj.name || 'XoBridgeError',
          message: errorObj.message,
        },
      };
    }
  }
}

export const xoBridgeSingleton = new XoBridgeService();
