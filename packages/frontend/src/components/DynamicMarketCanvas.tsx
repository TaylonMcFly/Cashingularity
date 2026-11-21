import { StakeControls } from './StakeControls.js';
import { maximumStake, parseStakeAmount } from '../services/stakePreferences.js';
import { readOutcomeLayout, saveOutcomeLayout, type Theme } from '../services/appearance.js';
import { OutcomePanelMenu } from './OutcomePanelMenu.js';
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock,
  ShieldCheck,
} from "lucide-react";
import {
  AiExecutionMode,
  ConfigurableMarket,
  ExecutionMode,
  marketPriceBook,
  recentRoundBuys,
  satsToBchString,
  simulateMarketBuy,
  type MarketPricingInput,
  UtxoDagInspection,
  VolatilityBandPoint,
} from "@cashingularity/shared";
import {
  buildPaperStakeDag,
  fetchMarketBySlugApi,
  prepareContractPaymentApi,
} from "../services/apiClient.js";
import type { PreparedPayment } from "../services/paymentService.js";
import { hasFreshSpotObservation } from '../services/rateFreshness.js';
import {
  openPaperPositions,
  makePaperPosition,
  PAPER_QUOTE_TTL_MS,
  type PaperCashOut,
  type PaperPosition,
} from "../services/paperTrading.js";
import {
  wizardWalletSingleton,
  type ConnectedWalletProfile,
} from "../services/walletRuntime.js";
import { RabbyUtxoInspector } from "./RabbyUtxoInspector.js";
import { findMarketBySlug, LIVE_SERIES_SLUGS, parseRollingMarketSlug } from "../services/marketRoutes.js";
import { profileManager } from "../services/profileManager.js";
import { bchSeries, epochTimeframeFor, findLiveEpoch, isLiveEpoch, MARKET_TIMEFRAMES, type MarketFeedState } from "../services/marketEpochs.js";
import { MarketEpochBar } from "./MarketEpochBar.js";
import { SpotTargetChart } from "./SpotTargetChart.js";
import { MarketAccessStatus, MarketOutcomeCard, MarketPoolBalance, StakeReturnPreview } from "./MarketTicketPanels.js";
import { MarketPositions, PaperCashOutTicket } from "./MarketPositions.js";
import { TradingViewSymbolOverview } from './TradingViewSymbolOverview.js';

export interface DynamicMarketCanvasProps {
  theme: Theme;
  markets: ConfigurableMarket[];
  selectedSlug: string;
  marketFeed: MarketFeedState;
  onNavigateMarket: (slug: string | null) => void;
  bchUsdPrice: number;
  priceSamples: Array<{ time: number; value: number }>;
  spotFeed: string | null;
  spotObservedAt: number | null;
  priceSource: "live" | "fallback";
  pricing: MarketPricingInput;
  paperScope: string;
  paperBalance: bigint;
  paperPositions: PaperPosition[];
  onPaperStake: (position: PaperPosition) => void;
  onPaperCashOut: (action: PaperCashOut) => void;
  ewmaSigma: number;
  volatilityCone: VolatilityBandPoint[];
  mode: ExecutionMode;
  analysisMode: AiExecutionMode;
  onChangeAnalysisMode: (mode: AiExecutionMode) => void;
  onRequestConnectWallet: () => void;
  onRequestEnableSigning: () => void;
  walletProfile?: ConnectedWalletProfile;
  onSwitchSandbox?: () => void;
}

interface StakeReview {
  key: string;
  expiry: number;
  stakeSats: bigint;
  dag?: UtxoDagInspection;
  priceUsd?: number;
  payment?: PreparedPayment;
  error?: string;
  position?: PaperPosition;
  quoteExpiresAtMs?: number;
}

export const DynamicMarketCanvas: React.FC<DynamicMarketCanvasProps> = ({
  theme,
  markets,
  selectedSlug,
  marketFeed,
  onNavigateMarket,
  bchUsdPrice,
  priceSamples,
  spotFeed,
  spotObservedAt,
  priceSource,
  pricing,
  paperScope,
  paperBalance,
  paperPositions,
  onPaperStake,
  onPaperCashOut,
  mode,
  analysisMode,
  onChangeAnalysisMode,
  onRequestConnectWallet,
  onRequestEnableSigning,
  walletProfile,
  onSwitchSandbox,
}) => {
  const [sellSelection, setSellSelection] = useState<{ scope: string; positionId?: string }>();
  const ticketRef = useRef<HTMLElement>(null);
  const [selectedBucketId, setSelectedBucketId] = useState<number>(1);
  const [stakeText, setStakeText] = useState("0.0025");
  const stakeSats = parseStakeAmount(stakeText) ?? 0n;
  const stakeValid = stakeSats >= 546n;
  const availableStake = maximumStake(walletProfile, mode === "SANDBOX_MODE", paperBalance);
  const [engineTrack, setEngineTrack] = useState<
    "CASHSCRIPT_WIZARD" | "XO_INVITATION" | "SOLIDCASH_SCASH"
  >("CASHSCRIPT_WIZARD");
  const [review, setReview] = useState<StakeReview>();
  const [prepareError, setPrepareError] = useState<string>();
  const [requestKey, setRequestKey] = useState<string>();
  const prepareVersion = useRef(0);
  useEffect(() => () => { prepareVersion.current++; }, []);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [xoSerializedJson, setXoSerializedJson] = useState<string>("");
  const [lookup, setLookup] = useState<{ slug: string; market?: ConfigurableMarket }>();
  const [panelLayout, setPanelLayout] = useState(readOutcomeLayout);
  const [customSlug, setCustomSlug] = useState<string>();
  const rolling = parseRollingMarketSlug(selectedSlug);
  const listedMarket = findMarketBySlug(markets, selectedSlug);
  const linkedMarket = listedMarket ?? (lookup?.slug === selectedSlug ? lookup.market : undefined);
  const timeframe = rolling?.timeframe ?? MARKET_TIMEFRAMES.find(({ label, seconds }) =>
    linkedMarket?.epochSeriesId === `bchusd-${label}` && linkedMarket.durationSeconds === seconds)?.label;
  const series = timeframe ? bchSeries(timeframe) : linkedMarket;
  const activeMarket = timeframe ? findLiveEpoch(markets, series!, nowMs)
    : linkedMarket && isLiveEpoch(linkedMarket, nowMs) ? linkedMarket : undefined;
  const linkedExpiry = rolling?.expiryMs ?? (linkedMarket && linkedMarket.expiryTimestampMs <= nowMs ? linkedMarket.expiryTimestampMs : undefined);
  const scoreboardMarkets = linkedMarket && !listedMarket ? [...markets, linkedMarket] : markets;

  useEffect(() => {
    if (rolling || listedMarket || marketFeed !== 'ready') return;
    const controller = new AbortController();
    void fetchMarketBySlugApi(selectedSlug, controller.signal).then(market => {
      if (!controller.signal.aborted) setLookup({ slug: selectedSlug, market });
    });
    return () => controller.abort();
  }, [selectedSlug, !!rolling, !!listedMarket, marketFeed]);

  const customHorizon = customSlug === selectedSlug;
  const changeTimeframe = (durationSeconds: number, custom = false) => {
    const slug = LIVE_SERIES_SLUGS[epochTimeframeFor(durationSeconds, custom)];
    setCustomSlug(custom && !customHorizon ? slug : undefined);
    if (slug !== selectedSlug && (!custom || timeframe !== '5m')) onNavigateMarket(slug);
    else if (custom && timeframe === '5m' && !customHorizon) setCustomSlug(selectedSlug);
  };

  const activeBucket =
    activeMarket?.buckets.find((b) => b.bucketId === selectedBucketId) ??
    activeMarket?.buckets[0];
  const paper = mode === 'SANDBOX_MODE';
  const walletId = profileManager.getActiveId();
  const walletType = walletProfile?.connectionType;
  const walletAddress = walletProfile?.receiveAddress;
  const walletNetwork = walletProfile?.network;
  const epochOpen = !!activeMarket && marketFeed === 'ready';
  const tradeScope = JSON.stringify([mode, paper ? paperScope : walletId, walletAddress, walletNetwork, activeMarket?.marketId, activeMarket?.expiryTimestampMs]);
  const sell = sellSelection?.scope === tradeScope;
  const selectSell = (positionId?: string) => setSellSelection({ scope: tradeScope, positionId });
  const activePaperPositions = paper ? openPaperPositions(paperPositions, activeMarket, nowMs) : [];
  const book = activeMarket && epochOpen ? marketPriceBook(activeMarket, pricing, nowMs) : undefined;
  const currentQuote = book?.outcomes.find(quote => quote.bucketId === activeBucket?.bucketId);
  const simulation = activeMarket && currentQuote ? simulateMarketBuy(activeMarket, currentQuote, stakeSats) : undefined;
  const flowPulses = useMemo(() => activeMarket && epochOpen ? recentRoundBuys(activeMarket, pricing.buys, nowMs)
    .filter(buy => buy.timestampMs >= nowMs - 9_000)
    .sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 3) : [], [activeMarket, epochOpen, pricing.buys, nowMs]);
  const contextKey = !sell && epochOpen && activeMarket && activeBucket
    ? JSON.stringify([
        selectedSlug, activeMarket.marketId, activeMarket.expiryTimestampMs, activeMarket.strikePriceCents,
        activeBucket.bucketId, activeBucket.lowerBoundCents, activeBucket.upperBoundCents,
        stakeText, tradeScope, walletType,
      ])
    : undefined;
  const latestKey = useRef(contextKey);
  latestKey.current = contextKey;
  const openReview = review?.key === contextKey ? review : undefined;
  const preparingStake = !!contextKey && requestKey === contextKey;
  useEffect(() => {
    if ((review && review.key !== contextKey) || (requestKey && requestKey !== contextKey)) {
      prepareVersion.current++;
      setReview(undefined);
      setRequestKey(undefined);
      setPrepareError(!sell ? 'The round or wallet changed. Review your stake again.' : undefined);
    }
  }, [contextKey, review, requestKey, sell]);

  const handleGenerateXoInvitationJson = () => {
    if (!activeMarket || !activeBucket) return;
    const invitationPayload = {
      invitation: {
        id: `xo-inv-mkt-${activeMarket.marketId}-bkt-${activeBucket.bucketId}`,
        createdAtTimestamp: Math.floor(Date.now() / 1000),
        template: {
          name: `CashingularityMarket_${activeMarket.marketId}`,
          version: "1.0.0",
          network: "chipnet",
        },
        inputs: [
          {
            txid: activeMarket.categoryId,
            vout: 0,
            satoshis: activeMarket.totalPoolSats.toString(),
          },
        ],
        outputs: [
          {
            address: activeMarket.covenantAddress,
            satoshis: (activeMarket.totalPoolSats + stakeSats).toString(),
          },
        ],
      },
    };
    setXoSerializedJson((prev) =>
      prev ? "" : JSON.stringify(invitationPayload, null, 2),
    );
  };

  const reviewStake = () => {
    const now = Date.now();
    if (!contextKey || !activeMarket || !activeBucket || !stakeValid || preparingStake || !isLiveEpoch(activeMarket, now)) return;
    const expiry = activeMarket.expiryTimestampMs;
    const spot = { price: bchUsdPrice, source: spotFeed ?? undefined, fetchedAtMs: spotObservedAt ?? undefined };
    const priceUsd = priceSource === 'live' && hasFreshSpotObservation(spot, now) ? spot.price : undefined;
    const requestedStake = { key: contextKey, expiry, stakeSats, priceUsd };
    setPrepareError(undefined);

    if (paper) {
      const reviewedBook = marketPriceBook(activeMarket, pricing, now);
      const price = reviewedBook?.outcomes.find(quote => quote.bucketId === activeBucket.bucketId);
      if (stakeSats > paperBalance || priceUsd === undefined || !price) return;
      try {
        const returns = simulateMarketBuy(activeMarket, price, stakeSats);
        const position = makePaperPosition(activeMarket, activeBucket, stakeSats, returns.estimatedPayoutSats, returns.multiplier, priceUsd, now, price.askBps);
        const dag = buildPaperStakeDag({ market: activeMarket, bucketId: activeBucket.bucketId, stakeSats, analysisMode });
        setReview({ ...requestedStake, dag, position, quoteExpiresAtMs: Math.min(expiry, now + PAPER_QUOTE_TTL_MS) });
      } catch (error) {
        setPrepareError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const wallet = wizardWalletSingleton.getAddresses();
    if (!wallet.isConnected || wallet.connectionType === 'SANDBOX_DEMO') { onRequestConnectWallet(); return; }
    if (wallet.connectionType === 'WATCH_ONLY') { onRequestEnableSigning(); return; }
    const version = ++prepareVersion.current;
    setRequestKey(contextKey);
    void prepareContractPaymentApi({ contractType: 'PREDICTION_STAKE', marketId: activeMarket.marketId,
      bucketId: activeBucket.bucketId, stakeSats, analysisMode }).then(result => {
      const current = wizardWalletSingleton.getAddresses();
      if (version !== prepareVersion.current || latestKey.current !== contextKey || Date.now() >= expiry ||
          profileManager.getActiveId() !== walletId || current.receiveAddress !== wallet.receiveAddress ||
          current.network !== wallet.network || current.connectionType !== wallet.connectionType) return;
      setReview({ ...requestedStake, dag: result.dag, payment: result.prepared, error: result.error });
    }).catch(error => {
      if (version === prepareVersion.current && latestKey.current === contextKey) setPrepareError(error instanceof Error ? error.message : 'Stake review is unavailable.');
    }).finally(() => {
      if (version === prepareVersion.current) setRequestKey(undefined);
    });
  };

  return (
    <div className="market-detail">
      <div className="market-detail-top">
        <button
          type="button"
          className="market-back"
          onClick={() => onNavigateMarket(null)}
        >
          <ArrowLeft size={15} aria-hidden="true" /> All markets
        </button>
        <MarketAccessStatus paper={paper} />
      </div>
      {series && <MarketEpochBar key={selectedSlug} series={series} timeframe={timeframe} markets={scoreboardMarkets}
        now={nowMs} liveMarket={epochOpen ? activeMarket : undefined} initialExpiryMs={linkedExpiry} />}
      {!activeMarket && (
        <div className="card" role="status">
          {marketFeed === 'loading' || (!series && marketFeed === 'ready' && lookup?.slug !== selectedSlug)
            ? 'Loading market…' : marketFeed === 'unavailable' ? 'Market data is temporarily unavailable. Retrying…'
              : series ? 'Waiting for an open round in this market.' : 'Market not found. Choose a market from the explorer.'}
        </div>
      )}

      {activeMarket && (
        <div className={`market-trading-layout outcome-layout-${panelLayout}`}>
        <section className="card market-charts-card">
          {marketFeed === 'unavailable' && <p className="market-resolution" role="status">Live market updates are temporarily unavailable. Retrying…</p>}
          <div className="market-detail-heading">
            <div>
              <div className="market-round-summary">
                <span className="badge badge-orange">
                  {activeMarket.assetPair}
                </span>
                <span className="badge badge-mainnet">
                  <Clock size={11} /> {activeMarket.durationSeconds}s Horizon
                </span>
                <span className="market-round-volume">
                  Model pool{" "}
                  <strong>
                    {satsToBchString(activeMarket.totalPoolSats, 4)} BCH
                  </strong>
                </span>
              </div>
              <h1>{activeMarket.title}</h1>
              <p>{activeMarket.description}</p>
            </div>

          </div>
          <TradingViewSymbolOverview theme={theme} price={bchUsdPrice} fresh={priceSource === "live"} observedAtMs={spotObservedAt}/>

          <SpotTargetChart
            theme={theme}
            market={activeMarket}
            price={bchUsdPrice}
            priceSource={priceSource}
            spotFeed={spotFeed}
            observedAtMs={spotObservedAt}
            samples={priceSamples}
            paperBuys={flowPulses}
            nowMs={nowMs}
            mode={mode}
            customHorizon={customHorizon}
            onTimeframeChange={changeTimeframe}
          />

        </section>
        <aside ref={ticketRef} className="card outcome-ticket" aria-label="Select Outcome Position">
          <div className="outcome-ticket-heading">
            <div><h2>Select Outcome Position</h2>{paper && <span className="ticket-paper-label">Virtual BCH</span>}</div>
            <OutcomePanelMenu
              layout={panelLayout} onLayout={layout => { setPanelLayout(layout); saveOutcomeLayout(layout); }}
              engine={engineTrack} onEngine={setEngineTrack} onGenerateXo={handleGenerateXoInvitationJson} xoJson={xoSerializedJson}
            />
          </div>
          <div className="market-trade-actions" role="group" aria-label="Position action">
            <button type="button" aria-pressed={!sell} onClick={() => setSellSelection(undefined)}>Buy</button>
            <button type="button" aria-pressed={sell} onClick={() => selectSell(sellSelection?.scope === tradeScope ? sellSelection.positionId : undefined)}>Sell</button>
          </div>
          {!sell ? <>
          <div className="outcome-ticket-body">
            <MarketPoolBalance buckets={activeMarket.buckets} pricing={book} />
            <div className="outcome-grid" role="group" aria-label="Market outcomes">
              {activeMarket.buckets.map(bucket => {
                const odds = book?.outcomes.find(item => item.bucketId === bucket.bucketId);
                return (
                <MarketOutcomeCard key={bucket.bucketId} bucket={bucket} selected={bucket.bucketId === activeBucket?.bucketId}
                  quote={odds} multiplier={odds && stakeValid ? simulateMarketBuy(activeMarket, odds, stakeSats).multiplier : undefined}
                  showSpread={book?.source === 'model'}
                  onSelect={() => setSelectedBucketId(bucket.bucketId)} />
                );
              })}
            </div>
            <div className="stake-order-grid">
              <StakeControls value={stakeText} onChange={setStakeText} available={availableStake} paper={paper}
                quotePayout={sats => currentQuote && simulateMarketBuy(activeMarket, currentQuote, sats).estimatedPayoutSats} />
              <StakeReturnPreview simulation={stakeValid ? simulation : undefined} />
            </div>
          </div>
          <div className="outcome-ticket-footer">
            <button type="button" className="btn btn-primary stake-review-button" onClick={reviewStake}
              disabled={!stakeValid || !activeBucket || preparingStake || !epochOpen || (paper && (stakeSats > paperBalance || priceSource !== 'live' || !currentQuote))}>
              <ShieldCheck size={16} aria-hidden="true" />
              {preparingStake ? 'Preparing Covenant Tx…' : 'Review & Place Stake'}
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
            {paper && (!currentQuote || priceSource !== 'live') && <p>Waiting for a price feed before placing a paper position.</p>}
            {paper && stakeSats > paperBalance && <p className="negative-text">Insufficient paper balance.</p>}
            {!epochOpen && <p>Review is available when the live market feed returns.</p>}
            {prepareError && !openReview && <p className="negative-text" role="alert">{prepareError}</p>}
          </div>
          </> : <div className="outcome-ticket-body">
            {paper ? <PaperCashOutTicket key={tradeScope} market={activeMarket} positions={activePaperPositions}
              selectedId={sellSelection.positionId} onSelect={selectSell} pricing={book}
              nowMs={nowMs} onConfirm={onPaperCashOut} />
              : <div className="cash-out-ticket">
                <p className="portfolio-note">On-chain cash-out requires a verified settlement and redemption contract.</p>
                {onSwitchSandbox && <button type="button" className="btn" onClick={onSwitchSandbox}>Try Paper Trading</button>}
              </div>
            }
          </div>}
        </aside>
        </div>
      )}

      <MarketPositions paper={paper} market={activeMarket} pricing={book} positions={paperPositions}
        activePositions={activePaperPositions} balance={paperBalance} nowMs={nowMs} onCashOut={id => {
          selectSell(id);
          ticketRef.current?.scrollIntoView({ block: 'start' });
        }} />

      {openReview && (
        <RabbyUtxoInspector isDrawer dag={openReview.dag} preparedPayment={openReview.payment} prepareError={openReview.error}
          stake={{ amountSats: openReview.stakeSats, priceUsd: openReview.priceUsd, quoteExpiresAtMs: openReview.quoteExpiresAtMs,
            entryOddsBps: openReview.position?.entryOddsBps, payoutSats: openReview.position?.payoutSats }}
          mode={mode} engineTrack={engineTrack} analysisMode={analysisMode} onChangeAnalysisMode={onChangeAnalysisMode}
          onSwitchSandbox={onSwitchSandbox} onRequestConnectWallet={() => { setReview(undefined); onRequestConnectWallet(); }}
          onCloseDrawer={() => setReview(undefined)}
          onBeforeApprove={() => {
            if (Date.now() >= openReview.expiry || latestKey.current !== openReview.key || profileManager.getActiveId() !== walletId) {
              throw new Error('The round or wallet changed. Review your stake again.');
            }
            if (openReview.quoteExpiresAtMs !== undefined && Date.now() >= openReview.quoteExpiresAtMs) {
              throw new Error('The paper quote expired. Review your stake again.');
            }
            if (openReview.position && openReview.stakeSats > paperBalance) throw new Error('Insufficient paper balance.');
          }}
          onApprovedSign={receipt => {
            if (receipt.mode === 'SANDBOX_MODE' && openReview.position && Date.now() < openReview.expiry && latestKey.current === openReview.key) {
              onPaperStake({ ...openReview.position, placedAtMs: Date.now() });
              setReview(undefined);
            }
          }}
          title={`Confirm Position Stake · ${satsToBchString(openReview.stakeSats, 8)} BCH`} />
      )}
    </div>
  );
};
