import type { ConfigurableMarket } from "@cashingularity/shared";
import { MARKET_TIMEFRAMES, type EpochTimeframe } from './marketEpochs.js';

export const LIVE_SERIES_SLUGS: Record<EpochTimeframe, string> = {
  '1m': 'bchusd-1m',
  '5m': 'bchusd-5m-flash',
  '1h': 'bchusd-1h-breakout',
  '24h': 'bchusd-24h-range',
};

export function parseRollingMarketSlug(slug: string): { timeframe: EpochTimeframe; expiryMs?: number } | undefined {
  const frame = MARKET_TIMEFRAMES.find(({ label }) => LIVE_SERIES_SLUGS[label] === slug);
  if (frame) return { timeframe: frame.label };
  const match = /^bchusd-(1m|5m|1h|24h)-(\d{9,12})$/.exec(slug);
  if (match) return { timeframe: match[1] as EpochTimeframe, expiryMs: Number(match[2]) * 1000 };
}

export function liveMarketSlug(market: ConfigurableMarket): string {
  const frame = MARKET_TIMEFRAMES.find(({ label, seconds }) => market.epochSeriesId === `bchusd-${label}` && market.durationSeconds === seconds);
  return frame ? LIVE_SERIES_SLUGS[frame.label] : marketSlug(market);
}

/** Stable URLs must not depend on prices embedded in the market title. */
export function marketSlug(market: ConfigurableMarket): string {
  const supplied = (market as ConfigurableMarket & { slug?: unknown }).slug;
  if (
    typeof supplied === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(supplied)
  )
    return supplied;
  if (market.marketId === 1 && market.durationSeconds === 300)
    return "bchusd-5m-flash";
  if (market.marketId === 2 && market.durationSeconds === 3600)
    return "bchusd-1h-breakout";
  if (market.marketId === 3 && market.durationSeconds === 86400)
    return "bchusd-24h-range";
  return `market-${market.marketId}`;
}

export function parseMarketSlug(pathname: string): string | null {
  const match = /^\/market\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function findMarketBySlug(
  markets: ConfigurableMarket[],
  slug: string,
): ConfigurableMarket | undefined {
  return (
    markets.find((m) => marketSlug(m) === slug) ??
    markets.find((m) => `market-${m.marketId}` === slug)
  );
}
