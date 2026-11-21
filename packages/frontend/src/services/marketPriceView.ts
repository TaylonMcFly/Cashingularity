import type { ConfigurableMarket, ExecutionMode, MarketBucketPool, OutcomeRuleKind } from "@cashingularity/shared";
import type { OhlcvCandlePoint } from './apiClient.js';

export type LookbackUnit = 'seconds' | 'minutes';
export const MIN_LOOKBACK_SECONDS = 15;
export const MAX_LOOKBACK_SECONDS = 86_400;

export function parseChartLookback(amount: string, unit: LookbackUnit): number | null {
  const text = amount.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const seconds = Number(text) * (unit === 'minutes' ? 60 : 1);
  const rounded = Math.round(seconds);
  return rounded >= MIN_LOOKBACK_SECONDS && rounded <= MAX_LOOKBACK_SECONDS &&
    Math.abs(seconds - rounded) < 1e-8 ? rounded : null;
}

export function spotPlotWindow(
  market: Pick<ConfigurableMarket, 'createdAtMs' | 'expiryTimestampMs'>,
  nowMs: number,
  lookbackSeconds?: number,
) {
  const endMs = Math.min(nowMs, market.expiryTimestampMs);
  const startMs = lookbackSeconds !== undefined
    ? endMs - lookbackSeconds * 1000
    : endMs === market.expiryTimestampMs ? market.createdAtMs : Math.min(market.createdAtMs, endMs - 120_000);
  return { startMs, endMs };
}

/** Resolution is chosen in bands so changing the lookback doesn't fetch per keystroke. */
export function spotCandleRequest(horizonSeconds: number) {
  if (horizonSeconds <= 30 * 60) return { interval: '1m' as const, step: 60, limit: 32 };
  if (horizonSeconds <= 3600) return { interval: '1m' as const, step: 60, limit: 62 };
  if (horizonSeconds <= 3 * 3600) return { interval: '1m' as const, step: 60, limit: 182 };
  if (horizonSeconds <= 12 * 3600) return { interval: '5m' as const, step: 300, limit: 146 };
  return { interval: '1h' as const, step: 3600, limit: 26 };
}

export function outcomeKind(bucket: Pick<MarketBucketPool, 'outcomeRule' | 'label'>): OutcomeRuleKind | undefined {
  if (bucket.outcomeRule) return bucket.outcomeRule;
  if (/\bRANGE\b/i.test(bucket.label)) return 'RANGE';
  if (/\b(BELOW|BEAR)\b/i.test(bucket.label)) return 'BELOW';
  if (/\b(ABOVE|BULL)\b/i.test(bucket.label)) return 'ABOVE';
}

/** Indicative only. Compare at the same cent precision as market resolution. */
export function leadingSpotOutcome(market: ConfigurableMarket, spotUsd: number): OutcomeRuleKind | undefined {
  if (!Number.isFinite(spotUsd) || spotUsd <= 0 || market.strikePriceCents <= 0) return undefined;
  const priceCents = Math.round(spotUsd * 100);
  const winners = market.buckets.filter(bucket => {
    switch (outcomeKind(bucket)) {
      case 'BELOW': return priceCents < (bucket.upperBoundCents ?? market.strikePriceCents);
      case 'ABOVE': return priceCents >= (bucket.lowerBoundCents ?? market.strikePriceCents);
      case 'RANGE': return bucket.lowerBoundCents !== undefined && bucket.upperBoundCents !== undefined &&
        priceCents >= bucket.lowerBoundCents && priceCents <= bucket.upperBoundCents;
      default: return false;
    }
  });
  if (winners.length === 1) return outcomeKind(winners[0]);
}

/** Display-only monotone cubic interpolation. Never use this series for settlement. */
export function smoothPriceDisplay(
  observations: Array<{time:number;value:number}>, startMs:number, endMs:number,
  extendLast = false,
): Array<{time:number;value:number}> {
  const points = epochSpotSamples(observations, 0, endMs, endMs);
  if (!points.length) return [];
  const start = Math.max(Math.ceil(startMs/1000), points[0].time);
  const last = points[points.length-1];
  const end = Math.min(Math.floor(endMs/1000), extendLast ? Math.floor(endMs/1000) : last.time);
  if (end < start) return [];
  const gaps = points.slice(1).map((p,i)=>p.time-points[i].time);
  const gradients = points.slice(1).map((p,i)=>(p.value-points[i].value)/gaps[i]);
  const slopes = points.map((_,i)=> {
    if (i===0) return gradients[0]??0;
    if (i===points.length-1) return gradients[i-1]??0;
    const a=gradients[i-1],b=gradients[i];
    if (a*b<=0) return 0;
    const w1=2*gaps[i]+gaps[i-1],w2=gaps[i]+2*gaps[i-1];
    return (w1+w2)/(w1/a+w2/b);
  });
  const times = new Set<number>([start,end]);
  // Keep long epochs bounded while preserving one-second detail in the last two minutes.
  const step=Math.max(1,Math.ceil((end-start)/1800));
  for(let time=start;time<=end;time+=step)times.add(time);
  for(let time=Math.max(start,end-120);time<=end;time++)times.add(time);
  for(const p of points)if(p.time>=start&&p.time<=end)times.add(p.time);
  let index=0;
  return [...times].sort((a,b)=>a-b).map(time=>{
    while(index<points.length-2&&points[index+1].time<time)index++;
    const a=points[index],b=points[index+1];
    if(!b||time>=last.time)return{time,value:last.value};
    const width=b.time-a.time,t=(time-a.time)/width,t2=t*t,t3=t2*t;
    const value=(2*t3-3*t2+1)*a.value+(t3-2*t2+t)*width*slopes[index]+(-2*t3+3*t2)*b.value+(t3-t2)*width*slopes[index+1];
    return{time,value:Math.max(Math.min(a.value,b.value),Math.min(Math.max(a.value,b.value),value))};
  });
}

/** Candle opens and observed closes, never invented intra-candle high/low paths. */
export function epochPriceCurve(
  candles: OhlcvCandlePoint[],
  intervalSeconds: number,
  ticks: Array<{ time: number; value: number }>,
  startMs: number,
  endMs: number,
  nowMs: number,
  fetchedAtMs: number,
) {
  const points: Array<{time: number; value: number}> = [];
  for (const candle of candles) {
    points.push({time:candle.time, value:candle.open});
    const observedClose = Math.floor(Math.min((candle.time + intervalSeconds) * 1000, fetchedAtMs, nowMs) / 1000);
    // A candle extending beyond the epoch cannot supply its settlement close.
    if (observedClose > candle.time && observedClose * 1000 <= endMs) points.push({time:observedClose, value:candle.close});
  }
  return epochSpotSamples([...points, ...ticks], startMs, endMs, nowMs);
}

export function epochSpotSamples(
  samples: Array<{ time: number; value: number }>,
  startMs: number,
  endMs: number,
  nowMs: number,
) {
  const unique = new Map<number, number>();
  for (const sample of samples) {
    if (
      Number.isSafeInteger(sample.time) &&
      Number.isFinite(sample.value) &&
      sample.value > 0 &&
      sample.time * 1000 >= startMs &&
      sample.time * 1000 <= Math.min(endMs, nowMs)
    )
      unique.set(sample.time, sample.value);
  }
  return [...unique]
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time, value }));
}

export function marketResolutionRules(
  market: ConfigurableMarket,
  mode: ExecutionMode,
): string {
  const belowBucket = market.buckets.find((b) => b.outcomeRule === "BELOW");
  const aboveBucket = market.buckets.find((b) => b.outcomeRule === "ABOVE");
  const rangeBucket = market.buckets.find((b) => b.outcomeRule === "RANGE");

  if (
    market.buckets.length === 3 &&
    rangeBucket &&
    rangeBucket.lowerBoundCents !== undefined &&
    rangeBucket.upperBoundCents !== undefined
  ) {
    const lower = (rangeBucket.lowerBoundCents / 100).toFixed(2);
    const upper = (rangeBucket.upperBoundCents / 100).toFixed(2);
    return `BEAR resolves strictly below $${lower}; BULL resolves strictly above $${upper}; RANGE includes both [$${lower}, $${upper}] boundaries. ${mode === "SANDBOX_MODE" ? "Paper Trading uses a fresh spot within 10 seconds after expiry, or the exact expiry candle when available. Missing expiry data remains pending." : "Backend-reported epochs settle using the Binance expiry candle close."}`;
  }

  if (market.buckets.length === 2 && ((belowBucket && aboveBucket) || market.strikePriceCents > 0)) {
    const strikeUsd = (
      (aboveBucket?.lowerBoundCents ?? market.strikePriceCents) / 100
    ).toFixed(2);
    return mode === "SANDBOX_MODE"
      ? `Paper Trading resolves ABOVE when the BCH/USD spot observed within 10 seconds after expiry, or the exact expiry candle close, is greater than or equal to $${strikeUsd} (price >= target -> ABOVE); BELOW resolves strictly less than $${strikeUsd}. Missing expiry data remains pending.`
      : `Epochs resolve ABOVE when the BCH/USD Binance candle close at expiry is greater than or equal to $${strikeUsd} (price >= target -> ABOVE); BELOW resolves strictly less than $${strikeUsd}.`;
  }

  return "The outcome rules for this market are not available. Check the market’s published resolution terms before placing a position.";
}
