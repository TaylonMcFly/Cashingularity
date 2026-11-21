import type { FxQuoteLock } from "@cashingularity/shared";

export type FeedQuote = Omit<
  FxQuoteLock,
  "fxFetchedAtMs" | "fxSource" | "spotFetchedAtMs" | "spotSource"
> & {
  fxFetchedAtMs?: number;
  fxSource?: string;
  spotFetchedAtMs?: number;
  spotSource?: string;
};

const MAX_AGE_MS = 60_000;
const liveSpotSource = (value: unknown): value is string =>
  value === "binance" || value === "coinbase";
const freshTime = (value: unknown, now: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= now + 5_000 &&
  now - value <= MAX_AGE_MS;

export function hasFreshSpotObservation(
  spot: { price?: number; source?: string; fetchedAtMs?: number } | undefined,
  now = Date.now(),
): spot is { price: number; source: string; fetchedAtMs: number } {
  return (
    !!spot &&
    liveSpotSource(spot.source) &&
    freshTime(spot.fetchedAtMs, now) &&
    typeof spot.price === "number" &&
    Number.isFinite(spot.price) &&
    spot.price > 0
  );
}

export function hasFreshSpot(
  quote: FeedQuote | undefined,
  now = Date.now(),
): quote is FeedQuote & { spotFetchedAtMs: number; spotSource: string } {
  return (
    !!quote &&
    liveSpotSource(quote.spotSource) &&
    freshTime(quote.spotFetchedAtMs, now) &&
    Number.isFinite(quote.bchUsdPrice) &&
    quote.bchUsdPrice > 0
  );
}

export function freshFxExpiry(
  quote: FeedQuote | undefined,
  now = Date.now(),
): number | undefined {
  if (
    !quote ||
    !hasFreshSpot(quote, now) ||
    quote.fxSource !== "open.er-api.com" ||
    !freshTime(quote.fxFetchedAtMs, now) ||
    !Number.isFinite(quote.lockedAtMs) ||
    quote.lockedAtMs > now + 5_000 ||
    !Number.isFinite(quote.expiresAtMs) ||
    quote.expiresAtMs <= quote.lockedAtMs ||
    quote.expiresAtMs - quote.lockedAtMs > 65_000 ||
    !quote.quoteId
  )
    return undefined;
  const expiry = Math.min(
    quote.expiresAtMs,
    quote.fxFetchedAtMs + MAX_AGE_MS,
    quote.spotFetchedAtMs + MAX_AGE_MS,
  );
  return expiry > now ? expiry : undefined;
}
