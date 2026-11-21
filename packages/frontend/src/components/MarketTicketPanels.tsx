import React from 'react';
import { ArrowDownRight, ArrowUpRight, Check, Hourglass, LockKeyhole, Minus } from 'lucide-react';
import { satsToBchString, type MarketBucketPool, type MarketPriceBook, type OutcomeQuote, type ParimutuelSimulationResult } from '@cashingularity/shared';
import { outcomeKind } from '../services/marketPriceView.js';

export function MarketAccessStatus({ paper }: { paper: boolean }) {
  return <div className="market-access">
    <span className="market-access-odds">Indicative odds</span>
    <span className="market-access-mode" data-paper={paper}>
      {paper ? <Hourglass size={14} aria-hidden="true" /> : <LockKeyhole size={14} aria-hidden="true" />}
      {paper ? 'Paper Trading' : 'On-chain trading unavailable'}
    </span>
  </div>;
}

function percentOf(part: bigint, total: bigint) {
  return total > 0n && part > 0n ? Number(part) / Number(total) * 100 : 0;
}

function formatShare(percent: number) {
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${Number(percent.toFixed(1))}%`;
}

export function MarketPoolBalance({ buckets, pricing }: { buckets: MarketBucketPool[]; pricing?: MarketPriceBook }) {
  const title = pricing?.source === 'pool' ? 'Pool balance' : 'Model odds';
  const sides = pricing?.outcomes.map(quote => {
    const bucket = buckets.find(item => item.bucketId === quote.bucketId)!;
    const kind = outcomeKind(bucket);
    return { id: bucket.bucketId, label: kind ?? bucket.label, tone: kind?.toLowerCase(), share: quote.markBps / 100 };
  });
  return (
    <div className="market-pool-balance" role="group" aria-label={title}>
      <span className="market-pool-title">{title}</span>
      {sides?.length ? <>
        <div className="market-pool-track" aria-hidden="true">
          {sides.map(side => (
            <span key={side.id} data-outcome={side.tone} style={{ width: `${side.share}%` }} />
          ))}
        </div>
        <ul className="market-pool-legend">
          {sides.map(side => (
            <li key={side.id} data-outcome={side.tone}>
              <span>{side.label}</span> <strong>{formatShare(side.share)}</strong>
            </li>
          ))}
        </ul>
      </> : <span className="market-pool-empty">Waiting for a quote</span>}
    </div>
  );
}

export function MarketOutcomeCard({ bucket, selected, quote, multiplier, showSpread, onSelect }: {
  bucket: MarketBucketPool;
  selected: boolean;
  quote?: OutcomeQuote;
  multiplier?: number;
  showSpread: boolean;
  onSelect: () => void;
}) {
  const kind = outcomeKind(bucket);
  const Direction = kind === 'BELOW' ? ArrowDownRight : kind === 'ABOVE' ? ArrowUpRight : Minus;
  return (
    <button type="button" className="outcome-card" data-outcome={kind?.toLowerCase()} aria-pressed={selected} onClick={onSelect}>
      <span className="outcome-direction" aria-hidden="true"><Direction size={17} /></span>
      <span className="outcome-card-copy">
        <strong>{bucket.label}</strong>
        <small>{multiplier !== undefined ? `${multiplier.toFixed(2)}× if won` : 'No payout quote'}</small>
        {quote && showSpread && <small>Buy {formatShare(quote.askBps / 100)} · Sell {formatShare(quote.bidBps / 100)}</small>}
      </span>
      <span className="outcome-card-odds">
        <strong>{quote ? formatShare(quote.markBps / 100) : '—'}</strong>
        <span className="outcome-check" aria-hidden="true">{selected && <Check size={12} strokeWidth={3} />}</span>
      </span>
    </button>
  );
}

export function StakeReturnPreview({ simulation }: { simulation?: ParimutuelSimulationResult }) {
  const principalPercent = simulation ? percentOf(simulation.stakeSats, simulation.estimatedPayoutSats) : 0;
  const poolShare = simulation ? formatShare(percentOf(simulation.stakeSats, simulation.bucketPoolAfterSats)) : '—';
  return (
    <section className="stake-return-preview" aria-label="Return preview">
      <div className="stake-return-heading">
        <h3>Return preview</h3>
        <span className="stake-pool-share" title="Your share of the selected outcome’s pool after adding this stake">
          Pool share <strong>{poolShare}</strong>
        </span>
      </div>
      <div className="stake-return-track" aria-hidden="true">
        <span className="stake-return-principal" style={{ width: `${principalPercent}%` }} />
        <span className="stake-return-profit" style={{ width: `${simulation ? 100 - principalPercent : 0}%` }} />
      </div>
      <dl className="stake-return-values">
        <div><dt>Your stake</dt><dd>{simulation ? `${satsToBchString(simulation.stakeSats, 8)} BCH` : '—'}</dd></div>
        <div>
          <dt>Net profit</dt>
          <dd className={simulation && simulation.netProfitSats > 0n ? 'positive-text' : undefined}>
            {simulation ? `${simulation.netProfitSats > 0n ? '+' : ''}${satsToBchString(simulation.netProfitSats, 8)} BCH` : '—'}
          </dd>
        </div>
      </dl>
      {simulation && (
        <p className="stake-return-total" title="Winning stake plus your share of the losing pool after market fees and reserves">
          <span>If your outcome wins</span>
          <strong>{satsToBchString(simulation.estimatedPayoutSats, 8)} BCH · {simulation.multiplier.toFixed(3)}×</strong>
        </p>
      )}
    </section>
  );
}
