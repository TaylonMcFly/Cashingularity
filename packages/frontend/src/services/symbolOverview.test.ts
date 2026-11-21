import { describe, expect, it } from 'vitest';
import { oneDayReference, overviewPrices } from './symbolOverview.js';
describe('locally rendered symbol overview',()=>{
  it('uses only observed opens, completed closes and a timestamped live spot',()=>{
    const candles=[{time:0,open:200,high:205,low:195,close:202,volume:10},{time:60,open:202,high:210,low:201,close:209,volume:5}];
    expect(overviewPrices(candles,60,0,90000,{time:85,value:204})).toEqual([{time:0,value:200},{time:60,value:202},{time:85,value:204}]);
    expect(overviewPrices(candles,60,0,90000,{time:95,value:999})).toEqual([{time:0,value:200},{time:60,value:202}]);
  });
  it('cannot use a partial candle as the one-day-ago closing price',()=>{
    const candles=[{time:0,open:200,high:205,low:195,close:202,volume:10},{time:60,open:202,high:210,low:201,close:209,volume:5}];
    expect(oneDayReference(candles,90000)).toEqual({time:60,value:202});expect(oneDayReference(candles,59000)).toBeUndefined();
  });
});
