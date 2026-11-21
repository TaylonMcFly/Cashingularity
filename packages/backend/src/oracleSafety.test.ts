import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceFeedService, type CandleInterval } from './priceFeed.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('historical settlement authenticity', () => {
  it('does not expose synthetic fallback candles as observed spot ticks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const feed = new PriceFeedService();
    expect((await feed.fetchCandles('1m', 90)).source).toBe('fallback');
    expect(feed.getRecentTicks()).toEqual([]);
  });
  it('never uses synthetic fallback, a nearby candle, or current spot as an expiry close', async () => {
    const feed = new PriceFeedService();
    const end = Math.floor(Date.now() / 60_000) * 60_000;
    const candle = { time: end / 1000 - 60, open: 201, high: 205, low: 200, close: 204, volume: 10 };
    vi.spyOn(feed, 'fetchCandles').mockImplementation(async (interval: CandleInterval = '5m') => ({
      interval, symbol: 'BCH/USD', source: 'fallback', currentPriceUsd: 999, candles: [candle],
    }));
    const fallback = await feed.getHistoricalSettlementOracles();
    expect(fallback.findCloseUsdForTimestamp(end)).toBeUndefined();
    expect(fallback.findWindowPrices(end - 60_000, end, '1m')).toBeUndefined();

    vi.mocked(feed.fetchCandles).mockImplementation(async (interval: CandleInterval = '5m') => ({
      interval, symbol: 'BCH/USD', source: 'binance', currentPriceUsd: 999,
      candles: interval === '1m' ? [candle] : [],
    }));
    const live = await feed.getHistoricalSettlementOracles();
    expect(live.findCloseUsdForTimestamp(end)).toBe(204);
    expect(live.findCloseUsdForTimestamp(end + 1000)).toBeUndefined();
    expect(live.findCloseUsdForTimestamp(end, '5m')).toBeUndefined();
    expect(live.findWindowPrices(end - 60_000, end, '1m')).toEqual({ openUsd: 201, closeUsd: 204 });
    expect(live.findWindowPrices(end - 300_000, end, '1m')).toBeUndefined();
    expect(live.findCloseUsdForTimestamp(Date.now() + 60_000)).toBeUndefined();
  });
});
