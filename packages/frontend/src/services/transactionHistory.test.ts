import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeWalletTransactions,
  fetchChainHistoryApi,
  readTransactionHistory,
  saveTransactionHistory,
  transactionExplorer,
  type WalletTransaction,
} from './transactionHistory.js';

afterEach(() => vi.unstubAllGlobals());
const receipt: WalletTransaction = {
  txid: 'ab'.repeat(32), address: 'bchtest:public-address', network: 'chipnet', label: 'Simple transfer',
  timestamp: 1234, amountSats: '10000', feeSats: '300', totalSats: '10300', priceUsd: 204,
};
describe('persistent public transaction receipts', () => {
  it('survives reload and never persists signing material or caller explorer URLs', () => {
    let stored = '';
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_: string, value: string) => { stored = value; } });
    saveTransactionHistory([{ ...receipt, initiatorProfileId: 'sender', mnemonic: 'secret', signedHex: 'secret', explorerUrl: 'javascript:alert(1)' } as WalletTransaction]);
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('javascript:');
    expect(readTransactionHistory()).toEqual([{ ...receipt, initiatorProfileId: 'sender' }]);
    expect(transactionExplorer(receipt)).toBe(`https://chipnet.chaingraph.cash/tx/${receipt.txid}`);
  });
  it('recovers from corrupt storage and excludes malformed receipt values', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{invalid' });
    expect(readTransactionHistory()).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([receipt, { ...receipt, txid: 'fake' }, { ...receipt, amountSats: '-1' }]) });
    expect(readTransactionHistory()).toEqual([receipt]);
  });
  it('keeps unavailable chain amounts and dates unknown and scopes duplicates to the profile', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ history: [{ txid: receipt.txid, confirmed: true, amountSats: null }] }) }));
    const [row] = await fetchChainHistoryApi(receipt.address, receipt.network);
    expect(row.amountSats).toBeNull();
    expect(row.feeSats).toBeNull();
    expect(row.totalSats).toBeNull();
    expect(row.timestamp).toBe(0);
    expect(mergeWalletTransactions([receipt], [{ ...receipt, network: 'mainnet' }])).toHaveLength(2);
  });
  it('merges on-chain Fulcrum history with local broadcast receipts without losing receipt metadata', () => {
    const chainOnly: WalletTransaction = {
      txid: 'cd'.repeat(32),
      address: receipt.address,
      network: receipt.network,
      label: 'On-chain receive',
      timestamp: 2000,
      amountSats: '50000',
      feeSats: '0',
      totalSats: '50000',
      priceUsd: null,
    };
    const chainDuplicate: WalletTransaction = {
      ...receipt,
      label: 'Confirmed tx',
      priceUsd: null,
      confirmed: true,
    };
    const merged = mergeWalletTransactions([{ ...receipt, confirmed: false }], [chainDuplicate, chainOnly]);
    expect(merged).toHaveLength(2);
    expect(merged[0].txid).toBe(chainOnly.txid);
    expect(merged[1].label).toBe('Simple transfer');
    expect(merged[1].priceUsd).toBe(204);
    expect(merged[1].confirmed).toBe(true);
  });
});
