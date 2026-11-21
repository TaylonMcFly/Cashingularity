import React, { useEffect, useState } from "react";
import { ArrowUpRight, Bitcoin, Clock3 } from "lucide-react";
import {
  satsToBchString,
  marketPriceBook,
  type ConfigurableMarket,
  type MarketPricingInput,
} from "@cashingularity/shared";
import {
  isLiveEpoch,
  matchesMarketCategory,
  MARKET_TIMEFRAMES,
  type MarketFeedState,
  type MarketCategory,
} from "../services/marketEpochs.js";
import { outcomeKind } from '../services/marketPriceView.js';
import { MarketAccessStatus } from './MarketTicketPanels.js';

export const MarketExplorer: React.FC<{
  markets: ConfigurableMarket[];
  feed: MarketFeedState;
  paper: boolean;
  pricing: MarketPricingInput;
  onSelectMarket: (market: ConfigurableMarket) => void;
}> = ({ markets, feed, paper, pricing, onSelectMarket }) => {
  const [category, setCategory] = useState<MarketCategory>("All");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const filtered = markets.filter(
    (m) =>
      m.assetPair.replace(/[^a-z]/gi, "").toUpperCase() === "BCHUSD" &&
      isLiveEpoch(m, now) &&
      matchesMarketCategory(m, category),
  );
  const categories: MarketCategory[] = ['All', ...MARKET_TIMEFRAMES.map(frame => frame.label)];
  return (
    <section className="market-explorer">
      <div className="explorer-heading">
        <div>
          <h1>Explore markets</h1>
          <p>Track Bitcoin Cash price rounds and compare outcomes.</p>
        </div>
        <MarketAccessStatus paper={paper} />
      </div>
      <div
        className="category-filters"
        role="group"
        aria-label="Filter markets"
      >
        {categories.map((item) => (
          <button
            type="button"
            key={item}
            className={`market-pill ${category === item ? "active" : ""}`}
            aria-pressed={category === item}
            onClick={() => setCategory(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="explorer-section-title">
        <div>
          <h2>{category === "All" ? "BCH / USD markets" : category}</h2>
          {feed === 'ready' && <span>
            {filtered.length} market{filtered.length === 1 ? "" : "s"}
          </span>}
        </div>
      </div>
      {feed === 'ready' && filtered.length ? (
        <div className="market-explorer-grid">
          {filtered.map((market) => {
            const book = marketPriceBook(market, pricing, now);
            const expiry =
              Number.isFinite(market.expiryTimestampMs) &&
              market.expiryTimestampMs > 0
                ? new Date(market.expiryTimestampMs)
                : null;
            return (
              <button
                type="button"
                className="market-explorer-card"
                key={market.marketId}
                onClick={() => onSelectMarket(market)}
                aria-label={`Open ${market.title}`}
              >
                <div className="market-card-top">
                  <span className="market-card-icon"><Bitcoin size={18} aria-hidden="true" /></span>
                  <span className="market-card-symbol">BCH / USD</span>
                  <span className="market-card-state live">
                    <span className="status-dot" aria-hidden="true" /> Open round
                  </span>
                </div>
                <div className="market-card-question">{market.title}</div>
                <div className="market-card-outcomes">
                  {market.buckets.map(bucket => {
                    const quote = book?.outcomes.find(item => item.bucketId === bucket.bucketId);
                    return (
                    <div
                      key={bucket.bucketId}
                      className="market-card-outcome"
                      data-outcome={outcomeKind(bucket)?.toLowerCase()}
                    >
                      <span>{bucket.label}</span>
                      <strong>
                        {quote ? `${(quote.markBps / 100).toFixed(1)}%` : '—'}
                      </strong>
                    </div>
                    );
                  })}
                </div>
                <div className="market-card-footer">
                  <span>
                    Model pool · {satsToBchString(market.totalPoolSats, 4)} BCH
                  </span>
                  <span>
                    <Clock3 size={13} />
                    {expiry
                      ? `Ends ${expiry.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                      : "Expiry unavailable"}
                  </span>
                  <ArrowUpRight size={15} />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="card explorer-empty" role="status">
          {feed === 'loading' ? 'Loading live markets…' : feed === 'unavailable' ? 'Market data is temporarily unavailable. Retrying…' : 'No live BCH/USD rounds in this timeframe.'}
        </div>
      )}
    </section>
  );
};
