import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, History, X } from 'lucide-react';
import type { ConfigurableMarket } from '@cashingularity/shared';
import { fetchMarketEpochsApi } from '../services/apiClient.js';
import { epochResult, formatEpochSpread, resolvedEpochs, resolvedOutcomeBadge, type EpochSeries, type EpochTimeframe } from '../services/marketEpochs.js';
import { ResolutionHistoryModal } from './ResolutionHistoryModal.js';

const PAGE_SIZE = 8;
const RETENTION_MS = 7 * 86_400_000;
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

interface Props {
  markets: ConfigurableMarket[];
  series: EpochSeries;
  timeframe?: EpochTimeframe;
  liveMarket?: ConfigurableMarket;
  initialExpiryMs?: number;
  now: number;
}

export function MarketEpochBar({ markets, series, timeframe, liveMarket, initialExpiryMs, now }: Props) {
  const [archive, setArchive] = useState<ConfigurableMarket[]>([]);
  const [archiveState, setArchiveState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspectedExpiry, setInspectedExpiry] = useState(initialExpiryMs);
  const [offset, setOffset] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController>();
  const results = useMemo(() => resolvedEpochs([...markets, ...archive], series, now), [markets, archive, series, now]);
  const start = Math.min(offset, Math.max(0, results.length - 1));
  const visible = results.slice(start, start + PAGE_SIZE);
  const inspected = results.find(epoch => epoch.expiryTimestampMs === inspectedExpiry);
  const report = inspected && epochResult(inspected, now);
  const winner = inspected && resolvedOutcomeBadge(inspected);
  const loading = archiveState === 'loading';

  const loadArchive = async (after?: number) => {
    if (!timeframe || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setArchiveState('loading');
    try {
      const records = await fetchMarketEpochsApi(timeframe, controller.signal);
      if (controller.signal.aborted) return;
      setArchiveState(records ? 'ready' : 'unavailable');
      if (records) {
        setArchive(records);
        if (after !== undefined && resolvedEpochs([...markets, ...records], series, Date.now()).length > after) setOffset(after);
      }
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  };

  useEffect(() => {
    if (initialExpiryMs !== undefined && initialExpiryMs <= now && now - initialExpiryMs <= RETENTION_MS &&
        !results.some(epoch => epoch.expiryTimestampMs === initialExpiryMs)) void loadArchive();
    return () => { request.current?.abort(); request.current = undefined; };
  }, [timeframe, initialExpiryMs]);
  useEffect(() => { if (scroll.current) scroll.current.scrollLeft = 0; }, [start]);

  const nextOffset = start + visible.length;
  const hasOlder = nextOffset < results.length;
  const canLoadOlder = !!timeframe && archiveState !== 'ready';
  const earlier = () => {
    if (hasOlder) setOffset(nextOffset);
    else void loadArchive(nextOffset);
  };
  const openHistory = () => {
    setHistoryOpen(true);
    if (archiveState !== 'ready') void loadArchive();
  };

  return (
    <section className="epoch-section" aria-label="Market epochs" data-duration={series.durationSeconds}>
      <div className="epoch-heading">
        <div>
          <h2>Market epochs</h2>
          <p>Reported close vs. target · Local time</p>
        </div>
        <div className="epoch-arrows">
          <button type="button" className="epoch-history-btn" onClick={openHistory}><History size={14} aria-hidden="true" /> View all resolutions</button>
          <button type="button" aria-label="Earlier epochs" disabled={loading || (!hasOlder && !canLoadOlder)} onClick={earlier}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="Later epochs" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - PAGE_SIZE))}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="epoch-board">
        <div className={`epoch-pill epoch-live ${liveMarket ? 'active' : ''}`} aria-current={liveMarket ? 'time' : undefined} data-expiry={liveMarket?.expiryTimestampMs}>
          <span className="epoch-live-tag">{liveMarket && <span className="status-dot" aria-hidden="true" />}{liveMarket ? 'Live' : 'Next round'}</span>
          <strong>{liveMarket ? clock.format(liveMarket.expiryTimestampMs) : 'Awaiting feed'}</strong>
          {liveMarket && <span>Round close</span>}
        </div>
        {visible.length ? <div className="epoch-scroll" ref={scroll} aria-label="Reported epoch results">
          {visible.map(epoch => {
            const result = epochResult(epoch, now)!;
            const selected = inspectedExpiry === epoch.expiryTimestampMs;
            return (
              <button type="button" key={epoch.expiryTimestampMs} className="epoch-pill epoch-result-pill" data-expiry={epoch.expiryTimestampMs}
                aria-pressed={selected} onClick={() => setInspectedExpiry(selected ? undefined : epoch.expiryTimestampMs)}>
                <strong>{clock.format(epoch.expiryTimestampMs)}</strong><span>{date.format(epoch.expiryTimestampMs)}</span>
                <span className="epoch-direction" data-direction={result.direction}>{result.direction} <b>{formatEpochSpread(result.spreadCents)}</b></span>
              </button>
            );
          })}
        </div> : <p className="epoch-empty">{loading ? 'Loading reported results…' : 'No reported results for this series yet.'}</p>}
      </div>
      {archiveState === 'unavailable' && <p className="epoch-empty" role="status">The full archive is temporarily unavailable.</p>}
      {inspectedExpiry !== undefined && (
        <section className="epoch-inspection" aria-label="Selected epoch result">
          <div className="epoch-inspection-heading">
            <h3>{inspected ? `Result · ${date.format(inspectedExpiry)}, ${clock.format(inspectedExpiry)}` : 'Requested epoch result'}</h3>
            <button type="button" className="icon-button" aria-label="Close epoch result" onClick={() => setInspectedExpiry(undefined)}><X size={15} /></button>
          </div>
          {inspected && report ? <dl>
            <div><dt>Target</dt><dd>${(inspected.strikePriceCents / 100).toFixed(2)}</dd></div>
            <div><dt>Reported close</dt><dd>${(report.closeCents / 100).toFixed(2)}</dd></div>
            <div><dt>Spread</dt><dd className="epoch-direction" data-direction={report.direction}>{report.direction} {formatEpochSpread(report.spreadCents)}</dd></div>
            {winner && <div><dt>Winning outcome</dt><dd>{winner}</dd></div>}
          </dl> : <p className="epoch-empty">{loading ? 'Looking up this result…' : 'A reported close is unavailable for this epoch.'}</p>}
        </section>
      )}
      {historyOpen && <ResolutionHistoryModal series={series} timeframe={timeframe} epochs={results} now={now} state={archiveState}
        onRetry={() => void loadArchive()} onSelect={epoch => { setInspectedExpiry(epoch.expiryTimestampMs); setHistoryOpen(false); }} onClose={() => setHistoryOpen(false)} />}
    </section>
  );
}
