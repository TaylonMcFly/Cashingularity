import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BchWalletService } from '../packages/frontend/src/services/bchWalletService.js';
import { WalletChainSync } from '../packages/frontend/src/services/walletChainSync.js';
import { cashAddrToElectrumScriptHash } from '../packages/backend/src/bchNetworkService.js';
import { ElectrumWalletWatch, type WalletElectrumPeer } from '../packages/backend/src/electrumWalletSync.js';
import type { WalletSyncMessage, WalletSyncRequest } from '@cashingularity/shared';

// Deterministic local transport and Electrum responses, with real HD derivation and sync code.
const wallet = new BchWalletService();
wallet.importLocalWallet('abandon '.repeat(11) + 'about', 'mainnet'); // Public zero-entropy BIP39 test vector.
const used = new Map<string, { tx_hash: string; height: number }>();
for (const branch of ['receive', 'change'] as const) {
  for (let index = 0; index < 90; index += 18) {
    const { scriptHash } = cashAddrToElectrumScriptHash(wallet.getAddress(branch, index));
    used.set(scriptHash, { tx_hash: scriptHash, height: 495 });
  }
}
const initial = { height: 500, hex: '00'.repeat(80) };
let counts: Record<string, number> = {};
let derivations = 0;
let requests = 0;
let walletUpdates = 0;
let maxOpenSockets = 0;
let openSockets = 0;
let liveListeners = 0;
const peer: WalletElectrumPeer = {
  tip: initial,
  source: 'wallet-sync-bench',
  close() {},
  async call(method, [hash] = []) {
    counts[method] = (counts[method] ?? 0) + 1;
    const tx = used.get(String(hash));
    if (method === 'blockchain.headers.subscribe') return peer.tip;
    if (method === 'blockchain.scripthash.subscribe') return tx ? createHash('sha256').update(tx.tx_hash + ':' + tx.height + ':').digest('hex') : null;
    if (method === 'blockchain.scripthash.get_history') return tx ? [tx] : [];
    if (method === 'blockchain.scripthash.listunspent') return tx ? [{ ...tx, tx_pos: 0, value: 10_000 }] : [];
    if (method === 'blockchain.block.header') return initial.hex;
    throw new Error('Unexpected RPC ' + method);
  },
};

let activeSocket: BenchSocket;
let watch: ElectrumWalletWatch;
class BenchSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  constructor() {
    super();
    activeSocket = this;
    watch = new ElectrumWalletWatch(peer, notice => this.message(notice ?? { type: 'changed' }));
    maxOpenSockets = Math.max(maxOpenSockets, ++openSockets);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  message(message: WalletSyncMessage) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  send(raw: string) {
    requests++;
    const { id, addresses, fresh, ...options } = JSON.parse(raw) as WalletSyncRequest & { verify?: boolean };
    // The fourth argument is ignored by the pre-audit transport.
    const read = watch.read.bind(watch) as typeof watch.read & ((id: number, addresses: ReturnType<typeof cashAddrToElectrumScriptHash>[], fresh: boolean | undefined, verify: boolean | undefined) => ReturnType<typeof watch.read>);
    void read(id, addresses.map(cashAddrToElectrumScriptHash), fresh, options.verify).then(result => this.message(result), () => this.close());
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    openSockets--;
    this.dispatchEvent(new Event('close'));
  }
}

class BrowserEvents extends EventTarget {
  private subscriptions = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      const listeners = this.subscriptions.get(type) ?? new Set();
      if (!listeners.has(listener)) liveListeners++;
      listeners.add(listener);
      this.subscriptions.set(type, listeners);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener && this.subscriptions.get(type)?.delete(listener)) liveListeners--;
    super.removeEventListener(type, listener, options);
  }
}
Object.assign(globalThis, { WebSocket: BenchSocket, window: Object.assign(new BrowserEvents(), { location: { href: 'http://localhost:3000' }, setTimeout }) });
const createSync = () => new WalletChainSync({
  network: 'mainnet',
  derive: (branch, index) => {
    derivations++;
    return wallet.getAddress(branch, index);
  },
}, () => { walletUpdates++; });
let sync = createSync();
const advanceBlock = async () => {
  const previousHash = createHash('sha256').update(createHash('sha256').update(Buffer.from(peer.tip.hex, 'hex')).digest()).digest('hex');
  peer.tip = { height: peer.tip.height + 1, hex: '01'.repeat(4) + previousHash + '00'.repeat(44) };
  peer.onNotification?.({ method: 'blockchain.headers.subscribe', params: [peer.tip] });
  // Wait for status verification on builds which implement it.
  await (watch as ElectrumWalletWatch & { recheck?: () => Promise<void> }).recheck?.();
  const snapshot = await sync.refresh();
  if (snapshot.height !== peer.tip.height || snapshot.utxos.length !== used.size) throw new Error('Benchmark wallet failed reconciliation.');
};
const describeTimings = (samples: number[]) => {
  const ordered = samples.toSorted((a, b) => a - b);
  return { medianMs: Number(ordered[Math.ceil(ordered.length * .50) - 1].toFixed(3)),
    p95Ms: Number(ordered[Math.ceil(ordered.length * .95) - 1].toFixed(3)),
    worstMs: Number(ordered.at(-1)!.toFixed(3)) };
};
const measure = async (run: (i: number) => Promise<unknown>, rounds = 30) => {
  counts = {};
  requests = derivations = walletUpdates = 0;
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }
  return { rounds, ...describeTimings(samples), requests, derivations, walletUpdates, electrum: counts };
};

void (async () => {
  try {
    const start = performance.now();
    await sync.refresh();
    const coldMs = performance.now() - start;
    for (let i = 0; i < 5; i++) await advanceBlock();
    const cold = { ms: Number(coldMs.toFixed(2)), requests, derivations };
    const warm = await measure(advanceBlock);
    const active = await measure(async i => {
      const branch = i % 2 ? 'receive' : 'change';
      const { scriptHash } = cashAddrToElectrumScriptHash(wallet.getAddress(branch, 9));
      const tx = { tx_hash: (1000 + i).toString(16).padStart(64, '0'), height: 0 };
      used.set(scriptHash, tx);
      const status = createHash('sha256').update(`${tx.tx_hash}:0:`).digest('hex');
      peer.onNotification?.({ method: 'blockchain.scripthash.subscribe', params: [scriptHash, status] });
      const snapshot = await sync.refresh();
      if (!snapshot.utxos.some(u => u.txid === tx.tx_hash && u.derivationScope === branch && u.addressIndex === 9)) {
        throw new Error('Benchmark missed a live wallet change');
      }
    });
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    // Recreate the complete watch, as happens on a selected-profile change.
    const reconnect = await measure(async () => {
      sync.close();
      sync = createSync();
      await sync.refresh(true);
      if (openSockets !== 1 || liveListeners !== 2) throw new Error('Wallet watch leaked a socket or an event listener');
    }, 20);
    sync.close();
    gc?.();
    console.log(JSON.stringify({ cold, warm, active, reconnect, maxOpenSockets, liveListeners, openSockets,
      ...(gc && { heapDeltaKiB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024) }) }, null, 2));
  } finally {
    sync.close();
    wallet.lock();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
