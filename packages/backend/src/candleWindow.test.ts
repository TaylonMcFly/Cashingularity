import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceFeedService } from './priceFeed.js';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function offlineFeed() {
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('offline')));
  const feed=new PriceFeedService();await feed.refreshLiveRatesFromNetwork(true);return feed;
}
describe('read-only real candle windows',()=>{
  it('loads a bounded historical window and leaves live rates, ticks and quotes untouched',async()=>{
    const feed=await offlineFeed();
    vi.spyOn(Date,'now').mockReturnValue(Date.now());
    vi.spyOn(feed,'refreshLiveRatesFromNetwork').mockResolvedValue(undefined);
    const tick=feed.getCurrentTick(),quote=feed.getQuoteLock(),ticks=feed.getRecentTicks();
    const end=Math.floor(Date.now()/60000)*60000-1,open=Math.floor(end/60000)*60000;
    const network=vi.fn().mockResolvedValue(new Response(JSON.stringify([[open,'200','205','195','202','10']]),{status:200}));vi.stubGlobal('fetch',network);
    const result=await feed.fetchCandleWindow('1m',10,end);
    expect(result.source).toBe('binance');expect(result.candles[0]).toMatchObject({time:open/1000,open:200,close:202});
    expect(new URL(network.mock.calls[0][0]).searchParams.get('endTime')).toBe(String(end));
    expect(feed.getCurrentTick()).toMatchObject({bchUsdPrice:tick.bchUsdPrice,spotFetchedAtMs:tick.spotFetchedAtMs});
    expect(feed.getQuoteLock()).toEqual(quote);expect(feed.getRecentTicks()).toEqual(ticks);
    await feed.fetchCandleWindow('1m',10,end);expect(network).toHaveBeenCalledTimes(1);
  });
  it('tries Coinbase on bad data and rejects out-of-window rows',async()=>{
    const feed=await offlineFeed();const end=Math.floor(Date.now()/60000)*60000-1,open=Math.floor(end/60000)*60;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([[open*1000,'200','100','200','202','10']]),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify([[open,195,205,200,202,10],[open+60,195,205,200,202,10]]),{status:200})));
    const result=await feed.fetchCandleWindow('1m',10,end);expect(result.source).toBe('coinbase');expect(result.candles).toHaveLength(1);expect(result.candles[0].time).toBe(open);
  });
  it('never produces synthetic historical prices when both exchange feeds fail',async()=>{
    const feed=await offlineFeed();expect(await feed.fetchCandleWindow('1m',10,Date.now()-3600000)).toMatchObject({source:'fallback',candles:[]});
  });
});
