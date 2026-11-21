import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, Clock3 } from 'lucide-react';
import { satsToBchString, type ConfigurableMarket, type MarketPriceBook } from '@cashingularity/shared';
import { ActionPopup } from './ActionPopup.js';
import {
  PAPER_QUOTE_TTL_MS,
  quotePaperCashOut,
  validatePaperCashOut,
  type PaperCashOut,
  type PaperCashOutQuote,
  type PaperPosition,
} from '../services/paperTrading.js';
import { parseStakeAmount } from '../services/stakePreferences.js';

const bch = (sats: bigint) => `${satsToBchString(sats)} BCH`;

function timeRemaining(expiry: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expiry - now) / 1000));
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map(part => String(part).padStart(2, '0')).join(':');
}

function PositionPnl({ value, cost }: { value: bigint; cost: bigint }) {
  const delta = value - cost;
  const sign = delta > 0n ? '+' : delta < 0n ? '−' : '';
  const abs = delta < 0n ? -delta : delta;
  const pct = cost > 0n ? (Number(abs) / Number(cost)) * 100 : 0;
  return <strong className={delta < 0n ? 'negative-text' : delta > 0n ? 'positive-text' : undefined}>
    {sign}{bch(abs)} <span>({sign}{pct.toFixed(2)}%)</span>
  </strong>;
}

export function MarketPositions({ paper, market, pricing, positions, activePositions, balance, nowMs, onCashOut }: {
  paper: boolean;
  market?: ConfigurableMarket;
  pricing?: MarketPriceBook;
  positions: PaperPosition[];
  activePositions: PaperPosition[];
  balance: bigint;
  nowMs: number;
  onCashOut: (id: string) => void;
}) {
  const otherPositions = positions.filter(position => !activePositions.includes(position));
  return <>
    <section className="card market-positions" aria-label="Active Positions">
    <div className="section-heading">
      <h2>Active Positions</h2>
      {paper && <span className="position-paper-balance">Paper balance <strong>{bch(balance)}</strong></span>}
    </div>
    {!paper ? <p className="portfolio-note">Live positions require a verified settlement contract.</p> : <>
      {activePositions.length === 0 && <p className="portfolio-note">You have no paper positions in this round.</p>}
      {activePositions.map(position => {
        const mark = market && pricing ? quotePaperCashOut(position, market, position.sats, pricing, nowMs) : undefined;
        return <article className="position-card active-position" key={position.id} aria-label={`${position.outcome} paper position`}>
          <div className="paper-position">
            <strong>{position.outcome}</strong>
            <span className="position-clock"><Clock3 size={13} aria-hidden="true" /> {timeRemaining(position.expiresAtMs, nowMs)}</span>
          </div>
          <dl className="position-figures">
            <div><dt>Open stake</dt><dd><strong>{bch(position.sats)}</strong></dd></div>
            <div><dt>Entry odds</dt><dd><strong>{(position.entryOddsBps / 100).toFixed(2)}% · {position.multiplier.toFixed(3)}×</strong></dd></div>
            <div><dt>Cash-out value</dt><dd><strong>{mark ? bch(mark.proceedsSats) : 'Unavailable'}</strong></dd></div>
            <div><dt>Unrealized PnL</dt><dd>{mark ? <PositionPnl value={mark.proceedsSats} cost={position.sats}/> : 'Unavailable'}</dd></div>
            <div><dt>Payout if won</dt><dd><strong>{bch(position.payoutSats)}</strong></dd></div>
          </dl>
          <button className="btn" type="button" disabled={!mark} onClick={() => onCashOut(position.id)}>
            <ArrowDownLeft size={15} aria-hidden="true" /> Sell / Cash Out
          </button>
        </article>;
      })}
    </>}
    </section>
    {paper && otherPositions.length > 0 && <details className="card position-history" aria-label="Paper position history">
        <summary>Paper position history <span>{otherPositions.length}</span></summary>
        {otherPositions.map(position => {
          const pending = position.status === 'ACTIVE' && nowMs >= position.expiresAtMs;
          const label = position.status === 'CASHED_OUT' ? 'Cashed out' : pending ? 'Awaiting settlement' :
            position.status === 'ACTIVE' ? 'Open · another round' : position.status;
          const paid = position.status === 'CASHED_OUT' ? position.cashOutSats
            : position.status === 'WON' ? position.payoutSats : position.status === 'LOST' ? 0n : undefined;
          return <article className="position-card" key={position.id}>
            <div className="paper-position">
              <strong>{position.outcome}</strong>
              <span className={`position-status ${position.status.toLowerCase()}`}>{label}</span>
            </div>
            <p>{position.market}</p>
            <dl className="position-figures">
              <div><dt>Stake</dt><dd><strong>{bch(position.sats)}</strong></dd></div>
              {paid !== undefined && <div><dt>Received</dt><dd><strong>{bch(paid)}</strong></dd></div>}
              {position.status === 'ACTIVE' && !pending && <div><dt>Time left</dt><dd>{timeRemaining(position.expiresAtMs, nowMs)}</dd></div>}
              {position.settlementPrice !== undefined && <div><dt>Settlement price</dt><dd>${position.settlementPrice.toFixed(2)}</dd></div>}
            </dl>
          </article>;
        })}
    </details>}
  </>;
}

interface CashOutReview {
  pricing: MarketPriceBook;
  quotes: PaperCashOutQuote[];
  all: boolean;
}

export function PaperCashOutTicket({ market, positions, selectedId, onSelect, pricing, nowMs, onConfirm }: {
  market: ConfigurableMarket;
  positions: PaperPosition[];
  selectedId?: string;
  onSelect: (id: string) => void;
  pricing?: MarketPriceBook;
  nowMs: number;
  onConfirm: (action: PaperCashOut) => void;
}) {
  const [review, setReview] = useState<CashOutReview>();
  const position = positions.find(item => item.id === selectedId) ?? positions[0];
  if (!position) return <p className="portfolio-note">No open positions in this round.</p>;
  const reviewSale = (orders: { position: PaperPosition; amountSats: bigint }[], all: boolean) => {
    if (!pricing) return;
    const now = Date.now();
    const quotes = orders.map(order => quotePaperCashOut(order.position, market, order.amountSats, pricing, now));
    if (quotes.every(quote => quote !== undefined)) setReview({ pricing, quotes, all });
  };
  const reviewedSale = review && { type: 'cashOut' as const, market, pricing: review.pricing, quotes: review.quotes, nowMs };
  const canConfirm = (action: PaperCashOut) => !!pricing && (!review?.all || action.quotes.length === positions.length) &&
    validatePaperCashOut(positions, action);
  return <div className="cash-out-ticket">
    {positions.length > 1 && <div className="sell-position-picker"><label>Position
      <select className="select-field" value={position.id} onChange={event => onSelect(event.target.value)}>
        {positions.map((item, index) => <option key={item.id} value={item.id}>
          {index + 1}. {item.outcome} · {bch(item.sats)}
        </option>)}
      </select>
    </label>
      <button type="button" className="btn" disabled={!pricing}
        onClick={() => reviewSale(positions.map(item => ({ position: item, amountSats: item.sats })), true)}>
        Sell all positions
      </button>
    </div>}
    <PaperCashOutAmount key={`${position.id}:${position.sats}`} market={market} position={position}
      pricing={pricing} nowMs={nowMs} onReview={amountSats => reviewSale([{ position, amountSats }], false)} />
    {reviewedSale && createPortal(
      <CashOutConfirmation sale={reviewedSale} canConfirm={canConfirm(reviewedSale)} onClose={() => setReview(undefined)}
        onConfirm={() => {
          const action = { ...reviewedSale, nowMs: Date.now() };
          if (!canConfirm(action)) return;
          onConfirm(action);
          setReview(undefined);
        }} />,
      document.body,
    )}
  </div>;
}

function PaperCashOutAmount({ market, position, pricing, nowMs, onReview }: {
  market: ConfigurableMarket;
  position: PaperPosition;
  pricing?: MarketPriceBook;
  nowMs: number;
  onReview: (amountSats: bigint) => void;
}) {
  const [amount, setAmount] = useState(() => satsToBchString(position.sats));
  const amountSats = parseStakeAmount(amount);
  const validAmount = amountSats !== null && amountSats <= position.sats;
  const currentQuote = pricing && validAmount ? quotePaperCashOut(position, market, amountSats, pricing, nowMs) : undefined;
  return <>
    <p className="cash-out-outcome"><strong>{position.outcome}</strong><span>{bch(position.sats)} open</span></p>
    <label>Stake to cash out (BCH)
      <input className="input-field" inputMode="decimal" autoComplete="off" value={amount} onChange={event => setAmount(event.target.value)}
        aria-invalid={!validAmount} aria-describedby={validAmount ? undefined : 'cash-out-amount-error'} />
    </label>
    <div className="cash-out-fractions" role="group" aria-label="Cash-out percentage">
      {[25, 50, 100].map(percent => {
        const portion = (position.sats * BigInt(percent)) / 100n;
        return <button type="button" className="btn" key={percent} aria-pressed={amountSats === portion}
          disabled={portion === 0n} onClick={() => setAmount(satsToBchString(portion))}>{percent === 100 ? 'Max (100%)' : `${percent}%`}</button>;
      })}
    </div>
    {!validAmount && <p id="cash-out-amount-error" className="stake-input-error" role="alert">Enter a positive amount up to {bch(position.sats)}.</p>}
    <div className="cash-out-quote">
      <dl className="receipt-fields">
        <dt>Sell price</dt><dd>{currentQuote ? `${(currentQuote.bidBps / 100).toFixed(2)}%` : 'Unavailable'}</dd>
        <dt>You receive</dt><dd><strong>{currentQuote ? bch(currentQuote.proceedsSats) : 'Unavailable'}</strong></dd>
        <dt>Realized PnL</dt><dd>{currentQuote ? <PositionPnl value={currentQuote.proceedsSats} cost={currentQuote.amountSats}/> : 'Unavailable'}</dd>
      </dl>
    </div>
    <button className="btn btn-primary cash-out-primary" type="button" disabled={!currentQuote}
      onClick={() => { if (amountSats !== null) onReview(amountSats); }}>
      Review Cash Out <ArrowDownLeft size={15} aria-hidden="true" />
    </button>
  </>;
}

function CashOutConfirmation({ sale, canConfirm, onClose, onConfirm }: {
  sale: PaperCashOut; canConfirm: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const { sold, remaining, credit } = sale.quotes.reduce((total, quote) => ({
    sold: total.sold + quote.amountSats,
    remaining: total.remaining + quote.openStakeSats - quote.amountSats,
    credit: total.credit + quote.proceedsSats,
  }), { sold: 0n, remaining: 0n, credit: 0n });
  const seconds = Math.ceil((Math.min(sale.pricing.asOfMs + PAPER_QUOTE_TTL_MS, sale.market.expiryTimestampMs) - sale.nowMs) / 1000);
  return <ActionPopup open title="Confirm Paper Cash Out" onClose={onClose}>
    <div className="cash-out-ticket">
      <dl className="receipt-fields">
        <dt>Positions</dt><dd>{sale.quotes.length}</dd>
        <dt>Stake sold</dt><dd>{bch(sold)}</dd>
        <dt>Remaining stake in sale</dt><dd>{bch(remaining)}</dd>
        <dt>Paper balance credit</dt><dd><strong>{bch(credit)}</strong></dd>
        <dt>Realized PnL</dt><dd><PositionPnl value={credit} cost={sold}/></dd>
      </dl>
      {canConfirm ? <p className="portfolio-note">Quote held for {seconds}s</p> :
        <p className="modal-note" role="alert">This quote is no longer available. Close this review for a new quote.</p>}
      <button className="btn btn-primary cash-out-primary" type="button" disabled={!canConfirm} onClick={onConfirm}>Confirm Cash Out</button>
    </div>
  </ActionPopup>;
}
