import React, { useState } from 'react';
import type { ConfigurableMarket } from '@cashingularity/shared';
import { epochResult, formatEpochSpread, resolvedOutcomeBadge, resolutionWindowLabel, type EpochSeries, type EpochTimeframe } from '../services/marketEpochs.js';
import { ActionPopup } from './ActionPopup.js';

interface Props {
  series: EpochSeries;
  timeframe?: EpochTimeframe;
  epochs: ConfigurableMarket[];
  now: number;
  state: 'idle' | 'loading' | 'ready' | 'unavailable';
  onRetry: () => void;
  onSelect: (market: ConfigurableMarket) => void;
  onClose: () => void;
}

export function ResolutionHistoryModal({ series, timeframe, epochs, now, state, onRetry, onSelect, onClose }: Props) {
  const [limit, setLimit] = useState(100);
  return (
    <ActionPopup open title={`${series.assetPair} Resolution History`} wide onClose={onClose}>
      <p className="portfolio-note">{timeframe ?? `${series.durationSeconds}s`} epochs · {epochs.length} reported results · {resolutionWindowLabel(epochs)}. Times are local.</p>
      {state === 'loading' && <p className="portfolio-note" role="status">Loading older results…</p>}
      {state === 'unavailable' && <p className="resolution-retry" role="status">Archive unavailable. <button type="button" className="btn" onClick={onRetry}>Retry</button></p>}
      <div className="resolution-table-head" aria-hidden="true"><span>Epoch close</span><span>Target</span><span>Reported close</span><span>Spread vs. target</span><span>Result</span></div>
      <div className="resolution-list">
        {epochs.slice(0, limit).map(epoch => {
          const result = epochResult(epoch, now)!;
          const winner = resolvedOutcomeBadge(epoch);
          return <button type="button" className="resolution-row" key={epoch.expiryTimestampMs} onClick={() => onSelect(epoch)}>
            <div className="resolution-cell resolution-time"><strong>{new Date(epoch.expiryTimestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>{new Date(epoch.expiryTimestampMs).toLocaleDateString()}</span></div>
            <div className="resolution-cell"><span className="resolution-mobile-label">Target</span><strong>${(epoch.strikePriceCents / 100).toFixed(2)}</strong></div>
            <div className="resolution-cell"><span className="resolution-mobile-label">Reported close</span><strong>${(result.closeCents / 100).toFixed(2)}</strong></div>
            <div className="resolution-cell resolution-direction"><span className="epoch-direction" data-direction={result.direction}>{result.direction} <b>{formatEpochSpread(result.spreadCents)}</b></span>{winner && <small>Winner: {winner}</small>}</div>
            <div className="resolution-cell resolution-action"><span>Inspect <span aria-hidden="true">→</span></span></div>
          </button>;
        })}
      </div>
      {!epochs.length && state !== 'loading' && <p className="empty-state">No reported resolutions are available for this series yet.</p>}
      {limit < epochs.length && <button type="button" className="btn" onClick={() => setLimit(value => value + 100)}>Show more results</button>}
    </ActionPopup>
  );
}
