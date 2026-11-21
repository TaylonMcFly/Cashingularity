import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { BchNetworkService } from './bchNetworkService.js';

afterEach(() => vi.restoreAllMocks());
const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
function mockFulcrum(result: unknown) {
  return vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, callback: () => void) => {
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.servername).toBe(options.host);
    const socket = new EventEmitter() as tls.TLSSocket;
    socket.end = vi.fn(() => socket);
    socket.destroy = vi.fn(() => socket);
    socket.write = vi.fn((payload: string) => {
      const rpc = JSON.parse(payload);
      if (rpc.method === 'blockchain.scripthash.listunspent') expect(rpc.params[1]).toBe('include_tokens');
      const response = typeof result === 'function' ? result(rpc) : result;
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ id: 1, result: response }) + '\n')));
      return true;
    }) as typeof socket.write;
    queueMicrotask(callback);
    return socket;
  }) as typeof tls.connect);
}
describe('authenticated Fulcrum response handling', () => {
  it('requests token metadata and preserves token-bearing outputs for safe coin selection', async () => {
    mockFulcrum([{ tx_hash: 'ab'.repeat(32), tx_pos: 0, height: 1, value: 1000, token_data: { category: 'cd'.repeat(32), amount: '12', nft: { capability: 'none', commitment: '1234' } } }]);
    const result = await new BchNetworkService().fetchAddressUtxos(address);
    expect(result.totalBalanceSats).toBe(1000n);
    expect(result.utxos[0].token?.amount).toBe(12n);
    expect(result.utxos[0].token?.nft?.commitment).toBe('1234');
  });
  it('rejects malformed values and a mismatched address network', async () => {
    const connection = mockFulcrum([{ tx_hash: 'ab'.repeat(32), tx_pos: 0, height: 1, value: -1 }]);
    const service = new BchNetworkService();
    await expect(service.fetchAddressUtxos(address, 'chipnet')).rejects.toThrow(/network/);
    expect(connection).not.toHaveBeenCalled();
    await expect(service.fetchAddressUtxos(address)).rejects.toThrow(/Invalid or duplicate/);
  });
  it('does not invent a wallet spend amount from all transaction outputs', async () => {
    const txid = 'ab'.repeat(32);
    mockFulcrum((rpc: { method: string }) => rpc.method === 'blockchain.scripthash.get_history'
      ? [{ tx_hash: txid, height: 1 }]
      : { txid, blocktime: 1234, vout: [{ value: 99 }] });
    const result = await new BchNetworkService().fetchAddressHistory(address);
    expect(result.history[0].amountSats).toBeNull();
    expect(result.history[0].direction).toBe('ACTIVITY');
    expect(result.history[0].timestampMs).toBe(1234000);
    expect(result.history[0].feeSats).toBeUndefined();
  });
  it('does not accept an unrelated transaction hash as a successful broadcast', async () => {
    mockFulcrum('ab'.repeat(32));
    const raw = binToHex(encodeTransaction({ version: 2, locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ valueSatoshis: 546n, lockingBytecode: new Uint8Array([0x51]) }],
    }));
    await expect(new BchNetworkService().broadcastRawTransaction(raw)).rejects.toThrow(/mismatched transaction ID/);
  });
});
