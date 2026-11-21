import { binToHex, encodeTransaction, getDustThreshold, hexToBin, type Output, type Transaction } from '@bitauth/libauth';
import { type AiExecutionMode, type CashTokenData, type WalletUtxo, validateAndConvertCashAddr } from '@cashingularity/shared';
import type { ConnectedWalletProfile } from './walletRuntime.js';
import type { PreparedPayment } from './paymentService.js';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
export function outputToken(token: CashTokenData): NonNullable<Output['token']> {
  return { category: hexToBin(token.categoryId), amount: token.amount, ...(token.nft ? { nft: { capability: token.nft.capability, commitment: hexToBin(token.nft.commitment) } } : {}) };
}
export function tokensEqual(a: CashTokenData | undefined, b: CashTokenData | undefined): boolean {
  return !a && !b || !!a && !!b && a.categoryId.toLowerCase() === b.categoryId.toLowerCase() && a.amount === b.amount && (!a.nft && !b.nft || !!a.nft && !!b.nft && a.nft.capability === b.nft.capability && a.nft.commitment.toLowerCase() === b.nft.commitment.toLowerCase());
}
export function prepareTokenPayment(profile: ConnectedWalletProfile, address: string, category: string, amount: bigint, mode: AiExecutionMode): PreparedPayment {
  if (!profile.isConnected || profile.connectionType === 'WATCH_ONLY' || ['sandbox','syncing','unavailable'].includes(profile.utxoSource ?? 'unavailable')) throw new Error('Sync a signing wallet before transferring CashTokens.');
  const checked = validateAndConvertCashAddr(address);
  if (!checked.valid || checked.network !== profile.network || !checked.tokenAwareAddress) throw new Error('Enter a valid CashAddr on the selected BCH network.');
  if (amount <= 0n) throw new Error('Enter a positive token amount.');
  const script = (cashaddr: string) => { const result = cashAddressToLockingBytecode(cashaddr); if (typeof result === 'string') throw new Error(result); return result.bytecode; };
  const tokenInputs: WalletUtxo[] = []; let tokens = 0n;
  for (const input of profile.utxos.filter(u => u.token?.categoryId.toLowerCase() === category.toLowerCase() && (u.derivationScope === 'receive' || u.derivationScope === 'change'))) { tokenInputs.push(input); tokens += input.token!.amount; if (tokens >= amount) break; }
  if (tokens < amount) throw new Error('Insufficient token balance.');
  const outputs: Output[] = [{ valueSatoshis: 546n, lockingBytecode: script(checked.tokenAwareAddress), token: outputToken({ categoryId: category, amount }) }];
  // Return every NFT/capability unchanged; transferring fungible units never burns an NFT.
  for (const input of tokenInputs.filter(u => u.token?.nft)) outputs.push({ valueSatoshis: 546n, lockingBytecode: script(profile.changeTokenAddress), token: outputToken({ ...input.token!, amount: 0n }) });
  if (tokens > amount) {
    const change = outputs.find((output, index) => index > 0 && output.token);
    if (change?.token) change.token.amount = tokens - amount;
    else outputs.push({ valueSatoshis: 546n, lockingBytecode: script(profile.changeTokenAddress), token: outputToken({ categoryId: category, amount: tokens - amount }) });
  }
  for (const output of outputs) output.valueSatoshis = getDustThreshold(output);
  const inputs = [...tokenInputs], funding = profile.utxos.filter(u => !u.token && (u.derivationScope === 'receive' || u.derivationScope === 'change'));
  const tx = (): Transaction => ({ version: 2, locktime: 0, inputs: inputs.map(u => ({ outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })), outputs });
  const base = outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  let fee = 0n, total = 0n;
  for (let index = 0; ; index++) {
    if (inputs.length > 200) throw new Error('Too many inputs for one token transfer.');
    total = inputs.reduce((sum, input) => sum + input.satoshis, 0n);
    const candidate = tx(); candidate.outputs = [...outputs, { valueSatoshis: 546n, lockingBytecode: script(profile.changeAddress) }];
    fee = BigInt(2 * (encodeTransaction(candidate).length + 108 * inputs.length));
    if (total >= base + fee) break;
    if (!funding[index]) throw new Error('Insufficient BCH for token dust outputs and the miner fee. Fund the wallet first.');
    inputs.push(funding[index]);
  }
  const change = total - base - fee;
  if (change >= 546n) outputs.push({ valueSatoshis: change, lockingBytecode: script(profile.changeAddress) }); else fee += change;
  const transaction = tx();
  return { transaction, sourceOutputs: inputs.map(u => ({ valueSatoshis: u.satoshis, lockingBytecode: script(u.address), ...(u.token ? { token: outputToken(u.token) } : {}) })), inputs, network: profile.network, profileId: profile.profileId, receiveAddress: profile.receiveAddress,
    dag: { txidPreview: '', inputs: inputs.map((u, index) => ({ inputIndex: index, txid: u.txid, vout: u.vout, address: u.address, satoshis: u.satoshis, token: u.token, isGenesisInput: false })), outputs: outputs.map((output, index) => ({ index, address: index === 0 ? checked.tokenAwareAddress! : output.token ? profile.changeTokenAddress : profile.changeAddress, scriptType: output.lockingBytecode.length === 35 ? 'P2SH32' : 'P2PKH', lockingBytecodeHex: binToHex(output.lockingBytecode), satoshis: output.valueSatoshis, isChange: index > 0, token: output.token ? { categoryId: binToHex(output.token.category), amount: output.token.amount, ...(output.token.nft ? { nft: { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) } } : {}) } : undefined })), audit: { minerFeeSats: fee, feeRateSatsPerByte: 2, disassembledOpcodes: [], dustPassed: true, bcmrVerified: false, addressReuseDetected: false, aiVerdict: 'CAUTION', aiExplanation: 'Review the token amount, NFT change and BCH fee.', analysisMode: mode } } };
}
