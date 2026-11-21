/**
 * @cashingularity/backend - Live BCH/USD Price Feed, EWMA Volatility & 60s Multi-Currency FX Quote Lock
 * Supports all 7 required currencies: USD ($), EUR (€), KZT (₸), RUB (₽), GBP (£), USDT, and BCH.
 */

import {
  computeEwmaSigma,
  createDefaultFxQuoteLock,
  EWMA_LAMBDA_DEFAULT,
  FxQuoteLock,
  generateEwmaVolatilityCone,
  SupportedCurrency,
  VolatilityBandPoint,
} from '@cashingularity/shared';

export interface HistoricalCandleOracles {
  latestSpotUsd: number;
  source: 'binance' | 'coinbase' | 'fallback';
  fetchedAtMs: number;
  candlesByInterval: Record<CandleInterval, OhlcvCandle[]>;
  findCloseUsdForTimestamp: (timestampMs: number, preferredInterval?: CandleInterval) => number | undefined;
  findWindowPrices: (
    slotStartMs: number,
    slotEndMs: number,
    preferredInterval: CandleInterval
  ) => { openUsd?: number; closeUsd: number } | undefined;
}

export interface SpotTickPoint {
  timestampMs: number;
  priceUsd: number;
}

export interface PriceTick {
  timestampMs: number;
  bchUsdPrice: number;
  bchUsdSpot: number;
  spotPriceCents: number;
  ewmaSigma: number;
  muAiDrift: number;
  source?: 'live' | 'fallback';
  spotSource?: 'binance' | 'coinbase' | 'fallback';
  spotFetchedAtMs?: number;
}

export type CandleInterval = '1m' | '5m' | '1h' | '1d';

export interface OhlcvCandle {
  time: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
};

export class PriceFeedService {
  private priceHistory: number[] = [
    498.4, 498.9, 499.2, 498.7, 499.6, 500.1, 499.8, 500.45, 500.2, 500.8,
  ];
  private currentPriceUsd = 500.8;
  private muAiDrift = 0.00018;
  private rateSource: 'live' | 'fallback' = 'fallback';
  private spotExchangeSource: 'binance' | 'coinbase' | 'fallback' = 'fallback';
  private spotFetchedAtMs = 0;
  private fxSource: 'open.er-api.com' | 'fallback' = 'fallback';
  private fxFetchedAtMs = 0;
  private fiatUnitsPerUsd: Record<'EUR' | 'GBP' | 'KZT' | 'RUB', number> = {
    EUR: 0.925,
    GBP: 0.787,
    KZT: 498.5,
    RUB: 97.8,
  };
  private lastNetworkFetchMs = 0;
  private lastFxFetchMs = 0;
  private recentSpotTicks: SpotTickPoint[] = [];
  private activeQuoteLock: FxQuoteLock;
  private candleCache = new Map<
    string,
    { expiresAtMs: number; source: 'binance' | 'coinbase' | 'fallback'; candles: OhlcvCandle[] }
  >();

  constructor() {
    this.activeQuoteLock = this.buildFreshQuoteLock(Date.now());
    void this.refreshLiveRatesFromNetwork();
  }

  private setCachedCandles(
    cacheKey: string,
    entry: { expiresAtMs: number; source: 'binance' | 'coinbase' | 'fallback'; candles: OhlcvCandle[] }
  ): void {
    if (!this.candleCache.has(cacheKey) && this.candleCache.size >= 100) {
      const oldestKey = this.candleCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.candleCache.delete(oldestKey);
      }
    }
    this.candleCache.set(cacheKey, entry);
  }

  /**
   * Fetches real historical & live BCH/USD OHLCV candlesticks from Binance (`BCHUSDT`)
   * with Coinbase Exchange (`BCH-USD`) fallback and a 15-second cache per interval.
   */
  public async fetchCandles(
    interval: CandleInterval = '5m',
    limit = 60
  ): Promise<{
    interval: CandleInterval;
    symbol: string;
    source: 'binance' | 'coinbase' | 'fallback';
    currentPriceUsd: number;
    candles: OhlcvCandle[];
  }> {
    const safeLimit = Math.min(200, Math.max(10, Math.trunc(limit)));
    const cacheKey = `${interval}:${safeLimit}`;
    const cached = this.candleCache.get(cacheKey);
    const now = Date.now();
    if (cached && now < cached.expiresAtMs) {
      return {
        interval,
        symbol: 'BCH/USD',
        source: cached.source,
        currentPriceUsd: this.currentPriceUsd,
        candles: cached.candles,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const url = `https://api.binance.com/api/v3/klines?symbol=BCHUSDT&interval=${interval}&limit=${safeLimit}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const raw = (await res.json()) as Array<[number, string, string, string, string, string]>;
        if (Array.isArray(raw) && raw.length > 0) {
          const candles: OhlcvCandle[] = raw
            .map((k) => ({
              time: Math.floor(Number(k[0]) / 1000),
              open: Number.parseFloat(k[1]),
              high: Number.parseFloat(k[2]),
              low: Number.parseFloat(k[3]),
              close: Number.parseFloat(k[4]),
              volume: Number.parseFloat(k[5]),
            }))
            .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));

          if (candles.length > 0) {
            const latest = candles[candles.length - 1];
            const fetchedAt = Date.now();
            this.currentPriceUsd = Number(latest.close.toFixed(2));
            this.rateSource = 'live';
            this.spotExchangeSource = 'binance';
            this.spotFetchedAtMs = fetchedAt;
            this.priceHistory = candles.slice(-60).map((c) => c.close);
            this.activeQuoteLock = this.buildFreshQuoteLock(fetchedAt);
            this.setCachedCandles(cacheKey, {
              expiresAtMs: fetchedAt + 15_000,
              source: 'binance',
              candles,
            });
            if (interval === '1m') {
              this.seedRecentTicksFromCandles(candles);
            } else {
              this.recordSpotTick(this.currentPriceUsd, fetchedAt);
            }
            return {
              interval,
              symbol: 'BCH/USD',
              source: 'binance',
              currentPriceUsd: this.currentPriceUsd,
              candles,
            };
          }
        }
      }
    } catch {
      // Fallback to Coinbase Exchange
    }

    try {
      const granularity = CANDLE_INTERVAL_SECONDS[interval];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(
        `https://api.exchange.coinbase.com/products/BCH-USD/candles?granularity=${granularity}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const raw = (await res.json()) as Array<[number, number, number, number, number, number]>;
        if (Array.isArray(raw) && raw.length > 0) {
          const candles: OhlcvCandle[] = raw
            .slice(0, safeLimit)
            .map(([time, low, high, open, close, volume]) => ({
              time: Number(time),
              open: Number(open),
              high: Number(high),
              low: Number(low),
              close: Number(close),
              volume: Number(volume),
            }))
            .sort((a, b) => a.time - b.time);

          if (candles.length > 0) {
            const latest = candles[candles.length - 1];
            const fetchedAt = Date.now();
            this.currentPriceUsd = Number(latest.close.toFixed(2));
            this.rateSource = 'live';
            this.spotExchangeSource = 'coinbase';
            this.spotFetchedAtMs = fetchedAt;
            this.priceHistory = candles.slice(-60).map((c) => c.close);
            this.activeQuoteLock = this.buildFreshQuoteLock(fetchedAt);
            this.setCachedCandles(cacheKey, {
              expiresAtMs: fetchedAt + 15_000,
              source: 'coinbase',
              candles,
            });
            if (interval === '1m') {
              this.seedRecentTicksFromCandles(candles);
            } else {
              this.recordSpotTick(this.currentPriceUsd, fetchedAt);
            }
            return {
              interval,
              symbol: 'BCH/USD',
              source: 'coinbase',
              currentPriceUsd: this.currentPriceUsd,
              candles,
            };
          }
        }
      }
    } catch {
      // Offline fallback below
    }

    const stepSec = CANDLE_INTERVAL_SECONDS[interval];
    const endSec = Math.floor(now / 1000 / stepSec) * stepSec;
    const base = this.currentPriceUsd;
    const candles: OhlcvCandle[] = Array.from({ length: safeLimit }, (_, idx) => {
      const t = endSec - (safeLimit - 1 - idx) * stepSec;
      const drift = Math.sin(idx * 0.35) * 1.4 + Math.cos(idx * 0.17) * 0.8;
      const open = Number((base + drift - 0.35).toFixed(2));
      const close = Number((base + drift).toFixed(2));
      const high = Number((Math.max(open, close) + 0.65).toFixed(2));
      const low = Number((Math.min(open, close) - 0.55).toFixed(2));
      return { time: t, open, high, low, close, volume: 120 + (idx % 15) * 18 };
    });

    this.setCachedCandles(cacheKey, {
      expiresAtMs: Date.now() + 5_000,
      source: 'fallback',
      candles,
    });

    return {
      interval,
      symbol: 'BCH/USD',
      source: 'fallback',
      currentPriceUsd: this.currentPriceUsd,
      candles,
    };
  }

  /** Read-only chart window: historical candles never update live spot or FX locks. */
  public async fetchCandleWindow(interval: CandleInterval, limit: number, endTimeMs: number) {
    const stepMs = CANDLE_INTERVAL_SECONDS[interval] * 1000;
    const end = Math.min(endTimeMs, Date.now());
    const lastOpen = Math.floor(end / stepMs) * stepMs;
    const start = lastOpen - (limit - 1) * stepMs;
    const cacheKey = `window:${interval}:${limit}:${endTimeMs}`;
    const cached = this.candleCache.get(cacheKey);
    const response = (source: 'binance' | 'coinbase' | 'fallback', candles: OhlcvCandle[], fetchedAtMs: number) => ({
      interval, symbol: 'BCH/USD', source, candles, fetchedAtMs,
    });
    if (cached && Date.now() < cached.expiresAtMs) {
      return response(cached.source, cached.candles, cached.expiresAtMs - 15_000);
    }
    const valid = (candles: OhlcvCandle[]) => {
      const unique = new Map<number, OhlcvCandle>();
      for (const c of candles) {
        if (Number.isSafeInteger(c.time) && c.time * 1000 >= start && c.time * 1000 <= end &&
          [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) &&
          Number.isFinite(c.volume) && c.volume >= 0 && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close)) unique.set(c.time, c);
      }
      return [...unique.values()].sort((a, b) => a.time - b.time).slice(-limit);
    };
    const providers = [
      { source: 'binance' as const, url: `https://api.binance.com/api/v3/klines?symbol=BCHUSDT&interval=${interval}&limit=${limit}&endTime=${Math.floor(end)}`,
        decode: (row: unknown[]) => ({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }) },
      { source: 'coinbase' as const, url: `https://api.exchange.coinbase.com/products/BCH-USD/candles?granularity=${CANDLE_INTERVAL_SECONDS[interval]}&start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`,
        decode: (row: unknown[]) => ({ time: Number(row[0]), low: Number(row[1]), high: Number(row[2]), open: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }) },
    ];
    for (const provider of providers) {
      try {
        const res = await fetch(provider.url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) continue;
        const raw: unknown = await res.json();
        if (!Array.isArray(raw)) continue;
        const candles = valid(raw.filter(Array.isArray).map(provider.decode));
        if (!candles.length) continue;
        const fetchedAtMs = Date.now();
        this.setCachedCandles(cacheKey, { source: provider.source, candles, expiresAtMs: fetchedAtMs + 15_000 });
        return response(provider.source, candles, fetchedAtMs);
      } catch { /* Try the next real feed; never synthesize a historical curve. */ }
    }
    return response('fallback', [], Date.now());
  }

  /**
   * Queries live BCH/USD spot price (Binance / Coinbase) and live USD FX rates
   * (`open.er-api.com`) for EUR, GBP, KZT, and RUB with short timeouts so callers never block.
   */
  public async refreshLiveRatesFromNetwork(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastNetworkFetchMs < 4_000) {
      return;
    }
    this.lastNetworkFetchMs = now;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2200);
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BCHUSDT', {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('Primary spot provider unavailable.');
      if (res.ok) {
        const data = (await res.json()) as { price?: string };
        const parsed = Number.parseFloat(data.price ?? '');
        if (!Number.isFinite(parsed) || parsed <= 10) throw new Error('Invalid spot price.');
        if (Number.isFinite(parsed) && parsed > 10) {
          const ts = Date.now();
          this.currentPriceUsd = Number(parsed.toFixed(2));
          this.rateSource = 'live';
          this.spotExchangeSource = 'binance';
          this.spotFetchedAtMs = ts;
          this.recordSpotTick(this.currentPriceUsd, ts);
        }
      }
    } catch {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2200);
        const res = await fetch('https://api.coinbase.com/v2/prices/BCH-USD/spot', {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = (await res.json()) as { data?: { amount?: string } };
          const parsed = Number.parseFloat(data.data?.amount ?? '');
          if (Number.isFinite(parsed) && parsed > 10) {
            const ts = Date.now();
            this.currentPriceUsd = Number(parsed.toFixed(2));
            this.rateSource = 'live';
            this.spotExchangeSource = 'coinbase';
            this.spotFetchedAtMs = ts;
            this.recordSpotTick(this.currentPriceUsd, ts);
          }
        }
      } catch {
        // Keep last known / fallback price
      }
    }

    if (force || now - this.lastFxFetchMs >= 15_000) {
      this.lastFxFetchMs = now;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2200);
        const fxRes = await fetch('https://open.er-api.com/v6/latest/USD', {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (fxRes.ok) {
          const fxData = (await fxRes.json()) as {
            rates?: Record<string, number>;
          };
          if (fxData.rates && ['EUR', 'GBP', 'KZT', 'RUB'].every(currency => Number.isFinite(fxData.rates![currency]) && fxData.rates![currency] > 0)) {
            if (fxData.rates.EUR && fxData.rates.EUR > 0) this.fiatUnitsPerUsd.EUR = fxData.rates.EUR;
            if (fxData.rates.GBP && fxData.rates.GBP > 0) this.fiatUnitsPerUsd.GBP = fxData.rates.GBP;
            if (fxData.rates.KZT && fxData.rates.KZT > 0) this.fiatUnitsPerUsd.KZT = fxData.rates.KZT;
            if (fxData.rates.RUB && fxData.rates.RUB > 0) this.fiatUnitsPerUsd.RUB = fxData.rates.RUB;
            this.fxSource = 'open.er-api.com';
            this.fxFetchedAtMs = Date.now();
          }
        }
      } catch {
        // Keep last known FX ratios
      }
    }

    this.activeQuoteLock = this.buildFreshQuoteLock(Date.now());
  }

  private recordSpotTick(priceUsd: number, timestampMs: number): void {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(timestampMs)) {
      return;
    }
    const cleanPrice = Number(priceUsd.toFixed(2));
    const last = this.recentSpotTicks[this.recentSpotTicks.length - 1];
    if (last && timestampMs <= last.timestampMs) {
      if (Math.floor(timestampMs / 1000) === Math.floor(last.timestampMs / 1000)) {
        last.priceUsd = cleanPrice;
      }
      return;
    }
    this.recentSpotTicks.push({ timestampMs, priceUsd: cleanPrice });
    if (this.recentSpotTicks.length > 120) {
      this.recentSpotTicks.splice(0, this.recentSpotTicks.length - 120);
    }
  }

  private seedRecentTicksFromCandles(candles: OhlcvCandle[]): void {
    if (this.recentSpotTicks.length >= 60 || candles.length === 0) {
      return;
    }
    const observedAt = Date.now();
    const baseline: SpotTickPoint[] = candles.slice(-90).map((c) => ({
      timestampMs: Math.min((c.time + 60) * 1000, observedAt),
      priceUsd: Number(c.close.toFixed(2)),
    }));
    const latestBaselineTs = baseline[baseline.length - 1]?.timestampMs ?? 0;
    const newerLive = this.recentSpotTicks.filter((t) => t.timestampMs > latestBaselineTs);
    this.recentSpotTicks = [...baseline, ...newerLive].slice(-120);
  }

  public getRecentTicks(limit = 120): SpotTickPoint[] {
    const safeLimit = Math.min(120, Math.max(1, Math.trunc(limit)));
    if (this.recentSpotTicks.length === 0 && this.spotExchangeSource !== 'fallback' && this.spotFetchedAtMs > 0) {
      this.recordSpotTick(this.currentPriceUsd, this.spotFetchedAtMs);
    }
    return this.recentSpotTicks.slice(-safeLimit);
  }

  public async ensureRecentTicksPopulated(limit = 120): Promise<SpotTickPoint[]> {
    if (this.recentSpotTicks.length < 15) {
      await this.fetchCandles('1m', 90);
    }
    return this.getRecentTicks(limit);
  }

  private buildFreshQuoteLock(nowMs: number): FxQuoteLock {
    const usdPerBch = Math.max(1, this.currentPriceUsd);
    const bchPerUsd = Number((1 / usdPerBch).toFixed(8));

    const ratesToBch: Record<SupportedCurrency, number> = {
      BCH: 1.0,
      USD: bchPerUsd,
      USDT: bchPerUsd,
      PUSD: bchPerUsd,
      EUR: Number((bchPerUsd / this.fiatUnitsPerUsd.EUR).toFixed(8)),
      GBP: Number((bchPerUsd / this.fiatUnitsPerUsd.GBP).toFixed(8)),
      KZT: Number((bchPerUsd / this.fiatUnitsPerUsd.KZT).toFixed(9)),
      RUB: Number((bchPerUsd / this.fiatUnitsPerUsd.RUB).toFixed(9)),
    };

    return createDefaultFxQuoteLock(ratesToBch, nowMs, {
      fxSource: this.fxSource,
      fxFetchedAtMs: this.fxFetchedAtMs,
      spotSource: this.spotExchangeSource,
      spotFetchedAtMs: this.spotFetchedAtMs,
    });
  }

  /**
   * Returns a valid 60-second FX quote lock with `expiresAtMs = Date.now() + 60_000` in the future,
   * triggering a non-blocking background refresh when network rates are older than 15 seconds.
   */
  public getQuoteLock(forceRefresh = false): FxQuoteLock {
    const now = Date.now();
    if (forceRefresh || now - this.lastNetworkFetchMs >= 15_000) {
      void this.refreshLiveRatesFromNetwork(forceRefresh);
    }
    this.activeQuoteLock = this.buildFreshQuoteLock(now);
    return this.activeQuoteLock;
  }

  /**
   * Returns the latest unaltered exchange spot price for live WebSocket streaming and updates EWMA sigma.
   */
  public stepTick(nowMs: number = Date.now()): PriceTick {
    if (nowMs - this.lastNetworkFetchMs > 30_000) {
      void this.refreshLiveRatesFromNetwork();
    }

    const lastRecorded = this.priceHistory[this.priceHistory.length - 1];
    if (lastRecorded !== this.currentPriceUsd) {
      this.priceHistory.push(this.currentPriceUsd);
      if (this.priceHistory.length > 120) {
        this.priceHistory.shift();
      }
    }

    const ewmaSigma = computeEwmaSigma(this.priceHistory, EWMA_LAMBDA_DEFAULT);
    return {
      timestampMs: nowMs,
      bchUsdPrice: this.currentPriceUsd,
      bchUsdSpot: this.currentPriceUsd,
      spotPriceCents: Math.round(this.currentPriceUsd * 100),
      ewmaSigma,
      muAiDrift: this.muAiDrift,
      source: this.rateSource,
      spotSource: this.spotExchangeSource,
      spotFetchedAtMs: this.spotFetchedAtMs,
    };
  }

  public getCurrentTick(): PriceTick {
    return {
      timestampMs: Date.now(),
      bchUsdPrice: this.currentPriceUsd,
      bchUsdSpot: this.currentPriceUsd,
      spotPriceCents: Math.round(this.currentPriceUsd * 100),
      ewmaSigma: computeEwmaSigma(this.priceHistory, EWMA_LAMBDA_DEFAULT),
      muAiDrift: this.muAiDrift,
      source: this.rateSource,
      spotSource: this.spotExchangeSource,
      spotFetchedAtMs: this.spotFetchedAtMs,
    };
  }

  public async getLatestLiveSpotForSettlement(): Promise<{
    spotUsd: number;
    source: 'binance' | 'coinbase' | 'fallback';
    fetchedAtMs: number;
  }> {
    const res = await this.fetchCandles('1m', 10);
    return {
      spotUsd: res.currentPriceUsd,
      source: res.source,
      fetchedAtMs: this.spotFetchedAtMs || Date.now(),
    };
  }

  /**
   * Loads cached real Binance/Coinbase candles across 1m, 5m, 1h (7d+), and 1d (14d)
   * so historical time slots and expired positions can settle against exact candle closes.
   */
  public async getHistoricalSettlementOracles(): Promise<HistoricalCandleOracles> {
    const [m1, m5, h1, d1] = await Promise.all([
      this.fetchCandles('1m', 120),
      this.fetchCandles('5m', 200),
      this.fetchCandles('1h', 180),
      this.fetchCandles('1d', 14),
    ]);

    const candlesByInterval: Record<CandleInterval, OhlcvCandle[]> = {
      '1m': m1.source === 'fallback' ? [] : m1.candles,
      '5m': m5.source === 'fallback' ? [] : m5.candles,
      '1h': h1.source === 'fallback' ? [] : h1.candles,
      '1d': d1.source === 'fallback' ? [] : d1.candles,
    };

    const pickLatestValidSource = (): 'binance' | 'coinbase' | 'fallback' => {
      for (const src of [m1.source, m5.source, h1.source, d1.source]) {
        if (src === 'binance' || src === 'coinbase') return src;
      }
      return 'fallback';
    };

    const latestSpotUsd = this.currentPriceUsd;

    const findCloseUsdForTimestamp = (timestampMs: number, preferredInterval: CandleInterval = '1m'): number | undefined => {
      if (!Number.isFinite(timestampMs) || timestampMs > Date.now()) return undefined;
      const step = CANDLE_INTERVAL_SECONDS[preferredInterval] * 1000;
      const candle = candlesByInterval[preferredInterval].find(c => (c.time * 1000 + step) === timestampMs);
      return candle && Number.isFinite(candle.close) && candle.close > 0 ? candle.close : undefined;
    };
    const findWindowPrices = (slotStartMs: number, slotEndMs: number, preferredInterval: CandleInterval): { openUsd: number; closeUsd: number } | undefined => {
      const step = CANDLE_INTERVAL_SECONDS[preferredInterval] * 1000;
      if (slotEndMs > Date.now() || slotEndMs - slotStartMs !== step) return undefined;
      const candle = candlesByInterval[preferredInterval].find(c => c.time * 1000 === slotStartMs);
      return candle && [candle.open, candle.close].every(v => Number.isFinite(v) && v > 0) ? {openUsd:candle.open, closeUsd:candle.close} : undefined;
    };

    return {
      latestSpotUsd,
      source: pickLatestValidSource(),
      fetchedAtMs: this.spotFetchedAtMs || Date.now(),
      candlesByInterval,
      findCloseUsdForTimestamp,
      findWindowPrices,
    };
  }

  public getVolatilityCone(remainingSeconds = 300, steps = 25): VolatilityBandPoint[] {
    const tick = this.getCurrentTick();
    return generateEwmaVolatilityCone({
      currentPrice: tick.bchUsdPrice,
      muAiDrift: tick.muAiDrift,
      sigma: tick.ewmaSigma,
      remainingSeconds,
      steps,
    });
  }
}
