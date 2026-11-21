import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { ArrowUpRight, Bitcoin, ChevronDown } from 'lucide-react';

export interface ArcadeMarketData {
  price: number;
  fresh: boolean;
  samples: ReadonlyArray<{ time: number; value: number }>;
}

export const MarketWidget = memo(function MarketWidget({ market, onMarkets }: { market: ArcadeMarketData; onMarkets: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = useMemo(() => {
    const recent = market.samples.slice(-90).filter(sample => Number.isFinite(sample.value) && sample.value > 0);
    return recent.filter((_, index) => index % 2 === 0 || index === recent.length - 1);
  }, [market.samples]);
  const first = points[0];
  const last = points.at(-1);
  const change = market.fresh && first && last && last.time > first.time ? (last.value / first.value - 1) * 100 : null;
  const minutes = first && last ? Math.max(1, Math.round((last.time - first.time) / 60)) : 0;

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const { width, height } = context.canvas;
    context.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    const values = points.map(p => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    context.beginPath();
    values.forEach((value, i) => {
      const x = 3 + (width - 6) * i / (values.length - 1);
      const y = height - 4 - (height - 8) * (value - min) / (max - min || 1);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = change === null ? '#8794ac' : change < 0 ? '#df747b' : '#82b998';
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.stroke();
  }, [points, change]);

  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onMarkets();
  };
  return <details className="race-market-widget">
    <summary aria-label="BCH market information">
      <Bitcoin size={17} aria-hidden="true" /> <span>BCH/USD</span>
      <strong>{market.fresh && Number.isFinite(market.price) ? `$${market.price.toFixed(2)}` : 'Price unavailable'}</strong>
      <ChevronDown size={14} className="race-market-chevron" aria-hidden="true" />
    </summary>
    <div className="race-market-expanded">
      {points.length >= 2 ? <canvas ref={canvas} width={198} height={43} role="img" aria-label="Recent Bitcoin Cash spot prices" />
        : <p>Recent price history unavailable.</p>}
      <div>
        {change !== null ? <span data-positive={change >= 0}>{change >= 0 ? '+' : ''}{change.toFixed(2)}% <small>· {minutes} min</small></span>
          : <small>{points.length >= 2 ? 'Historical spot prices' : 'Waiting for price history'}</small>}
        <a href="/market" onClick={navigate}>Market <ArrowUpRight size={13} aria-hidden="true" /></a>
      </div>
    </div>
  </details>;
});
