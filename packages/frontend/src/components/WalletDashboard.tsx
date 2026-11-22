import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Clock3,
  AppWindow,
  Copy,
  FileText,
  Layers,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { satsToBchString, bchToSats, type ConfigurableMarket } from "@cashingularity/shared";
import type { ConnectedWalletProfile } from "../services/walletRuntime.js";

import { transactionExplorer, type WalletTransaction } from "../services/transactionHistory.js";
import type { PaperPosition } from '../services/paperTrading.js';
import { WalletPortfolio } from './WalletPortfolio.js';
export type { WalletTransaction } from "../services/transactionHistory.js";

const widgetFactoryPresentation = 'https://github.com/TaylonMcFly/Cashingularity/blob/After/docs/blaze-submission/Cashingularity-Widget-Factory.pdf';
const chipnetBatchReceipt = 'https://explorer.selene.cash/tx/a87122c361114ab59e6547fad6f6921fd948700f51ed80dc365ddeb5a542ec3f?network=chipnet';
const emberVotingAddress = 'bitcoincash:zqx5xk9fpzgsrlk07t8e2asxx099d87txsgllfh3nd';

interface Props {
  profile: ConnectedWalletProfile;
  balanceSats: bigint;
  balanceAvailable: boolean;
  paper: boolean;
  price: number;
  priceSource: "live" | "fallback";
  priceSamples: Array<{ time: number; value: number }>;
  transactions: WalletTransaction[];
  paperPositions: PaperPosition[];
  onSend: () => void;
  onReceive: () => void;
  onBatch: () => void;
  onApps: () => void;
  onCreateProfile: () => void;
  onConnectExternal: () => void;
  onExistingProfile: () => void;
  onExploreSandbox: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onEnableSigning: () => void;
  liveFlash?: ConfigurableMarket;
  onBrowseMarkets: () => void;
  onOpenFlash: () => void;
  onSetPaperBalance: (balance: bigint) => void;
}

export const WalletDashboard: React.FC<Props> = ({
  profile,
  balanceSats,
  balanceAvailable,
  paper,
  price,
  priceSource,
  priceSamples,
  transactions,
  paperPositions,
  onSend,
  onReceive,
  onBatch,
  onApps,
  onCreateProfile,
  onConnectExternal,
  onExistingProfile,
  onExploreSandbox,
  onRefresh,
  refreshing,
  onEnableSigning,
  liveFlash,
  onBrowseMarkets,
  onOpenFlash,
  onSetPaperBalance,
}) => {
  const [virtualAmount, setVirtualAmount] = useState('');
  const [balanceError, setBalanceError] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const watchOnly = !paper && profile.connectionType === 'WATCH_ONLY';
  const disconnected = !paper && !profile.isConnected;
  const syncing = !paper && (refreshing || profile.utxoSource === 'syncing');
  const network = profile.network === 'chipnet' ? 'Chipnet' : 'Mainnet';
  const externalOffline = profile.connectionType === 'WIZARD_CONNECT' && !profile.externalSigningReady;
  const walletStatus = paper ? 'paper' : disconnected ? 'disconnected' : watchOnly ? 'watch' : externalOffline ? 'offline' : syncing ? 'syncing' : 'signing';
  const statusLabel = {
    paper: 'Paper Trading', disconnected: 'Not connected', watch: `Watch-only · ${network}`,
    syncing: `Syncing · ${network}`, signing: `Signing wallet · ${network}`, offline: `Waiting for wallet · ${network}`,
  }[walletStatus];
  const observed = useMemo(
    () =>
      priceSamples.filter(
        (sample, i) =>
          Number.isFinite(sample.value) &&
          sample.value > 0 &&
          (i === 0 || sample.time > priceSamples[i - 1].time),
      ),
    [priceSamples],
  );
  const change =
    priceSource === "live" && observed.length > 1
      ? (observed[observed.length - 1].value / observed[0].value - 1) * 100
      : null;
  const points = useMemo(() => {
    if (observed.length < 2) return "";
    const min = Math.min(...observed.map((p) => p.value)),
      max = Math.max(...observed.map((p) => p.value));
    return observed
      .map(
        (p, i) =>
          `${((i / (observed.length - 1)) * 200).toFixed(1)},${(35 - ((p.value - min) / (max - min || 1)) * 28).toFixed(1)}`,
      )
      .join(" ");
  }, [observed]);
  const visibleTransactions = transactions.filter(
    (t) =>
      !paper &&
      t.address === profile.receiveAddress &&
      t.network === profile.network,
  );
  const actions = [
    {
      label: "Send",
      description: "Transfer BCH",
      icon: ArrowUpRight,
      action: onSend,
    },
    {
      label: "Receive",
      description: "Address & QR",
      icon: ArrowDownLeft,
      action: onReceive,
    },
    {
      label: "Batch Pay",
      description: "Pay multiple",
      icon: Layers,
      action: onBatch,
    },
    { label: 'Approvals & Connected Apps', description: 'Review connections', icon: AppWindow, action: onApps },
    {
      label: "Transactions",
      description: "Recent activity",
      icon: Clock3,
      action: () => setHistoryExpanded(expanded => !expanded),
    },

  ];

  async function copyVotingAddress() {
    try {
      await navigator.clipboard.writeText(emberVotingAddress);
      setCopyStatus('Address copied.');
    } catch {
      setCopyStatus('Select the address to copy it.');
    }
  }

  return (
    <div className="wallet-home">
      <section className="blaze-entry" aria-labelledby="blaze-entry-title">
        <p className="blaze-entry-track">BCH BLAZE 2026 · Mainnet Track</p>
        <h2 id="blaze-entry-title">Non-custodial BCH batch payouts</h2>
        <p>Pay multiple recipients in one transaction. Review each address, amount, and miner fee before approving.</p>
        <div className="blaze-entry-actions">
          <button type="button" className="btn btn-primary" onClick={onBatch}>
            <Layers size={16} aria-hidden="true" /> Open Batch Pay
          </button>
          <a className="btn" href={widgetFactoryPresentation} target="_blank" rel="noopener noreferrer">
            <FileText size={16} aria-hidden="true" /> Mainnet Track presentation (PDF)
          </a>
          <a className="blaze-entry-proof" href={chipnetBatchReceipt} target="_blank" rel="noopener noreferrer">
            Chipnet batch receipt <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
        <div className="blaze-entry-vote">
          <div>
            <strong>Vote with EMBER2026</strong>
            <span> · BCH Mainnet CashTokens</span>
            <code>{emberVotingAddress}</code>
          </div>
          <div className="blaze-entry-copy">
            <button type="button" className="btn" onClick={() => void copyVotingAddress()}>
              <Copy size={14} aria-hidden="true" /> Copy voting address
            </button>
            <span role="status">{copyStatus}</span>
          </div>
        </div>
      </section>
      <div className="wallet-home-title">
        <div>
          <h1>Welcome to your wallet</h1>
          {!disconnected && !paper && <p className="wallet-home-profile">{profile.walletLabel}</p>}
        </div>
        <span className="wallet-home-network" data-wallet-status={walletStatus}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>
      <div className="wallet-columns">
      <div className="wallet-main-column">
      <section
        className="wallet-portfolio-hero"
        aria-label="BCH portfolio balance"
      >
        <div>
          <span className="wallet-hero-label">YOUR BCH BALANCE</span>

          <div className="wallet-hero-value">
            {balanceAvailable && priceSource === "live"
              ? `$${((Number(balanceSats) / 1e8) * price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : "—"}
          </div>
          <div className="wallet-hero-bch">
            {balanceAvailable
              ? `${satsToBchString(balanceSats, 8)} BCH`
              : disconnected ? 'Connect a wallet to see your balance' : syncing ? 'Refreshing your balance…' : 'Balance unavailable'}
          </div>
          {disconnected && <div className="wallet-profile-start">
            <button type="button" className="btn" onClick={onConnectExternal}>Connect external wallet</button>
            <button type="button" className="btn btn-primary" onClick={onCreateProfile}>Create Profile</button>
            <button type="button" className="btn" onClick={onExistingProfile}>Existing Profile</button>
            <button type="button" className="btn" onClick={onExploreSandbox}>Explore Sandbox</button>
          </div>}
          {watchOnly && <>
            <p>Monitor this address and receive funds. Enable signing to spend.</p>
            <button type="button" className="btn wallet-enable-signing" onClick={onEnableSigning}>Enable signing</button>
          </>}
          {balanceAvailable && !paper && <p>BCH before fees · CashToken dust reserved</p>}
          {!disconnected && !paper && <button type="button" className="btn wallet-refresh" disabled={syncing} onClick={onRefresh}>
            <RefreshCw size={14} aria-hidden="true" /> {syncing ? 'Syncing…' : 'Refresh wallet'}
          </button>}
          {paper && <form className="virtual-balance-editor" onSubmit={event => { event.preventDefault(); try { if (!/^\d{1,80}(?:\.\d{1,8})?$/.test(virtualAmount.trim())) throw new Error('Enter a non-negative BCH amount with up to eight decimals.'); onSetPaperBalance(bchToSats(virtualAmount.trim())); setBalanceError(''); } catch (e) { setBalanceError(e instanceof Error ? e.message : String(e)); } }}><label>Virtual balance (BCH)<input className="input-field" aria-label="Virtual balance in BCH" inputMode="decimal" value={virtualAmount} onChange={e => setVirtualAmount(e.target.value)} placeholder="Any BCH amount"/></label><button className="btn">Set Virtual Balance</button>{balanceError && <p className="modal-note" role="alert">{balanceError}</p>}</form>}
        </div>
        <div className="wallet-hero-chart" data-trend={change === null || change === 0 ? 'neutral' : change > 0 ? 'up' : 'down'}>
          {change !== null && (
            <span className={`wallet-change ${change < 0 ? "negative" : ""}`}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          )}
          {points ? (
            <svg
              viewBox="0 0 200 40"
              role="img"
              aria-label="Recent BCH price trend"
            >
              <polyline
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <div className="wallet-chart-empty">Waiting for price history</div>
          )}
          <small>Recent BCH price</small>
        </div>
      </section>
      <div className="wallet-section-heading">
        <div>
          <h2>Quick actions</h2>
        </div>
      </div>
      <div className="wallet-action-grid">
        {actions.map(({ label, description, icon: Icon, action }) => (
          <button
            type="button"
            key={label}
            onClick={action}
            className="wallet-action-tile"
            aria-expanded={label === 'Transactions' ? historyExpanded : undefined}
            aria-controls={label === 'Transactions' ? 'wallet-recent-transactions' : undefined}
          >
            <span className="wallet-action-icon">
              <Icon size={20} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <ArrowRight className="wallet-action-arrow" size={15} />
          </button>
        ))}
      </div>
      <section className="wallet-live-markets card" aria-label="Live markets">
        <span className="wallet-action-icon" aria-hidden="true"><TrendingUp size={20} /></span>
        <div className="wallet-market-copy">
          <h2>Live markets</h2>
          {liveFlash ? <p>BCH/USD · 5m strike <strong>${(liveFlash.strikePriceCents / 100).toFixed(2)}</strong> · Ends {new Date(liveFlash.expiryTimestampMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</p>
            : <p>Explore Bitcoin Cash price rounds and past results.</p>}
        </div>
        <div className="wallet-market-actions">
          {liveFlash && <button type="button" className="btn" onClick={onOpenFlash}>Open live 5m <ArrowUpRight size={14} /></button>}
          <button type="button" className="btn" onClick={onBrowseMarkets}>Explore markets <ArrowRight size={14} /></button>
        </div>
      </section>
      <section className="wallet-detail-panel history-panel wallet-compact-history" id="wallet-recent-transactions"
        aria-label="Recent transactions" data-expanded={historyExpanded}>
        <div className="section-heading">
          <h2>Recent transactions</h2>
          {visibleTransactions.length > 4 && <button type="button" className="btn" onClick={() => setHistoryExpanded(expanded => !expanded)}>
            {historyExpanded ? 'Show recent' : 'View all'}
          </button>}
        </div>
        {visibleTransactions.length ? (historyExpanded ? visibleTransactions : visibleTransactions.slice(0, 4)).map(transaction => (
          <TransactionRow key={transaction.txid} transaction={transaction} />
        )) : <p className="wallet-history-empty">{paper ? 'Practice transfers stay in Paper Trading.'
          : disconnected ? 'Select a wallet to see its transactions.' : syncing ? 'Syncing transactions…' : !balanceAvailable ? 'Transaction history unavailable.' : 'No transactions to show.'}</p>}
      </section>
      </div>
      <aside className="wallet-side-column" aria-label="Wallet portfolio and positions">
        <WalletPortfolio profile={profile} balanceSats={balanceSats} balanceAvailable={balanceAvailable}
          paper={paper} price={price} priceSource={priceSource} />
        <WalletMarketPositions paper={paper} positions={paperPositions} onBrowse={onBrowseMarkets} />
      </aside>
      </div>
    </div>
  );
};

function TransactionRow({ transaction }: { transaction: WalletTransaction }) {
  const status = transaction.confirmed === true ? 'Confirmed' : transaction.confirmed === false ? 'Pending' : undefined;
  const date = transaction.timestamp ? new Date(transaction.timestamp) : undefined;
  const label = ['Confirmed tx', 'Unconfirmed tx'].includes(transaction.label) ? 'On-chain transaction' : transaction.label;
  const shortId = `${transaction.txid.slice(0, 9)}…${transaction.txid.slice(-6)}`;
  return <article className="wallet-history-item">
    <div className="wallet-history-summary">
      <div className="wallet-history-method">
        <strong>{label}</strong>
        <small>{date ? date.toLocaleString() : shortId}</small>
      </div>
      <div className="wallet-history-value">
        {transaction.amountSats !== null && <strong>{satsToBchString(BigInt(transaction.amountSats), 8)} BCH</strong>}
        {status && <small data-confirmed={transaction.confirmed} title={transaction.confirmations === undefined ? undefined : `${transaction.confirmations} confirmation${transaction.confirmations === 1 ? '' : 's'}`}>{status}</small>}
      </div>
      <a className="header-icon-button" href={transactionExplorer(transaction)} target="_blank" rel="noreferrer"
        aria-label={`View transaction ${shortId}`} title="View transaction"><ArrowUpRight size={16} aria-hidden="true" /></a>
    </div>
    <details className="wallet-history-details">
      <summary>Details</summary>
      <dl className="receipt-fields">
        {transaction.feeSats !== null && <><dt>Network fee</dt><dd>{transaction.feeSats} sats</dd></>}
        {transaction.totalSats !== null && <><dt>Total spend</dt><dd>{satsToBchString(BigInt(transaction.totalSats), 8)} BCH</dd></>}
        {transaction.priceUsd !== null && <><dt>Price at review</dt><dd>${transaction.priceUsd.toFixed(2)} / BCH</dd></>}
        <dt>Transaction ID</dt><dd><code>{transaction.txid}</code></dd>
      </dl>
    </details>
  </article>;
}

function WalletMarketPositions({ paper, positions, onBrowse }: { paper: boolean; positions: PaperPosition[]; onBrowse: () => void }) {
  const [now, setNow] = useState(Date.now);
  const active = paper ? positions.filter(position => position.status === 'ACTIVE' && position.expiresAtMs > Math.max(now, Date.now())) : [];
  const nextExpiry = active.reduce((earliest, position) => Math.min(earliest, position.expiresAtMs), Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  return <section className="card wallet-market-positions" aria-label="Market positions">
    <div className="section-heading"><h2>Market positions</h2>{paper && <span className="badge badge-orange">Paper</span>}</div>
    {active.length ? <ul>
      {active.slice(0, 4).map(position => <li key={position.id}>
        <div><strong>{position.outcome}</strong><small>{position.market}</small></div>
        <span>{satsToBchString(position.sats, 8)} BCH</span>
      </li>)}
    </ul> : <p className="portfolio-note">{paper ? 'No active paper positions.' : 'On-chain market positions require verified settlement.'}</p>}
    <button type="button" className="btn" onClick={onBrowse}>{active.length > 4 ? `View markets · ${active.length} open` : 'View markets'} <ArrowRight size={14} aria-hidden="true" /></button>
  </section>;
}
