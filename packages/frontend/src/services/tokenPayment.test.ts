import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { BchWalletService } from './bchWalletService.js';
import { prepareTokenPayment } from './tokenPayment.js';
import type { ConnectedWalletProfile } from './walletRuntime.js';
import { parseAssetUnits } from './walletAssets.js';
afterEach(() => vi.unstubAllGlobals());
const TEST_VECTOR = 'abandon '.repeat(11) + 'about'; // Public zero-entropy BIP39 test vector.
describe('held assets and CashToken transfer signing', () => {
  it('signs token outputs in CashVM and preserves token/NFT change', () => {
    const wallet = new BchWalletService(); const addresses = wallet.importLocalWallet(TEST_VECTOR, 'mainnet');
    const categoryId = 'ab'.repeat(32);
    const profile = { ...addresses, isConnected: true, connectionType: 'BUILTIN_HD_XO', utxoSource: 'live', balanceSats: 101000n, utxos: [
      { txid: '11'.repeat(32), vout: 1, satoshis: 1000n, address: addresses.receiveAddress, tokenAddress: addresses.receiveTokenAddress, derivationScope: 'receive', addressIndex: 0, isGenesisCapable: false, token: { categoryId, amount: 1000n, nft: { capability: 'none', commitment: '1234' } } },
      { txid: '22'.repeat(32), vout: 1, satoshis: 100000n, address: addresses.receiveAddress, tokenAddress: addresses.receiveTokenAddress, derivationScope: 'receive', addressIndex: 0, isGenesisCapable: false },
    ] } as ConnectedWalletProfile;
    const payment = prepareTokenPayment(profile, addresses.receiveTokenAddress, categoryId, 250n, 'LOCAL');
    expect(payment.transaction.outputs[0].token?.amount).toBe(250n);
    const change = payment.transaction.outputs.find((o, index) => index > 0 && o.token?.nft);
    expect(change?.token?.amount).toBe(750n); expect(change?.token?.nft?.commitment).toEqual(new Uint8Array([0x12,0x34]));
    const signed = wallet.signPayment(payment.transaction, payment.sourceOutputs, payment.inputs.map(() => 'receive'));
    expect(createVirtualMachineBCH().verify({ transaction: signed, sourceOutputs: payment.sourceOutputs })).toBe(true);
    expect(() => prepareTokenPayment(profile, addresses.receiveTokenAddress, categoryId, 1001n, 'LOCAL')).toThrow(/Insufficient token/);
    wallet.lock();
  });
  it('parses native/token precision exactly and rejects excessive fractional digits', () => {
    expect(parseAssetUnits('1.25', 2)).toBe(125n); expect(parseAssetUnits('0.00000546',8)).toBe(546n);
    expect(() => parseAssetUnits('1.251',2)).toThrow(/decimal places/);
    expect(() => parseAssetUnits('0',8)).toThrow(/positive/);
  });
});
