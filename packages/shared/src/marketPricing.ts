import { calculateParimutuelMultiplier } from './math.js';
import { BPS_DENOMINATOR, type ConfigurableMarket } from './types.js';

export const MARKET_FLOW_WINDOW_MS = 300_000;
export const MODEL_SPREAD_BPS = 100;
export const MODEL_JITTER_BPS = 20;
const MODEL_MIN_BPS = 400;
const BASIS_POINTS = Number(BPS_DENOMINATOR);
const DEFAULT_MINUTE_VOLATILITY = 0.0015;

export interface MarketBuy {
  id: string;
  marketId: number;
  bucketId: number;
  sats: bigint;
  timestampMs: number;
}

export interface OutcomeQuote {
  bucketId: number;
  markBps: number;
  bidBps: number;
  askBps: number;
  pricedPoolSats: bigint;
}

export interface MarketPriceBook {
  marketId: number;
  expiryMs: number;
  asOfMs: number;
  source: 'model' | 'pool';
  outcomes: OutcomeQuote[];
}

export interface MarketPricingInput {
  spot?: { usd: number; timestampMs: number };
  minuteVolatility: number;
  buys: readonly MarketBuy[];
}

export function isMarketOpenAt(market: ConfigurableMarket, nowMs: number): boolean {
  return market.status === 'OPEN' && !market.isFutureSlot && !market.isHistoricalSlot &&
    Number.isFinite(market.expiryTimestampMs) && market.createdAtMs <= nowMs && market.expiryTimestampMs > nowMs;
}

/** Recent observed returns expressed as volatility over one minute. */
export function estimateMinuteVolatility(samples: readonly { time: number; value: number }[]): number {
  const latest = samples.at(-1)?.time ?? 0;
  let variance = 0;
  let totalWeight = 0;
  let returnCount = 0;
  for (let i = Math.max(1, samples.length - 120); i < samples.length; i++) {
    const previous = samples[i - 1], current = samples[i];
    const stepSeconds = current.time - previous.time;
    if (!(stepSeconds > 0 && stepSeconds <= 300 && current.value > 0 && previous.value > 0)) continue;
    const change = Math.log(current.value / previous.value);
    const weight = Math.pow(0.94, (latest - current.time) / 60);
    if (!Number.isFinite(change) || !Number.isFinite(weight)) continue;
    variance += change ** 2 * (60 / stepSeconds) * weight;
    totalWeight += weight;
    returnCount++;
  }
  // Wait for enough returns to estimate a rolling scale independently of a single move.
  return returnCount >= 8 && totalWeight > 0
    ? Math.min(0.05, Math.max(0.0003, Math.sqrt(variance / totalWeight)))
    : DEFAULT_MINUTE_VOLATILITY;
}

export function recentRoundBuys(market: ConfigurableMarket, buys: readonly MarketBuy[], nowMs: number): MarketBuy[] {
  const start = Math.max(market.createdAtMs, nowMs - MARKET_FLOW_WINDOW_MS);
  const buckets = new Set(market.buckets.map(bucket => bucket.bucketId));
  const seen = new Set<string>();
  return buys.filter(buy => {
    if (buy.marketId !== market.marketId || !buckets.has(buy.bucketId) || buy.sats <= 0n ||
        !(buy.timestampMs >= start && buy.timestampMs <= nowMs && buy.timestampMs < market.expiryTimestampMs) ||
        seen.has(buy.id)) return false;
    seen.add(buy.id);
    return true;
  });
}

function flowPressure(market: ConfigurableMarket, buys: readonly MarketBuy[], aboveId: number, nowMs: number): number {
  // Regularize thin flow against the indicative pool so one tiny buy cannot dominate the mark.
  const liquidity = Math.max(1, Number(market.totalPoolSats));
  let volume = 0, imbalance = 0, recentVolume = 0, recentImbalance = 0;
  for (const buy of recentRoundBuys(market, buys, nowMs)) {
    const size = Number(buy.sats);
    const signed = buy.bucketId === aboveId ? size : -size;
    const recency = Math.exp(-(nowMs - buy.timestampMs) / 30_000);
    volume += size;
    imbalance += signed;
    recentVolume += size * recency;
    recentImbalance += signed * recency;
  }
  return 0.65 * imbalance / (volume + liquidity * 0.1) +
    0.7 * recentImbalance / (recentVolume + liquidity * 0.08);
}

function normalCdf(z: number): number {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) *
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z < 0 ? tail : 1 - tail;
}

/** Binary odds use a spot-to-strike probability with a bounded flow adjustment in log-odds. */
export function marketPriceBook(market: ConfigurableMarket, input: MarketPricingInput, nowMs: number): MarketPriceBook | undefined {
  if (!isMarketOpenAt(market, nowMs)) return;
  const metadata = { marketId: market.marketId, expiryMs: market.expiryTimestampMs, asOfMs: nowMs };
  const above = market.buckets.find(bucket => bucket.outcomeRule === 'ABOVE');
  const below = market.buckets.find(bucket => bucket.outcomeRule === 'BELOW');
  const threshold = above?.lowerBoundCents ?? market.strikePriceCents;
  if (market.buckets.length !== 2 || !above || !below ||
      !(threshold > 0 && threshold === (below.upperBoundCents ?? market.strikePriceCents))) {
    if (market.totalPoolSats <= 0n) return;
    return { ...metadata, source: 'pool', outcomes: market.buckets.map(bucket => {
      const markBps = Number(bucket.poolSats * BPS_DENOMINATOR / market.totalPoolSats);
      return { bucketId: bucket.bucketId, markBps, bidBps: markBps, askBps: markBps, pricedPoolSats: bucket.poolSats };
    }) };
  }

  const spot = input.spot;
  if (!spot || !Number.isFinite(spot.usd) || spot.usd <= 0 ||
      !(spot.timestampMs > 0 && spot.timestampMs <= nowMs + 5000 && spot.timestampMs >= nowMs - 60_000)) return;
  const sigma = input.minuteVolatility > 0 && Number.isFinite(input.minuteVolatility) ? input.minuteVolatility : DEFAULT_MINUTE_VOLATILITY;
  const horizon = Math.max(1000, market.expiryTimestampMs - nowMs) / 60_000;
  const z = Math.log(spot.usd / (threshold / 100)) / (sigma * Math.sqrt(horizon));
  const baseline = Math.max(1e-6, Math.min(1 - 1e-6, normalCdf(z)));
  const logOdds = Math.log(baseline / (1 - baseline)) + flowPressure(market, input.buys, above.bucketId, nowMs);
  // Seed the micro-adjustment with the observed exchange tick. Spot and settlement prices are untouched.
  const seed = Math.floor(spot.timestampMs / 1000) ^ market.marketId;
  const tickHash = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
  const jitter = tickHash % (2 * MODEL_JITTER_BPS + 1) - MODEL_JITTER_BPS;
  const baseMin = MODEL_MIN_BPS + MODEL_JITTER_BPS;
  const aboveBps = Math.min(BASIS_POINTS - baseMin, Math.max(baseMin,
    Math.round(BASIS_POINTS / (1 + Math.exp(-logOdds))))) + jitter;
  const halfSpread = MODEL_SPREAD_BPS / 2;
  return { ...metadata, source: 'model', outcomes: market.buckets.map(bucket => {
    const markBps = bucket.bucketId === above.bucketId ? aboveBps : BASIS_POINTS - aboveBps;
    const askBps = markBps + halfSpread;
    return { bucketId: bucket.bucketId, markBps, bidBps: markBps - halfSpread, askBps,
      pricedPoolSats: (market.totalPoolSats * BigInt(askBps)) / BPS_DENOMINATOR };
  }) };
}

/** Allocate the indicative liquidity at the buy quote for the existing parimutuel simulation. */
export function simulateMarketBuy(market: ConfigurableMarket, quote: OutcomeQuote, stakeSats: bigint) {
  return calculateParimutuelMultiplier({
    totalPoolSats: market.totalPoolSats,
    bucketPoolSats: quote.pricedPoolSats,
    deltaStakeSats: stakeSats,
    feeBps: market.feeBps,
  });
}
