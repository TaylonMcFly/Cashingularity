import tls from 'node:tls';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {} from '@fastify/websocket';
import {
  WALLET_SYNC_ADDRESS_LIMIT, WALLET_SYNC_BATCH_SIZE,
  type BchNetwork, type WalletSyncAddress, type WalletSyncMessage,
} from '@cashingularity/shared';
import { cashAddrToElectrumScriptHash, decodeFulcrumUtxos, fulcrumEndpoints, type FulcrumEndpoint } from './bchNetworkService.js';

const GENESIS: Record<BchNetwork, string> = {
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  chipnet: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
};
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const RPC_TIMEOUT_MS = 8_000;
const TXID = /^[a-f\d]{64}$/;
const HEADER = /^[a-f\d]{160}$/i;

interface Tip { height: number; hex: string }
function parseTip(data: unknown): Tip {
  const tip = data as Tip;
  if (!tip || !Number.isSafeInteger(tip.height) || tip.height <= 0 || !HEADER.test(tip.hex)) throw new Error('Invalid BCH chain tip.');
  return tip;
}

interface ElectrumNotice { method: string; params: unknown[] }
export interface WalletElectrumPeer {
  tip: Tip;
  source: string;
  call(method: string, params?: unknown[]): Promise<unknown>;
  onNotification?: (notice: ElectrumNotice) => void;
  onClose?: () => void;
  close(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class ElectrumPeer implements WalletElectrumPeer {
  tip!: Tip;
  readonly source: string;
  onNotification?: WalletElectrumPeer['onNotification'];
  onClose?: () => void;
  private readonly socket: tls.TLSSocket;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = '';

  constructor(endpoint: FulcrumEndpoint) {
    this.source = `fulcrum://${endpoint.host}:${endpoint.port}`;
    this.socket = tls.connect({ host: endpoint.host, servername: endpoint.host, port: endpoint.port, rejectUnauthorized: true });
    this.socket.setEncoding('utf8');
    this.socket.on('error', () => this.close());
    this.socket.once('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Fulcrum connection closed.'));
      }
      this.pending.clear();
      this.onClose?.();
    });
    this.socket.on('data', (chunk: string) => this.receive(chunk));
  }

  call(method: string, params: unknown[] = []): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error('Fulcrum connection closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.close(), RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close() { this.socket.destroy(); }

  private receive(chunk: string) {
    this.buffer += chunk;
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Fulcrum response too large.');
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const request = this.pending.get(message?.id);
        if (request) {
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error || !Object.hasOwn(message, 'result')) request.reject(new Error(`Fulcrum request failed: ${message.error?.message ?? 'invalid response'}`));
          else request.resolve(message.result);
        } else if (typeof message?.method === 'string' && Array.isArray(message.params)) {
          if (message.method === 'blockchain.headers.subscribe') this.tip = parseTip(message.params[0]);
          this.onNotification?.(message);
        }
      }
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) throw new Error('Fulcrum response too large.');
    } catch { this.close(); }
  }
}

async function connectElectrum(network: BchNetwork, signal: AbortSignal): Promise<WalletElectrumPeer> {
  const peers = fulcrumEndpoints(network).map(endpoint => new ElectrumPeer(endpoint));
  const abort = () => { for (const peer of peers) peer.close(); };
  signal.addEventListener('abort', abort, { once: true });
  let selected: ElectrumPeer | undefined;
  try {
    signal.throwIfAborted();
    selected = await Promise.any(peers.map(async peer => {
      await peer.call('server.version', ['Cashingularity', ['1.5', '1.6']]);
      const [features, header] = await Promise.all([
        peer.call('server.features') as Promise<{ genesis_hash?: string }>,
        peer.call('blockchain.headers.subscribe'),
      ]);
      if (features?.genesis_hash !== GENESIS[network]) throw new Error('Unexpected BCH network.');
      const tip = parseTip(header);
      peer.tip ??= tip;
      signal.throwIfAborted();
      return peer;
    }));
    return selected;
  } finally {
    signal.removeEventListener('abort', abort);
    for (const peer of peers) if (peer !== selected) peer.close();
  }
}

type AddressInfo = ReturnType<typeof cashAddrToElectrumScriptHash>;
type Status = string | null;
type WatchedScript = { status?: Status; version: number; subscribing?: Promise<void>; row?: WalletSyncAddress };
type WatchNotice = Extract<WalletSyncMessage, { type: 'changed' | 'tip' }>;
const readStatus = (data: unknown): Status => {
  if (data === null || typeof data === 'string' && TXID.test(data)) return data;
  throw new Error('Invalid Fulcrum script status.');
};

class ChangedSnapshot extends Error {}
const sameTip = (a: Tip, b: Tip) => a.height === b.height && a.hex.toLowerCase() === b.hex.toLowerCase();

/** All subscriptions, history and UTXOs come from the same peer and tip. */
export class ElectrumWalletWatch {
  private scripts = new Map<string, WatchedScript>();
  private blockTimes = new Map<number, Promise<number>>();
  private revision = 0;
  private noticeVersion = 0;
  private checking?: Promise<void>;
  private tip: Tip;

  constructor(private peer: WalletElectrumPeer, private onChanged: (notice: WatchNotice) => void) {
    this.tip = peer.tip;
    peer.onNotification = notice => {
      if (notice.method === 'blockchain.headers.subscribe') {
        const tip = parseTip(notice.params[0]);
        if (sameTip(tip, this.tip)) return;
        this.noticeVersion++;
        // Header delivery doesn't prove that every script-status notice was delivered.
        void this.recheck().catch(() => this.peer.close());
      } else if (notice.method === 'blockchain.scripthash.subscribe') {
        const hash = String(notice.params[0]);
        const script = this.scripts.get(hash);
        if (script) this.updateStatus(script, readStatus(notice.params[1]));
      }
    };
  }

  private updateStatus(script: WatchedScript, status: Status) {
    if (script.status === status) return;
    const wasSubscribed = script.status !== undefined;
    script.status = status;
    script.version++;
    script.row = undefined;
    if (wasSubscribed) {
      this.revision++;
      this.onChanged({ type: 'changed' });
    }
  }

  private subscribe(scriptHash: string, script: WatchedScript) {
    if (script.subscribing) return script.subscribing;
    const version = script.version;
    script.subscribing = this.peer.call('blockchain.scripthash.subscribe', [scriptHash]).then(data => {
      const status = readStatus(data);
      // A notification delivered during this RPC is newer than its reply.
      if (script.version === version) this.updateStatus(script, status);
    }).finally(() => { script.subscribing = undefined; });
    return script.subscribing;
  }

  recheck(): Promise<void> {
    return this.checking ??= this.checkActiveState().finally(() => { this.checking = undefined; });
  }

  private async checkActiveState(): Promise<void> {
    const originalRevision = this.revision;
    for (let attempt = 0; attempt < 6; attempt++) {
      const notice = this.noticeVersion;
      const before = parseTip(await this.peer.call('blockchain.headers.subscribe'));
      const scripts = [...this.scripts.entries()];
      // Keep the number of outstanding RPCs bounded for deeply used wallets.
      for (let start = 0; start < scripts.length; start += WALLET_SYNC_BATCH_SIZE) {
        await Promise.all(scripts.slice(start, start + WALLET_SYNC_BATCH_SIZE).map(async ([hash, script]) => {
          if (script.subscribing) await script.subscribing;
          await this.subscribe(hash, script);
        }));
      }
      const tip = parseTip(await this.peer.call('blockchain.headers.subscribe'));
      if (!sameTip(before, tip) || this.noticeVersion !== notice || scripts.length !== this.scripts.size) continue;
      if (sameTip(tip, this.tip)) return;
      const previous = createHash('sha256').update(createHash('sha256').update(Buffer.from(this.tip.hex, 'hex')).digest()).digest('hex');
      const extendsTip = tip.height === this.tip.height + 1 && tip.hex.slice(8, 72).toLowerCase() === previous;
      const unchanged = originalRevision === this.revision && scripts.every(([, script]) => script.row);
      if (!extendsTip) {
        this.blockTimes.clear();
        for (const script of this.scripts.values()) script.row = undefined;
      }
      this.tip = tip;
      this.revision++;
      this.onChanged(extendsTip && unchanged ? { type: 'tip', tip: tip.hex, height: tip.height, source: this.peer.source } : { type: 'changed' });
      return;
    }
    throw new Error('Fulcrum state changed during wallet revalidation.');
  }

  async read(id: number, addresses: AddressInfo[], fresh = false, verify = false): Promise<WalletSyncMessage> {
    const untracked = addresses.filter(address => !this.scripts.has(address.scriptHash));
    if (this.scripts.size + untracked.length > WALLET_SYNC_ADDRESS_LIMIT) throw new Error('Wallet scan limit reached.');
    for (const { scriptHash } of untracked) this.scripts.set(scriptHash, { version: 0 });
    if (verify) await this.recheck();
    else await this.checking;
    const scripts = addresses.map(({ scriptHash }) => this.scripts.get(scriptHash)!);
    await Promise.all(scripts.map(async (script, index) => {
      if (fresh || !script.row) await this.subscribe(addresses[index].scriptHash, script);
      if (fresh) script.row = undefined;
    }));

    const revision = this.revision;
    const tip = this.tip;
    const notice = this.noticeVersion;
    try {
      const missing = scripts.map(script => !script.row);
      const rows = await Promise.all(addresses.map((address, index) => this.readAddress(address, scripts[index], tip)));
      // The independent history and UTXO RPCs can straddle a spend even if there was no notification.
      await Promise.all(scripts.map(async (script, index) => {
        if (missing[index]) {
          if (script.subscribing) await script.subscribing;
          await this.subscribe(addresses[index].scriptHash, script);
        }
      }));
      if (revision !== this.revision || notice !== this.noticeVersion) return { type: 'retry', id };
      for (const [i, row] of rows.entries()) scripts[i].row = row;
      return { type: 'snapshot', id, tip: tip.hex, height: tip.height, source: this.peer.source, addresses: rows, ...(verify && { verified: true }) };
    } catch (error) {
      if (error instanceof ChangedSnapshot) await this.recheck().catch(() => {});
      if (revision !== this.revision || error instanceof ChangedSnapshot) return { type: 'retry', id };
      throw error;
    }
  }

  private async readAddress(info: AddressInfo, script: WatchedScript, tip: Tip): Promise<WalletSyncAddress> {
    const { scriptHash, standardAddress: address } = info;
    if (script.row) return script.row;
    const expected = script.status;
    if (expected === null) return { address, history: [], utxos: [] };
    const [history, unspent] = await Promise.all([
      this.peer.call('blockchain.scripthash.get_history', [scriptHash]),
      this.peer.call('blockchain.scripthash.listunspent', [scriptHash, 'include_tokens']),
    ]);
    if (!Array.isArray(history)) throw new Error('Invalid Fulcrum history.');
    const heights = new Map<string, number>();
    const digest = createHash('sha256');
    const rows = history.map(item => {
      if (!item || !TXID.test(item.tx_hash) || !Number.isSafeInteger(item.height) || item.height < -1 || item.height > tip.height || heights.has(item.tx_hash)) {
        throw new ChangedSnapshot();
      }
      heights.set(item.tx_hash, item.height);
      digest.update(`${item.tx_hash}:${item.height}:`);
      return {
        txid: item.tx_hash as string, height: item.height as number,
        ...(Number.isSafeInteger(item.fee) && item.fee >= 0 ? { feeSats: String(item.fee) } : {}),
      };
    });
    if (digest.digest('hex') !== expected) throw new ChangedSnapshot();
    const utxos = decodeFulcrumUtxos(unspent, info).map(({ txid, vout, satoshis, height, token }) => {
      if (!heights.has(txid) || Math.max(heights.get(txid)!, 0) !== height) throw new ChangedSnapshot();
      return { txid, vout, satoshis: String(satoshis), height, ...(token ? { token: { ...token, amount: String(token.amount) } } : {}) };
    });
    if (this.tip !== tip) throw new ChangedSnapshot();
    const recentBlocks = [...new Set(rows.slice(-20).filter(row => row.height > 0).map(row => row.height))];
    const times = new Map(await Promise.all(recentBlocks.map(async height => [height, await this.blockTime(height)] as const)));
    return { address, history: rows.map(row => ({ ...row, timestampMs: times.get(row.height) })), utxos };
  }

  private blockTime(height: number): Promise<number> {
    const cached = this.blockTimes.get(height);
    if (cached) return cached;
    const pending = this.peer.call('blockchain.block.header', [height]).then(header => {
      if (typeof header !== 'string' || !HEADER.test(header)) throw new Error('Invalid BCH block header.');
      return Buffer.from(header, 'hex').readUInt32LE(68) * 1000;
    }).catch(error => {
      if (this.blockTimes.get(height) === pending) this.blockTimes.delete(height);
      throw error;
    });
    if (this.blockTimes.size >= 512) this.blockTimes.clear();
    this.blockTimes.set(height, pending);
    return pending;
  }
}

export function registerWalletSync(app: FastifyInstance, dial = connectElectrum) {
  let open = 0;
  app.get('/ws/wallet', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && origin !== `https://${request.headers.host}` && origin !== `http://${request.headers.host}`) {
      socket.close(1008, 'Same-origin wallet connection required.');
      return;
    }
    if (open >= 48) { socket.close(1013, 'Wallet sync capacity reached.'); return; }
    open++;
    const abort = new AbortController();
    let peer: WalletElectrumPeer | undefined;
    let watch: ElectrumWalletWatch | undefined;
    let network: BchNetwork | undefined;
    let busy = false;
    let tipUpdates = false;
    let queued: WatchNotice | undefined;
    const send = (message: WalletSyncMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const notify = (notice: WatchNotice) => {
      if (queued?.type === 'changed') return;
      const scheduled = queued !== undefined;
      queued = tipUpdates ? notice : { type: 'changed' };
      if (!scheduled) queueMicrotask(() => {
        const current = queued;
        queued = undefined;
        if (current) send(current);
      });
    };
    const heartbeat = setInterval(() => {
      if (!peer) { if (!busy) socket.close(1008, 'Wallet sync request required.'); return; }
      void watch?.recheck().then(() => send({ type: 'heartbeat' })).catch(() => socket.close(1011, 'Fulcrum disconnected.'));
    }, 15_000);
    socket.once('close', () => { open--; abort.abort(); clearInterval(heartbeat); peer?.close(); });
    socket.on('error', () => socket.terminate());
    socket.on('message', async (raw: Buffer) => {
      if (busy) { socket.close(1008, 'Wait for the wallet sync response.'); return; }
      busy = true;
      try {
        if (raw.length > 8192) throw new Error('Wallet sync request too large.');
        const line = raw.toString();
        const data = JSON.parse(line);
        if (!Number.isSafeInteger(data?.id) || !['mainnet', 'chipnet'].includes(data.network) || (network && data.network !== network) ||
            !Array.isArray(data.addresses) || !data.addresses.length || data.addresses.length > WALLET_SYNC_BATCH_SIZE ||
            data.addresses.some((address: unknown) => typeof address !== 'string' || address.length > 128)) {
          socket.close(1008, 'Invalid wallet sync request.');
          return;
        }
        network = data.network as BchNetwork;
        tipUpdates = data.tipUpdates === true;
        const addresses = (data.addresses as string[]).map(cashAddrToElectrumScriptHash);
        if (addresses.some(address => address.network !== network) || new Set(addresses.map(address => address.scriptHash)).size !== addresses.length) {
          socket.close(1008, 'Invalid or duplicate wallet addresses.');
          return;
        }
        if (!watch) {
          peer = await dial(network, abort.signal);
          if (abort.signal.aborted) { peer.close(); return; }
          peer.onClose = () => socket.close(1011, 'Fulcrum disconnected.');
          watch = new ElectrumWalletWatch(peer, notify);
        }
        send(await watch.read(data.id, addresses, data.fresh === true, data.verify === true));
      } catch {
        socket.close(1011, 'Wallet sync unavailable.');
      } finally { busy = false; }
    });
  });
}
