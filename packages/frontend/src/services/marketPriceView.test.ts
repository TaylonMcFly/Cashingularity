import { describe, expect, it } from "vitest";
import type { ConfigurableMarket } from "@cashingularity/shared";
import {
  epochPriceCurve, epochSpotSamples, leadingSpotOutcome, marketResolutionRules,
  parseChartLookback, smoothPriceDisplay, spotCandleRequest, spotPlotWindow,
} from "./marketPriceView.js";

describe("spot versus target presentation", () => {
  it('changes the chart window in seconds or minutes while keeping the epoch boundaries intact', () => {
    const market = { createdAtMs: 900_000, expiryTimestampMs: 1_200_000 };
    expect(parseChartLookback('30', 'seconds')).toBe(30);
    expect(parseChartLookback('2.5', 'minutes')).toBe(150);
    expect(parseChartLookback('1440', 'minutes')).toBe(86_400);
    for (const invalid of ['', '14', '30.5', '1e3', '86401']) expect(parseChartLookback(invalid, 'seconds')).toBeNull();
    expect(spotPlotWindow(market, 1_000_000, 30)).toEqual({ startMs: 970_000, endMs: 1_000_000 });
    expect(spotPlotWindow(market, 1_000_000, 600)).toEqual({ startMs: 400_000, endMs: 1_000_000 });
    expect(spotPlotWindow(market, 1_300_000, 30)).toEqual({ startMs: 1_170_000, endMs: 1_200_000 });
    for (const horizon of [30, 1800, 3600, 10_800, 43_200, 86_400]) {
      const request = spotCandleRequest(horizon);
      expect(request.limit).toBeLessThanOrEqual(200);
      expect((request.limit - 1) * request.step).toBeGreaterThan(horizon);
    }
  });
  it('shows the leading outcome at market precision and includes both daily range boundaries', () => {
    const below = { bucketId: 0, label: 'BELOW', outcomeRule: 'BELOW', upperBoundCents: 20_800 };
    const above = { bucketId: 1, label: 'ABOVE', outcomeRule: 'ABOVE', lowerBoundCents: 20_800 };
    const binary = { strikePriceCents: 20_800, buckets: [below, above] } as ConfigurableMarket;
    expect(leadingSpotOutcome(binary, 207.99)).toBe('BELOW');
    expect(leadingSpotOutcome(binary, 208)).toBe('ABOVE');
    expect(leadingSpotOutcome(binary, 208.5)).toBe('ABOVE');
    const daily = { strikePriceCents: 20_800, buckets: [
      { ...below, upperBoundCents: 20_200 },
      { bucketId: 2, label: 'RANGE', outcomeRule: 'RANGE', lowerBoundCents: 20_200, upperBoundCents: 21_400 },
      { ...above, lowerBoundCents: 21_401 },
    ] } as ConfigurableMarket;
    expect(leadingSpotOutcome(daily, 202)).toBe('RANGE');
    expect(leadingSpotOutcome(daily, 214)).toBe('RANGE');
    expect(leadingSpotOutcome(daily, 214.01)).toBe('ABOVE');
    expect(leadingSpotOutcome(daily, NaN)).toBeUndefined();
  });
  it('fills an observed window with one-second cubic samples without overshooting source prices',()=>{
    const ticks=[{time:0,value:200},{time:40,value:210},{time:80,value:198},{time:120,value:202}];
    const copy=structuredClone(ticks),display=smoothPriceDisplay(ticks,0,120000);
    expect(display).toHaveLength(121);expect(display[0]).toEqual(ticks[0]);expect(display.at(-1)).toEqual(ticks.at(-1));
    expect(display.every((p,i)=>p.time===i&&p.value>=198&&p.value<=210)).toBe(true);
    for(const point of ticks)expect(display.find(p=>p.time===point.time)).toEqual(point);
    expect(display[10].value).not.toBe(202.5);expect(ticks).toEqual(copy);
  });
  it('advances only the display clock with the last known price, and bounds long-epoch rendering',()=>{
    const ticks=[{time:0,value:200},{time:60,value:202}];
    expect(smoothPriceDisplay(ticks,0,120000,false).at(-1)).toEqual({time:60,value:202});
    expect(smoothPriceDisplay(ticks,0,120000,true).at(-1)).toEqual({time:120,value:202});
    const long=smoothPriceDisplay([{time:0,value:200},{time:86400,value:205}],0,86400000);
    expect(long.length).toBeLessThan(2000);expect(long.slice(-121).every((p,i)=>p.time===86400-120+i)).toBe(true);
    expect(smoothPriceDisplay([],0,120000)).toEqual([]);
  });
  it('bootstraps a full historical curve from actual candle opens/closes and prefers observed ticks', () => {
    const candles=[{time:60,open:200,high:210,low:190,close:205,volume:10},{time:120,open:205,high:207,low:200,close:202,volume:12}];
    expect(epochPriceCurve(candles,60,[{time:130,value:204},{time:180,value:203},{time:181,value:900}],60000,180000,300000,300000)).toEqual([
      {time:60,value:200},{time:120,value:205},{time:130,value:204},{time:180,value:203},
    ]);
  });
  it('timestamps the partial live candle at its actual fetch time without using future closes', () => {
    const candles=[{time:60,open:200,high:210,low:190,close:205,volume:10}];
    expect(epochPriceCurve(candles,60,[],60000,120000,100000,90000)).toEqual([{time:60,value:200},{time:90,value:205}]);
    expect(epochPriceCurve(candles,60,[],60000,80000,200000,200000)).toEqual([{time:60,value:200}]);
    expect(epochPriceCurve([],60,[],60000,120000,100000,100000)).toEqual([]);
  });
  it("orders unique ticks and excludes invalid, future and other-epoch observations", () => {
    expect(
      epochSpotSamples(
        [
          { time: 4, value: 500 },
          { time: 2, value: 499 },
          { time: 2, value: 501 },
          { time: 1, value: 498 },
          { time: 5, value: NaN },
          { time: 6, value: 510 },
          { time: 3, value: -1 },
        ],
        2000,
        5000,
        4500,
      ),
    ).toEqual([
      { time: 2, value: 501 },
      { time: 4, value: 500 },
    ]);
  });
  it("describes structured outcome bounds and exact >= ABOVE parity rules", () => {
    const market = {
      strikePriceCents: 50_000,
      buckets: [
        { bucketId: 0, label: "BELOW $500", outcomeRule: "BELOW", upperBoundCents: 50_000 },
        { bucketId: 1, label: "ABOVE $500", outcomeRule: "ABOVE", lowerBoundCents: 50_000 },
      ],
    } as ConfigurableMarket;
    expect(marketResolutionRules(market, "SANDBOX_MODE")).toContain(
      "greater than or equal to",
    );
    expect(marketResolutionRules(market, "SANDBOX_MODE")).toContain(
      "price >= target -> ABOVE",
    );
    expect(marketResolutionRules(market, "MAINNET_MODE")).toContain(
      "price >= target -> ABOVE",
    );
    expect(
      marketResolutionRules(
        { strikePriceCents: 0, buckets: [{ label: "YES" }, { label: "NO" }] } as ConfigurableMarket,
        "MAINNET_MODE",
      ),
    ).toContain("not available");
  });
});
