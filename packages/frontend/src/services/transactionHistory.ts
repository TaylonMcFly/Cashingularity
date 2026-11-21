import type { PreparedPayment } from "./paymentService.js";
import type { BchNetwork, WalletSyncTransaction } from '@cashingularity/shared';
export interface WalletTransaction {
  txid: string; address: string; network: "mainnet" | "chipnet"; label: string; timestamp: number;
  amountSats: string | null; feeSats: string | null; totalSats: string | null; priceUsd: number | null;
  confirmed?: boolean;
  confirmations?: number;
  initiatorProfileId?: string;
}

export function liveWalletHistory(rows: readonly WalletSyncTransaction[], address: string, network: BchNetwork, height: number): WalletTransaction[] {
  return [...rows].sort((a, b) => Number(a.height > 0) - Number(b.height > 0) || b.height - a.height || (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .map(row => ({
      address, network, txid: row.txid, label: 'On-chain transaction', timestamp: row.timestampMs ?? 0,
      amountSats: null, feeSats: row.feeSats ?? null, totalSats: null, priceUsd: null,
      confirmed: row.height > 0, confirmations: row.height > 0 ? height - row.height + 1 : 0,
    }));
}

/** Receipts decorate current chain activity. An orphaned or dropped tx is never restored from storage. */
export function reconcileWalletHistory(chain: WalletTransaction[], receipts: WalletTransaction[], profileId: string): WalletTransaction[] {
  if (!chain.length) return [];
  const { network, address } = chain[0];
  const byId = new Map(receipts.filter(row => row.network === network && row.address === address && row.initiatorProfileId === profileId)
    .map(row => [row.txid, row]));
  return chain.map(row => {
    const receipt = byId.get(row.txid);
    return receipt ? { ...receipt, timestamp: row.timestamp || receipt.timestamp, confirmed: row.confirmed, confirmations: row.confirmations } : row;
  });
}
const KEY = "cashingularity.transactions.v1";
export function transactionAmounts(payment: Pick<PreparedPayment, "dag">) {
  const amount = payment.dag.outputs.filter(o => !o.isChange).reduce((sum,o)=>sum+o.satoshis,0n);
  const fee = payment.dag.audit.minerFeeSats;
  return { amountSats: amount.toString(), feeSats: fee.toString(), totalSats: (amount+fee).toString() };
}
export function readTransactionHistory(): WalletTransaction[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is WalletTransaction => !!r && /^[a-f0-9]{64}$/i.test(r.txid) && typeof r.address === "string" && ["mainnet","chipnet"].includes(r.network) && typeof r.label === "string" && Number.isFinite(r.timestamp) && [r.amountSats,r.feeSats,r.totalSats].every(v=>v === null || (typeof v === "string" && /^\d{1,16}$/.test(v))) && (r.priceUsd === null || (Number.isFinite(r.priceUsd) && r.priceUsd>0)) && (r.initiatorProfileId === undefined || typeof r.initiatorProfileId === 'string')).slice(0,1000);
  } catch { return []; }
}
export function saveTransactionHistory(rows: WalletTransaction[]): void {
  localStorage.setItem(KEY, JSON.stringify(rows.slice(0,1000).map(({txid,address,network,label,timestamp,amountSats,feeSats,totalSats,priceUsd,confirmed,initiatorProfileId})=>({txid,address,network,label,timestamp,amountSats,feeSats,totalSats,priceUsd,confirmed,initiatorProfileId}))));
}
export function transactionExplorer(row: Pick<WalletTransaction,"network"|"txid">): string {
  return row.network === "chipnet" ? `https://chipnet.chaingraph.cash/tx/${row.txid}` : `https://blockchair.com/bitcoin-cash/transaction/${row.txid}`;
}
export function mergeWalletTransactions(
  localRows: WalletTransaction[],
  chainRows: WalletTransaction[],
): WalletTransaction[] {
  const byTxid = new Map<string, WalletTransaction>();
  for (const row of localRows) {
    byTxid.set(`${row.network}:${row.address}:${row.txid.toLowerCase()}`, row);
  }
  for (const row of chainRows) {
    const key = `${row.network}:${row.address}:${row.txid.toLowerCase()}`;
    const existing = byTxid.get(key);
    if (!existing) {
      byTxid.set(key, row);
    } else {
      byTxid.set(key, { ...existing, timestamp: existing.timestamp || row.timestamp, confirmed: row.confirmed ?? existing.confirmed });
    }
  }
  return [...byTxid.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 1000);
}
export async function fetchChainHistoryApi(
  address: string,
  network: "mainnet" | "chipnet",
  refresh = false,
): Promise<WalletTransaction[]> {
  try {
    const params = `address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}${refresh ? '&refresh=true' : ''}`;
    let res = await fetch(`/api/chain/history?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      res = await fetch(`/api/wallet/history?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (!res.ok) return [];
    const data = (await res.json()) as {
      history?: Array<{
        txid: string;
        confirmed: boolean;
        timestampMs?: number;
        amountSats?: string | null;
        feeSats?: string;
        direction?: string;
      }>;
    };
    if (!Array.isArray(data.history)) return [];
    return data.history
      .filter((h) => /^[a-f0-9]{64}$/i.test(h.txid))
      .map((h) => {
        const amt = typeof h.amountSats === "string" && /^\d{1,16}$/.test(h.amountSats) ? h.amountSats : null;
        const fee = typeof h.feeSats === "string" && /^\d{1,16}$/.test(h.feeSats) ? h.feeSats : null;
        return {
          txid: h.txid.toLowerCase(),
          address,
          network,
          label: h.direction === "INCOMING" ? "On-chain receive" : h.confirmed ? "Confirmed tx" : "Unconfirmed tx",
          timestamp: Number.isFinite(h.timestampMs) && h.timestampMs! > 0 ? h.timestampMs! : 0,
          amountSats: amt,
          feeSats: fee,
          totalSats: amt !== null && fee !== null ? (BigInt(amt) + BigInt(fee)).toString() : null,
          priceUsd: null,
          confirmed: typeof h.confirmed === 'boolean' ? h.confirmed : undefined,
        };
      });
  } catch {
    return [];
  }
}
