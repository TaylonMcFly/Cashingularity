import { afterEach, describe, expect, it, vi } from 'vitest';
import { binToHex, hash256, hexToBin } from '@bitauth/libauth';
import { BchWalletService } from './bchWalletService.js';
import { scanWalletAccount, WalletChainSync, type WalletSyncState } from './walletChainSync.js';
import { liveWalletHistory, reconcileWalletHistory } from './transactionHistory.js';
import { walletBchBalances } from './walletAssets.js';
import { isAuthenticatorCode, normalizeAuthenticatorCode } from '../components/AuthenticatorCodeInput.js';
import type { WalletSyncAddress, WalletSyncRequest } from '@cashingularity/shared';

const mnemonic = `${'abandon '.repeat(11)}about`;
const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const txid = '12'.repeat(32);
const block = '00'.repeat(80);
const result = (addresses: WalletSyncAddress[], id = 0, height = 500) => ({
  type: 'snapshot' as const, id, height, tip: block, source: 'test', addresses,
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('BCH account discovery and synchronization', () => {
  it('scans both branches through spent history and deduplicates transfers across the account', async () => {
    const wallet = new BchWalletService();
    wallet.importLocalWallet(mnemonic, 'mainnet', 2);
    const spent = wallet.getAddress('receive', 18);
    const funded = wallet.getAddress('receive', 37);
    const change = wallet.getAddress('change', 4);
    const read = vi.fn(async (addresses: string[]) => result(addresses.map(address => ({
      address,
      history: [spent, funded, change].includes(address) ? [{ txid, height: 0 }] : [],
      utxos: address === funded || address === change ? [{ txid, vout: address === funded ? 0 : 1, satoshis: '50000', height: 0 }] : [],
    }))));
    const snapshot = await scanWalletAccount({ network: 'mainnet', derive: (scope, index) => wallet.getAddress(scope, index) }, read);
    expect(snapshot.history).toEqual([expect.objectContaining({ txid, height: 0 })]);
    expect(snapshot.scanned).toEqual({ receive: 60, change: 40 });
    expect(snapshot.utxos).toEqual(expect.arrayContaining([
      expect.objectContaining({ derivationScope: 'receive', addressIndex: 37 }),
      expect.objectContaining({ derivationScope: 'change', addressIndex: 4 }),
    ]));
    expect(walletBchBalances(snapshot.utxos)).toEqual({ totalSats: 100000n, nativeSats: 100000n, spendableSats: 100000n });
    wallet.lock();
  });

  it('clears stale state on disconnect, reconnects, and replaces an absent history item', async () => {
    let row: WalletSyncAddress = { address, history: [{ txid, height: 0 }], utxos: [] };
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        super(); sockets.push(this);
        Promise.resolve().then(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
      }
      send(text: string) {
        const request = JSON.parse(text) as WalletSyncRequest;
        Promise.resolve().then(() => this.message(result([row], request.id)));
      }
      message(value: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'http://localhost:3000/' }, setTimeout });
    vi.stubGlobal('WebSocket', Socket);
    const states: WalletSyncState[] = [];
    const sync = new WalletChainSync({ network: 'mainnet', addresses: [{ address, scope: 'receive', index: 0 }] }, next => states.push(next));
    const first = sync.refresh();
    expect(sync.refresh()).toBe(first);
    expect((await first).history).toHaveLength(1);
    row = { ...row, history: [{ txid, height: 498 }] };
    sockets[0].message({ type: 'changed' });
    expect(states.at(-1)).toBe('syncing');
    expect((await sync.refresh()).history[0].height).toBe(498);
    sockets[0].close();
    expect(states.at(-1)).toBe('unavailable');
    row = { ...row, history: [] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ history: [], utxos: [] });
    sync.close();
  });

  it('serializes concurrent fresh reads and reconnects once after an offline transition', async () => {
    const sockets: Socket[] = [];
    const events = new EventTarget();
    class Socket extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      requests: WalletSyncRequest[] = [];
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
      }
      send(text: string) { this.requests.push(JSON.parse(text)); }
      message(value: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(events, { location: { href: 'http://localhost:3000/' }, setTimeout }));
    vi.stubGlobal('WebSocket', Socket);
    const states: WalletSyncState[] = [];
    const row = { address, history: [{ txid, height: 496 }], utxos: [] };
    const sync = new WalletChainSync({ network: 'mainnet', addresses: [{ address, scope: 'receive', index: 0 }] }, state => states.push(state));
    const first = sync.refresh();
    const fresh = sync.refresh(true);
    expect(sync.refresh(true)).toBe(fresh);
    await vi.advanceTimersByTimeAsync(0);
    const original = sockets[0];
    expect(original.requests).toHaveLength(1);
    original.message(result([row], original.requests[0].id));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(original.requests).toHaveLength(2);
    expect(original.requests[1].fresh).toBe(true);
    original.message(result([row], original.requests[1].id));
    const latest = await fresh;
    expect(await sync.refresh()).toBe(latest);
    const newHeader = '01'.repeat(4) + binToHex(hash256(hexToBin(block))) + '00'.repeat(44);
    original.message({ type: 'tip', height: 501, tip: newHeader, source: 'test' });
    expect((await sync.refresh()).history).toBe(latest.history);
    expect(states.at(-1)).toMatchObject({ height: 501 });
    expect(original.requests).toHaveLength(2);

    events.dispatchEvent(new Event('offline'));
    expect(states.at(-1)).toBe('unavailable');
    await expect(sync.refresh()).rejects.toThrow(/offline/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    events.dispatchEvent(new Event('online'));
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    original.message(result([row], original.requests[1].id, 700));
    expect(states.at(-1)).toBe('syncing');
    sockets[1].message(result([{ address, history: [], utxos: [] }], sockets[1].requests[0].id, 502));
    expect((await sync.refresh()).history).toHaveLength(0);
    sync.close();
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('uses the live confirmation level and never carries an orphaned receipt into history', () => {
    const confirmed = liveWalletHistory([{ txid, height: 490 }], address, 'mainnet', 500);
    const receipt = { ...confirmed[0], initiatorProfileId: 'A', amountSats: '1000' };
    const unconfirmed = liveWalletHistory([{ txid, height: -1 }], address, 'mainnet', 500);
    expect(reconcileWalletHistory(unconfirmed, [receipt], 'A')).toEqual([expect.objectContaining({ confirmed: false, confirmations: 0, amountSats: '1000' })]);
    expect(reconcileWalletHistory(unconfirmed, [receipt], 'B')[0].amountSats).toBeNull();
    expect(reconcileWalletHistory([], [receipt], 'A')).toEqual([]);
  });

  it('requires each UTXO to appear in its own address history', async () => {
    const wallet = new BchWalletService();
    const keys = wallet.importLocalWallet(mnemonic, 'mainnet');
    try {
      const addresses = [
        { address: keys.receiveAddress, scope: 'receive' as const, index: 0 },
        { address: keys.changeAddress, scope: 'change' as const, index: 0 },
      ];
      await expect(scanWalletAccount({ network: 'mainnet', addresses }, async () => result([
        { address: keys.receiveAddress, history: [{ txid, height: 496 }], utxos: [] },
        { address: keys.changeAddress, history: [], utxos: [{ txid, height: 496, vout: 1, satoshis: '1000' }] },
      ]))).rejects.toThrow(/wallet UTXO/);
    } finally { wallet.lock(); }
  });
});

it('accepts six-digit authenticator text including leading zeros and pasted separators', () => {
  expect(normalizeAuthenticatorCode(' 001-234\n')).toBe('001234');
  expect(normalizeAuthenticatorCode('001234567')).toBe('001234');
  expect(isAuthenticatorCode('001234')).toBe(true);
  expect(isAuthenticatorCode('01234')).toBe(false);
  expect(isAuthenticatorCode('01234a')).toBe(false);
});
