import { describe, expect, it } from "vitest";
import type { ConfigurableMarket } from "@cashingularity/shared";
import {
  availableEpochs,
  findLiveEpoch,
  epochTimeframeFor,
  resolvedEpochs,
  resolutionWindowLabel,
  epochState,
  epochResult,
  focusedEpochWindow,
  matchesMarketCategory,
  resolvedOutcomeBadge,
  type EpochMarket,
} from "./marketEpochs.js";

const now = 1_800_000_000_000;
const market = (
  marketId: number,
  offset: number,
  extras: Partial<EpochMarket> = {},
): EpochMarket =>
  ({
    marketId,
    assetPair: "BCH/USD",
    durationSeconds: 300,
    strikePriceCents: 20_500,
    createdAtMs: now - 100_000,
    expiryTimestampMs: now + offset,
    status: "OPEN",
    epochSeriesId: "five-minute",
    ...extras,
  }) as EpochMarket;
describe("market epochs", () => {
  it('defaults to the active rolling slot, excluding reported, future and unrelated records', () => {
    const alias = market(1, -1, {status:'RESOLVED'});
    const live = market(2, 200000, {epochKey:'5m:live'});
    const other = market(3, 200000, {epochSeriesId:'other'});
    const future = market(4, 600000, {createdAtMs:now+300000});
    expect(findLiveEpoch([alias,other,future,live],alias,now)).toBe(live);
    expect(findLiveEpoch([alias,future],alias,now)).toBeUndefined();
    expect(findLiveEpoch([market(6, 200000, { isFutureSlot: true })], alias, now)).toBeUndefined();
    expect(findLiveEpoch([live,{...live,marketId:5,durationSeconds:60}],{assetPair:'BCH/USD',durationSeconds:60},now)?.marketId).toBe(5);
    // A legacy alias can overlap the time window; prefer its deterministic epoch record.
    expect(findLiveEpoch([{...alias,status:'OPEN',expiryTimestampMs:now+300000},live],alias,now)).toBe(live);
  });
  it('maps exact timeframe steps, fixes Custom at 5m, and excludes incomplete history', () => {
    expect([60,300,3600,86400].map(seconds => epochTimeframeFor(seconds))).toEqual(['1m','5m','1h','24h']);
    expect(epochTimeframeFor(86400,true)).toBe('5m');
    const valid=market(1,-300000,{status:'RESOLVED',resolvedOutcome:1,resolutionPriceCents:20400,buckets:[{bucketId:1,outcomeRule:'ABOVE'}] as ConfigurableMarket['buckets']});
    expect(resolvedEpochs([valid,{...valid,marketId:2,resolutionPriceCents:undefined},{...valid,marketId:3,status:'OPEN'},{...valid,marketId:4,expiryTimestampMs:now+1000},{...valid,marketId:5,expiryTimestampMs:now-600000,strikePriceCents:NaN}],valid,now).map(m=>m.marketId)).toEqual([1]);
  });
  it('labels the observed history window instead of assuming the retention maximum', () => {
    const first = market(1,-3600000), last = market(2,-60000);
    expect(resolutionWindowLabel([first,last])).toBe(`${new Date(first.expiryTimestampMs).toLocaleString()} – ${new Date(last.expiryTimestampMs).toLocaleString()}`);
    expect(resolutionWindowLabel([])).toBe('No observed history yet');
  });
  it("uses only returned records in the same explicit series and one-week / one-day window", () => {
    const selected = market(2, 300_000);
    const records = [
      market(3, 86_400_001),
      market(4, -604_800_001),
      market(5, -300_000),
      selected,
      market(6, 600_000),
      market(7, 300_000, { epochSeriesId: "other" }),
      market(8, 300_000, { durationSeconds: 3600 }),
      market(9, 300_000, { assetPair: "BTC/USD" }),
    ];
    expect(
      availableEpochs(records, selected, now).map((m) => m.marketId),
    ).toEqual([5, 2, 6]);
  });
  it("does not infer a series from unrelated markets with the same duration", () => {
    const selected = market(1, 0, { epochSeriesId: undefined });
    expect(
      availableEpochs(
        [selected, market(2, 300_000, { epochSeriesId: undefined })],
        selected,
        now,
      ),
    ).toEqual([selected]);
  });
  it("classifies epoch states without claiming ended markets are resolved", () => {
    expect(epochState(market(1, -1), now)).toBe("Ended");
    expect(epochState(market(2, -1, { status: "RESOLVED" }), now)).toBe(
      "Reported",
    );
    expect(
      epochState(market(3, 300_000, { createdAtMs: now + 1000 }), now),
    ).toBe("Upcoming");
    expect(epochState(market(4, 300_000), now)).toBe("Live");
  });
  it('filters by exact duration, including the separate 1m and 5m series', () => {
    for (const [timeframe, seconds] of [['1m', 60], ['5m', 300], ['1h', 3600], ['24h', 86400]] as const) {
      expect(matchesMarketCategory(market(1, 0, { durationSeconds: seconds }), timeframe)).toBe(true);
      expect(matchesMarketCategory(market(1, 0, { durationSeconds: seconds + 1 }), timeframe)).toBe(false);
    }
    expect(matchesMarketCategory(market(1, 0, { durationSeconds: 60 }), '5m')).toBe(false);
  });
  it('computes direction from the reported close independently of the payout bucket', () => {
    const close = (resolutionPriceCents: number, extra: Partial<EpochMarket> = {}) =>
      market(1, -1, { status: 'RESOLVED', resolutionPriceCents, ...extra });
    expect(epochResult(close(20_501), now)).toMatchObject({ direction: 'UP', spreadCents: 1 });
    expect(epochResult(close(20_499), now)).toMatchObject({ direction: 'DOWN', spreadCents: -1 });
    expect(epochResult(close(20_500, { resolvedOutcome: 1 }), now)).toMatchObject({ direction: 'FLAT', spreadCents: 0 });
    expect(epochResult(close(20_501, { status: 'OPEN' }), now)).toBeUndefined();
    expect(epochResult(close(20_501, { expiryTimestampMs: now + 1 }), now)).toBeUndefined();
    expect(epochResult(close(20_501.5), now)).toBeUndefined();
  });
  it("slices epoch bar to at most 9 focused slots centered on the selected epoch", () => {
    const sequence = Array.from({ length: 25 }, (_, i) =>
      market(100 + i, (i - 10) * 300_000),
    );
    expect(
      focusedEpochWindow(sequence, 110, 9).map((m) => m.marketId),
    ).toEqual([106, 107, 108, 109, 110, 111, 112, 113, 114]);
    expect(
      focusedEpochWindow(sequence, 100, 9).map((m) => m.marketId),
    ).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108]);
    expect(
      focusedEpochWindow(sequence, 124, 9).map((m) => m.marketId),
    ).toEqual([116, 117, 118, 119, 120, 121, 122, 123, 124]);
    expect(focusedEpochWindow(sequence.slice(0, 4), 102, 9)).toHaveLength(4);
  });
  it("extracts structured ABOVE, BELOW, and RANGE badges from resolved epochs", () => {
    const resolved = market(10, -300_000, {
      status: "RESOLVED",
      resolvedOutcome: 1,
      buckets: [
        {
          bucketId: 0,
          label: "BELOW $500",
          poolSats: 100_000n,
          participantCount: 1,
          impliedProbability: 0.5,
          currentMultiplier: 1.98,
          outcomeRule: "BELOW",
        },
        {
          bucketId: 1,
          label: "ABOVE $500",
          poolSats: 100_000n,
          participantCount: 1,
          impliedProbability: 0.5,
          currentMultiplier: 1.98,
          outcomeRule: "ABOVE",
        },
      ],
    });
    expect(resolvedOutcomeBadge(resolved)).toBe("ABOVE");
    expect(
      resolvedOutcomeBadge({ ...resolved, status: "OPEN" }),
    ).toBeUndefined();
  });
});
