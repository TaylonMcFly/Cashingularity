import {
  WALLET_GAP_LIMIT, WALLET_SYNC_ADDRESS_LIMIT, WALLET_SYNC_BATCH_SIZE, validateAndConvertCashAddr,
  type BchNetwork, type WalletSyncAddress, type WalletSyncMessage, type WalletSyncRequest,
  type WalletSyncTransaction, type WalletUtxo,
} from '@cashingularity/shared';
import { binToHex, hash256, hexToBin } from '@bitauth/libauth';

export type WalletBranch = 'receive' | 'change';
type OwnedAddress = { address: string; scope: WalletBranch; index: number };
export type WalletScan = { network: BchNetwork } & (
  { derive: (scope: WalletBranch, index: number) => string } | { addresses: OwnedAddress[] }
);
export interface AccountChainSnapshot {
  utxos: WalletUtxo[];
  history: WalletSyncTransaction[];
  source: string;
  height: number;
}
export type WalletSyncState = AccountChainSnapshot | 'syncing' | 'unavailable';
export interface AccountChainSync {
  refresh(fresh?: boolean): Promise<AccountChainSnapshot>;
  close(): void;
}

type Batch = Extract<WalletSyncMessage, { type: 'snapshot' }>;
class ChangedSnapshot extends Error {}

/** BIP44 discovery counts used addresses by history, even when every output was spent. */
export async function scanWalletAccount(
  wallet: WalletScan,
  read: (addresses: string[]) => Promise<Batch>,
  previous?: Record<WalletBranch, number>,
): Promise<AccountChainSnapshot & { scanned: Record<WalletBranch, number>; tip: string }> {
  const scanned = { receive: 0, change: 0 };
  const unused = { receive: 0, change: 0 };
  const collected = new Map<string, { owned: OwnedAddress; row: WalletSyncAddress }>();
  let tip: Batch | undefined;
  const readBatch = async (owners: OwnedAddress[]) => {
    const requested = [...new Set(owners.map(item => item.address))];
    const batch = await read(requested);
    if (tip && (tip.tip !== batch.tip || tip.height !== batch.height || tip.source !== batch.source)) throw new ChangedSnapshot();
    tip = batch;
    const results = new Map(batch.addresses.map(row => [row.address, row]));
    if (results.size !== requested.length || batch.addresses.length !== results.size) throw new Error('Incomplete wallet sync response.');
    for (const owned of owners) {
      const row = results.get(owned.address);
      if (!row || !Array.isArray(row.history) || !Array.isArray(row.utxos)) throw new Error('Missing wallet script history.');
      unused[owned.scope] = row.history.length || row.utxos.length ? 0 : unused[owned.scope] + 1;
      if (!collected.has(owned.address)) collected.set(owned.address, { owned, row });
    }
  };

  if ('derive' in wallet) {
    const scopes = ['receive', 'change'] as const;
    while (scopes.some(scope => unused[scope] < WALLET_GAP_LIMIT || scanned[scope] < (previous?.[scope] ?? 0))) {
      const batch: OwnedAddress[] = [];
      for (const scope of scopes) {
        if (unused[scope] >= WALLET_GAP_LIMIT && scanned[scope] >= (previous?.[scope] ?? 0)) continue;
        if (scanned[scope] + WALLET_GAP_LIMIT > WALLET_SYNC_ADDRESS_LIMIT / scopes.length) throw new Error('Wallet discovery limit reached.');
        const end = scanned[scope] + WALLET_GAP_LIMIT;
        for (; scanned[scope] < end; scanned[scope]++) {
          const index = scanned[scope];
          batch.push({ address: wallet.derive(scope, index), scope, index });
        }
      }
      await readBatch(batch);
    }
  } else {
    for (let offset = 0; offset < wallet.addresses.length; offset += WALLET_SYNC_BATCH_SIZE) {
      await readBatch(wallet.addresses.slice(offset, offset + WALLET_SYNC_BATCH_SIZE));
    }
  }

  if (!tip) throw new Error('The wallet has no addresses to watch.');
  const history = new Map<string, WalletSyncTransaction>();
  const utxos = new Map<string, WalletUtxo>();
  const txid = /^[a-f\d]{64}$/;
  for (const { owned, row } of collected.values()) {
    const checked = validateAndConvertCashAddr(owned.address);
    if (!checked.valid || checked.network !== wallet.network || !checked.tokenAwareAddress) throw new Error('Wallet address or network mismatch.');
    const heights = new Map<string, number>();
    for (const tx of row.history) {
      if (!txid.test(tx.txid) || !Number.isSafeInteger(tx.height) || tx.height < -1 || tx.height > tip.height) throw new Error('Invalid wallet history.');
      if (heights.has(tx.txid)) throw new Error('Duplicate address history entry.');
      heights.set(tx.txid, tx.height);
      const existing = history.get(tx.txid);
      if (existing && existing.height !== tx.height) throw new ChangedSnapshot();
      history.set(tx.txid, {
        ...tx, timestampMs: tx.timestampMs ?? existing?.timestampMs, feeSats: tx.feeSats ?? existing?.feeSats,
      });
    }
    for (const u of row.utxos) {
      const outpoint = `${u.txid}:${u.vout}`;
      if (!txid.test(u.txid) || !Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff ||
          !/^\d{1,16}$/.test(u.satoshis) || BigInt(u.satoshis) > 2_100_000_000_000_000n || utxos.has(outpoint) ||
          !heights.has(u.txid) || Math.max(heights.get(u.txid)!, 0) !== u.height) throw new Error('Invalid or duplicate wallet UTXO.');
      const token = u.token;
      if (token && (!txid.test(token.categoryId) || !/^\d{1,19}$/.test(token.amount) || BigInt(token.amount) > 0x7fffffffffffffffn ||
          (token.nft ? !['none', 'mutable', 'minting'].includes(token.nft.capability) || !/^(?:[a-f\d]{2}){0,40}$/i.test(token.nft.commitment) : BigInt(token.amount) === 0n))) {
        throw new Error('Invalid wallet CashToken data.');
      }
      utxos.set(outpoint, {
        txid: u.txid, vout: u.vout, satoshis: BigInt(u.satoshis), address: owned.address,
        tokenAddress: checked.tokenAwareAddress, addressIndex: owned.index, derivationScope: owned.scope,
        isGenesisCapable: u.vout === 0, ...(token ? { token: { ...token, amount: BigInt(token.amount) } } : {}),
      });
    }
  }
  return { scanned, utxos: [...utxos.values()], history: [...history.values()], source: tip.source, height: tip.height, tip: tip.tip };
}

type Query = { id: number; timer: number; resolve: (batch: Batch) => void; reject: (error: Error) => void };
type Connection = { socket: WebSocket; ready: Promise<void>; detach: () => void };
type ChainPosition = Pick<Batch, 'tip' | 'height' | 'source'>;
const validPosition = ({ tip, height, source }: ChainPosition) =>
  /^[a-f\d]{160}$/i.test(tip) && Number.isSafeInteger(height) && height > 0 && typeof source === 'string' && !!source;

/** A single live watch for the selected account. Disconnects invalidate the exposed snapshot. */
export class WalletChainSync implements AccountChainSync {
  private wallet: WalletScan;
  private connection?: Connection;
  private pending?: Query;
  private running?: Promise<AccountChainSnapshot>;
  private queuedFresh?: Promise<AccountChainSnapshot>;
  private forceReading = false;
  private scanned?: Record<WalletBranch, number>;
  private snapshot?: AccountChainSnapshot & { tip: string };
  private dirty = true;
  private published?: WalletSyncState;
  private nextId = 0;
  private revision = 0;
  private reconnectAttempt = 0;
  private retryTimer?: number;
  private heartbeat = 0;
  private lastFrameAt = 0;
  private disposed = false;
  private online = typeof navigator === 'undefined' || navigator.onLine !== false;

  constructor(wallet: WalletScan, private onUpdate: (state: WalletSyncState) => void) {
    if ('derive' in wallet) {
      const addresses: Record<WalletBranch, string[]> = { receive: [], change: [] };
      this.wallet = { ...wallet, derive: (branch, index) => addresses[branch][index] ??= wallet.derive(branch, index) };
    } else this.wallet = wallet;
    window.addEventListener?.('online', this.onOnline);
    window.addEventListener?.('offline', this.onOffline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  refresh(fresh = false): Promise<AccountChainSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Wallet sync was closed.'));
    if (!this.online) {
      this.publish('unavailable');
      return Promise.reject(new Error('Browser is offline.'));
    }
    if (this.running) {
      if (!fresh || this.forceReading) return this.running;
      return this.queuedFresh ??= this.running.catch(() => {}).then(() => this.refresh(true)).finally(() => { this.queuedFresh = undefined; });
    }
    if (!fresh && !this.dirty && this.snapshot) return Promise.resolve(this.snapshot);
    this.clearRetry();
    this.forceReading = fresh;
    this.running = Promise.resolve().then(() => this.scan(fresh)).finally(() => { this.running = undefined; });
    return this.running;
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetry();
    window.removeEventListener?.('online', this.onOnline);
    window.removeEventListener?.('offline', this.onOffline);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (this.connection) this.drop(this.connection.socket);
    this.snapshot = undefined;
    this.published = undefined;
  }

  private publish(state: WalletSyncState) {
    if (this.disposed || state === this.published) return;
    this.published = state;
    this.onUpdate(state);
  }

  private clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private readonly onOffline = () => {
    this.online = false;
    this.clearRetry();
    if (this.connection) this.drop(this.connection.socket);
    else this.publish('unavailable');
  };

  private readonly onOnline = () => {
    this.online = true;
    this.reconnectAttempt = 0;
    if (this.connection) this.onVisible();
    else {
      this.clearRetry();
      this.scheduleReconnect(0);
    }
  };

  private readonly onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.connection && Date.now() - this.lastFrameAt > 36_000) this.drop(this.connection.socket, 0);
    else if (!this.connection && this.retryTimer !== undefined && this.online) {
      this.clearRetry();
      this.scheduleReconnect(0);
    }
  };

  private changed() {
    this.dirty = true;
    this.publish('syncing');
    void this.refresh().catch(() => {});
  }

  private newTip(position: ChainPosition) {
    if (!validPosition(position)) throw new Error('Invalid wallet chain tip.');
    const snapshot = this.snapshot;
    if (snapshot && !this.dirty && snapshot.source === position.source &&
        position.height === snapshot.height + 1 && position.tip.slice(8, 72).toLowerCase() === binToHex(hash256(hexToBin(snapshot.tip)))) {
      this.snapshot = { ...snapshot, tip: position.tip, height: position.height };
      this.publish(this.snapshot);
    } else {
      this.changed();
    }
  }

  private async scan(fresh: boolean): Promise<AccountChainSnapshot> {
    if (this.disposed || !this.online) throw new Error('Wallet sync is offline.');
    let connection: Connection | undefined;
    try {
      connection = this.connection ?? this.open();
      await connection.ready;
      const socket = connection.socket;
      for (let attempt = 0; attempt < 6; attempt++) {
        const revision = this.revision;
        try {
          let firstAddress: string | undefined;
          let batches = 0;
          const snapshot = await scanWalletAccount(this.wallet, addresses => {
            firstAddress ??= addresses[0];
            batches++;
            return this.read(socket, addresses, fresh);
          }, this.scanned);
          if (batches > 1 && firstAddress) {
            const check = await this.read(socket, [firstAddress], false, true);
            if (!check.verified) throw new Error('The wallet server cannot verify multi-batch sync.');
            if (check.tip !== snapshot.tip || check.height !== snapshot.height || check.source !== snapshot.source) throw new ChangedSnapshot();
          }
          if (this.connection !== connection || this.disposed) throw new Error('Wallet sync connection changed.');
          if (revision !== this.revision) throw new ChangedSnapshot();
          this.scanned = snapshot.scanned;
          this.reconnectAttempt = 0;
          this.snapshot = snapshot;
          this.dirty = false;
          this.publish(snapshot);
          return snapshot;
        } catch (error) {
          if (!(error instanceof ChangedSnapshot)) throw error;
          await new Promise(resolve => setTimeout(resolve, 75));
        }
      }
      throw new Error('BCH state changed during synchronization.');
    } catch (error) {
      if (connection) this.drop(connection.socket);
      else this.scheduleReconnect();
      throw error;
    }
  }

  private open(): Connection {
    const url = new URL('/ws/wallet', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const listeners = new AbortController();
    const signal = listeners.signal;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      socket.addEventListener('open', () => resolve(), { once: true, signal });
    });
    this.connection = { socket, ready, detach: () => { listeners.abort(); rejectReady(new Error('Wallet sync connection closed.')); } };
    this.publish('syncing');
    this.touch(socket);
    socket.addEventListener('error', () => this.drop(socket), { signal });
    socket.addEventListener('close', () => this.drop(socket), { signal });
    socket.addEventListener('message', event => {
      if (this.connection?.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data)) as WalletSyncMessage;
        this.touch(socket);
        if (message.type === 'changed') {
          this.revision++;
          this.changed();
        } else if (message.type === 'tip') {
          this.revision++;
          this.newTip(message);
        } else if ((message.type === 'snapshot' || message.type === 'retry') && this.pending?.id === message.id) {
          const query = this.pending;
          this.pending = undefined;
          clearTimeout(query.timer);
          if (message.type === 'retry') query.reject(new ChangedSnapshot());
          else {
            if (!validPosition(message) || !Array.isArray(message.addresses)) {
              query.reject(new Error('Invalid wallet snapshot.'));
            } else query.resolve(message);
          }
        }
      } catch { this.drop(socket); }
    }, { signal });
    return this.connection;
  }

  private read(socket: WebSocket, addresses: string[], fresh: boolean, verify = false): Promise<Batch> {
    if (this.connection?.socket !== socket || socket.readyState !== WebSocket.OPEN || this.pending) return Promise.reject(new Error('Wallet sync is offline.'));
    return new Promise((resolve, reject) => {
      const request: WalletSyncRequest = { id: ++this.nextId, network: this.wallet.network, addresses, fresh, tipUpdates: true, ...(verify && { verify: true }) };
      const timer = window.setTimeout(() => this.drop(socket), 24_000);
      this.pending = { id: request.id, resolve, reject, timer };
      socket.send(JSON.stringify(request));
    });
  }

  private touch(socket: WebSocket) {
    clearTimeout(this.heartbeat);
    this.lastFrameAt = Date.now();
    this.heartbeat = window.setTimeout(() => this.drop(socket), 36_000);
  }

  private drop(socket: WebSocket, delay?: number) {
    const connection = this.connection;
    if (connection?.socket !== socket) return;
    this.connection = undefined;
    this.snapshot = undefined;
    this.dirty = true;
    clearTimeout(this.heartbeat);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Wallet sync connection closed.'));
      this.pending = undefined;
    }
    connection.detach();
    if (socket.readyState < 2) socket.close();
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay?: number) {
    if (this.disposed) return;
    this.publish('unavailable');
    if (!this.online || this.retryTimer !== undefined) return;
    const wait = delay ?? Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.refresh().catch(() => {});
    }, wait);
  }
}
