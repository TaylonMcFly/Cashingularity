/**
 * @cashingularity/backend - Real Bitcoin Cash Mainnet & Chipnet Electrum/Fulcrum Network Service
 * Connects to live Fulcrum TLS servers (port 50002) for real on-chain UTXO lookups, balances,
 * and raw transaction hex broadcasting (`blockchain.transaction.broadcast`).
 */

import {
  binToHex,
  hashTransaction,
  hexToBin,
  decodeTransaction,
  cashAddressToLockingBytecode,
  sha256,
} from '@bitauth/libauth';
import {
  BchNetwork,
  CashTokenCapability,
  CashTokenData,
  validateAndConvertCashAddr,
  WalletUtxo,
} from '@cashingularity/shared';
import tls from 'node:tls';

export interface FulcrumEndpoint {
  host: string;
  port: number;
  network: BchNetwork;
}

const MAINNET_FULCRUM_SERVERS: FulcrumEndpoint[] = [
  { host: 'bch.loping.net', port: 50002, network: 'mainnet' },
  { host: 'electroncash.de', port: 50002, network: 'mainnet' },
  { host: 'fulcrum.greyh.at', port: 50002, network: 'mainnet' },
  { host: 'bch.imaginary.cash', port: 50002, network: 'mainnet' },
];

const CHIPNET_FULCRUM_SERVERS: FulcrumEndpoint[] = [
  { host: 'chipnet.bch.ninja', port: 50002, network: 'chipnet' },
  { host: 'chipnet.imaginary.cash', port: 50002, network: 'chipnet' },
];

export function fulcrumEndpoints(network: BchNetwork): readonly FulcrumEndpoint[] {
  return network === 'chipnet' ? CHIPNET_FULCRUM_SERVERS : MAINNET_FULCRUM_SERVERS;
}

interface ElectrumUnspentItem {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  token_data?: {
    category: string;
    amount?: string | number;
    nft?: {
      capability?: 'none' | 'mutable' | 'minting';
      commitment?: string;
    };
  };
}

export function decodeFulcrumUtxos(raw: unknown, info: ReturnType<typeof cashAddrToElectrumScriptHash>): Array<WalletUtxo & { height: number }> {
  if (!Array.isArray(raw)) throw new Error('Invalid Fulcrum UTXO response.');
  const seen = new Set<string>();
  return (raw as ElectrumUnspentItem[]).map(u => {
    const txid = String(u.tx_hash).toLowerCase();
    const outpoint = `${txid}:${u.tx_pos}`;
    if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isInteger(u.tx_pos) || u.tx_pos < 0 || u.tx_pos > 0xffffffff ||
        !Number.isSafeInteger(u.value) || u.value < 0 || u.value > 2_100_000_000_000_000 ||
        !Number.isSafeInteger(u.height) || u.height < 0 || seen.has(outpoint)) throw new Error('Invalid or duplicate Fulcrum UTXO.');
    seen.add(outpoint);
    let token: CashTokenData | undefined;
    if (u.token_data) {
      const { category, nft } = u.token_data;
      const capability: CashTokenCapability = nft?.capability ?? 'none';
      const amount = String(u.token_data.amount ?? 0);
      const commitment = nft?.commitment ?? '';
      if (!/^[a-f0-9]{64}$/i.test(category) || !/^\d+$/.test(amount) || BigInt(amount) > 0x7fffffffffffffffn ||
          !['none', 'mutable', 'minting'].includes(capability) || !/^(?:[a-f0-9]{2}){0,40}$/i.test(commitment) ||
          (typeof u.token_data.amount === 'number' && !Number.isSafeInteger(u.token_data.amount)) || (!nft && BigInt(amount) === 0n)) {
        throw new Error('Invalid Fulcrum CashToken data.');
      }
      token = { categoryId: category.toLowerCase(), amount: BigInt(amount), ...(nft ? { nft: { capability, commitment } } : {}) };
    }
    return {
      txid, vout: u.tx_pos, satoshis: BigInt(u.value), height: u.height,
      address: info.standardAddress, tokenAddress: info.tokenAwareAddress, derivationScope: 'receive',
      addressIndex: 0, isGenesisCapable: u.tx_pos === 0, token,
    };
  });
}

interface ElectrumBalanceResult {
  confirmed: number;
  unconfirmed: number;
}

/**
 * Converts a Bitcoin Cash address (`bitcoincash:...` or `bchtest:...`) to an Electrum/Fulcrum
 * scriptHash (reversed SHA-256 of the locking bytecode).
 */
export function cashAddrToElectrumScriptHash(cashAddr: string): {
  scriptHash: string;
  lockingBytecodeHex: string;
  network: BchNetwork;
  standardAddress: string;
  tokenAwareAddress: string;
} {
  const validation = validateAndConvertCashAddr(cashAddr);
  if (!validation.valid || !validation.standardAddress || !validation.tokenAwareAddress) {
    throw new Error(`Invalid CashAddr: ${validation.error ?? cashAddr}`);
  }

  const decoded = cashAddressToLockingBytecode(validation.standardAddress);
  if (typeof decoded === 'string') {
    throw new Error(`Failed to decode locking bytecode: ${decoded}`);
  }

  const digest = sha256.hash(decoded.bytecode);
  const reversed = Uint8Array.from(digest).reverse();

  return {
    scriptHash: binToHex(reversed),
    lockingBytecodeHex: binToHex(decoded.bytecode),
    network: validation.network ?? 'mainnet',
    standardAddress: validation.standardAddress,
    tokenAwareAddress: validation.tokenAwareAddress,
  };
}

export interface AddressUtxoLookupResult {
  address: string;
  tokenAwareAddress: string;
  network: BchNetwork;
  scriptHash: string;
  confirmedSats: bigint;
  unconfirmedSats: bigint;
  totalBalanceSats: bigint;
  utxos: WalletUtxo[];
  source: string;
  cached?: boolean;
}

export interface AddressHistoryEntry {
  txid: string;
  height: number;
  confirmed: boolean;
  timestampMs?: number;
  amountSats: string | null;
  feeSats?: string;
  direction?: 'INCOMING' | 'OUTGOING' | 'ACTIVITY';
  explorerUrl: string;
  source: string;
}

export interface AddressHistoryLookupResult {
  address: string;
  tokenAwareAddress: string;
  network: BchNetwork;
  scriptHash: string;
  history: AddressHistoryEntry[];
  source: string;
  cached?: boolean;
}

interface ElectrumHistoryItem {
  tx_hash: string;
  height: number;
  fee?: number;
}

interface ElectrumVerboseTx {
  txid?: string;
  blocktime?: number;
  time?: number;
  vout?: Array<{
    value?: number;
    scriptPubKey?: {
      hex?: string;
      addresses?: string[];
    };
  }>;
}

/**
 * Executes a single JSON-RPC 2.0 call over TLS to a Fulcrum server with a strict 2500ms timeout.
 */
async function callFulcrumTls<T>(
  endpoint: FulcrumEndpoint,
  method: string,
  params: unknown[],
  timeoutMs = 2500
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const socket = tls.connect(
      {
        host: endpoint.host,
        servername: endpoint.host,
        port: endpoint.port,
        rejectUnauthorized: true,
      },
      () => {
        const payload =
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
          }) + '\n';
        socket.write(payload);
      }
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Timeout (${timeoutMs}ms) connecting to ${endpoint.host}:${endpoint.port}`));
      }
    }, timeoutMs);

    const MAX_FULCRUM_RESPONSE_BYTES = 4 * 1024 * 1024;
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (Buffer.byteLength(buffer, 'utf8') + chunk.length > MAX_FULCRUM_RESPONSE_BYTES) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Fulcrum response exceeded ${MAX_FULCRUM_RESPONSE_BYTES} byte limit.`));
        return;
      }
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        const line = buffer.slice(0, newlineIdx).trim();
        socket.end();
        try {
          const parsed = JSON.parse(line) as {
            result?: T;
            error?: { code?: number; message?: string } | string;
          };
          if (parsed.error) {
            const msg =
              typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error.message ?? JSON.stringify(parsed.error);
            reject(new Error(msg));
            return;
          }
          resolve(parsed.result as T);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Fulcrum connection closed prematurely by ${endpoint.host}:${endpoint.port}.`));
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
    });
  });
}

export class BchNetworkService {
  private static readonly UTXO_CACHE_TTL_MS = 15_000;
  private static readonly SOCKET_TIMEOUT_MS = 2500;
  private static readonly MAX_CACHE_ENTRIES = 500;

  private readonly utxoCache = new Map<
    string,
    { expiresAtMs: number; result: AddressUtxoLookupResult }
  >();
  private readonly inFlightLookups = new Map<string, Promise<AddressUtxoLookupResult>>();
  private readonly historyCache = new Map<
    string,
    { expiresAtMs: number; result: AddressHistoryLookupResult }
  >();
  private readonly inFlightHistory = new Map<string, Promise<AddressHistoryLookupResult>>();

  private setBoundedCache<V>(cache: Map<string, V>, key: string, value: V): void {
    if (!cache.has(key) && cache.size >= BchNetworkService.MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, value);
  }

  /**
   * Queries real Fulcrum servers for an address's live confirmed/unconfirmed balance and UTXO set.
   * Uses a 15-second in-memory cache per address, in-flight request deduplication, and parallel
   * Fulcrum server racing with a strict 2500ms socket timeout so new/empty wallets resolve fast.
   */
  public async fetchAddressUtxos(
    address: string,
    preferredNetwork?: BchNetwork,
    forceRefresh = false
  ): Promise<AddressUtxoLookupResult> {
    const info = cashAddrToElectrumScriptHash(address);
    if (preferredNetwork && preferredNetwork !== info.network) throw new Error('Address network does not match the requested network.');
    const network = preferredNetwork ?? info.network;
    const cacheKey = `${network}:${info.standardAddress}`;
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.utxoCache.get(cacheKey);
      if (cached && now < cached.expiresAtMs) {
        return { ...cached.result, cached: true };
      }
    }

    const existingInFlight = this.inFlightLookups.get(cacheKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const lookupPromise = this.performFulcrumUtxoLookup(info, network)
      .then((result) => {
        this.setBoundedCache(this.utxoCache, cacheKey, {
          expiresAtMs: Date.now() + BchNetworkService.UTXO_CACHE_TTL_MS,
          result,
        });
        return result;
      })
      .finally(() => {
        this.inFlightLookups.delete(cacheKey);
      });

    this.inFlightLookups.set(cacheKey, lookupPromise);
    return lookupPromise;
  }

  private async performFulcrumUtxoLookup(
    info: ReturnType<typeof cashAddrToElectrumScriptHash>,
    network: BchNetwork
  ): Promise<AddressUtxoLookupResult> {
    const servers = fulcrumEndpoints(network);

    const querySingleEndpoint = async (
      endpoint: FulcrumEndpoint
    ): Promise<AddressUtxoLookupResult> => {
      const rawUtxos = await callFulcrumTls<ElectrumUnspentItem[]>(
        endpoint,
        'blockchain.scripthash.listunspent',
        [info.scriptHash, 'include_tokens'],
        BchNetworkService.SOCKET_TIMEOUT_MS
      );

      let confirmedSats = 0n;
      let unconfirmedSats = 0n;

      const utxos = decodeFulcrumUtxos(rawUtxos, info);
      for (const utxo of utxos) {
        if (utxo.height > 0) confirmedSats += utxo.satoshis;
        else unconfirmedSats += utxo.satoshis;
      }

      const totalBalanceSats = confirmedSats + unconfirmedSats;

      return {
        address: info.standardAddress,
        tokenAwareAddress: info.tokenAwareAddress,
        network,
        scriptHash: info.scriptHash,
        confirmedSats,
        unconfirmedSats,
        totalBalanceSats,
        utxos,
        source: `fulcrum://${endpoint.host}:${endpoint.port}`,
      };
    };

    if (network === 'chipnet') {
      const settled = await Promise.allSettled(servers.map((ep) => querySingleEndpoint(ep)));
      const fulfilled = settled
        .filter(
          (s): s is PromiseFulfilledResult<AddressUtxoLookupResult> => s.status === 'fulfilled'
        )
        .map((s) => s.value)
        .sort((a, b) => b.utxos.length - a.utxos.length);
      if (fulfilled.length > 0) {
        return fulfilled[0];
      }
      const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      throw new Error(
        `Unable to reach ${network} Fulcrum servers: ${rejected?.reason?.message ?? 'connection failed'}`
      );
    }

    try {
      return await Promise.any(servers.map((ep) => querySingleEndpoint(ep)));
    } catch (err) {
      const aggErr = err as { errors?: Error[]; message?: string };
      const firstMsg = aggErr.errors?.[0]?.message ?? aggErr.message ?? 'connection failed';
      throw new Error(`Unable to reach ${network} Fulcrum servers: ${firstMsg}`);
    }
  }

  /**
   * Queries Fulcrum (`blockchain.scripthash.get_history` + best-effort tx details)
   * for an address's confirmed and mempool transaction history.
   */
  public async fetchAddressHistory(
    address: string,
    preferredNetwork?: BchNetwork,
    forceRefresh = false
  ): Promise<AddressHistoryLookupResult> {
    const info = cashAddrToElectrumScriptHash(address);
    if (preferredNetwork && preferredNetwork !== info.network) {
      throw new Error('Address network does not match the requested network.');
    }
    const network = preferredNetwork ?? info.network;
    const cacheKey = `${network}:${info.standardAddress}`;
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.historyCache.get(cacheKey);
      if (cached && now < cached.expiresAtMs) {
        return { ...cached.result, cached: true };
      }
    }

    const existing = this.inFlightHistory.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = this.performFulcrumHistoryLookup(info, network)
      .then((result) => {
        this.setBoundedCache(this.historyCache, cacheKey, {
          expiresAtMs: Date.now() + BchNetworkService.UTXO_CACHE_TTL_MS,
          result,
        });
        return result;
      })
      .finally(() => {
        this.inFlightHistory.delete(cacheKey);
      });

    this.inFlightHistory.set(cacheKey, promise);
    return promise;
  }

  private async performFulcrumHistoryLookup(
    info: ReturnType<typeof cashAddrToElectrumScriptHash>,
    network: BchNetwork
  ): Promise<AddressHistoryLookupResult> {
    const servers =
      network === 'chipnet' ? CHIPNET_FULCRUM_SERVERS : MAINNET_FULCRUM_SERVERS;

    const queryEndpoint = async (
      endpoint: FulcrumEndpoint
    ): Promise<AddressHistoryLookupResult> => {
      const rawHistory = await callFulcrumTls<ElectrumHistoryItem[]>(
        endpoint,
        'blockchain.scripthash.get_history',
        [info.scriptHash],
        BchNetworkService.SOCKET_TIMEOUT_MS
      );
      if (!Array.isArray(rawHistory)) {
        throw new Error('Invalid Fulcrum history response.');
      }

      const recent = rawHistory
        .filter((item) => /^[a-f0-9]{64}$/i.test(item.tx_hash))
        .slice(-20)
        .reverse();

      const sourceLabel = `fulcrum://${endpoint.host}:${endpoint.port}`;
      const explorerPrefix =
        network === 'chipnet'
          ? 'https://chipnet.chaingraph.cash/tx/'
          : 'https://blockchair.com/bitcoin-cash/transaction/';

      const details = await Promise.allSettled(
        recent.slice(0, 10).map((item) =>
          callFulcrumTls<ElectrumVerboseTx>(
            endpoint,
            'blockchain.transaction.get',
            [item.tx_hash, true],
            BchNetworkService.SOCKET_TIMEOUT_MS
          )
        )
      );

      const history: AddressHistoryEntry[] = recent.map((item, idx) => {
        const txid = item.tx_hash.toLowerCase();
        const detail = details[idx]?.status === 'fulfilled' ? details[idx].value : undefined;
        const blockSec = detail?.blocktime ?? detail?.time;
        // A transaction's outputs alone cannot identify a wallet's net spend:
        // incoming outputs may be change, and other recipients are not this wallet.
        const amountSats = null;

        return {
          txid,
          height: Number(item.height ?? 0),
          confirmed: Number(item.height ?? 0) > 0,
          ...(blockSec && Number.isFinite(blockSec) ? { timestampMs: blockSec * 1000 } : {}),
          amountSats,
          ...(typeof item.fee === 'number' && Number.isSafeInteger(item.fee) && item.fee >= 0
            ? { feeSats: item.fee.toString() }
            : {}),
          direction: 'ACTIVITY',
          explorerUrl: `${explorerPrefix}${txid}`,
          source: sourceLabel,
        };
      });

      return {
        address: info.standardAddress,
        tokenAwareAddress: info.tokenAwareAddress,
        network,
        scriptHash: info.scriptHash,
        history,
        source: sourceLabel,
      };
    };

    try {
      return await Promise.any(servers.map((ep) => queryEndpoint(ep)));
    } catch (err) {
      const aggErr = err as { errors?: Error[]; message?: string };
      const firstMsg = aggErr.errors?.[0]?.message ?? aggErr.message ?? 'connection failed';
      throw new Error(`Unable to reach ${network} Fulcrum history servers: ${firstMsg}`);
    }
  }

  /**
   * Broadcasts a raw signed transaction hex to Bitcoin Cash Mainnet or Chipnet Fulcrum servers.
   */
  public async broadcastRawTransaction(
    rawTxHex: string,
    network: BchNetwork = 'mainnet'
  ): Promise<{
    txid: string;
    network: BchNetwork;
    broadcasted: boolean;
    explorerUrl: string;
    source: string;
  }> {
    if (network !== 'mainnet' && network !== 'chipnet') throw new Error('Invalid BCH broadcast network.');
    const cleanHex = rawTxHex.trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{20,}$/i.test(cleanHex) || cleanHex.length % 2 !== 0) {
      throw new Error('Invalid rawTxHex: expected even-length hexadecimal transaction bytes.');
    }

    const bytes = hexToBin(cleanHex);
    if (typeof decodeTransaction(bytes) === 'string') throw new Error('Invalid serialized transaction.');
    const expectedTxid = hashTransaction(bytes);
    const servers = fulcrumEndpoints(network);

    let lastError: Error | null = null;

    for (const endpoint of servers) {
      try {
        const txid = await callFulcrumTls<string>(endpoint, 'blockchain.transaction.broadcast', [cleanHex], 5000)
          .catch(async error => {
            // Some wallets submit the transaction themselves. Verify the exact transaction on-chain or in the mempool.
            if (!/already|missing.?inputs/i.test(error instanceof Error ? error.message : String(error))) throw error;
            const known = await callFulcrumTls<string>(endpoint, 'blockchain.transaction.get', [expectedTxid, false]);
            if (typeof known !== 'string' || known.toLowerCase() !== cleanHex.toLowerCase()) throw error;
            return expectedTxid;
          });

        const cleanTxid = String(txid).trim().toLowerCase();
        if (cleanTxid !== expectedTxid) throw new Error('Broadcast server returned a mismatched transaction ID.');
        this.utxoCache.clear();
        const explorerUrl =
          network === 'chipnet'
            ? `https://chipnet.chaingraph.cash/tx/${cleanTxid}`
            : `https://blockchair.com/bitcoin-cash/transaction/${cleanTxid}`;

        return {
          txid: cleanTxid,
          network,
          broadcasted: true,
          explorerUrl,
          source: `fulcrum://${endpoint.host}:${endpoint.port}`,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(
      `Broadcast failed across ${network} Fulcrum nodes: ${lastError?.message ?? 'unknown error'}`
    );
  }
}
