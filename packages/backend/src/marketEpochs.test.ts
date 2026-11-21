import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigurableMarketEngine, TIMEFRAME_MS } from './marketEngine.js';
import { CashingularityWalStore } from './db.js';
import type { HistoricalCandleOracles } from './priceFeed.js';
describe('real timeframe epochs and durable resolution history', () => {
  it.each([{ close: 199.99, winner: 0 }, { close: 200, winner: 1 }])(
    'settles the two paper buckets once at expiry for a close of $close',
    ({ close, winner }) => {
      const directory = mkdtempSync(join(tmpdir(), 'cashingularity-up-down-'));
      try {
        const store = new CashingularityWalStore(directory);
        const engine = new ConfigurableMarketEngine(store);
        const market = engine.createMarket({
          title: 'UP/DOWN settlement test', description: 'Test only', strikePriceCents: 20_000,
          durationSeconds: 300, bucketLabels: ['DOWN', 'UP'],
        });
        const positions = [0, 1].map(bucketId => engine.placeStake({
          marketId: market.marketId, bucketId, stakeSats: 5000n, entrySpotUsd: 200, mode: 'SANDBOX_MODE',
        }).position);
        const expiry = market.expiryTimestampMs;
        expect(engine.autoSettleExpiredPositions(close, expiry - 1, () => close)).toEqual([]);
        expect(engine.autoSettleExpiredPositions(close, expiry, () => undefined)).toEqual([]);
        const settled = engine.autoSettleExpiredPositions(close, expiry, time => {
          expect(time).toBe(expiry);
          return close;
        });
        for (const position of positions) {
          const result = settled.find(row => row.positionId === position.positionId)!;
          expect(result.status).toBe(position.bucketId === winner ? 'WON' : 'LOST');
          expect(result.payoutSats).toBe(position.bucketId === winner
            ? position.stakeSats * BigInt(position.lockedMultiplierBps) / 10_000n : 0n);
        }
        expect(new ConfigurableMarketEngine(new CashingularityWalStore(directory))
          .autoSettleExpiredPositions(close, expiry, () => close)).toEqual([]);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
  );

  it('steps all four series exactly and persists only completed, priced history across reloads', () => {
    const directory = mkdtempSync(join(tmpdir(),'cashingularity-epoch-'));
    try {
      const now = Date.UTC(2026,10,17,12,31,12), store = new CashingularityWalStore(directory), engine = new ConfigurableMarketEngine(store);
      const oracles: HistoricalCandleOracles = { latestSpotUsd:202, source:'binance', fetchedAtMs:now, candlesByInterval:{'1m':[],'5m':[],'1h':[],'1d':[]}, findCloseUsdForTimestamp:()=>202,
        findWindowPrices:(start,end,interval) => {const step=interval==='1m'?60000:interval==='5m'?300000:interval==='1h'?3600000:86400000;return end<=now && end-start===step && start>=Math.floor(now/step)*step-4*step ? {openUsd:200,closeUsd:202}:undefined;} };
      for (const timeframe of ['1m','5m','1h','24h'] as const) {
        const records = engine.getCuratedMarketsWithLiveSpot(202,{timeframe,nowMs:now,oracles,includeExtended:true});
        const currentStart=Math.floor(now/TIMEFRAME_MS[timeframe])*TIMEFRAME_MS[timeframe];
        const nearby=records.filter(m=>m.createdAtMs>=currentStart-4*TIMEFRAME_MS[timeframe]&&m.createdAtMs<=currentStart+TIMEFRAME_MS[timeframe]).sort((a,b)=>a.createdAtMs-b.createdAtMs);
        expect(nearby.length).toBeGreaterThanOrEqual(5);
        for(let i=1;i<nearby.length;i++) expect(nearby[i].createdAtMs-nearby[i-1].createdAtMs).toBe(TIMEFRAME_MS[timeframe]);
        expect(records.every(m=>m.durationSeconds*1000===TIMEFRAME_MS[timeframe])).toBe(true);
        for (const past of records.filter(m=>m.expiryTimestampMs<=now)) {expect(past.status).toBe('RESOLVED');expect(past.resolutionPriceCents).toBe(20200);}
        const active=records.find(m=>m.createdAtMs<=now&&m.expiryTimestampMs>now)!;
        expect(engine.resolveMarketByIdOrSlug(active.slug!,202,now,oracles)?.marketId).toBe(active.marketId);
        expect(engine.resolveMarketByIdOrSlug(String(active.marketId),202,now,oracles)?.marketId).toBe(active.marketId);
      }
      const reloaded=new CashingularityWalStore(directory);
      const archive=reloaded.listMarkets().filter(m=>m.isHistoricalSlot);
      expect(archive.length).toBeGreaterThanOrEqual(16);
      expect(archive.every(m=>m.status==='RESOLVED'&&m.resolutionPriceCents===20200)).toBe(true);
      expect(reloaded.listMarkets().some(m=>m.isFutureSlot)).toBe(false);
    } finally {if(!resolve(directory).startsWith(resolve(tmpdir())+ '\\') && !resolve(directory).startsWith(resolve(tmpdir())+'/')) throw new Error('Unsafe cleanup.');rmSync(directory,{recursive:true,force:true});}
  });
});
