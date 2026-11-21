import { fileURLToPath } from 'node:url';
import {
  binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeTransaction, hash160,
  hashTransaction, hexToBin, secp256k1, sha256, type Output as SourceOutput, type Transaction,
} from '@bitauth/libauth';
import { createVirtualMachineBch2026 } from '@bitauth/libauth-vm';
import { decodeNftReceiptCommitment, encodeNftReceiptCommitment } from '@cashingularity/shared';
import { compileFile } from 'cashc';
import { Contract, SignatureTemplate, TransactionBuilder, type NetworkProvider, type TokenDetails, type Utxo } from 'cashscript';

// The QA runner uses this real artifact directly. The app's prediction broadcast gate stays closed.
export const artifact = compileFile(fileURLToPath(new URL('../contracts/PredictionPool.cash', import.meta.url)));
export const reserve = 1500n;
const receiptValue = 2500n;
const covenantFee = 2200n;
const genesisFee = 500n;
const open = 0, downWon = 1, upWon = 2, refund = 3;
export type Bucket = 0 | 1;
type WalletSigner = Uint8Array | string;

export interface RoundParameters {
  categoryId: string;
  marketId: number;
  strikePriceCents: number;
  expiry: number;
  refundTime: number;
  oraclePublicKey: Uint8Array;
  reservePkh: Uint8Array;
}

const script = (address: string) => {
  const bytes = cashAddressToLockingBytecode(address);
  if (typeof bytes === 'string') throw new Error(bytes);
  return bytes.bytecode;
};

export function publicKey(privateKey: Uint8Array) {
  const result = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof result === 'string') throw new Error(result);
  return result;
}
function walletUnlock(signer: WalletSigner) {
  if (typeof signer !== 'string') return new SignatureTemplate(signer).unlockP2PKH();
  const lockingBytecode = script(signer);
  if (!/^bchtest:/i.test(signer) || !/^76a914[0-9a-f]{40}88ac$/.test(binToHex(lockingBytecode))) {
    throw new Error('A Chipnet P2PKH address is required for an unsigned wallet input.');
  }
  return { generateLockingBytecode: () => lockingBytecode, generateUnlockingBytecode: () => new Uint8Array() };
}
export const walletLock = (signer: WalletSigner) => walletUnlock(signer).generateLockingBytecode();
const reserveScript = (pkh: Uint8Array) => Uint8Array.of(0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac);

function fixedBytes(value: number | bigint, size: 4 | 8, littleEndian = true) {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  if (size === 4) view.setUint32(0, Number(value), littleEndian);
  else view.setBigUint64(0, BigInt(value), littleEndian);
  return new Uint8Array(buffer);
}

function baton(categoryId: string, phase: number, first: bigint, second: bigint): TokenDetails {
  return {
    category: categoryId, amount: 0n,
    nft: { capability: 'minting', commitment: binToHex(Uint8Array.of(phase, ...fixedBytes(first, 8), ...fixedBytes(second, 8))) },
  };
}

export function createRound(params: RoundParameters, provider: NetworkProvider) {
  if (provider.network !== 'chipnet' && provider.network !== 'mocknet') {
    throw new Error('Prediction round verification is restricted to Chipnet and Mocknet.');
  }
  if (!/^[0-9a-f]{64}$/.test(params.categoryId) ||
      ![params.marketId, params.expiry, params.refundTime, params.strikePriceCents].every(n => Number.isInteger(n) && n > 0 && n <= 0xffffffff) ||
      params.strikePriceCents > 2_000_000_000 || params.expiry >= params.refundTime ||
      (params.expiry < 500_000_000) !== (params.refundTime < 500_000_000) || params.reservePkh.length !== 20) {
    throw new Error('Invalid prediction round parameters.');
  }
  const contract = new Contract(artifact, [
    params.oraclePublicKey, hexToBin(params.categoryId).reverse(), fixedBytes(params.marketId, 4, false),
    BigInt(params.strikePriceCents), BigInt(params.expiry), BigInt(params.refundTime), params.reservePkh,
  ], { provider, addressType: 'p2sh32' });
  return { ...params, provider, contract, lock: script(contract.address) };
}

type Round = ReturnType<typeof createRound>;

export function genesis(round: Round, source: Utxo, key: WalletSigner) {
  return new TransactionBuilder({ provider: round.provider })
    .addInput(source, walletUnlock(key))
    .addOutput({ to: round.contract.tokenAddress, amount: reserve, token: baton(round.categoryId, open, 0n, 0n) })
    .addOutput({ to: walletLock(key), amount: source.satoshis - reserve - genesisFee });
}

/** Every participant must pin this genesis. CashTokens permit arbitrary issuance in an unchecked genesis. */
export function verifyGenesis(round: Pick<Round, 'categoryId' | 'lock'>, transaction: Transaction, funding: SourceOutput) {
  const input = transaction.inputs[0];
  const output = transaction.outputs[0];
  if (transaction.inputs.length !== 1 || !input || input.outpointIndex !== 0 ||
      binToHex(input.outpointTransactionHash) !== round.categoryId || funding.token ||
      !output || output.valueSatoshis !== reserve || binToHex(output.lockingBytecode) !== binToHex(round.lock) ||
      !output.token || binToHex(output.token.category) !== round.categoryId || output.token.amount !== 0n ||
      output.token.nft?.capability !== 'minting' || binToHex(output.token.nft.commitment) !== '00'.repeat(17) ||
      transaction.outputs.slice(1).some(other => other.token)) {
    throw new Error('Expected exactly one zero-state baton from the pinned genesis input.');
  }
  assertCashVm(transaction, [funding]);
}

function state(round: Round, pool: Utxo) {
  const nft = pool.token?.nft;
  if (pool.token?.category !== round.categoryId || pool.token.amount !== 0n || nft?.capability !== 'minting' ||
      !/^[0-9a-f]{34}$/.test(nft.commitment)) throw new Error('Pool input is missing its state baton.');
  const bytes = hexToBin(nft.commitment);
  const numbers = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { phase: bytes[0], first: numbers.getBigUint64(1, true), second: numbers.getBigUint64(9, true) };
}

function dataSignature(key: Uint8Array, message: Uint8Array) {
  const signature = secp256k1.signMessageHashSchnorr(key, sha256.hash(message));
  if (typeof signature === 'string') throw new Error(signature);
  return signature;
}

export function stakeOrder(round: Round, pool: Utxo, funding: Utxo, key: WalletSigner, bucketId: Bucket, stakeSats: bigint, oracleKey: Uint8Array) {
  const { first: down, second: up } = state(round, pool);
  const receipt = encodeNftReceiptCommitment({ marketId: round.marketId, bucketId, stakeSats });
  const owner = walletLock(key);
  const order = Uint8Array.of(
    ...hexToBin('4353475301'), ...round.lock,
    ...hexToBin(pool.txid).reverse(), ...fixedBytes(pool.vout, 4),
    ...hexToBin(funding.txid).reverse(), ...fixedBytes(funding.vout, 4), ...receipt, ...owner,
  );
  return new TransactionBuilder({ provider: round.provider })
    .addInput(pool, round.contract.unlock.placeStake(Uint8Array.of(bucketId), stakeSats, dataSignature(oracleKey, order)))
    .addInput(funding, walletUnlock(key))
    .addOutput({
      to: round.contract.tokenAddress, amount: pool.satoshis + stakeSats,
      token: baton(round.categoryId, open, down + (bucketId === 0 ? stakeSats : 0n), up + (bucketId === 1 ? stakeSats : 0n)),
    })
    .addOutput({
      to: owner, amount: receiptValue,
      token: { category: round.categoryId, amount: 0n, nft: { capability: 'none', commitment: binToHex(receipt) } },
    })
    .addOutput({ to: owner, amount: funding.satoshis - stakeSats - receiptValue - covenantFee });
}

function receiptStake(utxo: Utxo) {
  if (!utxo.token?.nft) throw new Error('Receipt input has no commitment.');
  return decodeNftReceiptCommitment(utxo.token.nft.commitment);
}

export function resolutionSignature(round: Round, closeCents: number, oracleKey: Uint8Array) {
  return dataSignature(oracleKey, Uint8Array.of(...hexToBin('4353475201'), ...round.lock, ...fixedBytes(closeCents, 8)));
}

export function claim(round: Round, pool: Utxo, receipt: Utxo, key: WalletSigner, closeCents: number, oracleKey: Uint8Array) {
  const { phase, first, second } = state(round, pool);
  const up = closeCents >= round.strikePriceCents;
  const remaining = phase === open && up ? second : first;
  const { stakeSats } = receiptStake(receipt);
  const payout = stakeSats * (pool.satoshis - reserve) / remaining;
  const next = remaining - stakeSats;
  return new TransactionBuilder({ provider: round.provider })
    .addInput(pool, round.contract.unlock.claimRoundPayout(resolutionSignature(round, closeCents, oracleKey), BigInt(closeCents)))
    .addInput(receipt, walletUnlock(key))
    .setLocktime(round.expiry)
    .addOutput(next === 0n
      ? { to: reserveScript(round.reservePkh), amount: reserve }
      : { to: round.contract.tokenAddress, amount: pool.satoshis - payout,
          token: baton(round.categoryId, up ? upWon : downWon, next, BigInt(closeCents)) })
    .addOutput({ to: walletLock(key), amount: payout + receipt.satoshis - covenantFee });
}

export function refundReceipt(round: Round, pool: Utxo, receipt: Utxo, key: WalletSigner) {
  const { first: down, second: up } = state(round, pool);
  const { bucketId, stakeSats } = receiptStake(receipt);
  const nextDown = down - (bucketId === 0 ? stakeSats : 0n);
  const nextUp = up - (bucketId === 1 ? stakeSats : 0n);
  const next = nextDown + nextUp;
  return new TransactionBuilder({ provider: round.provider })
    .addInput(pool, round.contract.unlock.reclaimExpiredStake())
    .addInput(receipt, walletUnlock(key))
    .setLocktime(round.refundTime)
    .addOutput(next === 0n
      ? { to: reserveScript(round.reservePkh), amount: reserve }
      : { to: round.contract.tokenAddress, amount: reserve + next,
          token: baton(round.categoryId, refund, nextDown, nextUp) })
    .addOutput({ to: walletLock(key), amount: stakeSats + receipt.satoshis - covenantFee });
}

export function recoverEmptyReserve(round: Round, pool: Utxo, feeInput: Utxo, signer: WalletSigner) {
  const owner = walletLock(signer);
  return new TransactionBuilder({ provider: round.provider })
    .addInput(pool, round.contract.unlock.recoverEmptyRoundReserve())
    .addInput(feeInput, walletUnlock(signer))
    .setLocktime(round.refundTime)
    .addOutput({ to: owner, amount: reserve })
    .addOutput({ to: owner, amount: feeInput.satoshis - covenantFee });
}

/** Invalidate an unfilled admission by spending its exact funding input back to its owner. */
export function cancelUnfilledOrder(round: Round, funding: Utxo, signer: WalletSigner) {
  return new TransactionBuilder({ provider: round.provider })
    .addInput(funding, walletUnlock(signer))
    .addOutput({ to: walletLock(signer), amount: funding.satoshis - genesisFee });
}

const vm = createVirtualMachineBch2026();
export function assertCashVm(transaction: Transaction, sourceOutputs: SourceOutput[]) {
  const result = vm.verify({ transaction, sourceOutputs });
  if (result !== true) throw new Error(result);
}

export function inspect(builder: TransactionBuilder) {
  const raw = builder.build();
  const transaction = decodeTransaction(hexToBin(raw));
  if (typeof transaction === 'string') throw new Error(transaction);
  const sourceOutputs = builder.inputs.map(input => ({
    lockingBytecode: input.unlocker.generateLockingBytecode(), valueSatoshis: input.satoshis,
    token: input.token && {
      category: hexToBin(input.token.category), amount: input.token.amount,
      nft: input.token.nft && { ...input.token.nft, commitment: hexToBin(input.token.nft.commitment) },
    },
  }));
  return { raw, transaction, sourceOutputs, txid: hashTransaction(encodeTransaction(transaction)) };
}

export function utxo(txid: string, vout: number, output: SourceOutput): Utxo {
  return {
    txid, vout, satoshis: output.valueSatoshis,
    token: output.token && {
      category: binToHex(output.token.category), amount: output.token.amount,
      nft: output.token.nft && { ...output.token.nft, commitment: binToHex(output.token.nft.commitment) },
    },
  };
}

export function reserveOwner(signer: WalletSigner) {
  return typeof signer === 'string' ? walletLock(signer).slice(3, 23) : hash160(publicKey(signer));
}
