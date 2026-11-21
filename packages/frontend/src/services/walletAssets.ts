import { getDustThreshold, hexToBin, type Output } from '@bitauth/libauth';
import type { WalletUtxo } from '@cashingularity/shared';

/** Spend a token category as a group so all fungible units and NFTs are returned. */
export function tokenBchFunding(utxos: readonly WalletUtxo[], lockingBytecode: Uint8Array) {
  const categories = new Map<string, WalletUtxo[]>();
  for (const input of utxos) {
    if (!input.token) continue;
    const id = input.token.categoryId.toLowerCase();
    if (!categories.has(id)) categories.set(id, []);
    categories.get(id)!.push(input);
  }
  return [...categories].map(([id, inputs]) => {
    const category = hexToBin(id);
    const tokens: NonNullable<Output['token']>[] = [];
    let amount = 0n;
    let satoshis = 0n;
    for (const input of inputs) {
      const token = input.token!;
      amount += token.amount;
      satoshis += input.satoshis;
      if (token.nft) tokens.push({ category, amount: 0n, nft: { ...token.nft, commitment: hexToBin(token.nft.commitment) } });
    }
    const maxAmount = 0x7fffffffffffffffn;
    for (; amount > 0n; amount -= maxAmount) {
      tokens.push({ category, amount: amount > maxAmount ? maxAmount : amount });
    }
    const outputs = tokens.map(token => {
      const output = { lockingBytecode, valueSatoshis: 0n, token };
      return { ...output, valueSatoshis: getDustThreshold(output) };
    });
    const reserve = outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
    return { inputs, outputs, satoshis, reserve, surplus: satoshis - reserve };
  }).filter(group => group.surplus > 0n);
}

/** BCH funds before miner fees, after providing dust for token change. */
export function walletBchBalances(utxos: readonly WalletUtxo[]) {
  let nativeSats = 0n;
  let totalSats = 0n;
  for (const { satoshis, token } of utxos) {
    totalSats += satoshis;
    if (!token) nativeSats += satoshis;
  }
  const spendableSats = tokenBchFunding(utxos, new Uint8Array(25)).reduce((sum, group) => sum + group.surplus, nativeSats);
  return { totalSats, nativeSats, spendableSats };
}

export function parseAssetUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d{1,80}(?:\.\d{1,18})?$/.test(text.trim())) throw new Error('Enter a valid asset amount.');
  const [whole, fraction = ''] = text.trim().split('.');
  if (fraction.length > decimals) throw new Error(`This asset supports at most ${decimals} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n) throw new Error('Enter a positive amount.');
  return amount;
}
export function formatAssetUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals), fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${decimals && fraction ? `.${fraction}` : ''}`;
}
