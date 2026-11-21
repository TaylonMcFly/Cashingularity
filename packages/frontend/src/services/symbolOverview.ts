import type { OhlcvCandlePoint } from './apiClient.js';
export const OVERVIEW_RANGES = [
  {label:'1D',seconds:86400,interval:'1h',limit:25},
  {label:'1M',seconds:30*86400,interval:'1d',limit:31},
  {label:'3M',seconds:90*86400,interval:'1d',limit:91},
  {label:'1Y',seconds:365*86400,interval:'1d',limit:200},
  {label:'5Y',seconds:5*365*86400,interval:'1d',limit:200},
  {label:'All',seconds:Infinity,interval:'1d',limit:200},
] as const;
export function overviewPrices(candles:OhlcvCandlePoint[],step:number,cutoffMs:number,nowMs:number,spot?:{time:number;value:number}) {
  const prices=new Map<number,number>();
  const add=(time:number,value:number)=>{if(Number.isSafeInteger(time)&&time*1000>=cutoffMs&&time*1000<=nowMs&&Number.isFinite(value)&&value>0)prices.set(time,value);};
  for(const candle of candles){add(candle.time,candle.open);if((candle.time+step)*1000<=nowMs)add(candle.time+step,candle.close);}
  if(spot)add(spot.time,spot.value);
  return [...prices].sort(([a],[b])=>a-b).map(([time,value])=>({time,value}));
}
/** Use only a completed candle at/before the reference time, never its future close. */
export function oneDayReference(candles:OhlcvCandlePoint[],atMs:number):{time:number;value:number}|undefined {
  const candle=candles.filter(c=>(c.time+60)*1000<=atMs&&Number.isFinite(c.close)&&c.close>0).sort((a,b)=>b.time-a.time)[0];
  return candle?{time:candle.time+60,value:candle.close}:undefined;
}
