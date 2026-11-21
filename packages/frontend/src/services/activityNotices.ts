import type { BchNetwork, ConfigurableMarket } from '@cashingularity/shared';
import type { PaperPosition } from './paperTrading.js';
import type { WalletTransaction } from './transactionHistory.js';

export type WalletNoticeScope = `chain:${BchNetwork}:${string}`;
export type ActivityScope = WalletNoticeScope | `paper:${string}`;

export interface ActivityNotice {
  id: string;
  scope: ActivityScope;
  kind: 'transfer' | 'confirmation' | 'signing' | 'connection' | 'resolution';
  title: string;
  detail?: string;
  timeMs: number;
  read?: boolean;
}

export function walletNoticeScope(profileId: string, network: BchNetwork): WalletNoticeScope {
  return `chain:${network}:${profileId}`;
}

export function paperNoticeScope(profileId: string): ActivityScope {
  return `paper:${profileId}`;
}

export function visibleActivity(notices: ActivityNotice[], scope?: ActivityScope): ActivityNotice[] {
  return scope ? notices.filter(notice => notice.scope === scope) : [];
}

function roundKey(marketId: number, expiry: number, series?: string): string {
  return series ? `series:${series}:${expiry}` : `market:${marketId}:${expiry}`;
}

export function paperResolutionNotices(
  profileId: string,
  positions: readonly PaperPosition[],
  markets: readonly ConfigurableMarket[],
  nowMs: number,
): ActivityNotice[] {
  if (positions.length === 0) return [];
  const scope = paperNoticeScope(profileId);
  const enteredRounds = new Set(positions.map(position =>
    roundKey(position.marketId, position.expiresAtMs, position.epochSeriesId),
  ));
  const notices: ActivityNotice[] = [];
  const resolvedRounds = new Set<string>();
  for (const market of markets) {
    const key = roundKey(market.marketId, market.expiryTimestampMs, market.epochSeriesId);
    const outcome = market.buckets.find(bucket => bucket.bucketId === market.resolvedOutcome);
    const close = (market.resolutionPriceCents ?? 0) / 100;
    if (!enteredRounds.has(key) || resolvedRounds.has(key) || market.status !== 'RESOLVED' ||
        !Number.isFinite(market.expiryTimestampMs) || market.expiryTimestampMs > nowMs ||
        !outcome || !Number.isFinite(close) || close <= 0) continue;
    resolvedRounds.add(key);
    notices.push({
      id: `resolution:${scope}:${key}`,
      scope,
      kind: 'resolution',
      title: 'Market resolved',
      detail: `Paper Trading · ${market.assetPair} ${market.timeframe ?? ''} · ${outcome.label} · $${close.toFixed(2)} close`,
      timeMs: nowMs,
    });
  }
  return notices;
}

/** Compare chain activity with pending transactions observed by the same profile or sent by it. */
export function observeConfirmations(
  profileId: string,
  scope: WalletNoticeScope,
  pending: ReadonlySet<string> | undefined,
  rows: readonly WalletTransaction[],
  receipts: readonly WalletTransaction[],
  nowMs: number,
): { pending: Set<string>; notices: ActivityNotice[] } {
  const tracked = new Set(pending);
  const notices: ActivityNotice[] = [];
  const localReceipts = new Map(receipts.filter(row => row.initiatorProfileId).map(row => [row.txid, row]));
  const observations = new Map<string, boolean>();
  for (const row of rows) {
    if (typeof row.confirmed === 'boolean') observations.set(row.txid, observations.get(row.txid) === true || row.confirmed);
  }
  for (const [txid, confirmed] of observations) {
    const receipt = localReceipts.get(txid);
    if (receipt && receipt.initiatorProfileId !== profileId) {
      tracked.delete(txid);
      continue;
    }
    if (!confirmed) {
      tracked.add(txid);
      continue;
    }
    if (tracked.delete(txid) || receipt?.confirmed === false) notices.push({
      id: `confirmation:${scope}:${txid}`, scope, kind: 'confirmation',
      title: 'Transaction confirmed', detail: `${txid.slice(0, 10)}…${txid.slice(-6)}`, timeMs: nowMs,
    });
  }
  return { pending: new Set([...tracked].slice(-1000)), notices };
}
