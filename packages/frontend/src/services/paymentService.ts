import {
  binToHex,
  cashAddressToLockingBytecode,
  hexToBin,
  encodeTransaction,
  encodeTransactionOutputs,
  sha256,
  hash160,
  decodeAuthenticationInstructions,
  authenticationInstructionsAreMalformed,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import {
  type AiExecutionMode,
  type CashTokenData,
  type PreparedContractTransactionTemplate,
  type PreparedContractType,
  type UtxoDagInspection,
  type WalletUtxo,
  validateAndConvertCashAddr,
} from "@cashingularity/shared";
import type { ConnectedWalletProfile } from "./walletRuntime.js";
import { bchWalletService, type BchWalletService } from "./bchWalletService.js";
import { tokenBchFunding } from './walletAssets.js';
import { outputToken, tokensEqual } from './tokenPayment.js';

export const PREDICTION_SETTLEMENT_REQUIRED =
  'This ticket supports owner recovery only. Live prediction staking requires an independently verified settlement contract.';

export interface PreparedPayment {
  assetTransfer?: { categoryId: string; symbol: string; amount: string };
  transaction: Transaction;
  sourceOutputs: Output[];
  inputs: WalletUtxo[];
  dag: UtxoDagInspection;
  network: "mainnet" | "chipnet";
  profileId?: string;
  receiveAddress: string;
  receiptPriceUsd?: number;
  contractType?: PreparedContractType;
  covenantTemplate?: CovenantTemplate;
  covenantProof?: CovenantProof;
  quote?: {
    id: string;
    expiresAtMs: number;
    source: string;
    freshnessVerified?: boolean;
    rows: Array<{ amount: string; currency: string; satoshis: string }>;
  };
}
export interface PaymentRecipient {
  address: string;
  satoshis: bigint;
}
const scriptFor = (address: string, network: "mainnet" | "chipnet") => {
  const validation = validateAndConvertCashAddr(address);
  if (!validation.valid || validation.network !== network)
    throw new Error(`Invalid ${network} recipient address: ${address}`);
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === "string") throw new Error(decoded);
  return decoded.bytecode;
};

const tokenDetails = (token: NonNullable<Output['token']>): CashTokenData => ({
  categoryId: binToHex(token.category), amount: token.amount,
  ...(token.nft ? { nft: { ...token.nft, commitment: binToHex(token.nft.commitment) } } : {}),
});

/** The review describes the exact transaction that may be signed. */
export function assertPaymentMatchesReview(payment: PreparedPayment, profile: ConnectedWalletProfile): void {
  const { transaction, inputs, sourceOutputs, dag } = payment;
  if (!inputs.length || inputs.length !== transaction.inputs.length || inputs.length !== sourceOutputs.length ||
      inputs.length !== dag.inputs.length || transaction.outputs.length !== dag.outputs.length) {
    throw new Error('The prepared transaction differs from the review.');
  }
  const unique = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const outpoint = `${input.txid}:${input.vout}`;
    if (unique.has(outpoint)) throw new Error('The reviewed payment contains a duplicate input.');
    unique.add(outpoint);
    const reviewed = dag.inputs[index];
    if (reviewed.inputIndex !== index || reviewed.txid !== input.txid || reviewed.vout !== input.vout ||
        reviewed.address !== input.address || reviewed.satoshis !== input.satoshis || !tokensEqual(reviewed.token, input.token)) {
      throw new Error('A prepared input differs from the review.');
    }
  }
  for (const [index, output] of transaction.outputs.entries()) {
    const reviewed = dag.outputs[index];
    const locking = binToHex(output.lockingBytecode);
    const address = validateAndConvertCashAddr(reviewed.address);
    const displayed = address.valid && address.network === payment.network ? cashAddressToLockingBytecode(reviewed.address) : undefined;
    if (reviewed.index !== index || reviewed.satoshis !== output.valueSatoshis || reviewed.lockingBytecodeHex !== locking ||
        !displayed || typeof displayed === 'string' || binToHex(displayed.bytecode) !== locking ||
        !tokensEqual(reviewed.token, output.token && tokenDetails(output.token)) ||
        (reviewed.isChange && address.standardAddress !== profile.changeAddress)) {
      throw new Error('The prepared transaction differs from a reviewed output. Review the payment again.');
    }
  }
  const fee = sourceOutputs.reduce((sum, source) => sum + source.valueSatoshis, 0n) -
    transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (fee < 0n || fee !== dag.audit.minerFeeSats) throw new Error('The prepared network fee differs from the review.');
}

/** Prefer native BCH, preserving CashTokens in change if their excess BCH is needed. */
export function preparePayment(
  profile: ConnectedWalletProfile,
  recipients: PaymentRecipient[],
  analysisMode: AiExecutionMode,
): PreparedPayment {
  if (
    !profile.isConnected ||
    profile.utxoSource === "sandbox" ||
    profile.utxoSource === "unavailable" ||
    profile.utxoSource === "syncing"
  )
    throw new Error(
      "On-chain balance is unavailable. Refresh the wallet before preparing a payment.",
    );
  if (profile.connectionType === "WATCH_ONLY")
    throw new Error(
      "This is a watch-only profile. Connect a signing wallet to send BCH.",
    );
  if (profile.connectionType === 'WIZARD_CONNECT' && !profile.externalSigningReady) throw new Error('Reconnect the external wallet before sending.');
  if (!recipients.length || recipients.length > 100)
    throw new Error("Enter between 1 and 100 recipients.");
  const outputs: Output[] = recipients.map((r) => {
    if (r.satoshis < 546n)
      throw new Error("Each payment must be at least 546 sats.");
    return {
      valueSatoshis: r.satoshis,
      lockingBytecode: scriptFor(r.address, profile.network),
    };
  });
  const changeScript = scriptFor(profile.changeAddress, profile.network);
  const amount = outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  const candidates = profile.utxos
    .filter(
      (u) =>
        !u.token &&
        (u.derivationScope === "receive" || u.derivationScope === "change"),
    )
    .sort((a, b) =>
      a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0,
    );
  const inputs: WalletUtxo[] = [];
  const estimateFee = (count: number, changeOutputs: Output[] = []) => BigInt(2 * (
    9 + 141 * count + encodeTransactionOutputs([...outputs, ...changeOutputs, { lockingBytecode: changeScript, valueSatoshis: 0n }]).length
  ));
  let total = 0n;
  let reserved = 0n;
  let estimatedFee = estimateFee(0);
  for (const utxo of candidates) {
    if (inputs.length >= 200)
      throw new Error(
        "This payment needs too many inputs. Send a smaller amount.",
      );
    inputs.push(utxo);
    total += utxo.satoshis;
    estimatedFee = estimateFee(inputs.length);
    if (total >= amount + estimatedFee) break;
  }
  if (total < amount + estimatedFee) {
    const groups = tokenBchFunding(profile.utxos.filter(u => u.derivationScope === 'receive' || u.derivationScope === 'change'), changeScript)
      .sort((a, b) => a.surplus > b.surplus ? -1 : a.surplus < b.surplus ? 1 : 0);
    for (const group of groups) {
      const count = inputs.length + group.inputs.length;
      if (count > 200) continue;
      const withGroupFee = estimateFee(count, group.outputs);
      if (group.surplus <= withGroupFee - estimatedFee) continue;
      inputs.push(...group.inputs);
      outputs.push(...group.outputs);
      total += group.satoshis;
      reserved += group.reserve;
      estimatedFee = withGroupFee;
      if (total >= amount + reserved + estimatedFee) break;
    }
  }
  if (total < amount + reserved + estimatedFee)
    throw new Error(
      "Insufficient on-chain balance after reserving CashToken change and network fees.",
    );
  const change = total - amount - reserved - estimatedFee;
  if (change >= 546n) outputs.push({ valueSatoshis: change, lockingBytecode: changeScript });
  const fee = total - outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  if (fee < 0n || fee > estimatedFee + 545n) {
    throw new Error(
      `Computed miner fee (${fee.toString()} sats) exceeds safe transaction ceiling (${(estimatedFee + 545n).toString()} sats).`
    );
  }
  const sourceOutputs = inputs.map((u) => ({
    valueSatoshis: u.satoshis,
    lockingBytecode: scriptFor(u.address, profile.network),
    ...(u.token ? { token: outputToken(u.token) } : {}),
  }));
  const transaction: Transaction = {
    version: 2,
    locktime: 0,
    inputs: inputs.map((u) => ({
      outpointTransactionHash: hexToBin(u.txid),
      outpointIndex: u.vout,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    })),
    outputs,
  };
  const dag: UtxoDagInspection = {
    txidPreview: "",
    inputs: inputs.map((u, i) => ({
      inputIndex: i,
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis,
      address: u.address,
      isGenesisInput: u.vout === 0,
      token: u.token,
      derivationPath: (u.derivationScope === 'change' ? profile.changeDerivationPath : profile.receiveDerivationPath).replace(/\/\d+$/, `/${u.addressIndex}`),
    })),
    outputs: outputs.map((o, i) => ({
      index: i,
      address:
        i < recipients.length ? recipients[i].address : o.token ? profile.changeTokenAddress : profile.changeAddress,
      scriptType:
        o.lockingBytecode.length === 25
          ? "P2PKH"
          : o.lockingBytecode.length === 35
            ? "P2SH32"
            : "UNKNOWN",
      lockingBytecodeHex: binToHex(o.lockingBytecode),
      satoshis: o.valueSatoshis,
      isChange: i >= recipients.length,
      ...(o.token ? { token: tokenDetails(o.token) } : {}),
    })),
    audit: {
      disassembledOpcodes: [],
      minerFeeSats: fee,
      feeRateSatsPerByte: Number(
        (
          Number(fee) /
          (encodeTransaction(transaction).length + inputs.length * 100)
        ).toFixed(2),
      ),
      dustPassed: true,
      bcmrVerified: false,
      addressReuseDetected: false,
      aiVerdict: "CAUTION",
      aiExplanation:
        "Review the recipients, amount, and network fee. Any CashTokens used for BCH funding are returned in change.",
      analysisMode,
    },
  };
  return {
    transaction,
    sourceOutputs,
    inputs,
    dag,
    network: profile.network,
    profileId: profile.profileId,
    receiveAddress: profile.receiveAddress,
  };
}

/** A complete transaction candidate, including the fields that must be shown during review. */
export interface CovenantTemplate {
  transaction: Transaction;
  sourceOutputs: Output[];
  walletInputs: Array<{ inputIndex: number; scope: "receive" | "change"; addressIndex: number }>;
  reviewedVersion: number;
  reviewedLocktime: number;
  reviewedSequences: number[];
}

export interface CovenantProof {
  redeemScriptHex: string;
  scriptHash32Hex: string;
  lockingBytecodeHex: string;
  spendPathSelectorOpcode?: number;
}

/**
 * Verify one specific output and a locally simulated recovery. This is not proof
 * of market, vault or reward semantics; callers must verify those independently.
 */
export function verifyCovenantProof(
  proof: CovenantProof,
  outputIndex: number,
  transaction: Transaction,
  dag: UtxoDagInspection,
  wallet: ConnectedWalletProfile,
  signer: BchWalletService,
): void {
  const scriptHex = proof?.redeemScriptHex;
  if (typeof scriptHex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(scriptHex)) throw new Error("Missing or invalid covenant redeem script.");
  const redeemScript = hexToBin(scriptHex);
  const instructions = decodeAuthenticationInstructions(redeemScript);
  if (authenticationInstructionsAreMalformed(instructions)) throw new Error("Malformed covenant redeem script.");
  const publicKey = signer.getReceivePublicKey();
  if (signer.getAddresses()?.receiveAddress !== wallet.receiveAddress || signer.getAddresses()?.network !== wallet.network) throw new Error("The active local signing key does not match the wallet.");
  const identity = [binToHex(publicKey), binToHex(hash160(publicKey))];
  if (!instructions.some(instruction => "data" in instruction && identity.includes(binToHex(instruction.data)))) throw new Error("Covenant does not contain the active wallet public key or public key hash.");
  const hash = binToHex(sha256.hash(sha256.hash(redeemScript)));
  const locking = `aa20${hash}87`;
  const output = transaction.outputs[outputIndex], preview = dag.outputs[outputIndex];
  if (!output || !preview || preview.index !== outputIndex || preview.scriptType !== "P2SH32" || proof.scriptHash32Hex?.toLowerCase() !== hash || proof.lockingBytecodeHex?.toLowerCase() !== locking || binToHex(output.lockingBytecode) !== locking || preview.lockingBytecodeHex.toLowerCase() !== locking || preview.satoshis !== output.valueSatoshis) throw new Error("Covenant proof does not match the reviewed output.");
  const address = validateAndConvertCashAddr(preview.address);
  const addressScript = cashAddressToLockingBytecode(preview.address);
  if (!address.valid || address.network !== wallet.network || typeof addressScript === "string" || binToHex(addressScript.bytecode) !== locking) throw new Error("Covenant address does not match the reviewed output.");
  assertTokenMatches(preview.token, output.token, `Output ${outputIndex}`);
  if (!signer.verifyCovenantRecovery(redeemScript, output, proof.spendPathSelectorOpcode)) throw new Error("Covenant recovery could not be verified with this wallet in CashVM.");
}

function assertTokenMatches(expected: CashTokenData | undefined, actual: Output["token"], where: string): void {
  if (!expected || !actual) {
    if (expected !== undefined || actual !== undefined) throw new Error(`${where}: token presence differs from preview.`);
    return;
  }
  if (!/^[0-9a-f]{64}$/i.test(expected.categoryId) || binToHex(actual.category).toLowerCase() !== expected.categoryId.toLowerCase() || actual.amount !== expected.amount) throw new Error(`${where}: token category or amount differs from preview.`);
  if (actual.amount < 0n || actual.amount > 9_223_372_036_854_775_807n) throw new Error(`${where}: invalid token amount.`);
  if (Boolean(expected.nft) !== Boolean(actual.nft)) throw new Error(`${where}: NFT presence differs from preview.`);
  if (expected.nft && actual.nft && (actual.nft.capability !== expected.nft.capability || !/^(?:[0-9a-f]{2})*$/i.test(expected.nft.commitment) || binToHex(actual.nft.commitment).toLowerCase() !== expected.nft.commitment.toLowerCase())) throw new Error(`${where}: NFT capability or commitment differs from preview.`);
  if (actual.nft && (!['none', 'mutable', 'minting'].includes(actual.nft.capability) || actual.nft.commitment.length > 40)) throw new Error(`${where}: invalid NFT capability or commitment.`);
}

/**
 * Compare a candidate to the exact reviewed DAG before signing. The caller must
 * supply a freshly refreshed wallet profile and explicitly reviewed transaction
 * version, locktime, and sequence numbers. This does not attest that a covenant
 * address corresponds to a trusted contract; callers must establish that separately.
 */
export function assertCovenantMatchesPreview(
  template: CovenantTemplate,
  dag: UtxoDagInspection,
  wallet: ConnectedWalletProfile,
  options?: { verifiedOutputCovenant?: boolean },
): void {
  const { transaction, sourceOutputs, walletInputs } = template;
  if (!wallet.isConnected || wallet.connectionType !== "BUILTIN_HD_XO" || !wallet.utxoSource || ["sandbox", "syncing", "unavailable"].includes(wallet.utxoSource)) throw new Error("A refreshed local signing wallet is required.");
  if (transaction.version !== template.reviewedVersion || transaction.locktime !== template.reviewedLocktime || template.reviewedSequences.length !== transaction.inputs.length || transaction.inputs.some((input, i) => input.sequenceNumber !== template.reviewedSequences[i])) throw new Error("Transaction version, locktime, or sequence differs from review.");
  if (transaction.inputs.length !== dag.inputs.length || transaction.inputs.length !== sourceOutputs.length || transaction.outputs.length !== dag.outputs.length || !transaction.inputs.length) throw new Error("Transaction input or output count differs from preview.");
  const walletByIndex = new Map<number, (typeof walletInputs)[number]>();
  for (const item of walletInputs) {
    if (!Number.isInteger(item.inputIndex) || item.inputIndex < 0 || item.inputIndex >= transaction.inputs.length || item.addressIndex !== 0 || (item.scope !== "receive" && item.scope !== "change") || walletByIndex.has(item.inputIndex)) throw new Error("Invalid wallet input selection.");
    walletByIndex.set(item.inputIndex, item);
  }
  if (!walletByIndex.size) throw new Error("No wallet funding inputs were identified.");
  if (!options?.verifiedOutputCovenant && walletByIndex.size === transaction.inputs.length) throw new Error("No covenant input is present. A P2SH output alone does not verify the intended contract.");
  const outpoints = new Set<string>();
  for (let i = 0; i < transaction.inputs.length; i++) {
    const input = transaction.inputs[i], preview = dag.inputs[i], source = sourceOutputs[i];
    if (preview.inputIndex !== i || !/^[0-9a-f]{64}$/i.test(preview.txid) || binToHex(input.outpointTransactionHash).toLowerCase() !== preview.txid.toLowerCase() || input.outpointIndex !== preview.vout) throw new Error(`Input ${i}: outpoint differs from preview.`);
    const outpoint = `${preview.txid.toLowerCase()}:${preview.vout}`; if (outpoints.has(outpoint)) throw new Error("Duplicate transaction input."); outpoints.add(outpoint);
    const address = validateAndConvertCashAddr(preview.address);
    const script = cashAddressToLockingBytecode(preview.address);
    if (!address.valid || address.network !== wallet.network || typeof script === "string" || binToHex(source.lockingBytecode) !== binToHex(script.bytecode) || source.valueSatoshis !== preview.satoshis) throw new Error(`Input ${i}: source output differs from preview.`);
    assertTokenMatches(preview.token, source.token, `Input ${i}`);
    const own = walletByIndex.get(i);
    if (own) {
      if (input.unlockingBytecode.length || source.token) throw new Error(`Input ${i}: wallet funding must be unsigned and token-free.`);
      const live = wallet.utxos.find(u => u.txid.toLowerCase() === preview.txid.toLowerCase() && u.vout === preview.vout);
      const expectedAddress = own.scope === "receive" ? wallet.receiveAddress : wallet.changeAddress;
      if (!live || live.token || live.satoshis !== source.valueSatoshis || live.address !== expectedAddress || live.derivationScope !== own.scope || live.addressIndex !== own.addressIndex || preview.address !== expectedAddress) throw new Error(`Input ${i}: wallet UTXO is not in the refreshed wallet.`);
    } else {
      if (!preview.unlockingBytecodeHex || !/^(?:[0-9a-f]{2})+$/i.test(preview.unlockingBytecodeHex) || binToHex(input.unlockingBytecode).toLowerCase() !== preview.unlockingBytecodeHex.toLowerCase()) throw new Error(`Input ${i}: reviewed covenant unlocking bytecode is missing or differs.`);
      if (source.lockingBytecode.length !== 35 || source.lockingBytecode[0] !== 0xaa || source.lockingBytecode[1] !== 0x20 || source.lockingBytecode[34] !== 0x87) throw new Error(`Input ${i}: unsupported non-wallet source output.`);
    }
  }
  for (let i = 0; i < transaction.outputs.length; i++) {
    const output = transaction.outputs[i], preview = dag.outputs[i];
    if (preview.index !== i || !/^(?:[0-9a-f]{2})+$/i.test(preview.lockingBytecodeHex) || binToHex(output.lockingBytecode).toLowerCase() !== preview.lockingBytecodeHex.toLowerCase() || output.valueSatoshis !== preview.satoshis) throw new Error(`Output ${i}: locking bytecode or amount differs from preview.`);
    assertTokenMatches(preview.token, output.token, `Output ${i}`);
    const scriptHex = binToHex(output.lockingBytecode);
    const matchesType = preview.scriptType === "P2SH32" ? /^aa20[0-9a-f]{64}87$/.test(scriptHex) : preview.scriptType === "P2PKH" ? /^76a914[0-9a-f]{40}88ac$/.test(scriptHex) : preview.scriptType === "OP_RETURN" ? /^(?:6a|006a)/.test(scriptHex) : false;
    if (!matchesType) throw new Error(`Output ${i}: script type differs from preview or is unsupported.`);
    if (preview.scriptType !== "OP_RETURN") {
      const address = validateAndConvertCashAddr(preview.address), script = cashAddressToLockingBytecode(preview.address);
      if (!address.valid || address.network !== wallet.network || typeof script === "string" || binToHex(script.bytecode) !== binToHex(output.lockingBytecode)) throw new Error(`Output ${i}: address does not match locking bytecode.`);
    }
    if (preview.isChange && preview.address !== wallet.receiveAddress && preview.address !== wallet.changeAddress) throw new Error(`Output ${i}: change does not belong to the wallet.`);
  }
  const fee = sourceOutputs.reduce((sum, o) => sum + o.valueSatoshis, 0n) - transaction.outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  if (fee < 0n || fee !== dag.audit.minerFeeSats) throw new Error("Transaction fee differs from preview.");
}

/**
 * Materializes a `/api/contracts/prepare` transaction template into a verifiable `PreparedPayment`
 * whose unsigned `Transaction`, `sourceOutputs`, and `dag` match byte-for-byte before signing.
 */
export function materializePreparedContractPayment(
  template: PreparedContractTransactionTemplate,
  dag: UtxoDagInspection,
  wallet: ConnectedWalletProfile,
  signer: BchWalletService = bchWalletService,
): PreparedPayment {
  if (!wallet.isConnected || wallet.network !== template.network) {
    throw new Error(`Connect an active ${template.network} wallet before signing this contract.`);
  }
  if (wallet.connectionType !== "BUILTIN_HD_XO") {
    throw new Error("A local signing wallet is required to verify contract transactions.");
  }

  if (!Array.isArray(template.transaction.inputs) || !Array.isArray(template.transaction.outputs) || !Array.isArray(template.sourceOutputs) || template.sourceOutputs.length !== template.transaction.inputs.length) throw new Error("Incomplete contract transaction template.");
  const readHex = (value: string, label: string, bytes?: number): Uint8Array => {
    if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(value) || (bytes !== undefined && value.length !== bytes * 2)) throw new Error(`Invalid ${label}.`);
    return hexToBin(value);
  };
  const readAmount = (value: string, label: string): bigint => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Invalid ${label}.`);
    const amount = BigInt(value); if (amount > 9_223_372_036_854_775_807n) throw new Error(`Invalid ${label}.`); return amount;
  };
  type WireToken = NonNullable<(typeof template.transaction.outputs)[number]["token"]>;
  const readToken = (token: WireToken | undefined): Output["token"] => token ? {
    category: readHex(token.categoryId, "token category", 32),
    amount: readAmount(token.amount, "token amount"),
    ...(token.nft ? { nft: { capability: token.nft.capability, commitment: readHex(token.nft.commitment, "NFT commitment") } } : {}),
  } : undefined;
  const transaction: Transaction = {
    version: template.transaction.version,
    locktime: template.transaction.locktime,
    inputs: template.transaction.inputs.map(inp => ({ outpointTransactionHash: readHex(inp.outpointTransactionHash, "transaction ID", 32), outpointIndex: inp.outpointIndex, sequenceNumber: inp.sequenceNumber, unlockingBytecode: readHex(inp.unlockingBytecodeHex, "unlocking bytecode") })),
    outputs: template.transaction.outputs.map(out => ({ valueSatoshis: readAmount(out.valueSatoshis, "output amount"), lockingBytecode: readHex(out.lockingBytecodeHex, "locking bytecode"), ...(out.token ? { token: readToken(out.token) } : {}) })),
  };
  const sourceOutputs: Output[] = template.sourceOutputs.map((source, i) => {
    const input = transaction.inputs[i];
    if (source.txid.toLowerCase() !== binToHex(input.outpointTransactionHash) || source.vout !== input.outpointIndex) throw new Error(`Source output ${i} does not match its input.`);
    const token = (source as typeof source & { token?: WireToken }).token;
    return { valueSatoshis: readAmount(source.valueSatoshis, "source amount"), lockingBytecode: readHex(source.lockingBytecodeHex, "source locking bytecode"), ...(token ? { token: readToken(token) } : {}) };
  });
  const inputs: WalletUtxo[] = [];
  const walletInputs: CovenantTemplate["walletInputs"] = [];
  template.sourceOutputs.forEach((source, inputIndex) => {
    const live = wallet.utxos.find(u => u.txid.toLowerCase() === source.txid.toLowerCase() && u.vout === source.vout);
    if (!live) return;
    const input = template.transaction.inputs[inputIndex];
    if (input.derivationScope !== live.derivationScope || input.addressIndex !== live.addressIndex) throw new Error(`Wallet input ${inputIndex} derivation does not match the wallet.`);
    if (live.derivationScope !== "receive" && live.derivationScope !== "change") throw new Error("Unsupported wallet derivation scope.");
    inputs.push(live); walletInputs.push({ inputIndex, scope: live.derivationScope, addressIndex: live.addressIndex });
  });
  for (let i = 0; i < template.transaction.outputs.length; i++) {
    const output = template.transaction.outputs[i], preview = dag.outputs[i];
    if (!preview || output.address !== preview.address || output.isChange !== preview.isChange) throw new Error(`Output ${i}: address or change designation differs from preview.`);
  }

  const covenantTemplate: CovenantTemplate = {
    transaction,
    sourceOutputs,
    walletInputs,
    reviewedVersion: transaction.version,
    reviewedLocktime: transaction.locktime,
    reviewedSequences: transaction.inputs.map((inp) => inp.sequenceNumber),
  };

  const covenantProof = (template as typeof template & { covenantProof?: CovenantProof }).covenantProof;
  let verifiedOutputCovenant = false;
  if (covenantProof) {
    const matching = transaction.outputs
      .map((output, index) =>
        binToHex(output.lockingBytecode) === covenantProof.lockingBytecodeHex.toLowerCase()
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (matching.length !== 1) {
      throw new Error("Covenant proof must match exactly one P2SH32 output.");
    }
    verifyCovenantProof(covenantProof, matching[0], transaction, dag, wallet, signer);
    verifiedOutputCovenant = true;
  }

  assertCovenantMatchesPreview(covenantTemplate, dag, wallet, { verifiedOutputCovenant });

  return {
    transaction,
    sourceOutputs,
    inputs,
    dag,
    network: template.network,
    profileId: wallet.profileId,
    receiveAddress: wallet.receiveAddress,
    contractType: template.contractType,
    covenantProof,
    covenantTemplate,
  };
}
