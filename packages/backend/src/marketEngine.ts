/**
 * @cashingularity/backend - Configurable Parimutuel Prediction Market Engine
 * Supports custom durations T (short-term flash epochs to multi-day events),
 * multi-bucket parimutuel pools, CashTokens NFT receipt commitments & Rabby UTXO DAG inspection.
 */

import {
  buildPredictionStakeDagPreview,
  buildWizardSignRequest,
} from '@cashingularity/contracts-cashscript';
import {
  calculateParimutuelMultiplier,
  ConfigurableMarket,
  DEFAULT_PROTOCOL_FEE_BPS,
  deriveP2sh32CashAddr,
  DUST_LIMIT_SATS,
  encodeNftReceiptCommitment,
  ExecutionMode,
  isAboveDustLimit,
  MarketBucketPool,
  MarketPositionRecord,
  MarketPositionStatus,
  ParimutuelSimulationResult,
  UtxoDagInspection,
  validateAndConvertCashAddr,
  WalletUtxo,
  WizardSignTransactionRequest,
} from '@cashingularity/shared';
import { createHash } from 'node:crypto';
import { CashingularityWalStore, MarketStakeRecord } from './db.js';
import type { HistoricalCandleOracles } from './priceFeed.js';

export type MarketTimeframe = '1m' | '5m' | '1h' | '24h';

export const EPOCH_RETENTION_DAYS = 7;
export const EPOCH_RETENTION_MS = EPOCH_RETENTION_DAYS * 86_400_000;
export const EPOCH_FUTURE_HORIZON_MS = 24 * 3_600_000;
const EPOCH_BASE_MS = Date.UTC(2020, 0, 1, 0, 0, 0);

export const TIMEFRAME_MS: Record<MarketTimeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
};

const TIMEFRAME_ID_OFFSET: Record<MarketTimeframe, number> = {
  '1m': 400_000_000,
  '5m': 100_000_000,
  '1h': 200_000_000,
  '24h': 300_000_000,
};

export function formatSlotTimeLabel(
  timestampMs: number,
  timeframe: MarketTimeframe,
  nowMs: number = Date.now()
): string {
  const d = new Date(timestampMs);
  const nowDate = new Date(nowMs);
  const sameDay =
    d.getFullYear() === nowDate.getFullYear() &&
    d.getMonth() === nowDate.getMonth() &&
    d.getDate() === nowDate.getDate();

  if (timeframe === '24h') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  if (sameDay) {
    return timePart;
  }
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${datePart}, ${timePart}`;
}

export interface PlaceStakeResult {
  market: ConfigurableMarket;
  stakeRecord: MarketStakeRecord;
  position: MarketPositionRecord;
  simulation: ParimutuelSimulationResult;
  dagInspection: UtxoDagInspection;
  wizardSignRequest: WizardSignTransactionRequest;
}

export class ConfigurableMarketEngine {
  private readonly store: CashingularityWalStore;
  private positionSeq = 0;

  constructor(store: CashingularityWalStore) {
    this.store = store;
    this.ensureSeedMarkets();
  }

  private deterministicUuid(seed: string): string {
    const hex = createHash('sha256').update(seed).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private curatedSlugForMarket(m: {
    marketId: number;
    durationSeconds: number;
    bucketsCount: number;
    title: string;
  }): string {
    if (m.marketId === 1) return 'bchusd-5m-flash';
    if (m.marketId === 2 && m.durationSeconds === 3600) return 'bchusd-1h-breakout';
    if ((m.marketId === 3 || m.durationSeconds === 86_400) && m.bucketsCount === 3) {
      return 'bchusd-24h-range';
    }
    const base = m.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return base ? `${base}-${m.marketId}` : `market-${m.marketId}`;
  }

  private ensureSeedMarkets(): void {
    const existing = this.store.listMarkets();
    if (existing.length > 0) {
      for (const m of existing) {
        let changed = false;
        if (!validateAndConvertCashAddr(m.covenantAddress).valid) {
          m.covenantAddress = deriveP2sh32CashAddr(
            `market-${m.marketId}-${m.categoryId}`,
            'mainnet'
          ).standardAddress;
          changed = true;
        }
        if (!m.id) {
          m.id = this.deterministicUuid(`market-${m.marketId}-${m.categoryId}`);
          changed = true;
        }
        if (!m.slug) {
          m.slug = this.curatedSlugForMarket({
            marketId: m.marketId,
            durationSeconds: m.durationSeconds,
            bucketsCount: m.buckets.length,
            title: m.title,
          });
          changed = true;
        }
        if (changed) {
          this.store.upsertMarket(m);
        }
      }
      return;
    }

    const nowMs = Date.now();
    this.createMarket({
      slug: 'bchusd-5m-flash',
      title: 'BCH/USD 5-Minute Flash Candle (> Spot)',
      description: 'Curated 5-minute parimutuel candle epoch settled against live BCH/USD spot feed.',
      assetPair: 'BCH/USD',
      strikePriceCents: 50_000,
      durationSeconds: 300,
      bucketLabels: ['NO / BELOW TARGET', 'YES / ABOVE TARGET'],
      initialBucketsSats: [450_000n, 550_000n],
      nowMs,
    });

    this.createMarket({
      slug: 'bchusd-1h-breakout',
      title: 'BCH/USD 1-Hour Breakout (+1.5% Move)',
      description: 'Curated 60-minute momentum market anchored to real BCH/USD hourly close.',
      assetPair: 'BCH/USD',
      strikePriceCents: 50_800,
      durationSeconds: 3_600,
      bucketLabels: ['BELOW BREAKOUT', 'BREAKOUT ABOVE TARGET'],
      initialBucketsSats: [620_000n, 580_000n],
      nowMs,
    });

    this.createMarket({
      slug: 'bchusd-24h-range',
      title: 'BCH/USD 24-Hour Volatility Band',
      description: 'Curated 24-hour multi-bucket range market across Bear, Range, and Bull zones.',
      assetPair: 'BCH/USD',
      strikePriceCents: 51_500,
      durationSeconds: 86_400,
      bucketLabels: ['BEAR (-3%)', 'RANGE (±3%)', 'BULL (+3%)'],
      initialBucketsSats: [800_000n, 1_200_000n, 1_000_000n],
      nowMs,
    });
  }

  private alignMarketWithLiveSpot(
    m: ConfigurableMarket,
    liveSpotUsd: number,
    nowMs: number = Date.now(),
    oracles?: HistoricalCandleOracles
  ): ConfigurableMarket {
    if (!Number.isFinite(liveSpotUsd) || liveSpotUsd <= 10) {
      return m;
    }

    const timeframe: MarketTimeframe = m.marketId === 1 ? '5m' : m.marketId === 2 ? '1h' : '24h';
    const start = Math.floor(nowMs / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe];
    const epochKey = `${timeframe}:${Math.floor((start + TIMEFRAME_MS[timeframe]) / 1000)}`;
    if (
      m.marketId <= 3 &&
      m.epochKey === epochKey &&
      m.buckets.every((b) => b.outcomeRule !== undefined)
    ) {
      return m;
    }
    const candleInterval = timeframe === '24h' ? '1d' : timeframe;
    const open = oracles?.candlesByInterval[candleInterval].find(c => c.time * 1000 === start)?.open;
    if (open && Number.isFinite(open) && open > 0) liveSpotUsd = open;
    // Persist the target once per epoch. Streaming spot updates must not move the goalpost.
    const snapshot = (market: ConfigurableMarket): ConfigurableMarket => {
      this.store.upsertMarket(market);
      return market;
    };
    const spotRounded = Math.round(liveSpotUsd);
    const hourlyTarget = Math.round(liveSpotUsd * 1.015);
    const bearCut = Math.round(liveSpotUsd * 0.97);
    const bullCut = Math.round(liveSpotUsd * 1.03);

    if (m.marketId === 1) {
      const slotStartMs = Math.floor(nowMs / TIMEFRAME_MS['5m']) * TIMEFRAME_MS['5m'];
      const slotEndMs = slotStartMs + TIMEFRAME_MS['5m'];
      const slotLabel = formatSlotTimeLabel(slotEndMs, '5m', nowMs);
      const strikeCents =
        m.epochKey === epochKey && m.strikePriceCents > 0 ? m.strikePriceCents : spotRounded * 100;
      const strikeUsd = strikeCents / 100;
      return snapshot({
        ...m,
        status: 'OPEN',
        resolvedOutcome: undefined,
        resolutionPriceCents: undefined,
        resolutionSignatureHex: undefined,
        slug: 'bchusd-5m-flash',
        timeframe: '5m',
        epochSeriesId: 'bchusd-5m',
        slotStartMs,
        slotLabel,
        createdAtMs: slotStartMs,
        expiryTimestampMs: slotEndMs,
        isCurrentSlot: true,
        isFutureSlot: false,
        isHistoricalSlot: false,
        retentionExpiresAtMs: slotEndMs + EPOCH_RETENTION_MS,
        epochKey: `5m:${Math.floor(slotEndMs / 1000)}`,
        title: `BCH/USD 5-Minute Flash · ${slotLabel} (> $${strikeUsd.toFixed(2)})`,
        strikePriceCents: strikeCents,
        buckets: m.buckets.map((b, i) => ({
          ...b,
          label: i === 0 ? `BELOW $${strikeUsd}` : `ABOVE $${strikeUsd}`,
          outcomeRule: i === 0 ? 'BELOW' : 'ABOVE',
          lowerBoundCents: i === 0 ? undefined : strikeCents,
          upperBoundCents: i === 0 ? strikeCents : undefined,
        })),
      });
    }
    if (m.marketId === 2 && m.durationSeconds === 3600) {
      const slotStartMs = Math.floor(nowMs / TIMEFRAME_MS['1h']) * TIMEFRAME_MS['1h'];
      const slotEndMs = slotStartMs + TIMEFRAME_MS['1h'];
      const slotLabel = formatSlotTimeLabel(slotEndMs, '1h', nowMs);
      const strikeCents =
        m.epochKey === epochKey && m.strikePriceCents > 0 ? m.strikePriceCents : hourlyTarget * 100;
      const targetUsd = strikeCents / 100;
      return snapshot({
        ...m,
        status: 'OPEN',
        resolvedOutcome: undefined,
        resolutionPriceCents: undefined,
        resolutionSignatureHex: undefined,
        slug: 'bchusd-1h-breakout',
        timeframe: '1h',
        epochSeriesId: 'bchusd-1h',
        slotStartMs,
        slotLabel,
        createdAtMs: slotStartMs,
        expiryTimestampMs: slotEndMs,
        isCurrentSlot: true,
        isFutureSlot: false,
        isHistoricalSlot: false,
        retentionExpiresAtMs: slotEndMs + EPOCH_RETENTION_MS,
        epochKey: `1h:${Math.floor(slotEndMs / 1000)}`,
        title: `BCH/USD 1-Hour Breakout · ${slotLabel} (> $${targetUsd.toFixed(2)})`,
        strikePriceCents: strikeCents,
        buckets: m.buckets.map((b, i) => ({
          ...b,
          label: i === 0 ? `BELOW $${targetUsd}` : `ABOVE $${targetUsd}`,
          outcomeRule: i === 0 ? 'BELOW' : 'ABOVE',
          lowerBoundCents: i === 0 ? undefined : strikeCents,
          upperBoundCents: i === 0 ? strikeCents : undefined,
        })),
      });
    }
    if (m.marketId === 3 && m.buckets.length === 3) {
      const slotStartMs = Math.floor(nowMs / TIMEFRAME_MS['24h']) * TIMEFRAME_MS['24h'];
      const slotEndMs = slotStartMs + TIMEFRAME_MS['24h'];
      const slotLabel = formatSlotTimeLabel(slotEndMs, '24h', nowMs);
      const effectiveSpot =
        m.epochKey === epochKey && m.strikePriceCents > 0 ? m.strikePriceCents / 100 : spotRounded;
      const effBear =
        m.epochKey === epochKey && m.buckets[0]?.upperBoundCents
          ? Math.round(m.buckets[0].upperBoundCents / 100)
          : m.epochKey === epochKey
            ? Math.round(effectiveSpot * 0.97)
            : bearCut;
      const effBull =
        m.epochKey === epochKey && m.buckets[1]?.upperBoundCents
          ? Math.round(m.buckets[1].upperBoundCents / 100)
          : m.epochKey === epochKey
            ? Math.round(effectiveSpot * 1.03)
            : bullCut;
      const bearCents = effBear * 100;
      const bullCents = effBull * 100;
      return snapshot({
        ...m,
        status: 'OPEN',
        resolvedOutcome: undefined,
        resolutionPriceCents: undefined,
        resolutionSignatureHex: undefined,
        slug: 'bchusd-24h-range',
        timeframe: '24h',
        epochSeriesId: 'bchusd-24h',
        slotStartMs,
        slotLabel,
        createdAtMs: slotStartMs,
        expiryTimestampMs: slotEndMs,
        isCurrentSlot: true,
        isFutureSlot: false,
        isHistoricalSlot: false,
        retentionExpiresAtMs: slotEndMs + EPOCH_RETENTION_MS,
        epochKey: `24h:${Math.floor(slotEndMs / 1000)}`,
        title: `BCH/USD 24h Range · ${slotLabel} ($${effBear} – $${effBull})`,
        strikePriceCents: Math.round(effectiveSpot * 100),
        buckets: m.buckets.map((b, i) => ({
          ...b,
          label:
            i === 0
              ? `BEAR (< $${effBear})`
              : i === 1
                ? `RANGE ($${effBear} – $${effBull})`
                : `BULL (> $${effBull})`,
          outcomeRule: i === 0 ? 'BELOW' : i === 1 ? 'RANGE' : 'ABOVE',
          lowerBoundCents: i === 0 ? undefined : i === 1 ? bearCents : bullCents + 1,
          upperBoundCents: i === 0 ? bearCents : i === 1 ? bullCents : undefined,
        })),
      });
    }
    return m;
  }

  private deterministicEpochMarketId(timeframe: MarketTimeframe, slotStartMs: number): number {
    const stepMs = TIMEFRAME_MS[timeframe];
    const slotIndex = Math.max(1, Math.floor((slotStartMs - EPOCH_BASE_MS) / stepMs));
    return TIMEFRAME_ID_OFFSET[timeframe] + slotIndex;
  }

  private buildTimeSlotMarket(params: {
    timeframe: MarketTimeframe;
    slotStartMs: number;
    nowMs: number;
    liveSpotUsd: number;
    oracles?: HistoricalCandleOracles;
  }): ConfigurableMarket {
    const { timeframe, slotStartMs, nowMs, liveSpotUsd, oracles } = params;
    const stepMs = TIMEFRAME_MS[timeframe];
    const slotEndMs = slotStartMs + stepMs;
    const slotEndSec = Math.floor(slotEndMs / 1000);
    const epochKey = `${timeframe}:${slotEndSec}`;
    const currentSlotStart = Math.floor(nowMs / stepMs) * stepMs;
    const isHistoricalSlot = slotEndMs <= nowMs;
    const isFutureSlot = slotStartMs > currentSlotStart;
    const marketId = this.deterministicEpochMarketId(timeframe, slotStartMs);
    const slug = `bchusd-${timeframe}-${slotEndSec}`;
    const slotLabel = formatSlotTimeLabel(slotEndMs, timeframe, nowMs);

    // Preserve any user-staked state already stored for this time slot
    const persisted = this.store
      .listMarkets()
      .find((m) => m.epochKey === epochKey || m.slug === slug || m.marketId === marketId);

    const candleInterval = timeframe === '24h' ? '1d' : timeframe;
    const windowPrices =
      isHistoricalSlot && oracles
        ? oracles.findWindowPrices(slotStartMs, slotEndMs, candleInterval)
        : undefined;
    const opening = oracles?.candlesByInterval[candleInterval].find(c => c.time * 1000 === slotStartMs)?.open;
    const referenceSpot = windowPrices?.openUsd ?? opening ?? liveSpotUsd;
    const strikeRounded = Math.round(referenceSpot);
    const hourlyTarget = Math.round(referenceSpot * 1.015);
    const bearCut = Math.round(referenceSpot * 0.97);
    const bullCut = Math.round(referenceSpot * 1.03);

    const feeBps = persisted?.feeBps ?? DEFAULT_PROTOCOL_FEE_BPS;
    const categoryId =
      persisted?.categoryId ??
      createHash('sha256').update(`cashingularity-epoch-${epochKey}`).digest('hex');
    const id = persisted?.id ?? this.deterministicUuid(`epoch-${epochKey}-${categoryId}`);
    const covenantAddress =
      persisted?.covenantAddress ??
      deriveP2sh32CashAddr(`market-${marketId}-${categoryId}`, 'mainnet').standardAddress;

    let rawBuckets: MarketBucketPool[];
    let strikePriceCents: number;
    let title: string;
    let description: string;

    if (timeframe === '5m' || timeframe === '1m') {
      const strike = windowPrices?.openUsd
        ? Number(windowPrices.openUsd.toFixed(2))
        : strikeRounded;
      strikePriceCents = Math.round(strike * 100);
      title = `BCH/USD ${timeframe} · ${slotLabel} (> $${strike.toFixed(2)})`;
      description = isHistoricalSlot
        ? `Settled ${timeframe} BCH/USD epoch ending ${slotLabel} against the exact exchange candle close.`
        : `Rolling ${timeframe} BCH/USD epoch ending ${slotLabel}.`;
      rawBuckets = (persisted?.buckets ?? [
        {
          bucketId: 0,
          label: `BELOW $${strike.toFixed(2)}`,
          poolSats: 450_000n,
          participantCount: 1,
          impliedProbability: 0.45,
          currentMultiplier: 2.19,
        },
        {
          bucketId: 1,
          label: `ABOVE $${strike.toFixed(2)}`,
          poolSats: 550_000n,
          participantCount: 1,
          impliedProbability: 0.55,
          currentMultiplier: 1.79,
        },
      ]).map((b, i) => ({
        ...b,
        outcomeRule: i === 0 ? ('BELOW' as const) : ('ABOVE' as const),
        lowerBoundCents: i === 0 ? undefined : strikePriceCents,
        upperBoundCents: i === 0 ? strikePriceCents : undefined,
      }));
    } else if (timeframe === '1h') {
      strikePriceCents = hourlyTarget * 100;
      title = `BCH/USD 1h · ${slotLabel} (> $${hourlyTarget.toFixed(2)})`;
      description = isHistoricalSlot
        ? `Settled 1-hour BCH/USD breakout epoch ending ${slotLabel} against Binance 1h candle close.`
        : `Rolling 1-hour BCH/USD breakout epoch ending ${slotLabel}.`;
      rawBuckets = (persisted?.buckets ?? [
        {
          bucketId: 0,
          label: `BELOW $${hourlyTarget}`,
          poolSats: 620_000n,
          participantCount: 1,
          impliedProbability: 0.5167,
          currentMultiplier: 1.91,
        },
        {
          bucketId: 1,
          label: `ABOVE $${hourlyTarget}`,
          poolSats: 580_000n,
          participantCount: 1,
          impliedProbability: 0.4833,
          currentMultiplier: 2.04,
        },
      ]).map((b, i) => ({
        ...b,
        outcomeRule: i === 0 ? ('BELOW' as const) : ('ABOVE' as const),
        lowerBoundCents: i === 0 ? undefined : strikePriceCents,
        upperBoundCents: i === 0 ? strikePriceCents : undefined,
      }));
    } else {
      strikePriceCents = strikeRounded * 100;
      const bearCents = bearCut * 100;
      const bullCents = bullCut * 100;
      title = `BCH/USD 24h · ${slotLabel} ($${bearCut} – $${bullCut})`;
      description = isHistoricalSlot
        ? `Settled 24-hour BCH/USD range epoch for ${slotLabel} against Binance daily candle close.`
        : `Rolling 24-hour BCH/USD volatility band ending ${slotLabel}.`;
      rawBuckets = (persisted?.buckets ?? [
        {
          bucketId: 0,
          label: `BEAR (< $${bearCut})`,
          poolSats: 800_000n,
          participantCount: 1,
          impliedProbability: 0.2667,
          currentMultiplier: 3.71,
        },
        {
          bucketId: 1,
          label: `RANGE ($${bearCut} – $${bullCut})`,
          poolSats: 1_200_000n,
          participantCount: 1,
          impliedProbability: 0.4,
          currentMultiplier: 2.47,
        },
        {
          bucketId: 2,
          label: `BULL (> $${bullCut})`,
          poolSats: 1_000_000n,
          participantCount: 1,
          impliedProbability: 0.3333,
          currentMultiplier: 2.97,
        },
      ]).map((b, i) => ({
        ...b,
        outcomeRule: i === 0 ? ('BELOW' as const) : i === 1 ? ('RANGE' as const) : ('ABOVE' as const),
        lowerBoundCents: i === 0 ? undefined : i === 1 ? bearCents : bullCents + 1,
        upperBoundCents: i === 0 ? bearCents : i === 1 ? bullCents : undefined,
      }));
    }

    strikePriceCents = persisted?.strikePriceCents ?? strikePriceCents;
    const totalPoolSats =
      persisted?.totalPoolSats ?? rawBuckets.reduce((acc, b) => acc + b.poolSats, 0n);
    const buckets = this.recomputeBucketMetrics(rawBuckets, totalPoolSats, feeBps);

    let status: ConfigurableMarket['status'] = persisted?.status ?? 'OPEN';
    let resolvedOutcome = persisted?.resolvedOutcome;
    let resolutionPriceCents = persisted?.resolutionPriceCents;
    let resolutionSignatureHex = persisted?.resolutionSignatureHex;

    if (isHistoricalSlot && status !== 'RESOLVED' && windowPrices) {
      const closeUsd = windowPrices.closeUsd;
      resolutionPriceCents = Math.round(closeUsd * 100);
      if (timeframe === '24h') {
        resolvedOutcome =
          resolutionPriceCents < bearCut * 100
            ? 0
            : resolutionPriceCents > bullCut * 100
              ? 2
              : 1;
      } else {
        resolvedOutcome = resolutionPriceCents >= strikePriceCents ? 1 : 0;
      }
      status = 'RESOLVED';
      resolutionSignatureHex = undefined; // A hash is not an oracle signature.
    }

    return {
      id,
      slug,
      marketId,
      title,
      description,
      assetPair: 'BCH/USD',
      strikePriceCents,
      createdAtMs: slotStartMs,
      durationSeconds: Math.floor(stepMs / 1000),
      expiryTimestampMs: slotEndMs,
      feeBps,
      status,
      totalPoolSats,
      buckets,
      oraclePubKeyHex: persisted?.oraclePubKeyHex ?? '02' + 'ab'.repeat(32),
      covenantAddress,
      categoryId,
      resolvedOutcome,
      resolutionPriceCents,
      resolutionSignatureHex,
      timeframe,
      epochSeriesId: `bchusd-${timeframe}`,
      slotStartMs,
      slotLabel,
      isCurrentSlot: slotStartMs === currentSlotStart,
      isFutureSlot,
      isHistoricalSlot,
      retentionExpiresAtMs: slotEndMs + EPOCH_RETENTION_MS,
      epochKey,
    };
  }

  /**
   * Generates wall-clock-aligned rolling 5m, 1h, and 24h market epochs with 7-day historical
   * retention, 24-hour future schedule, and automatic settlement against real Binance candles.
   */
  public getCuratedMarketsWithLiveSpot(
    liveSpotUsd: number,
    options?: {
      nowMs?: number;
      oracles?: HistoricalCandleOracles;
      timeframe?: MarketTimeframe;
      includeExtended?: boolean;
    }
  ): ConfigurableMarket[] {
    const nowMs = options?.nowMs ?? Date.now();
    const oracles = options?.oracles;
    this.store.pruneExpiredEpochMarkets(nowMs);

    const persisted = this.store.listMarkets();
    const activeCurated = persisted
      .filter((m) => m.marketId <= 3)
      .sort((a, b) => a.marketId - b.marketId)
      .map((m) => this.alignMarketWithLiveSpot(m, liveSpotUsd, nowMs, oracles));

    const customAdmin = persisted
      .filter((m) => m.marketId > 3 && m.marketId < 100_000_000)
      .map((m) => this.alignMarketWithLiveSpot(m, liveSpotUsd, nowMs, oracles));

    const rollingEpochs: ConfigurableMarket[] = [];
    const seenKeys = new Set<string>(
      activeCurated.map((m) => m.epochKey).filter((k): k is string => Boolean(k))
    );

    const archive: ConfigurableMarket[] = [];
    const addWindow = (tf: MarketTimeframe, pastSlots: number, futureSlots: number) => {
      if (options?.timeframe && options.timeframe !== tf) return;
      const stepMs = TIMEFRAME_MS[tf];
      const currentStart = Math.floor(nowMs / stepMs) * stepMs;
      for (let offset = -pastSlots; offset <= futureSlots; offset++) {
        if (offset === 0 && activeCurated.some(m => m.timeframe === tf)) continue;
        const slotStartMs = currentStart + offset * stepMs;
        if (nowMs - (slotStartMs + stepMs) > EPOCH_RETENTION_MS) continue;
        if (slotStartMs - nowMs > EPOCH_FUTURE_HORIZON_MS) continue;
        const previous = persisted.find(m => m.epochKey === `${tf}:${Math.floor((slotStartMs + stepMs) / 1000)}`);
        if (slotStartMs + stepMs <= nowMs && previous?.status !== 'RESOLVED' && !oracles?.findWindowPrices(slotStartMs, slotStartMs + stepMs, tf === '24h' ? '1d' : tf)) continue;
        const slot = this.buildTimeSlotMarket({
          timeframe: tf,
          slotStartMs,
          nowMs,
          liveSpotUsd,
          oracles,
        });
        if (slot.epochKey && !seenKeys.has(slot.epochKey)) {
          seenKeys.add(slot.epochKey);
          rollingEpochs.push(slot);
          if (slot.status === 'RESOLVED' && Number.isFinite(slot.resolutionPriceCents)) archive.push(slot);
        }
      }
    };

    const full = Boolean(options?.includeExtended);
    // 5m: recent 1h past (12) .. +2h future (24), or up to full 24h when extended
    addWindow('1m', full ? 7 * 1440 : 4, full ? 1440 : 4);
    addWindow('5m', full ? 7 * 288 : 12, full ? 288 : 24);
    // 1h: 24h past .. 24h future (or full 7d past when extended)
    addWindow('1h', full ? 168 : 24, 24);
    // 24h: full 7d past .. +24h future
    addWindow('24h', 7, 1);

    this.store.archiveResolvedEpochs(archive);
    const filteredActive = options?.timeframe
      ? activeCurated.filter((m) => m.timeframe === options.timeframe)
      : activeCurated;

    return [...filteredActive, ...customAdmin.filter(m => !options?.timeframe || m.durationSeconds * 1000 === TIMEFRAME_MS[options.timeframe]), ...rollingEpochs.filter(m => !m.isHistoricalSlot || (m.status === 'RESOLVED' && Number.isFinite(m.resolutionPriceCents)))];
  }

  private recomputeBucketMetrics(
    buckets: MarketBucketPool[],
    totalPoolSats: bigint,
    feeBps: bigint
  ): MarketBucketPool[] {
    return buckets.map((bucket) => {
      const sim = calculateParimutuelMultiplier({
        totalPoolSats,
        bucketPoolSats: bucket.poolSats,
        deltaStakeSats: 0n,
        feeBps,
        outputDustCount: 1n,
      });
      const impliedProbability =
        totalPoolSats > 0n
          ? Number(((bucket.poolSats * 10_000n) / totalPoolSats)) / 10_000
          : Number((1 / buckets.length).toFixed(4));

      return {
        ...bucket,
        impliedProbability: Number(impliedProbability.toFixed(4)),
        currentMultiplier: sim.multiplier,
      };
    });
  }

  public listMarkets(): ConfigurableMarket[] {
    return this.store.listMarkets();
  }

  public getMarketOrThrow(marketId: number): ConfigurableMarket {
    const market = this.store.getMarket(marketId);
    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }
    return market;
  }

  /**
   * Resolves a market by UUID `id`, text `slug` (canonical or rolling time slot), or numeric `marketId`.
   */
  public resolveMarketByIdOrSlug(
    idOrSlug: string,
    liveSpotUsd?: number,
    nowMs: number = Date.now(),
    oracles?: HistoricalCandleOracles
  ): ConfigurableMarket | undefined {
    const key = idOrSlug.trim().toLowerCase();
    if (!key) return undefined;

    const markets = this.store.listMarkets();
    const found = markets.find(
      (m) =>
        m.id?.toLowerCase() === key ||
        m.slug?.toLowerCase() === key ||
        (/^\d+$/.test(key) && m.marketId === Number(key))
    );
    if (found) {
      return liveSpotUsd && liveSpotUsd > 10
        ? this.alignMarketWithLiveSpot(found, liveSpotUsd, nowMs, oracles)
        : found;
    }

    // Dynamic resolution for time-indexed slugs (`bchusd-5m-<endSec>`, `bchusd-1h-<endSec>`, `bchusd-24h-<endSec>`)
    const slugMatch = /^bchusd-(1m|5m|1h|24h)-(\d{9,12})$/.exec(key);
    if (slugMatch) {
      const tf = slugMatch[1] as MarketTimeframe;
      const endSec = Number(slugMatch[2]);
      const stepMs = TIMEFRAME_MS[tf];
      const slotEndMs = endSec * 1000;
      const slotStartMs = slotEndMs - stepMs;
      if (
        slotStartMs % stepMs === 0 &&
        nowMs - slotEndMs <= EPOCH_RETENTION_MS &&
        slotStartMs - nowMs <= EPOCH_FUTURE_HORIZON_MS
      ) {
        return this.buildTimeSlotMarket({
          timeframe: tf,
          slotStartMs,
          nowMs,
          liveSpotUsd: liveSpotUsd && liveSpotUsd > 10 ? liveSpotUsd : 205,
          oracles,
        });
      }
    }

    // Dynamic resolution for numeric epoch IDs (>= 100_000_000)
    if (/^\d+$/.test(key)) {
      const numericId = Number(key);
      for (const tf of ['1m', '5m', '1h', '24h'] as const) {
        const offset = TIMEFRAME_ID_OFFSET[tf];
        const nextOffset = offset + 100_000_000;
        if (numericId >= offset && numericId < nextOffset) {
          const slotIndex = numericId - offset;
          const slotStartMs = EPOCH_BASE_MS + slotIndex * TIMEFRAME_MS[tf];
          const slotEndMs = slotStartMs + TIMEFRAME_MS[tf];
          if (
            nowMs - slotEndMs <= EPOCH_RETENTION_MS &&
            slotStartMs - nowMs <= EPOCH_FUTURE_HORIZON_MS
          ) {
            return this.buildTimeSlotMarket({
              timeframe: tf,
              slotStartMs,
              nowMs,
              liveSpotUsd: liveSpotUsd && liveSpotUsd > 10 ? liveSpotUsd : 205,
              oracles,
            });
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Persists a dynamically generated rolling epoch into the WAL store before accepting a user stake.
   */
  public ensureMarketPersisted(market: ConfigurableMarket): ConfigurableMarket {
    const existing = this.store.getMarket(market.marketId);
    if (existing) return existing;
    return this.store.upsertMarket(market);
  }

  /**
   * Creates a new configurable parimutuel prediction market with any custom duration T (`durationSeconds`).
   */
  public createMarket(params: {
    id?: string;
    slug?: string;
    title: string;
    description: string;
    assetPair?: string;
    strikePriceCents: number;
    durationSeconds: number;
    bucketLabels?: string[];
    initialBucketsSats?: bigint[];
    feeBps?: bigint;
    nowMs?: number;
  }): ConfigurableMarket {
    if (params.durationSeconds < 10) {
      throw new Error('Market durationSeconds must be at least 10 seconds.');
    }

    const existing = this.store.listMarkets().filter((m) => m.marketId < 100_000_000);
    const marketId = existing.length > 0 ? Math.max(...existing.map((m) => m.marketId)) + 1 : 1;
    const nowMs = params.nowMs ?? Date.now();
    const feeBps = params.feeBps ?? DEFAULT_PROTOCOL_FEE_BPS;
    const labels = params.bucketLabels?.length
      ? params.bucketLabels
      : ['NO / DOWN', 'YES / UP'];

    let totalPoolSats = 0n;
    const rawBuckets: MarketBucketPool[] = labels.map((label, idx) => {
      const initialSats = params.initialBucketsSats?.[idx] ?? 100_000n;
      totalPoolSats += initialSats;
      const isRange = labels.length === 3;
      const bearCents = Math.round(params.strikePriceCents * 0.97);
      const bullCents = Math.round(params.strikePriceCents * 1.03);
      return {
        bucketId: idx,
        label,
        poolSats: initialSats,
        participantCount: initialSats > 0n ? 1 : 0,
        impliedProbability: 0,
        currentMultiplier: 1,
        outcomeRule: isRange
          ? idx === 0
            ? 'BELOW'
            : idx === 1
              ? 'RANGE'
              : 'ABOVE'
          : idx === 0
            ? 'BELOW'
            : 'ABOVE',
        lowerBoundCents: isRange
          ? idx === 0
            ? undefined
            : idx === 1
              ? bearCents
              : bullCents + 1
          : idx === 0
            ? undefined
            : params.strikePriceCents,
        upperBoundCents: isRange
          ? idx === 0
            ? bearCents
            : idx === 1
              ? bullCents
              : undefined
          : idx === 0
            ? params.strikePriceCents
            : undefined,
      };
    });

    const buckets = this.recomputeBucketMetrics(rawBuckets, totalPoolSats, feeBps);
    const categoryId = createHash('sha256')
      .update(`cashingularity-market-${marketId}-${nowMs}`)
      .digest('hex');

    const slug = params.slug
      ? params.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      : this.curatedSlugForMarket({
          marketId,
          durationSeconds: params.durationSeconds,
          bucketsCount: buckets.length,
          title: params.title,
        });

    const market: ConfigurableMarket = {
      id: params.id ?? this.deterministicUuid(`market-${marketId}-${categoryId}`),
      slug,
      marketId,
      title: params.title,
      description: params.description,
      assetPair: params.assetPair ?? 'BCH/USD',
      strikePriceCents: params.strikePriceCents,
      createdAtMs: nowMs,
      durationSeconds: params.durationSeconds,
      expiryTimestampMs: nowMs + params.durationSeconds * 1000,
      feeBps,
      status: 'OPEN',
      totalPoolSats,
      buckets,
      oraclePubKeyHex: '02' + 'ab'.repeat(32),
      covenantAddress: deriveP2sh32CashAddr(
        `market-${marketId}-${categoryId}`,
        'mainnet'
      ).standardAddress,
      categoryId,
    };

    return this.store.upsertMarket(market);
  }

  /**
   * Places a stake in a configurable market bucket, builds the Rabby UTXO DAG inspection
   * and WizardConnect SignTransactionRequest, and persists the position.
   */
  public placeStake(params: {
    marketId: number;
    bucketId: number;
    stakeSats: bigint;
    predictorAddress?: string;
    predictorTokenAddress?: string;
    walletUtxos?: WalletUtxo[];
    mode?: ExecutionMode;
    entrySpotUsd?: number;
    txid?: string;
    expiresAtMs?: number;
  }): PlaceStakeResult {
    const MAX_BCH_SUPPLY_SATS = 2_100_000_000_000_000n;
    const market = this.getMarketOrThrow(params.marketId);
    if (params.mode === 'MAINNET_MODE') throw new Error('On-chain stake indexing requires independently verified chain transactions.');
    const now = Date.now();
    if (market.createdAtMs > now || market.expiryTimestampMs <= now) throw new Error('Market is not in its active epoch.');
    if (params.expiresAtMs !== undefined && params.expiresAtMs !== market.expiryTimestampMs) throw new Error('Position expiry must match the market epoch.');
    if (market.status !== 'OPEN') {
      throw new Error(`Market ${market.marketId} is ${market.status} and cannot accept new stakes.`);
    }
    if (!Number.isInteger(params.bucketId) || params.bucketId < 0) {
      throw new Error('Outcome bucketId must be a non-negative integer.');
    }
    if (!isAboveDustLimit(params.stakeSats) || params.stakeSats > MAX_BCH_SUPPLY_SATS) {
      throw new Error(
        `Stake (${params.stakeSats.toString()} sats) must be between ${DUST_LIMIT_SATS.toString()} and ${MAX_BCH_SUPPLY_SATS.toString()} sats.`
      );
    }
    if (params.txid !== undefined && !/^[a-f0-9]{64}$/i.test(params.txid)) {
      throw new Error('txid must be a valid 64-character hexadecimal hash.');
    }
    if (params.predictorAddress !== undefined) {
      const addrCheck = validateAndConvertCashAddr(params.predictorAddress);
      if (!addrCheck.valid) {
        throw new Error(addrCheck.error ?? 'Invalid predictorAddress CashAddr.');
      }
    }

    const bucket = market.buckets.find((b) => b.bucketId === params.bucketId);
    if (!bucket) {
      throw new Error(`Invalid outcome bucketId ${params.bucketId} for market ${market.marketId}`);
    }

    const simulation = calculateParimutuelMultiplier({
      totalPoolSats: market.totalPoolSats,
      bucketPoolSats: bucket.poolSats,
      deltaStakeSats: params.stakeSats,
      feeBps: market.feeBps,
      outputDustCount: 1n,
    });

    const userAddress =
      params.predictorAddress ?? 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
    const userTokenAddress =
      params.predictorTokenAddress ?? 'bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m';
    const userChangeAddress = 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';

    const poolTxid = createHash('sha256')
      .update(`pool-utxo-${market.marketId}-${market.totalPoolSats.toString()}`)
      .digest('hex');
    const userFundingTxid = createHash('sha256')
      .update(`user-utxo-${userAddress}-${Date.now()}`)
      .digest('hex');

    const dagInspection = buildPredictionStakeDagPreview({
      marketId: market.marketId,
      bucketId: params.bucketId,
      stakeSats: params.stakeSats,
      poolTxid,
      poolCurrentSats: market.totalPoolSats,
      poolAddress: market.covenantAddress,
      categoryId: market.categoryId,
      userFundingTxid,
      userFundingVout: 0,
      userFundingSats: params.stakeSats + 50_000n,
      userAddress,
      userTokenAddress,
      userChangeAddress,
      walletUtxos: params.walletUtxos,
    });

    const wizardSignRequest = buildWizardSignRequest({
      transaction: {
        version: 2,
        locktime: 0,
        inputs: dagInspection.inputs,
        outputs: dagInspection.outputs,
      },
      inputs: [
        { inputIndex: 0, scope: 'defi', addressIndex: 0 },
        { inputIndex: 1, scope: 'receive', addressIndex: 0 },
      ],
      userPrompt: `Cashingularity: Stake ${params.stakeSats.toString()} sats on "${bucket.label}" (Market #${market.marketId})`,
    });

    const commitmentBytes = encodeNftReceiptCommitment({
      marketId: market.marketId,
      bucketId: params.bucketId,
      stakeSats: params.stakeSats,
    });
    const nftCommitmentHex = Array.from(commitmentBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    bucket.poolSats += params.stakeSats;
    bucket.participantCount += 1;
    market.totalPoolSats += params.stakeSats;
    market.buckets = this.recomputeBucketMetrics(
      market.buckets,
      market.totalPoolSats,
      market.feeBps
    );

    this.store.upsertMarket(market);

    const nowMs = Date.now();
    const resolvedEntrySpot =
      params.entrySpotUsd && Number.isFinite(params.entrySpotUsd) && params.entrySpotUsd > 10
        ? Number(params.entrySpotUsd.toFixed(2))
        : Number((market.strikePriceCents / 100).toFixed(2));
    const displayMarketBefore = this.alignMarketWithLiveSpot(market, resolvedEntrySpot);
    const displayBucket =
      displayMarketBefore.buckets.find((b) => b.bucketId === params.bucketId) ?? bucket;
    const txid = params.txid || dagInspection.txidPreview;

    const stakeRecord: MarketStakeRecord = {
      stakeId: `stake-${market.marketId}-${nowMs}`,
      marketId: market.marketId,
      bucketId: params.bucketId,
      stakeSats: params.stakeSats,
      predictorAddress: userAddress,
      nftCommitmentHex,
      mode: params.mode ?? 'SANDBOX_MODE',
      txid,
      createdAtMs: nowMs,
    };
    this.store.insertStake(stakeRecord);

    const positionExpiresAtMs =
      params.expiresAtMs ??
      (market.expiryTimestampMs > nowMs
        ? market.expiryTimestampMs
        : nowMs + market.durationSeconds * 1000);
    const lockedMultiplierBps = Math.max(
      10_000,
      Math.round(simulation.multiplier * 10_000)
    );
    this.positionSeq += 1;

    const position: MarketPositionRecord = {
      positionId: `pos-${market.marketId}-${nowMs}-${this.positionSeq}`,
      marketId: market.marketId,
      marketTitle: displayMarketBefore.title,
      bucketId: params.bucketId,
      bucketLabel: displayBucket.label,
      outcomeRule: displayBucket.outcomeRule ?? (params.bucketId === 0 ? 'BELOW' : 'ABOVE'),
      lowerBoundCents: displayBucket.lowerBoundCents,
      upperBoundCents: displayBucket.upperBoundCents,
      stakeSats: params.stakeSats,
      entrySpotUsd: resolvedEntrySpot,
      strikePriceUsd: Number((displayMarketBefore.strikePriceCents / 100).toFixed(2)),
      lockedMultiplierBps,
      placedAtMs: nowMs,
      expiresAtMs: positionExpiresAtMs,
      mode: params.mode ?? 'SANDBOX_MODE',
      txid,
      predictorAddress: userAddress,
      status: 'OPEN',
      payoutSats: 0n,
    };
    this.store.upsertPosition(position);

    return {
      market: this.alignMarketWithLiveSpot(market, resolvedEntrySpot),
      stakeRecord,
      position,
      simulation,
      dagInspection,
      wizardSignRequest,
    };
  }

  public listPositions(filters?: {
    marketId?: number;
    status?: MarketPositionStatus;
    predictorAddress?: string;
  }): MarketPositionRecord[] {
    return this.store.listPositions(filters);
  }

  private evaluatePositionWin(
    position: MarketPositionRecord,
    settlementSpotUsd: number
  ): boolean {
    const spotCents = Math.round(settlementSpotUsd * 100);
    if (position.outcomeRule === 'ABOVE') {
      const thresholdCents =
        position.lowerBoundCents ?? Math.round(position.strikePriceUsd * 100);
      return spotCents >= thresholdCents;
    }
    if (position.outcomeRule === 'BELOW') {
      const thresholdCents =
        position.upperBoundCents ?? Math.round(position.strikePriceUsd * 100);
      return spotCents < thresholdCents;
    }
    if (
      position.outcomeRule === 'RANGE' &&
      position.lowerBoundCents !== undefined &&
      position.upperBoundCents !== undefined
    ) {
      return (
        spotCents >= position.lowerBoundCents &&
        spotCents <= position.upperBoundCents
      );
    }

    const market = this.store.getMarket(position.marketId);
    const bucket = market?.buckets.find((b) => b.bucketId === position.bucketId);
    if (bucket?.outcomeRule === 'ABOVE') {
      const thresholdCents =
        bucket.lowerBoundCents ?? Math.round(position.strikePriceUsd * 100);
      return spotCents >= thresholdCents;
    }
    if (bucket?.outcomeRule === 'BELOW') {
      const thresholdCents =
        bucket.upperBoundCents ?? Math.round(position.strikePriceUsd * 100);
      return spotCents < thresholdCents;
    }
    if (
      bucket?.outcomeRule === 'RANGE' &&
      bucket.lowerBoundCents !== undefined &&
      bucket.upperBoundCents !== undefined
    ) {
      return spotCents >= bucket.lowerBoundCents && spotCents <= bucket.upperBoundCents;
    }

    const strikeCents = Math.round(position.strikePriceUsd * 100);
    return position.bucketId === 0 ? spotCents < strikeCents : spotCents >= strikeCents;
  }

  /**
   * Settles a single open prediction market position against the real live spot/candle close price.
   */
  public settlePosition(params: {
    positionId: string;
    settlementSpotUsd: number;
    nowMs?: number;
    requireExpired?: boolean;
  }): MarketPositionRecord {
    const existing = this.store.getPosition(params.positionId);
    if (!existing) {
      throw new Error(`Position ${params.positionId} not found`);
    }
    if (existing.status !== 'OPEN') {
      return existing;
    }

    const nowMs = params.nowMs ?? Date.now();
    if (nowMs < existing.expiresAtMs) {
      throw new Error(
        `Position ${params.positionId} has not expired yet (expires at ${existing.expiresAtMs}).`
      );
    }

    if (!Number.isFinite(params.settlementSpotUsd) || params.settlementSpotUsd <= 0) throw new Error('A valid settlement price is required.');
    const spotUsd = Number(params.settlementSpotUsd.toFixed(2));
    const won = this.evaluatePositionWin(existing, spotUsd);
    const payoutSats = won
      ? (existing.stakeSats * BigInt(existing.lockedMultiplierBps)) / 10_000n
      : 0n;

    const settled: MarketPositionRecord = {
      ...existing,
      status: won ? 'WON' : 'LOST',
      payoutSats,
      settledAtMs: nowMs,
      settlementSpotUsd: spotUsd,
    };
    return this.store.upsertPosition(settled);
  }

  /**
   * Automatically settles any open positions whose expiry timestamp has elapsed using real Binance
   * exact candle closes; missing oracle data leaves positions pending.
   */
  public autoSettleExpiredPositions(
    settlementSpotUsd: number,
    nowMs: number = Date.now(),
    findCloseForTimestamp?: (timestampMs: number, interval?: '1m' | '5m' | '1h' | '1d') => number | undefined
  ): MarketPositionRecord[] {
    const settledNow: MarketPositionRecord[] = [];
    const openPositions = this.store.listPositions({ status: 'OPEN' });
    for (const pos of openPositions) {
      if (nowMs >= pos.expiresAtMs) {
        const market = this.store.getMarket(pos.marketId);
        const preferredInterval: '1m' | '5m' | '1h' | '1d' =
          market?.durationSeconds === 86_400
            ? '1d'
            : market?.durationSeconds === 3_600
              ? '1h'
              : '1m';
        const exactClose = findCloseForTimestamp
          ? findCloseForTimestamp(pos.expiresAtMs, preferredInterval)
          : undefined;
        if (exactClose === undefined) continue;
        settledNow.push(
          this.settlePosition({
            positionId: pos.positionId,
            settlementSpotUsd: exactClose,
            nowMs,
          })
        );
      }
    }
    return settledNow;
  }

  /**
   * Resolves a market with an oracle outcome and price.
   */
  public resolveMarket(params: {
    marketId: number;
    winningBucketId: number;
    resolutionPriceCents: number;
  }): ConfigurableMarket {
    const market = this.getMarketOrThrow(params.marketId);
    const winningBucket = market.buckets.find((b) => b.bucketId === params.winningBucketId);
    if (!winningBucket) {
      throw new Error(`Invalid winningBucketId ${params.winningBucketId}`);
    }

    if (Date.now() < market.expiryTimestampMs) throw new Error('Market has not expired.');
    if (!Number.isSafeInteger(params.resolutionPriceCents) || params.resolutionPriceCents <= 0) throw new Error('A valid resolution price is required.');
    market.status = 'RESOLVED';
    market.resolvedOutcome = params.winningBucketId;
    market.resolutionPriceCents = params.resolutionPriceCents;
    // Administrative attribution is not a cryptographic oracle signature.
    market.resolutionSignatureHex = undefined;

    return this.store.upsertMarket(market);
  }
}
