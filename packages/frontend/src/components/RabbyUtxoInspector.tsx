import React, { useEffect, useState } from "react";
import { transactionAmounts } from "../services/transactionHistory.js";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  X,
} from "lucide-react";
import { satsToBchString } from "@cashingularity/shared";
import type {
  AiExecutionMode,
  ExecutionMode,
  UtxoDagInspection,
} from "@cashingularity/shared";
import { PREDICTION_SETTLEMENT_REQUIRED, type PreparedPayment } from "../services/paymentService.js";
import {
  wizardWalletSingleton,
  type SignedTransactionReceipt,
} from "../services/walletRuntime.js";

export interface RabbyUtxoInspectorProps {
  dag?: UtxoDagInspection;
  preparedPayment?: PreparedPayment;
  prepareError?: string;
  stake?: { amountSats: bigint; priceUsd?: number; entryOddsBps?: number; payoutSats?: bigint; quoteExpiresAtMs?: number };
  mode: ExecutionMode;
  engineTrack: "CASHSCRIPT_WIZARD" | "XO_INVITATION" | "SOLIDCASH_SCASH";
  analysisMode: AiExecutionMode;
  onChangeAnalysisMode: (mode: AiExecutionMode) => void;
  onBeforeApprove?: () => void;
  onSigningRequested?: (payment: PreparedPayment) => void;
  onApprovedSign?: (receipt: SignedTransactionReceipt) => void;
  onRequestConnectWallet?: () => void;
  onSwitchSandbox?: () => void;
  onCloseDrawer?: () => void;
  isDrawer?: boolean;
  title?: string;
}
export const RabbyUtxoInspector: React.FC<RabbyUtxoInspectorProps> = ({
  dag,
  preparedPayment,
  prepareError,
  stake,
  mode,
  engineTrack,
  onApprovedSign,
  onBeforeApprove,
  onSigningRequested,
  onRequestConnectWallet,
  onSwitchSandbox,
  onCloseDrawer,
  isDrawer = false,
  title = "Review transaction",
}) => {
  const [receipt, setReceipt] = useState<SignedTransactionReceipt>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(()=>{ const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const expiredQuote = !!preparedPayment?.quote && preparedPayment.quote.expiresAtMs <= now;
  const paperQuoteSeconds = stake?.quoteExpiresAtMs === undefined ? undefined : Math.ceil((stake.quoteExpiresAtMs - now) / 1000);
  const expiredPaperQuote = paperQuoteSeconds !== undefined && paperQuoteSeconds <= 0;
  const paper = mode === "SANDBOX_MODE";
  const paperStake = paper && stake;
  const amounts = dag && !paperStake ? transactionAmounts({ dag }) : undefined;
  const wallet = wizardWalletSingleton.getAddresses();
  const outputs = paperStake ? [] : dag?.outputs.filter((o) => !o.isChange) ?? [];
  const ownAddresses = new Set([
    wallet.receiveAddress,
    wallet.receiveTokenAddress,
    wallet.changeAddress,
    wallet.changeTokenAddress,
  ]);
  const spend = paperStake ? paperStake.amountSats : dag &&
    (dag.inputs.reduce((s, i) => s + i.satoshis, 0n) -
    dag.outputs
      .filter((o) => o.isChange || (!paper && ownAddresses.has(o.address)))
      .reduce((s, o) => s + o.satoshis, 0n));
  const receiptReserve = stake ? outputs.reduce((s, o) => s + (o.token?.nft ? o.satoshis : 0n), 0n) : 0n;
  const priceUsd = stake?.priceUsd ?? preparedPayment?.receiptPriceUsd;
  const method = stake
    ? paper ? "Paper stake" : "Covenant Stake · P2SH32"
    : preparedPayment?.contractType || (outputs.length > 1 ? "Batch transfer" : "BCH transfer");
  const displayBch = (satoshis: string | bigint | undefined) =>
    satoshis === undefined ? "Unavailable" : `${satsToBchString(BigInt(satoshis), 8)} BCH`;
  const blocked =
    !paper && (!preparedPayment || !!preparedPayment.contractType);
  const signingIssue = !paper && preparedPayment && !blocked && (
    preparedPayment.profileId !== wallet.profileId || preparedPayment.receiveAddress !== wallet.receiveAddress || preparedPayment.network !== wallet.network
      ? 'Wallet changed. Close this review and prepare the payment again.'
      : wizardWalletSingleton.getPaymentSigningIssue()?.message
  );
  const external = !paper && wallet.connectionType === 'WIZARD_CONNECT';
  const approve = async () => {
    if (busy || signingIssue) return;
    if (
      !paper &&
      (!wallet.isConnected || wallet.connectionType === "SANDBOX_DEMO")
    ) {
      onRequestConnectWallet?.();
      return;
    }
    setBusy(true);
    setError("");
    try {
      onBeforeApprove?.();
      if (!dag) throw new Error("Prepare the transaction before signing.");
      if (!paper && preparedPayment && !blocked) onSigningRequested?.(preparedPayment);
      const signed =
        !paper && preparedPayment
          ? await wizardWalletSingleton.signPreparedPayment(preparedPayment)
          : await wizardWalletSingleton.signAndBroadcast({
              dag,
              mode,
              engineTrack,
              userPrompt: title,
            });
      setReceipt(signed);
      onApprovedSign?.(signed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const content = (
    <div className="clean-confirmation">
      <div className="confirmation-heading">
        <div>
          <span className="eyebrow">
            {paper ? "PAPER PREVIEW" : wallet.network.toUpperCase()}
          </span>
          <h2>{title}</h2>
        </div>
        {onCloseDrawer && (
          <button
            type="button"
            className="icon-button"
            aria-label="Close confirmation"
            disabled={busy}
            onClick={onCloseDrawer}
          >
            <X size={18} />
          </button>
        )}
      </div>
      <div className="balance-change">
        <span>{paper ? "Virtual BCH balance change" : "Net BCH balance change"}</span>
        <strong>{spend === undefined ? "Unavailable" : `−${displayBch(spend > 0n ? spend : 0n)}`}</strong>
        {outputs.some((o) => o.token?.nft) && (
          <span className="badge badge-mainnet">
            {stake
              ? "CashTokens receipt preview"
              : "CashToken NFT receipt"}
          </span>
        )}
      </div>
      <div className="confirmation-outputs">
        {outputs.map((o) => (
          <div className="confirmation-output" key={o.index}>
            <div>
              <strong>
                {o.scriptType === "P2SH32"
                  ? "Covenant address · P2SH32"
                  : stake && o.token?.nft ? "CashTokens receipt · wallet-owned" : "Recipient address"}
              </strong>
              <span>{satsToBchString(o.satoshis, 8)} BCH</span>
            </div>
            <code>{o.address}</code>
            {o.token?.nft && (
              <small>NFT commitment: {o.token.nft.commitment || "Empty"}</small>
            )}
          </div>
        ))}
      </div>
      {preparedPayment?.assetTransfer && <div className="confirmation-token-amount"><strong>Transfer {preparedPayment.assetTransfer.amount} {preparedPayment.assetTransfer.symbol}</strong><small>CashTokens category: {preparedPayment.assetTransfer.categoryId}</small></div>}
      <dl className="receipt-fields">
        <dt>Method</dt><dd>{method}</dd>
        <dt>Price</dt><dd>{priceUsd === undefined ? "Unavailable" : `$${priceUsd.toFixed(2)} / BCH`}</dd>
        <dt>Amount</dt><dd>{displayBch(stake?.amountSats ?? amounts?.amountSats)}</dd>
        {paperStake && paperStake.entryOddsBps !== undefined && <><dt>Entry odds</dt><dd>{(paperStake.entryOddsBps / 100).toFixed(2)}%</dd></>}
        {paperStake && paperStake.payoutSats !== undefined && <><dt>Win payout</dt><dd>{displayBch(paperStake.payoutSats)}</dd></>}
        {receiptReserve > 0n && <><dt>Receipt reserve</dt><dd>{receiptReserve.toString()} sats</dd></>}
        <dt>Network Fee</dt><dd>{paperStake ? "0 sats" : amounts ? `${amounts.feeSats} sats` : "Unavailable"}</dd>
        <dt>Total Spend</dt><dd>{displayBch(paperStake ? paperStake.amountSats : amounts?.totalSats)}</dd>
        <dt>Date</dt><dd>{new Date(receipt?.signedAtMs ?? reviewedAt).toLocaleString()}</dd>
        <dt>Transaction ID</dt><dd>{paper ? paperStake ? "Paper position" : "Paper preview" : receipt?.txid || (blocked ? "Preview only" : "Assigned after signing")}</dd>
      </dl>
      {expiredQuote && <p role="alert">The FX quote expired. Close this review and prepare it again.</p>}
      {paperQuoteSeconds !== undefined && !receipt && (expiredPaperQuote
        ? <p className="modal-note" role="alert">The paper quote expired. Close this review for a new quote.</p>
        : <p className="portfolio-note">Quote held for {paperQuoteSeconds}s</p>)}
      {preparedPayment?.quote && (
        <div className="confirmation-quote">
          <strong>Locked currency quote</strong>
          <p>
            Expires{" "}
            {new Date(preparedPayment.quote.expiresAtMs).toLocaleTimeString()}
          </p>
          {preparedPayment.quote.rows.map((r, i) => (
            <small key={i}>
              {r.amount} {r.currency} → {r.satoshis} sats
            </small>
          ))}
        </div>
      )}
      {blocked && wallet.isConnected && !prepareError && (
        <p className="modal-note">
          {stake ? PREDICTION_SETTLEMENT_REQUIRED : "Prepare a verified transaction before signing."}
        </p>
      )}
      {(prepareError || error) && (
        <p className="modal-note" role="alert">
          {prepareError || error}
        </p>
      )}
      {!receipt && signingIssue && signingIssue !== error && <p className="modal-note" role="status">{signingIssue}</p>}
      {receipt ? (
        <div className="confirmation-success">
          <CheckCircle2 size={18} />
          <strong>
            {receipt.broadcasted
              ? "Transaction broadcast"
              : "Paper Preview Complete"}
          </strong>
          {receipt.explorerUrl && (
            <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">
              View transaction <ExternalLink size={14} />
            </a>
          )}
          {receipt.txid && <code>{receipt.txid}</code>}
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            expiredQuote ||
            expiredPaperQuote ||
            (blocked && wallet.isConnected) ||
            !!signingIssue ||
            !!prepareError ||
            error.startsWith("Broadcast result uncertain")
          }
          onClick={() => void approve()}
        >
          <ShieldCheck size={16} />
          {busy
            ? external ? "Awaiting wallet approval…" : "Signing…"
            : paper
              ? "Confirm Paper Preview"
              : !wallet.isConnected
                ? "Connect wallet"
                : "Sign & Broadcast"}
          <ArrowRight size={16} />
        </button>
      )}
      {onSwitchSandbox && !paper && blocked && (
        <button type="button" className="btn" onClick={onSwitchSandbox}>
          Try Paper Trading
        </button>
      )}
    </div>
  );
  return isDrawer ? (
    <div className="drawer-backdrop" onClick={busy ? undefined : onCloseDrawer}>
      <div
        className="rabby-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Transaction confirmation"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  ) : (
    <section className="card">{content}</section>
  );
};
