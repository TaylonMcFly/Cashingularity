import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ElectrumWalletWatch, type WalletElectrumPeer } from './electrumWalletSync.js';
import { cashAddrToElectrumScriptHash } from './bchNetworkService.js';

const address = cashAddrToElectrumScriptHash('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
const txid = '11'.repeat(32);
const status = (height: number) => createHash('sha256').update(`${txid}:${height}:`).digest('hex');

describe('Electrum wallet watch', () => {
  it('does not advance a cached snapshot past a spend whose script notice was missed', async () => {
    const original = { hex: '00'.repeat(80), height: 90 };
    const blockHash = createHash('sha256').update(createHash('sha256').update(Buffer.from(original.hex, 'hex')).digest()).digest('hex');
    const next = { hex: '01'.repeat(4) + blockHash + '00'.repeat(44), height: 91 };
    const spend = '12'.repeat(32);
    let spent = false;
    const history = () => [{ tx_hash: txid, height: 89 }, ...(spent ? [{ tx_hash: spend, height: 91 }] : [])];
    const peer: WalletElectrumPeer = {
      tip: original, source: 'test', close() {},
      async call(method) {
        if (method === 'blockchain.headers.subscribe') return peer.tip;
        if (method === 'blockchain.scripthash.subscribe') return createHash('sha256').update(history().map(tx => `${tx.tx_hash}:${tx.height}:`).join('')).digest('hex');
        if (method === 'blockchain.scripthash.get_history') return history();
        if (method === 'blockchain.scripthash.listunspent') return spent ? [] : [{ tx_hash: txid, tx_pos: 0, height: 89, value: 1000 }];
        if (method === 'blockchain.block.header') return original.hex;
        throw new Error('Unexpected call');
      },
    };
    const changed = vi.fn();
    const watch = new ElectrumWalletWatch(peer, changed);
    expect(await watch.read(1, [address])).toMatchObject({ addresses: [{ utxos: [{ satoshis: '1000' }] }] });
    spent = true;
    peer.tip = next;
    peer.onNotification?.({ method: 'blockchain.headers.subscribe', params: [next] });
    expect(await watch.read(2, [address])).toMatchObject({ type: 'snapshot', height: 91, addresses: [{ history: [{ txid }, { txid: spend }], utxos: [] }] });
    expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tip' }));
  });

  it('rejects a snapshot mixing history from before a spend with UTXOs from after it', async () => {
    const spend = '13'.repeat(32);
    let spent = false;
    const history = () => [{ tx_hash: txid, height: 89 }, ...(spent ? [{ tx_hash: spend, height: 0 }] : [])];
    const peer: WalletElectrumPeer = {
      tip: { hex: '00'.repeat(80), height: 90 }, source: 'test', close() {},
      async call(method) {
        if (method === 'blockchain.scripthash.subscribe') return createHash('sha256').update(history().map(tx => `${tx.tx_hash}:${tx.height}:`).join('')).digest('hex');
        if (method === 'blockchain.scripthash.get_history') return history();
        if (method === 'blockchain.scripthash.listunspent') { spent = true; return []; }
        if (method === 'blockchain.block.header') return peer.tip.hex;
        throw new Error('Unexpected call');
      },
    };
    const watch = new ElectrumWalletWatch(peer, () => {});
    expect(await watch.read(1, [address])).toEqual({ type: 'retry', id: 1 });
    expect(await watch.read(2, [address])).toMatchObject({ type: 'snapshot', addresses: [{ history: [{ txid }, { txid: spend }], utxos: [] }] });
  });

  it('reconciles a mempool spend, confirmation, and a removed transaction after a reorg', async () => {
    let height = -1;
    const changes = vi.fn();
    const peer: WalletElectrumPeer = {
      tip: { hex: '00'.repeat(80), height: 90 }, source: 'test', close() {},
      call: vi.fn(async method => {
        if (method === 'blockchain.headers.subscribe') return peer.tip;
        if (method === 'blockchain.scripthash.subscribe') return status(height);
        if (method === 'blockchain.scripthash.get_history') return [{ tx_hash: txid, height }];
        if (method === 'blockchain.scripthash.listunspent') return [{ tx_hash: txid, tx_pos: 0, height: Math.max(0, height), value: 1000 }];
        if (method === 'blockchain.block.header') return '00'.repeat(80);
        throw new Error('Unexpected call');
      }),
    };
    const watch = new ElectrumWalletWatch(peer, changes);
    await expect(watch.read(1, [address])).resolves.toMatchObject({
      type: 'snapshot', addresses: [{ history: [{ txid, height: -1 }], utxos: [{ txid, height: 0, satoshis: '1000' }] }],
    });
    height = 91;
    peer.tip = { hex: '01'.repeat(80), height };
    peer.onNotification?.({ method: 'blockchain.headers.subscribe', params: [peer.tip] });
    peer.onNotification?.({ method: 'blockchain.scripthash.subscribe', params: [address.scriptHash, status(height)] });
    await expect(watch.read(2, [address])).resolves.toMatchObject({
      type: 'snapshot', height: 91, addresses: [{ history: [{ txid, height: 91 }], utxos: [{ txid, height: 91 }] }],
    });
    peer.tip = { hex: '02'.repeat(80), height: 91 };
    height = -1;
    peer.onNotification?.({ method: 'blockchain.headers.subscribe', params: [peer.tip] });
    await expect(watch.read(3, [address])).resolves.toMatchObject({
      type: 'snapshot', tip: '02'.repeat(80), addresses: [{ history: [{ txid, height: -1 }], utxos: [{ txid, height: 0 }] }],
    });
    expect(changes).toHaveBeenCalledWith({ type: 'changed' });
  });

  it('advances confirmation height without re-reading confirmed scripts on a direct extension', async () => {
    const first = { hex: '00'.repeat(80), height: 90 };
    const previous = createHash('sha256').update(createHash('sha256').update(Buffer.from(first.hex, 'hex')).digest()).digest('hex');
    const next = { hex: '01'.repeat(4) + previous + '00'.repeat(44), height: 91 };
    const notify = vi.fn();
    const call = vi.fn(async method => {
      if (method === 'blockchain.headers.subscribe') return peer.tip;
      if (method === 'blockchain.scripthash.subscribe') return status(89);
      if (method === 'blockchain.scripthash.get_history') return [{ tx_hash: txid, height: 89 }];
      if (method === 'blockchain.scripthash.listunspent') return [{ tx_hash: txid, tx_pos: 0, height: 89, value: 1000 }];
      if (method === 'blockchain.block.header') return '00'.repeat(80);
      throw new Error('Unexpected call');
    });
    const peer: WalletElectrumPeer = { tip: first, source: 'test', close() {}, call };
    const watch = new ElectrumWalletWatch(peer, notify);
    const initial = await watch.read(1, [address]);
    expect(initial.type).toBe('snapshot');
    call.mockClear();
    peer.tip = next;
    peer.onNotification?.({ method: 'blockchain.headers.subscribe', params: [next] });
    await watch.recheck();
    expect(notify).toHaveBeenLastCalledWith({ type: 'tip', height: 91, tip: next.hex, source: 'test' });
    await expect(watch.read(2, [address])).resolves.toMatchObject({ ...initial, id: 2, height: 91, tip: next.hex });
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'blockchain.headers.subscribe', 'blockchain.scripthash.subscribe', 'blockchain.headers.subscribe',
    ]);
    call.mockClear();
    await watch.read(3, [address], true);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'blockchain.scripthash.subscribe', 'blockchain.scripthash.get_history', 'blockchain.scripthash.listunspent', 'blockchain.scripthash.subscribe',
    ]);
  });

  it('ignores out-of-order subscription replies after a script changed and changed back', async () => {
    let answer: ((value: string) => void) | undefined;
    let subscribeCount = 0;
    const peer: WalletElectrumPeer = {
      tip: { hex: '00'.repeat(80), height: 90 }, source: 'test', close() {},
      async call(method) {
        if (method === 'blockchain.scripthash.subscribe') {
          return ++subscribeCount === 3 ? new Promise<string>(resolve => { answer = resolve; }) : status(89);
        }
        if (method === 'blockchain.scripthash.get_history') return [{ tx_hash: txid, height: 89 }];
        if (method === 'blockchain.scripthash.listunspent') return [{ tx_hash: txid, tx_pos: 0, height: 89, value: 1000 }];
        if (method === 'blockchain.block.header') return '00'.repeat(80);
        throw new Error('Unexpected call');
      },
    };
    const watch = new ElectrumWalletWatch(peer, () => {});
    await watch.read(1, [address]);
    const pending = watch.read(2, [address], true);
    const duplicate = watch.read(3, [address], true);
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(subscribeCount).toBe(3);
    for (const height of [88, 89]) peer.onNotification?.({ method: 'blockchain.scripthash.subscribe', params: [address.scriptHash, status(height)] });
    answer!(status(88));
    await expect(pending).resolves.toMatchObject({ type: 'snapshot', addresses: [{ utxos: [{ height: 89 }] }] });
    await expect(duplicate).resolves.toMatchObject({ type: 'snapshot' });
  });

  it('refreshes the chain tip and recovers when a confirmed script status arrives before its block header notice', async () => {
    const first = { hex: '00'.repeat(80), height: 90 };
    const previous = createHash('sha256').update(createHash('sha256').update(Buffer.from(first.hex, 'hex')).digest()).digest('hex');
    const next = { hex: '01'.repeat(4) + previous + '00'.repeat(44), height: 91 };
    let confirmedHeight = 89;
    const peer: WalletElectrumPeer = {
      tip: first, source: 'test', close() {},
      async call(method) {
        if (method === 'blockchain.headers.subscribe') return peer.tip;
        if (method === 'blockchain.scripthash.subscribe') return status(confirmedHeight);
        if (method === 'blockchain.scripthash.get_history') return [{ tx_hash: txid, height: confirmedHeight }];
        if (method === 'blockchain.scripthash.listunspent') return [{ tx_hash: txid, tx_pos: 0, height: confirmedHeight, value: 1000 }];
        if (method === 'blockchain.block.header') return peer.tip.hex;
        throw new Error('Unexpected call');
      },
    };
    const watch = new ElectrumWalletWatch(peer, () => {});
    await expect(watch.read(1, [address])).resolves.toMatchObject({ type: 'snapshot', height: 90 });
    confirmedHeight = 91;
    peer.tip = next;
    // Deliver only the script notification; the header notification is delayed/missed.
    peer.onNotification?.({ method: 'blockchain.scripthash.subscribe', params: [address.scriptHash, status(91)] });
    await expect(watch.read(2, [address])).resolves.toEqual({ type: 'retry', id: 2 });
    await expect(watch.read(3, [address])).resolves.toMatchObject({
      type: 'snapshot', id: 3, height: 91, tip: next.hex,
      addresses: [{ history: [{ txid, height: 91 }], utxos: [{ txid, height: 91, satoshis: '1000' }] }],
    });
  });
});
