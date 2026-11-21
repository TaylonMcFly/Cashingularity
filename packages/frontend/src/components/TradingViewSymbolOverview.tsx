import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Bitcoin } from 'lucide-react';
import { createChart, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Theme } from '../services/appearance.js';
import { chartAreaOptions, chartThemeOptions } from '../services/chartAppearance.js';
import { fetchMarketCandlesApi, type OhlcvCandlePoint } from '../services/apiClient.js';
import { OVERVIEW_RANGES, oneDayReference, overviewPrices } from '../services/symbolOverview.js';

/** Fully local overview: the chart receives only public backend candles and spot data. */
export const TradingViewSymbolOverview = memo(function TradingViewSymbolOverview({theme,price,fresh,observedAtMs}:{theme:Theme;price:number;fresh:boolean;observedAtMs:number|null}) {
  const host=useRef<HTMLDivElement>(null),chart=useRef<IChartApi>(),area=useRef<ISeriesApi<'Area'>>();
  const [range,setRange]=useState(0),[candles,setCandles]=useState<OhlcvCandlePoint[]>([]),[source,setSource]=useState(''),[loading,setLoading]=useState(true);
  const [reference,setReference]=useState<{time:number;value:number}>(),[refresh,setRefresh]=useState(0);
  const selected=OVERVIEW_RANGES[range],nowMs=Date.now();
  const prices=useMemo(()=>overviewPrices(candles,selected.interval==='1h'?3600:86400,Number.isFinite(selected.seconds)?nowMs-selected.seconds*1000:0,nowMs,
    fresh&&observedAtMs?{time:Math.floor(observedAtMs/1000),value:price}:undefined),[candles,range,price,fresh,observedAtMs]);
  useEffect(()=>{
    let active=true;setCandles([]);setLoading(true);
    const load=async()=>{
      const now=Date.now(),[history,day]=await Promise.all([
        fetchMarketCandlesApi(selected.interval,selected.limit),
        fetchMarketCandlesApi('1m',10,now-86400_000-1),
      ]);
      if(!active)return;
      if(history.candles.length){setCandles(history.candles);setSource(history.source);}
      if(day.candles.length)setReference(oneDayReference(day.candles,now-86400_000));
      setLoading(false);
    };
    void load();const timer=setInterval(()=>void load(),30_000);
    return()=>{active=false;clearInterval(timer);};
  },[range,refresh]);
  useEffect(()=>{
    if(!host.current)return;
    const instance=createChart(host.current,{...chartThemeOptions(theme),height:270,width:host.current.clientWidth,
      timeScale:{...chartThemeOptions(theme).timeScale,timeVisible:selected.interval==='1h',borderVisible:false,rightOffset:0},
      rightPriceScale:{...chartThemeOptions(theme).rightPriceScale,borderVisible:false},
      handleScroll:false,handleScale:false});
    const series=instance.addAreaSeries({...chartAreaOptions(theme),lineWidth:2,lineType:LineType.Curved,priceLineVisible:false,lastValueVisible:false,pointMarkersVisible:false});
    chart.current=instance;area.current=series;
    const resize=new ResizeObserver(()=>{if(host.current)instance.applyOptions({width:host.current.clientWidth});});resize.observe(host.current);
    return()=>{resize.disconnect();instance.remove();chart.current=undefined;area.current=undefined;};
  },[]);
  useEffect(()=>{
    chart.current?.applyOptions({...chartThemeOptions(theme),timeScale:{timeVisible:selected.interval==='1h'}});
    area.current?.applyOptions(chartAreaOptions(theme));
  },[theme,range]);
  useEffect(()=>{area.current?.setData(prices.map(p=>({...p,time:p.time as UTCTimestamp})));chart.current?.timeScale().fitContent();},[prices]);
  const delta=fresh&&reference?price-reference.value:null;
  const incomplete=range>=3&&candles.length>0&&candles[0].time*1000>nowMs-selected.seconds*1000+86400_000;
  return <section className="local-symbol-overview" aria-label="Bitcoin Cash market overview" data-chart-theme={theme}>
    <div className="symbol-overview-heading"><span className="symbol-bch-icon" aria-hidden="true"><Bitcoin size={27}/></span><div><h2>Bitcoin Cash / U.S. Dollar <span className="symbol-market-status" data-fresh={fresh} role="img" aria-label={fresh ? 'Live spot price' : 'Waiting for live spot price'}><span className="status-dot"/></span></h2>
      <div className="symbol-price-row"><strong>{fresh?price.toFixed(2):'Unavailable'}</strong><span>USD</span>{delta!==null&&<><b className={delta<0?'negative-text':'positive-text'}>{delta>=0?'+':'−'}{Math.abs(delta).toFixed(2)}&nbsp; {delta>=0?'+':'−'}{Math.abs(delta/reference!.value*100).toFixed(2)}%</b><small title={`Reference close ${new Date(reference!.time*1000).toLocaleString()}`}>1 day</small></>}</div>
    </div></div>
    <div className="symbol-range-buttons" role="group" aria-label="Overview price range">{OVERVIEW_RANGES.map((r,i)=><button key={r.label} type="button" aria-pressed={range===i} onClick={()=>setRange(i)}>{r.label}</button>)}</div>
    <div className="symbol-overview-plot" ref={host} data-chart-theme={theme} data-point-count={prices.length}/>
    {!candles.length&&<p className="symbol-overview-note" role="status">{loading?'Loading market history…':<>Market history is unavailable. <button type="button" className="btn" onClick={()=>setRefresh(v=>v+1)}>Retry</button></>}</p>}
    {(incomplete||range===5)&&candles.length>0&&<p className="symbol-overview-note">Available backend history: {new Date(candles[0].time*1000).toLocaleDateString()}–{new Date(candles.at(-1)!.time*1000).toLocaleDateString()}.</p>}
    <p className="symbol-overview-source">{source==='binance'?'Binance BCH/USDT · USD proxy':source==='coinbase'?'Coinbase BCH/USD':'Backend price feed'} · Charting by <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener">TradingView</a></p>
  </section>;
});
