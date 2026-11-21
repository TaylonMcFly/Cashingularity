import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveHdPath, deriveHdPrivateNodeFromBip39Mnemonic, deriveHdPublicNode, deriveHdPublicNodeChild,
} from '@bitauth/libauth';
import type { CashTokenData, WalletSyncMessage, WalletSyncRequest } from '@cashingularity/shared';
import { cashAddrToElectrumScriptHash } from '../../../backend/src/bchNetworkService.js';
import { ElectrumWalletWatch, type WalletElectrumPeer } from '../../../backend/src/electrumWalletSync.js';
import { addressFromPubkey, BchWalletService } from './bchWalletService.js';
import { preparePayment } from './paymentService.js';
import { prepareTokenPayment } from './tokenPayment.js';
import { WalletChainSync, type AccountChainSnapshot, type WalletBranch, type WalletSyncState } from './walletChainSync.js';
import { walletBchBalances } from './walletAssets.js';
import { wizardProfile } from './walletRuntime.js';

type Out = { address: string; value: number; token?: CashTokenData };
type Tx = { txid: string; height: number; outputs: Out[]; inputs: string[] };
const id = (n: number) => n.toString(16).padStart(64, '0');
const tip = { height: 500, hex: '00'.repeat(80) };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
const outpoint = (tx: Tx, index: number) => `${tx.txid}:${index}`;
const hexTime = (height: number, salt: number) => {
  const bytes = Buffer.alloc(80, salt);
  bytes.writeUInt32LE(1_700_000_000 + height * 10 + salt, 68);
  return bytes.toString('hex');
};

/** A deterministic Fulcrum mock. The browser and server still run their production sync logic. */
class Ledger {
  txs: Tx[] = [];
  tip = { ...tip };
  timestampSalt = 0;
  beforeCall?: (method: string, script: string) => void;
  lastPeer?: WalletElectrumPeer;
  private readonly scripts = new Map<string, string>();

  address(address: string) {
    const { scriptHash } = cashAddrToElectrumScriptHash(address);
    this.scripts.set(scriptHash, address);
    return scriptHash;
  }

  private rows(address: string | undefined) {
    const matching = this.txs.flatMap(tx => tx.outputs.flatMap((output, index) =>
      output.address === address ? [{ tx, output, index }] : []));
    const owned = new Set(matching.map(({ tx, index }) => outpoint(tx, index)));
    return {
      history: this.txs.filter(tx => tx.outputs.some(output => output.address === address) || tx.inputs.some(input => owned.has(input)))
        .sort((a, b) => (a.height <= 0 ? Infinity : a.height) - (b.height <= 0 ? Infinity : b.height))
        .map(tx => ({ tx_hash: tx.txid, height: tx.height })),
      utxos: matching.filter(({ tx, index }) => this.txs.every(spend => !spend.inputs.includes(outpoint(tx, index))))
        .map(({ tx, output, index }) => ({
          tx_hash: tx.txid, tx_pos: index, height: Math.max(tx.height, 0), value: output.value,
          ...(output.token && { token_data: { category: output.token.categoryId, amount: String(output.token.amount), nft: output.token.nft } }),
        })),
    };
  }

  status(script: string) {
    const rows = this.rows(this.scripts.get(script)).history;
    return rows.length ? hash(rows.map(tx => `${tx.tx_hash}:${tx.height}:`).join('')).toString('hex') : null;
  }

  connect(close: () => void): WalletElectrumPeer {
    return this.lastPeer = {
      tip: this.tip, source: 'reference-mock', close,
      call: async (method, [key] = []) => {
        this.beforeCall?.(method, String(key));
        if (method === 'blockchain.headers.subscribe') return this.tip;
        if (method === 'blockchain.block.header') return hexTime(Number(key), this.timestampSalt);
        if (method === 'blockchain.scripthash.subscribe') return this.status(String(key));
        const rows = this.rows(this.scripts.get(String(key)));
        if (method === 'blockchain.scripthash.get_history') return rows.history;
        if (method === 'blockchain.scripthash.listunspent') return rows.utxos;
        throw Error('Unexpected Electrum request: ' + method);
      },
    };
  }

  notify(address: string, status = this.status(this.address(address))) {
    this.lastPeer?.onNotification?.({ method: 'blockchain.scripthash.subscribe', params: [this.address(address), status] });
  }

  header(height = this.tip.height + 1, fork = 0) {
    this.timestampSalt = fork;
    const link = hash(hash(Buffer.from(this.tip.hex, 'hex'))).toString('hex');
    this.tip = { height, hex: fork ? hexTime(height, fork) : '01'.repeat(4) + link + '00'.repeat(44) };
    this.lastPeer?.onNotification?.({ method: 'blockchain.headers.subscribe', params: [this.tip] });
  }
}

// Reference evaluator applies all transactions once, then walks each HD branch one address at a time.
// It does not read Electrum statuses, WebSocket replies, wallet caches or production discovery code.
function reference(ledger: Ledger, derive: (scope: WalletBranch, index: number) => string, floor = { receive: 0, change: 0 }) {
  const outputs = new Map<string, { output: Out; tx: Tx }>();
  const unspent = new Set<string>();
  const history = new Map<string, Set<Tx>>();
  function touch(address: string, tx: Tx) {
    const txs = history.get(address) ?? new Set<Tx>();
    txs.add(tx);
    history.set(address, txs);
  }
  for (const tx of ledger.txs) {
    tx.inputs.forEach(key => {
      unspent.delete(key);
      const previous = outputs.get(key);
      if (previous) touch(previous.output.address, tx);
    });
    tx.outputs.forEach((output, i) => {
      const key = outpoint(tx, i);
      outputs.set(key, { output, tx });
      unspent.add(key);
      touch(output.address, tx);
    });
  }
  const addresses = new Map<string, { branch: WalletBranch; index: number }>();
  for (const branch of ['receive', 'change'] as const) {
    let gap = 0;
    for (let index = 0; gap < 20 || index < floor[branch]; index++) {
      const addr = derive(branch, index);
      addresses.set(addr, { branch, index });
      gap = history.has(addr) ? 0 : gap + 1;
    }
  }
  const transactions = new Map<string, number>();
  for (const address of addresses.keys()) for (const tx of history.get(address) ?? []) transactions.set(tx.txid, tx.height);
  const utxos = [...unspent].flatMap(key => {
    const { output } = outputs.get(key)!;
    const owner = addresses.get(output.address);
    return owner ? [{ key, satoshis: BigInt(output.value), ...owner, token: output.token }] : [];
  });
  return { confirmedHeight: ledger.tip.height, history: [...transactions].sort(), utxos: utxos.sort((a, b) => a.key.localeCompare(b.key)),
    total: utxos.reduce((sum, u) => sum + u.satoshis, 0n), native: utxos.reduce((sum, u) => sum + (u.token ? 0n : u.satoshis), 0n) };
}

function mockSync(ledger: Ledger, derive: (scope: WalletBranch, index: number) => string) {
  const events = new EventTarget();
  const states: WalletSyncState[] = [];
  let watch: ElectrumWalletWatch;
  let active: Socket;
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      active = this;
      const peer = ledger.connect(() => this.close());
      watch = new ElectrumWalletWatch(peer, value => this.post(value));
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
    }
    send(raw: string) {
      const query = JSON.parse(raw) as WalletSyncRequest;
      void watch.read(query.id, query.addresses.map(cashAddrToElectrumScriptHash), query.fresh, query.verify)
        .then(value => this.post(value), () => this.close());
    }
    post(value: WalletSyncMessage) {
      if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('window', Object.assign(events, { setTimeout, location: { href: 'http://localhost:3000' } }));
  vi.stubGlobal('WebSocket', Socket);
  const sync = new WalletChainSync({ network: 'mainnet', derive: (branch, index) => {
    const address = derive(branch, index);
    ledger.address(address);
    return address;
  } }, state => states.push(state));
  return { events, sync, states, recheck: () => watch.recheck(), drop: () => active.close() };
}

afterEach(() => vi.unstubAllGlobals());

describe('Wallet sync compared to an independent UTXO and gap-discovery reference', () => {
  it('matches reference through restore, gap boundaries, mempool replacement, reorgs and missed events', async () => {
    const wallet = new BchWalletService();
    wallet.importLocalWallet(`${'abandon '.repeat(11)}about`, 'mainnet', 6);
    const derive = (branch: WalletBranch, n: number) => wallet.getAddress(branch, n);
    const ledger = new Ledger();
    const r19 = derive('receive', 19), r39 = derive('receive', 39), r59 = derive('receive', 59), r60 = derive('receive', 60);
    const c19 = derive('change', 19), c39 = derive('change', 39);
    const token = { categoryId: id(501), amount: 9007199254740993n, nft: { capability: 'mutable' as const, commitment: 'ab' } };
    const tx = (n: number, height: number, outputs: Out[], inputs: string[] = []): Tx => ({ txid: id(n), height, outputs, inputs });
    const historyOnly = tx(1, 497, [{ address: r19, value: 2000 }]);
    const funded = tx(2, 499, [{ address: r39, value: 1800 }, { address: c19, value: 600, token }], [outpoint(historyOnly, 0)]);
    const outsideGap = tx(3, 496, [{ address: r60, value: 4000 }]);
    ledger.txs.push(outsideGap, historyOnly, funded);
    const { events, sync, states, recheck, drop } = mockSync(ledger, derive);
    const assertMatches = (next: AccountChainSnapshot, known = { receive: 0, change: 0 }) => {
      const expected = reference(ledger, derive, known);
      const balances = walletBchBalances(next.utxos);
      expect(next.height).toBe(expected.confirmedHeight);
      expect(next.history.map(entry => [entry.txid, entry.height]).sort()).toEqual(expected.history);
      expect(next.utxos.map(u => ({ key: `${u.txid}:${u.vout}`, satoshis: u.satoshis, branch: u.derivationScope, index: u.addressIndex,
        token: u.token })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(expected.utxos);
      expect(balances.totalSats).toBe(expected.total);
      expect(balances.nativeSats).toBe(expected.native);
    };
    const known = { receive: 80, change: 60 };
    try {
      const initial = await sync.refresh();
      assertMatches(initial);
      expect(initial.utxos.some(u => u.txid === outsideGap.txid)).toBe(false);
      expect(initial.history.some(entry => entry.txid === historyOnly.txid)).toBe(true);

      // A deposit at the last watched gap index opens another discovery window.
      const pending = tx(4, 0, [{ address: r59, value: 2300 }]);
      ledger.txs.push(pending);
      ledger.notify(r59);
      assertMatches(await sync.refresh());
      expect((await sync.refresh()).utxos.some(u => u.txid === outsideGap.txid)).toBe(true);
      const spend = tx(5, -1, [{ address: c39, value: 1700 }], [outpoint(pending, 0)]);
      ledger.txs.push(spend);
      // Suppress both status notices. The regular recheck must catch the mempool update.
      await recheck();
      assertMatches(await sync.refresh(), known);

      const staleStatus = ledger.status(ledger.address(c39));
      ledger.txs.pop();
      const replacement = tx(6, -1, [{ address: r39, value: 1600 }], [outpoint(pending, 0)]);
      ledger.txs.push(replacement);
      await recheck();
      ledger.notify(c39, staleStatus);
      ledger.notify(c39, staleStatus);
      assertMatches(await sync.refresh(), known);

      pending.height = replacement.height = 501;
      ledger.header();
      await recheck();
      const confirmed = await sync.refresh();
      assertMatches(confirmed, known);
      ledger.header(501, 1);
      await recheck();
      const replacedTip = await sync.refresh();
      assertMatches(replacedTip, known);
      expect(replacedTip.history.find(item => item.txid === pending.txid)?.timestampMs)
        .not.toBe(confirmed.history.find(item => item.txid === pending.txid)?.timestampMs);

      events.dispatchEvent(new Event('offline'));
      expect(states.at(-1)).toBe('unavailable');
      ledger.txs.splice(-2, 2);
      ledger.header(503, 2);
      events.dispatchEvent(new Event('online'));
      const recovered = await sync.refresh(true);
      assertMatches(recovered, known);
      expect(recovered.history.find(item => item.txid === replacement.txid)).toBeUndefined();

      drop();
      expect(states.at(-1)).toBe('unavailable');
      const reconnect = sync.refresh(true);
      const follow = sync.refresh(true);
      expect(reconnect).toBe(follow);
      assertMatches(await reconnect, known);
    } finally { sync.close(); wallet.lock(); }
  });

  it('validates earlier batches when a spend occurs during a deep concurrent scan', async () => {
    const wallet = new BchWalletService();
    wallet.importLocalWallet(`${'abandon '.repeat(11)}about`, 'mainnet');
    const derive = (branch: WalletBranch, n: number) => wallet.getAddress(branch, n);
    const ledger = new Ledger();
    const early = derive('receive', 0);
    const first = { txid: id(1), height: 498, inputs: [], outputs: [{ address: early, value: 9000 }] };
    ledger.txs.push(first, { txid: id(2), height: 499, inputs: [], outputs: [{ address: derive('receive', 19), value: 1000 }] });
    const { sync, states } = mockSync(ledger, derive);
    const later = ledger.address(derive('receive', 20));
    ledger.beforeCall = (method, script) => {
      if (method !== 'blockchain.scripthash.subscribe' || script !== later) return;
      ledger.beforeCall = undefined;
      ledger.txs.push({ txid: id(3), height: 0, inputs: [outpoint(first, 0)], outputs: [] });
    };
    try {
      const initial = sync.refresh(), fresh = sync.refresh(true);
      expect(sync.refresh(true)).toBe(fresh);
      const expected = reference(ledger, derive);
      for (const snapshot of [await initial, await fresh]) {
        expect(snapshot.utxos.map(u => u.satoshis)).toEqual([1000n]);
        expect(snapshot.history.some(item => item.txid === id(3))).toBe(true);
      }
      expect(expected.total).toBe(10000n);
      expect(reference(ledger, derive).total).toBe(1000n);
      expect(states.filter(state => typeof state !== 'string').every(state => state.utxos.every(u => u.txid !== first.txid))).toBe(true);
    } finally { sync.close(); wallet.lock(); }
  });

  it('syncs nonstandard named WizardConnect paths across multi-block reorgs and enforces token-safe coin selection', async () => {
    const root = deriveHdPrivateNodeFromBip39Mnemonic(`${'abandon '.repeat(11)}about`);
    const receiveBranch = deriveHdPath(root, "m/44'/145'/0'/3");
    const changeBranch = deriveHdPath(root, "m/44'/145'/0'/8");
    const defiBranch = deriveHdPath(root, "m/44'/145'/0'/7");
    if (typeof receiveBranch === 'string' || typeof changeBranch === 'string' || typeof defiBranch === 'string') {
      throw new Error('HD derivation failed');
    }
    const pubReceive = deriveHdPublicNode(receiveBranch);
    const pubChange = deriveHdPublicNode(changeBranch);
    const pubDefi = deriveHdPublicNode(defiBranch);
    root.privateKey.fill(0);
    receiveBranch.privateKey.fill(0);
    changeBranch.privateKey.fill(0);
    defiBranch.privateKey.fill(0);

    const derive = (branch: WalletBranch, index: number) =>
      addressFromPubkey(deriveHdPublicNodeChild(branch === 'receive' ? pubReceive : pubChange, index).publicKey, 'mainnet');
    const defiAddress = addressFromPubkey(deriveHdPublicNodeChild(pubDefi, 0).publicKey, 'mainnet');

    const ledger = new Ledger();
    const categoryId = id(777);
    const tokenData: CashTokenData = { categoryId, amount: 500n, nft: { capability: 'none', commitment: 'beef' } };
    const nativeTx = { txid: id(10), height: 501, inputs: [], outputs: [{ address: derive('receive', 4), value: 10_000 }] };
    const tokenTx = { txid: id(11), height: 502, inputs: [], outputs: [{ address: derive('change', 7), value: 50_000, token: tokenData }] };
    const defiTx = { txid: id(12), height: 502, inputs: [], outputs: [{ address: defiAddress, value: 900_000 }] };
    const reorgedTx = { txid: id(13), height: 504, inputs: [], outputs: [{ address: derive('receive', 12), value: 25_000 }] };
    ledger.txs.push(nativeTx, tokenTx, defiTx, reorgedTx);
    ledger.header(504, 1);

    const { sync, recheck } = mockSync(ledger, derive);
    try {
      const beforeReorg = await sync.refresh();
      const expectedBefore = reference(ledger, derive);
      expect(beforeReorg.height).toBe(504);
      expect(beforeReorg.utxos.some(u => u.address === defiAddress)).toBe(false);
      expect(walletBchBalances(beforeReorg.utxos).nativeSats).toBe(expectedBefore.native);
      expect(walletBchBalances(beforeReorg.utxos).totalSats).toBe(expectedBefore.total);

      // Multi-block reorganization from 504 back to 502 removes reorgedTx and delivers duplicate notices.
      ledger.txs.pop();
      ledger.header(502, 2);
      ledger.notify(derive('receive', 12));
      ledger.notify(derive('receive', 12));
      await recheck();
      const afterReorg = await sync.refresh();
      const expectedAfter = reference(ledger, derive);
      expect(afterReorg.height).toBe(502);
      expect(afterReorg.utxos.map(u => u.txid).sort()).toEqual([nativeTx.txid, tokenTx.txid]);
      expect(walletBchBalances(afterReorg.utxos).nativeSats).toBe(expectedAfter.native);

      // Token-safe coin selection: native MAX payment (9,562 sats + 438 fee = 10,000 sats) never consumes the CashToken UTXO.
      const profile = {
        ...wizardProfile(derive('receive', 0), derive('change', 0), 'Wizard Nonstandard Paths', 'mainnet', true),
        profileId: 'wizard-audit',
        utxoSource: afterReorg.source,
        utxos: afterReorg.utxos,
        balanceSats: walletBchBalances(afterReorg.utxos).spendableSats,
      };
      const maxNative = preparePayment(profile, [{ address: derive('receive', 0), satoshis: 9_562n }], 'LOCAL');
      expect(maxNative.inputs.map(u => u.txid)).toEqual([nativeTx.txid]);
      expect(maxNative.inputs.some(u => u.token)).toBe(false);
      expect(maxNative.transaction.outputs).toHaveLength(1);

      // Explicit CashToken transfer preserves the NFT commitment and returns remaining fungible units + BCH change.
      const tokenSend = prepareTokenPayment(profile, derive('receive', 1), categoryId, 200n, 'LOCAL');
      expect(tokenSend.transaction.outputs.filter(o => o.token).map(o => o.token?.amount)).toEqual([200n, 300n]);
      expect(tokenSend.transaction.outputs.some(o => o.token?.nft?.capability === 'none')).toBe(true);
    } finally {
      sync.close();
    }
  });
});
