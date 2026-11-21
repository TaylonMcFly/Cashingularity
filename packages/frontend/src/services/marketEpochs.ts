import { isMarketOpenAt, type ConfigurableMarket } from "@cashingularity/shared";

export type EpochMarket = ConfigurableMarket;
export const MARKET_TIMEFRAMES = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3600 },
  { label: '24h', seconds: 86400 },
] as const;
export type EpochTimeframe = typeof MARKET_TIMEFRAMES[number]['label'];
export type MarketCategory = 'All' | EpochTimeframe;
export type MarketFeedState = 'loading' | 'ready' | 'unavailable';
export type EpochSeries = Pick<ConfigurableMarket, 'assetPair' | 'durationSeconds' | 'epochSeriesId'> & { marketId?: number };

export function bchSeries(timeframe: EpochTimeframe): EpochSeries {
  return { assetPair: 'BCH/USD', durationSeconds: MARKET_TIMEFRAMES.find(frame => frame.label === timeframe)!.seconds, epochSeriesId: `bchusd-${timeframe}` };
}

export function isLiveEpoch(market: ConfigurableMarket, now: number): boolean {
  return isMarketOpenAt(market, now);
}

/** Prefer a real rolling slot over a stale curated alias or a future record. */
export function findLiveEpoch(
  markets: ConfigurableMarket[],
  selected: EpochSeries,
  now: number,
): ConfigurableMarket | undefined {
  return markets.filter(m => m.assetPair === selected.assetPair && m.durationSeconds === selected.durationSeconds &&
    (!selected.epochSeriesId || m.epochSeriesId === selected.epochSeriesId) &&
    isLiveEpoch(m, now))
    .sort((a, b) => Number(!!b.epochKey) - Number(!!a.epochKey) || b.createdAtMs - a.createdAtMs)[0];
}
export function matchesMarketCategory(
  market: ConfigurableMarket,
  category: MarketCategory,
): boolean {
  return category === 'All' || MARKET_TIMEFRAMES.some(frame => frame.label === category && frame.seconds === market.durationSeconds);
}
/** Only navigate actual market records in the same explicit series. */
export function availableEpochs(
  markets: ConfigurableMarket[],
  selected: EpochSeries,
  now: number,
): ConfigurableMarket[] {
  const series = selected.epochSeriesId;
  return markets
    .filter((m) => {
      const same =
        m.marketId === selected.marketId ||
        (!!series &&
          m.epochSeriesId === series &&
          m.assetPair === selected.assetPair &&
          m.durationSeconds === selected.durationSeconds);
      return (
        same &&
        Number.isFinite(m.expiryTimestampMs) &&
        m.expiryTimestampMs >= now - 7 * 86_400_000 &&
        m.expiryTimestampMs <= now + 86_400_000
      );
    })
    .sort(
      (a, b) =>
        a.expiryTimestampMs - b.expiryTimestampMs || a.marketId - b.marketId,
    );
}
export function epochState(
  market: ConfigurableMarket,
  now: number,
): "Reported" | "Ended" | "Upcoming" | "Live" {
  if (market.status === "RESOLVED") return "Reported";
  if (
    market.expiryTimestampMs <= now ||
    market.status === "REFUNDED" ||
    market.status === "LOCKED"
  )
    return "Ended";
  return market.createdAtMs > now ? "Upcoming" : "Live";
}

/**
 * Slices a sorted epoch list to at most `maxSlots` (default 9) centered around
 * `selectedMarketId` (e.g. up to 4 past + active + up to 4 upcoming).
 */
export function focusedEpochWindow<T extends { marketId: number }>(
  epochs: T[],
  selectedMarketId: number,
  maxSlots = 9,
): T[] {
  if (maxSlots <= 0) return [];
  if (epochs.length <= maxSlots) return epochs;
  const selectedIdx = epochs.findIndex((m) => m.marketId === selectedMarketId);
  if (selectedIdx === -1) {
    return epochs.slice(0, maxSlots);
  }
  const half = Math.floor(maxSlots / 2);
  let start = selectedIdx - half;
  if (start < 0) start = 0;
  if (start + maxSlots > epochs.length) {
    start = Math.max(0, epochs.length - maxSlots);
  }
  return epochs.slice(start, start + maxSlots);
}

export type ResolvedOutcomeKind = "ABOVE" | "BELOW" | "RANGE";

/** Returns structured outcome rule (`ABOVE` | `BELOW` | `RANGE`) for a resolved market. */
export function resolvedOutcomeBadge(
  market: ConfigurableMarket,
): ResolvedOutcomeKind | undefined {
  if (market.status !== "RESOLVED" || market.resolvedOutcome === undefined) {
    return undefined;
  }
  const winningBucket = market.buckets?.find(
    (b) => b.bucketId === market.resolvedOutcome,
  );
  if (winningBucket?.outcomeRule) {
    return winningBucket.outcomeRule;
  }
  const upperLabel = winningBucket?.label?.toUpperCase() ?? "";
  if (upperLabel.includes("RANGE")) return "RANGE";
  if (upperLabel.includes("BELOW") || upperLabel.includes("BEAR")) return "BELOW";
  if (upperLabel.includes("ABOVE") || upperLabel.includes("BULL")) return "ABOVE";
  return undefined;
}

export function epochTimeframeFor(seconds: number, custom = false): EpochTimeframe {
  return custom ? '5m' : MARKET_TIMEFRAMES.find(frame => frame.seconds === seconds)?.label ?? '5m';
}

export function epochResult(market: ConfigurableMarket, now: number): { direction: 'UP' | 'DOWN' | 'FLAT'; spreadCents: number; closeCents: number } | undefined {
  const closeCents = market.resolutionPriceCents;
  if (market.status !== 'RESOLVED' || !(market.expiryTimestampMs <= now) || closeCents === undefined ||
      !Number.isSafeInteger(closeCents) || closeCents <= 0 || !Number.isSafeInteger(market.strikePriceCents) || market.strikePriceCents <= 0) return;
  const spreadCents = closeCents - market.strikePriceCents;
  return { direction: spreadCents > 0 ? 'UP' : spreadCents < 0 ? 'DOWN' : 'FLAT', spreadCents, closeCents };
}

export function formatEpochSpread(cents: number): string {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function resolvedEpochs(markets: ConfigurableMarket[], selected: EpochSeries, now: number): ConfigurableMarket[] {
  const byExpiry = new Map<number, ConfigurableMarket>();
  for (const market of availableEpochs(markets, selected, now)) {
    if (epochResult(market, now) && !byExpiry.has(market.expiryTimestampMs)) byExpiry.set(market.expiryTimestampMs, market);
  }
  return [...byExpiry.values()].reverse();
}

/** Describe observed coverage, not the maximum configured archive retention. */
export function resolutionWindowLabel(epochs: ConfigurableMarket[]): string {
  if (!epochs.length) return 'No observed history yet';
  const closes = epochs.map(m => m.expiryTimestampMs).filter(Number.isFinite);
  if (!closes.length) return 'No observed history yet';
  const oldest = Math.min(...closes), latest = Math.max(...closes);
  return oldest === latest ? `Observed close: ${new Date(oldest).toLocaleString()}` : `${new Date(oldest).toLocaleString()} – ${new Date(latest).toLocaleString()}`;
}
