import { describe, expect, it } from 'vitest';
import {
  estimateMinuteVolatility,
  marketPriceBook,
  MODEL_JITTER_BPS,
  MODEL_SPREAD_BPS,
  recentRoundBuys,
  simulateMarketBuy,
  type MarketBuy,
} from './marketPricing.js';
import type { ConfigurableMarket, MarketBucketPool } from './types.js';

const start = 1_800_000_000_000;
const expiry = start + 300_000;
const now = start + 100_000;
const buckets = [
  { bucketId: 0, label: 'BELOW $200', upperBoundCents: 20_000, poolSats: 450_000n, outcomeRule: 'BELOW' },
  { bucketId: 1, label: 'ABOVE $200', lowerBoundCents: 20_000, poolSats: 550_000n, outcomeRule: 'ABOVE' },
] as MarketBucketPool[];
const market = {
  marketId: 101, strikePriceCents: 20_000, status: 'OPEN', totalPoolSats: 1_000_000n,
  createdAtMs: start, expiryTimestampMs: expiry, durationSeconds: 300, buckets, feeBps: 100n,
} as ConfigurableMarket;
const priceBook = (spot: number, time = now, volatility = 0.0015, buys: MarketBuy[] = []) => marketPriceBook(market, {
  spot: { usd: spot, timestampMs: time }, minuteVolatility: volatility, buys,
}, time)!;
const buy = (id: string, bucketId = 1, time = now): MarketBuy => ({ id, bucketId, marketId: market.marketId, sats: 120_000n, timestampMs: time });

describe('indicative market pricing', () => {
  it('compresses the trailing side as spot moves away from the strike near expiry', () => {
    const centre = priceBook(200).outcomes[1].markBps;
    expect(Math.abs(centre - 5000)).toBeLessThanOrEqual(MODEL_JITTER_BPS);
    expect(priceBook(200.4).outcomes[1].markBps).toBeGreaterThan(centre);
    const early = priceBook(199.8).outcomes[1].markBps;
    const late = priceBook(199.8, expiry - 10_000).outcomes[1].markBps;
    expect(early).toBeLessThan(centre);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThanOrEqual(400);
    expect(late).toBeLessThan(1500);
    expect(priceBook(200.2, expiry - 10_000).outcomes[1].markBps).toBeGreaterThan(8500);
    expect(priceBook(199.8, expiry - 10_000, 0.004).outcomes[1].markBps).toBeGreaterThan(late);
  });

  it('leans with directional volume and recent momentum, using only unique buys in this round', () => {
    const baseline = priceBook(200).outcomes[1].markBps;
    const above = buy('above');
    const below = buy('below', 0);
    expect(priceBook(200, now, 0.0015, [above]).outcomes[1].markBps).toBeGreaterThan(baseline);
    expect(priceBook(200, now, 0.0015, [below]).outcomes[1].markBps).toBeLessThan(baseline);
    expect(priceBook(200, now, 0.0015, [above, below]).outcomes[1].markBps).toBe(baseline);
    expect(priceBook(200, now, 0.0015, [above, { ...below, timestampMs: now - 60_000 }]).outcomes[1].markBps).toBeGreaterThan(baseline);
    expect(recentRoundBuys(market, [above, above, { ...above, id: 'other', marketId: 102 }, {
      ...above, id: 'future', timestampMs: now + 1,
    }, buy('old', 1, start - 1), buy('invalid', 99)], now)).toEqual([above]);
  });

  it('uses complementary marks, a fixed one-point overround and bounded tick jitter', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const time = now + i * 1000;
      const quotes = priceBook(200, time).outcomes;
      seen.add(quotes[1].markBps);
      expect(quotes).toEqual(priceBook(200, time).outcomes);
      expect(quotes.reduce((total, quote) => total + quote.markBps, 0)).toBe(10_000);
      expect(quotes.reduce((total, quote) => total + quote.askBps, 0)).toBe(10_000 + MODEL_SPREAD_BPS);
      expect(quotes.reduce((total, quote) => total + quote.bidBps, 0)).toBe(10_000 - MODEL_SPREAD_BPS);
      expect(quotes.every(quote => quote.askBps - quote.bidBps === MODEL_SPREAD_BPS)).toBe(true);
      expect(Math.abs(quotes[1].markBps - 5000)).toBeLessThanOrEqual(MODEL_JITTER_BPS);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(priceBook(50).outcomes[1].markBps).toBeGreaterThanOrEqual(400);
    expect(priceBook(50).outcomes[1].markBps).toBeLessThanOrEqual(440);
    expect(priceBook(1000).outcomes[1].markBps).toBeGreaterThanOrEqual(9560);
    expect(priceBook(1000).outcomes[1].markBps).toBeLessThanOrEqual(9600);
  });

  it('requires a recent observed price and stops at the round boundary', () => {
    const input = { spot: { usd: 200, timestampMs: now - 60_001 }, minuteVolatility: 0.0015, buys: [] };
    expect(marketPriceBook(market, input, now)).toBeUndefined();
    expect(marketPriceBook(market, { ...input, spot: { usd: 200, timestampMs: expiry } }, expiry)).toBeUndefined();
    expect(marketPriceBook({ ...market, isFutureSlot: true }, input, now)).toBeUndefined();
  });

  it('retains pool quotes for ranged markets and preserves principal even at high fees', () => {
    const ranged = { ...market, buckets: [...buckets, { ...buckets[1], bucketId: 2, outcomeRule: 'RANGE' as const, poolSats: 10_001n }], totalPoolSats: 1_010_001n };
    const rangeBook = marketPriceBook(ranged, { minuteVolatility: 0.0015, buys: [] }, now)!;
    expect(rangeBook.source).toBe('pool');
    expect(rangeBook.outcomes[2].pricedPoolSats).toBe(10_001n);
    const book = priceBook(200.2);
    const stake = 100_000_000n;
    const result = simulateMarketBuy({ ...market, feeBps: 9900n }, book.outcomes[1], stake);
    expect(result.estimatedPayoutSats).toBeGreaterThanOrEqual(stake);
    expect(result.multiplier).toBeGreaterThanOrEqual(1);
  });

  it('estimates volatility from observed prices on a common minute scale', () => {
    const quiet = Array.from({ length: 12 }, (_, index) => ({ time: index * 10, value: 200 }));
    const moving = quiet.map((tick, index) => ({ ...tick, value: tick.value + (index % 2) * 0.35 }));
    expect(estimateMinuteVolatility(quiet)).toBeLessThan(estimateMinuteVolatility(moving));
    expect(estimateMinuteVolatility([])).toBeGreaterThan(0);
    expect(estimateMinuteVolatility([{ time: 1, value: 200 }, { time: 6, value: 197 }])).toBe(estimateMinuteVolatility([]));
  });
});
