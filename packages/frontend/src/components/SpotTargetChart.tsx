import { CHART_PALETTES, chartAreaOptions, chartThemeOptions } from '../services/chartAppearance.js';
import type { Theme } from '../services/appearance.js';
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineStyle,
  LineType,
  LastPriceAnimationMode,
  TickMarkType,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Activity, ArrowDownRight, ArrowUpRight, Clock3, ExternalLink, Minus, Radio } from "lucide-react";
import { satsToBchString, type ConfigurableMarket, type ExecutionMode, type MarketBuy } from "@cashingularity/shared";
import {
  epochPriceCurve,
  leadingSpotOutcome,
  parseChartLookback,
  smoothPriceDisplay,
  spotCandleRequest,
  spotPlotWindow,
  marketResolutionRules,
  type LookbackUnit,
} from "../services/marketPriceView.js";
import { fetchMarketCandlesApi, type OhlcvCandlePoint } from '../services/apiClient.js';
import { MARKET_TIMEFRAMES } from '../services/marketEpochs.js';

interface Props {
  theme: Theme;
  market: ConfigurableMarket;
  price: number;
  priceSource: "live" | "fallback";
  spotFeed: string | null;
  observedAtMs: number | null;
  samples: Array<{ time: number; value: number }>;
  paperBuys: MarketBuy[];
  nowMs: number;
  mode: ExecutionMode;
  customHorizon: boolean;
  onTimeframeChange: (seconds: number, custom?: boolean) => void;
}

const LOOKBACK_PRESETS = [{ label: '30s', seconds: 30 }, { label: '2m', seconds: 120 }, { label: '10m', seconds: 600 }, { label: '15m', seconds: 900 }, { label: '30m', seconds: 1800 }];
const localMinute = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localSecond = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const localDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function localTickMark(time: Time, type: TickMarkType) {
  if (typeof time !== 'number') return null;
  const format = type === TickMarkType.TimeWithSeconds ? localSecond
    : type === TickMarkType.Time ? localMinute : localDay;
  return format.format(time * 1000);
}

export const SpotTargetChart: React.FC<Props> = ({
  theme,
  market,
  price,
  priceSource,
  spotFeed,
  observedAtMs,
  samples,
  paperBuys,
  nowMs,
  mode,
  customHorizon,
  onTimeframeChange,
}) => {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>();
  const series = useRef<ISeriesApi<"Area">>();
  const targetLine = useRef<IPriceLine>();
  const fitted = useRef('');
  const [history, setHistory] = useState<{marketId:number; expiry:number; step:number; candles:OhlcvCandlePoint[]; fetchedAtMs:number; source:string}>();
  const [loading, setLoading] = useState(false);
  const [lookback, setLookback] = useState<{amount: string; unit: LookbackUnit; seconds: number}>({ amount: '5', unit: 'minutes', seconds: 300 });
  const editLookback = (amount: string, unit: LookbackUnit) => {
    const seconds = parseChartLookback(amount, unit);
    setLookback(previous => ({ amount, unit, seconds: seconds ?? previous.seconds }));
  };
  const invalidLookback = parseChartLookback(lookback.amount, lookback.unit) === null;
  const windowSeconds = customHorizon ? lookback.seconds : market.durationSeconds;
  const { interval, step, limit } = spotCandleRequest(windowSeconds);
  useEffect(() => {
    let active = true;
    let waiting = false;
    const refresh = async () => {
      const now = Date.now();
      const end = Math.min(now, market.expiryTimestampMs) - 1;
      if (market.createdAtMs > end || end < now - 8 * 86_400_000) { setLoading(false); return; }
      if (waiting) return;
      waiting = true;
      setLoading(true);
      const result = await fetchMarketCandlesApi(interval, limit, end);
      waiting = false;
      if (!active) return;
      if (result.candles.length) {
        setHistory({ marketId: market.marketId, expiry: market.expiryTimestampMs, step, candles: result.candles, fetchedAtMs: result.fetchedAtMs ?? Date.now(), source: result.source });
      }
      setLoading(false);
    };
    const first = window.setTimeout(() => void refresh(), customHorizon ? 180 : 0);
    const timer = market.expiryTimestampMs > Date.now() ? window.setInterval(() => void refresh(), 15_000) : undefined;
    return () => { active = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [market.marketId, market.createdAtMs, market.expiryTimestampMs, interval, step, limit, customHorizon]);
  const target = market.strikePriceCents / 100;
  const validTarget = Number.isFinite(target) && target > 0;
  const targetRef = useRef(target);
  targetRef.current = target;
  const fresh =
    priceSource === "live" &&
    (spotFeed === "binance" || spotFeed === "coinbase") &&
    observedAtMs !== null &&
    observedAtMs <= nowMs + 5000 &&
    nowMs - observedAtMs <= 60000 &&
    Number.isFinite(price) &&
    price > 0;
  const ended = nowMs >= market.expiryTimestampMs;
  const future = market.createdAtMs > nowMs;
  const live = fresh && !ended && !future && market.status === 'OPEN';
  const { startMs, endMs } = spotPlotWindow(market, nowMs, customHorizon ? lookback.seconds : undefined);
  const showSeconds = endMs - startMs <= 15 * 60_000;
  const activeHistory = history?.marketId === market.marketId && history.expiry === market.expiryTimestampMs ? history : undefined;
  const sampleEnd = live && observedAtMs !== null ? Math.min(endMs, observedAtMs) : endMs;
  const reportedClose = market.status === 'RESOLVED' && market.resolutionPriceCents && market.resolutionPriceCents > 0
    ? market.resolutionPriceCents / 100 : undefined;
  const observations = useMemo(() => {
    if (future) return [];
    const candleStep = activeHistory?.step ?? step;
    // The provider's reported close is a known endpoint even when the candle window is still loading.
    const ticks = ended && reportedClose !== undefined
      ? [...samples, { time: market.expiryTimestampMs / 1000, value: reportedClose }]
      : samples;
    return epochPriceCurve(activeHistory?.candles ?? [], candleStep, ticks,
      startMs - candleStep * 1000, market.expiryTimestampMs, endMs, activeHistory?.fetchedAtMs ?? endMs)
      .filter(point => point.time * 1000 <= sampleEnd);
  }, [activeHistory, future, step, samples, startMs, market.expiryTimestampMs, endMs, sampleEnd, ended, reportedClose]);
  const data = useMemo(() => smoothPriceDisplay(observations, startMs, endMs, live), [observations, startMs, endMs, live]);
  const close = observations.at(-1);
  const observedClose = close?.time === market.expiryTimestampMs / 1000 ? close.value : undefined;
  const displayedPrice = ended ? reportedClose ?? observedClose : fresh ? price : undefined;
  const deltaCents = displayedPrice !== undefined && validTarget ? Math.round(displayedPrice * 100) - market.strikePriceCents : undefined;
  const leading = live ? leadingSpotOutcome(market, price) : undefined;
  const spreadTone = leading?.toLowerCase() ?? (deltaCents === undefined || deltaCents === 0 ? undefined : deltaCents < 0 ? 'below' : 'above');
  const SpreadIcon = spreadTone === 'above' ? ArrowUpRight : spreadTone === 'below' ? ArrowDownRight : Minus;
  const remaining = Math.max(
    0,
    Math.ceil(
      ((future ? market.createdAtMs : market.expiryTimestampMs) - nowMs) / 1000,
    ),
  );
  const countdownUnits = [Math.floor(remaining / 60) % 60, remaining % 60];
  if (remaining >= 3600) countdownUnits.unshift(Math.floor(remaining / 3600));
  const countdown = countdownUnits.map(unit => String(unit).padStart(2, '0')).join(':');
  const exchange = ended ? activeHistory?.source : spotFeed;
  const source =
    exchange === "binance"
      ? "Binance BCH/USDT · USD proxy"
      : exchange === "coinbase"
        ? "Coinbase BCH/USD Spot Feed"
        : "Awaiting spot feed";
  const feedUrl =
    exchange === "coinbase"
      ? "https://api.coinbase.com/v2/prices/BCH-USD/spot"
      : "https://api.binance.com/api/v3/ticker/price?symbol=BCHUSDT";
  useEffect(() => {
    if (!container.current) return;
    const appearance=chartThemeOptions(theme);
    const instance = createChart(container.current, {
      ...appearance,
      width:container.current.clientWidth,
      height:container.current.clientHeight,
      grid:{...appearance.grid,vertLines:{...appearance.grid.vertLines,visible:false}},
      localization: {
        timeFormatter: (time: Time) =>
          typeof time === "number"
            ? new Date(time * 1000).toLocaleString()
            : String(time),
      },
      timeScale: {
        rightOffset: 0,
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: true,
        secondsVisible: true,
        borderColor: CHART_PALETTES[theme].border,
        tickMarkFormatter: localTickMark,
      },
      rightPriceScale: { borderColor: CHART_PALETTES[theme].border, scaleMargins: { top: 0.13, bottom: 0.14 } },
    });
    const area = instance.addAreaSeries({
      ...chartAreaOptions(theme),
      lineWidth: 2,
      lineType: LineType.Curved,
      pointMarkersVisible: false,
      lastPriceAnimation: LastPriceAnimationMode.Disabled,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        const strike = targetRef.current;
        return info && Number.isFinite(strike) && strike > 0
          ? {
              ...info,
              priceRange: {
                minValue: Math.min(info.priceRange.minValue, strike),
                maxValue: Math.max(info.priceRange.maxValue, strike),
              },
            }
          : info;
      },
    });
    chart.current = instance;
    series.current = area;
    fitted.current = '';
    const resize = new ResizeObserver(() => {
      const host = container.current;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        instance.resize(host.clientWidth, host.clientHeight);
        if (fitted.current) instance.timeScale().fitContent();
      }
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      instance.remove();
      chart.current = undefined;
      series.current = undefined;
      targetLine.current = undefined;
    };
  }, [market.marketId]);
  useEffect(() => {
    chart.current?.applyOptions(chartThemeOptions(theme));
    series.current?.applyOptions(chartAreaOptions(theme));
  }, [theme]);
  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { secondsVisible: showSeconds } });
  }, [showSeconds, market.marketId]);
  useEffect(() => {
    if (!series.current) return;
    if (targetLine.current) series.current.removePriceLine(targetLine.current);
    targetLine.current = validTarget
      ? series.current.createPriceLine({
          price: target,
          color: CHART_PALETTES[theme].target,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Target",
        })
      : undefined;
  }, [target, validTarget, market.marketId, theme]);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => series.current?.applyOptions({
      lastPriceAnimation: live && !motion.matches
        ? LastPriceAnimationMode.OnDataUpdate : LastPriceAnimationMode.Disabled,
    });
    update();
    motion.addEventListener('change', update);
    return () => motion.removeEventListener('change', update);
  }, [live, market.marketId]);
  useEffect(() => {
    series.current?.setData(
      data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );
    const extent = `${data[0]?.time}:${data.at(-1)?.time}`;
    if (data.length >= 2 && extent !== fitted.current) {
      chart.current?.timeScale().fitContent();
      fitted.current = extent;
    }
  }, [data, market.marketId]);
  return (
    <div className="spot-target-section">
      <section
        className="spot-target-card"
        aria-label="Live Spot vs Target Price"
      >
        <header className="spot-target-header">
          <div className="spot-target-title">
            <span className="spot-target-icon" aria-hidden="true"><Activity size={17} /></span>
            <div>
              <h3>Live Spot vs Target Price</h3>
              <span className={`spot-feed-badge ${live ? 'fresh' : ''}`}>
                <Radio size={11} aria-hidden="true" />
                {ended ? activeHistory ? `Historical · ${source}` : 'Historical prices' : fresh ? source : observedAtMs ? `${source} · stale` : 'Awaiting spot feed'}
              </span>
            </div>
          </div>
          <div className="spot-timeframes" role="group" aria-label="Market timeframe">
            {MARKET_TIMEFRAMES.map(({ label, seconds }) => (
              <button key={seconds} type="button" aria-pressed={!customHorizon && market.durationSeconds === seconds} onClick={() => onTimeframeChange(seconds)}>{label}</button>
            ))}
            <button type="button" aria-pressed={customHorizon} aria-expanded={customHorizon} aria-controls="custom-spot-lookback" onClick={() => onTimeframeChange(300, true)}>Custom</button>
          </div>
          <div className="spot-lookback" id="custom-spot-lookback" hidden={!customHorizon}>
            <div className="spot-lookback-presets" role="group" aria-label="Chart window presets">
              {LOOKBACK_PRESETS.map(({ label, seconds }) => (
                <button key={seconds} type="button" aria-pressed={!invalidLookback && lookback.seconds === seconds} onClick={() => {
                  const unit = seconds % 60 === 0 ? 'minutes' : 'seconds';
                  editLookback(String(unit === 'minutes' ? seconds / 60 : seconds), unit);
                }}>{label}</button>
              ))}
            </div>
            <div className="spot-lookback-field">
              <label htmlFor="spot-lookback-amount">Chart window</label>
              <input id="spot-lookback-amount" inputMode="decimal" autoComplete="off" maxLength={12}
                aria-invalid={invalidLookback} aria-describedby={invalidLookback ? 'spot-lookback-error' : 'spot-lookback-help'}
                value={lookback.amount} onChange={event => editLookback(event.target.value, lookback.unit)} />
              <select aria-label="Chart window unit" value={lookback.unit} onChange={event => editLookback(lookback.amount, event.target.value as LookbackUnit)}>
                <option value="seconds">sec</option>
                <option value="minutes">min</option>
              </select>
            </div>
            <p className="spot-lookback-help" id="spot-lookback-help">5m market expiry · 15s to 24h of price history</p>
            {invalidLookback && <p className="spot-lookback-help negative-text" id="spot-lookback-error" role="alert">Enter a duration from 15 seconds to 24 hours in whole seconds.</p>}
          </div>
        </header>
        <div className="spot-price-stats">
          <div>
            <span>Target Price</span>
            <strong>
              {validTarget ? `$${target.toFixed(2)}` : "Unavailable"}
            </strong>
          </div>
          <div>
            <span>{ended ? 'Epoch Close' : 'Current Spot Price'}</span>
            <strong>{displayedPrice === undefined ? 'Unavailable' : `$${displayedPrice.toFixed(2)}`}</strong>
          </div>
          <div className="spot-countdown">
            <span>
              <Clock3 size={12} />
              {future
                ? "Starts in"
                : nowMs >= market.expiryTimestampMs
                  ? "Epoch ended"
                  : "Time left"}
            </span>
            <strong>{countdown}</strong>
          </div>
        </div>
        {deltaCents !== undefined && (
          <div className="spot-spread-row">
            <span className="spot-delta" data-outcome={spreadTone} title="Spread from the strike target">
              <SpreadIcon size={14} aria-hidden="true" />
              <span>{leading ? `Winning ${leading}` : ended ? 'Close spread' : 'Spot spread'}</span>
              <strong>{deltaCents < 0 ? '−' : deltaCents > 0 ? '+' : ''}${(Math.abs(deltaCents) / 100).toFixed(2)}</strong>
            </span>
          </div>
        )}
        <div className="spot-target-plot">
          <div className="spot-target-canvas" ref={container} data-chart-theme={theme} data-window-seconds={windowSeconds}
            data-point-count={data.length} data-observation-count={observations.length}
            data-first-display-time={data[0]?.time} data-last-display-time={data.at(-1)?.time} />
          {paperBuys.length > 0 && <div className="spot-paper-flow" aria-label="Recent paper buys">
            <span className="spot-paper-flow-label">Paper flow</span>
            <ul>
              {paperBuys.map(buy => {
                const bucket = market.buckets.find(item => item.bucketId === buy.bucketId);
                const outcome = bucket?.outcomeRule ?? bucket?.label;
                const Direction = outcome === 'ABOVE' ? ArrowUpRight : outcome === 'BELOW' ? ArrowDownRight : Minus;
                return <li key={buy.id} data-outcome={outcome?.toLowerCase()}>
                  <Direction size={12} aria-hidden="true" /> +{satsToBchString(buy.sats, 8)} BCH · {outcome}
                </li>;
              })}
            </ul>
          </div>}
        </div>
        {!data.length && (
          <p className="spot-chart-note">
            {future ? 'This epoch has not started. Prices will appear when trading begins.' : loading ? 'Loading observed epoch prices…' : 'Price history is temporarily unavailable. Waiting for the exchange feed.'}
          </p>
        )}
        <p className="spot-chart-note">
          {!ended && observedAtMs
            ? `Last spot observation ${new Date(observedAtMs).toLocaleTimeString()}. `
            : ""}
          Smoothed reference curve, interpolated between observed prices. Settlement uses exchange closes.
        </p>
      </section>
      <details className="market-rules">
        <summary>Market Rules &amp; Resolution Oracle</summary>
        <div>
          <p>{marketResolutionRules(market, mode)}</p>
          <p>
            {mode === "SANDBOX_MODE"
              ? "Paper resolution source: the timestamped spot feed shown above."
              : "Resolution reference: backend Binance / Coinbase candle data. The live spot line is a reference; it is not a confirmed expiry candle close."}
          </p>
          <a href={feedUrl} target="_blank" rel="noreferrer">
            {exchange === "coinbase"
              ? "Coinbase BCH/USD spot feed"
              : "Binance BCH/USDT spot feed (USD proxy)"}
            <ExternalLink size={12} />
          </a>
        </div>
      </details>
    </div>
  );
};
