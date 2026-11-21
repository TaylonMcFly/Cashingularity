import { SpreadsheetFormatGuide } from './SpreadsheetFormatGuide.js';
import { batchReviewError, DISCONNECTED_BATCH_MESSAGE, hasRecipientContent, parseRecipientRow } from '../services/batchReview.js';
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Send,
  ShieldCheck,
  Plus,
  Save,
  X,
  Upload,
} from "lucide-react";
import {
  AiExecutionMode,
  ExecutionMode,
  FxQuoteLock,
  parsePayrollDraft,
  serializePayrollDraft,
  editPayrollDraft,
  createPayrollDraft,
  PAYROLL_CURRENCIES,
  normalizePayrollCurrency,
  PAYROLL_CURRENCY_NAMES,
  PayrollRow,
  recalculatePayrollRow,
  satsToBchString,
  SupportedCurrency,
  UtxoDagInspection,
} from "@cashingularity/shared";
import { importSpreadsheet } from "../services/spreadsheetImport.js";
import { readBatchDraft, saveBatchDraft, readSavedBatches, saveNamedBatch } from "../services/batchDraftStorage.js";
import { wizardWalletSingleton } from "../services/walletRuntime.js";
import type { ConnectedWalletProfile, SignedTransactionReceipt } from "../services/walletRuntime.js";
import { preparePayment, PreparedPayment } from "../services/paymentService.js";
import { RabbyUtxoInspector } from "./RabbyUtxoInspector.js";
import { hasFreshSpot, freshFxExpiry, type FeedQuote } from "../services/rateFreshness.js";

export interface PayrollBatchSenderProps {
  active?: boolean;
  profile: ConnectedWalletProfile;
  mode: ExecutionMode;
  quoteLock: FxQuoteLock;
  analysisMode: AiExecutionMode;
  onChangeAnalysisMode: (mode: AiExecutionMode) => void;
  onRequestConnectWallet: () => void;
  onRequestEnableSigning: () => void;
  onTransaction?: (
    receipt: SignedTransactionReceipt,
    payment: PreparedPayment,
  ) => void;
  onSigningRequested?: (payment: PreparedPayment) => void;
}

export const PayrollBatchSender: React.FC<PayrollBatchSenderProps> = ({
  active = true,
  profile,
  mode,
  quoteLock,
  analysisMode,
  onChangeAnalysisMode,
  onRequestConnectWallet,
  onRequestEnableSigning,
  onTransaction,
  onSigningRequested,
}) => {
  const [draft, setDraft] = useState(readBatchDraft);
  const [savedLists, setSavedLists] = useState(readSavedBatches);
  const [listName, setListName] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [activeQuote, setActiveQuote] = useState<FxQuoteLock>(quoteLock);
  const [secondsRemaining, setSecondsRemaining] = useState(60);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<PreparedPayment>();
  const [paymentError, setPaymentError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const watchOnly = mode === 'MAINNET_MODE' && profile.connectionType === 'WATCH_ONLY';
  const rawInput = draft.rawText;
  const rows = useMemo(() => draft.rows.map((row, index) => parseRecipientRow(row, index, activeQuote)), [draft.rows, activeQuote]);
  const hasContent = (index: number) => hasRecipientContent(draft.rows[index]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const draftRef = useRef(draft); draftRef.current = draft;
  const activeRef = useRef(active); activeRef.current = active;
  const walletKey = `${mode}:${profile.profileId ?? ''}:${profile.connectionType}:${profile.network}:${profile.receiveAddress}`;
  const walletKeyRef = useRef(walletKey); walletKeyRef.current = walletKey;
  useEffect(() => { setActiveQuote(previous => quoteLock.lockedAtMs > previous.lockedAtMs ? quoteLock : previous); }, [quoteLock]);
  useEffect(() => { try { saveBatchDraft(draft); } catch (error) { setStorageNotice(error instanceof Error ? error.message : 'Draft could not be saved.'); } }, [draft]);
  useEffect(() => { if (!active) { setIsDrawerOpen(false); setPreparedPayment(undefined); } }, [active]);
  useEffect(() => { setIsDrawerOpen(false); setPreparedPayment(undefined); setPaymentError(''); }, [walletKey]);
  useEffect(() => {
    const update = () => setSecondsRemaining(Math.max(0, Math.ceil(((freshFxExpiry(activeQuote as FeedQuote) ?? activeQuote.expiresAtMs) - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [activeQuote]);
  const updateDraft = (next: typeof draft) => { setDraft(next); setPreparedPayment(undefined); setIsDrawerOpen(false); setPaymentError(''); setStorageNotice(''); };
  const handleRowEdit = (index: number, recipientAddress: string, rawAmountText: string, currency: SupportedCurrency | null) => {
    const nextRows = editPayrollDraft(draft.rows, index, { recipientAddress, rawAmountText, currency });
    updateDraft({ rows: nextRows, rawText: serializePayrollDraft(nextRows) });
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try { const nextRows = await importSpreadsheet(file); updateDraft({ rows: nextRows, rawText: serializePayrollDraft(nextRows) }); setStorageNotice(`Imported ${nextRows.length} recipients from ${file.name}.`); }
    catch (error) { setStorageNotice(error instanceof Error ? error.message : String(error)); }
  };
  const editCurrency = (index: number, text: string) => {
    const nextRows = editPayrollDraft(draft.rows, index, { currencyInput: text, currency: normalizePayrollCurrency(text) });
    updateDraft({ rows: nextRows, rawText: serializePayrollDraft(nextRows) });
  };
  const editRaw = (text: string) => {
    const nextRows = parsePayrollDraft(text, activeQuote);
    if (nextRows.length > 100) { setStorageNotice('A batch can contain at most 100 rows.'); return; }
    updateDraft({ rawText: text, rows: nextRows });
  };

  const summary = useMemo(() => {
    const validRows = rows.filter((r) => r.isValid);
    const invalidRows = rows.filter((r, i) => hasContent(i) && !r.isValid);
    const totalSatoshis = validRows.reduce(
      (acc, r) => acc + r.calculatedSats,
      0n,
    );
    const estimatedMinerFeeSats = BigInt(192 + validRows.length * 34);
    return {
      validCount: validRows.length,
      invalidCount: invalidRows.length,
      totalSatoshis,
      estimatedMinerFeeSats,
      grandTotalSats: totalSatoshis + estimatedMinerFeeSats,
    };
  }, [rows]);

  // Build atomic multi-output DAG for all valid rows (64-char hex txidPreview)
  const batchDag: UtxoDagInspection = useMemo(() => {
    const validRows = rows.filter((r) => r.isValid);
    const fundingSats = summary.grandTotalSats + 100_000n;
    const changeSats = fundingSats - summary.grandTotalSats;

    const outputs = validRows.map((r, idx) => ({
      index: idx,
      address: r.recipientAddress,
      scriptType: "P2PKH" as const,
      lockingBytecodeHex: `76a914${String(idx).padStart(40, "a")}88ac`,
      satoshis: r.calculatedSats,
      isChange: false,
    }));

    outputs.push({
      index: outputs.length,
      address: "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy",
      scriptType: "P2PKH" as const,
      lockingBytecodeHex: `76a914${"b".repeat(40)}88ac`,
      satoshis: changeSats,
      isChange: true,
    });

    const hexSats = summary.totalSatoshis.toString(16).padStart(16, "0");
    const hexCount = validRows.length.toString(16).padStart(8, "0");

    return {
      txidPreview: `b47c4000${hexSats}${hexCount}`.padEnd(64, "0").slice(0, 64),
      inputs: [
        {
          inputIndex: 0,
          txid: "c".repeat(64),
          vout: 0,
          satoshis: fundingSats,
          address: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
          isGenesisInput: true,
          derivationPath: "m/44'/145'/0'/0/0",
        },
      ],
      outputs,
      audit: {
        disassembledOpcodes: [
          {
            opcode: "OP_DUP",
            hex: "76",
            description: "Duplicates top stack item (recipient pubkey)",
            isCovenantIntrospection: false,
          },
          {
            opcode: "OP_HASH160",
            hex: "a9",
            description: "Hashes public key with RIPEMD160(SHA256(pk))",
            isCovenantIntrospection: false,
          },
          {
            opcode: "OP_EQUALVERIFY",
            hex: "88",
            description: "Verifies recipient P2PKH hash matches",
            isCovenantIntrospection: false,
          },
          {
            opcode: "OP_CHECKSIG",
            hex: "ac",
            description: "Verifies sender Schnorr signature",
            isCovenantIntrospection: false,
          },
        ],
        minerFeeSats: summary.estimatedMinerFeeSats,
        feeRateSatsPerByte: 1.1,
        dustPassed: true,
        bcmrVerified: true,
        addressReuseDetected: false,
        aiVerdict: summary.invalidCount > 0 ? "CAUTION" : "SAFE",
        aiExplanation:
          summary.invalidCount > 0
            ? `Caution: ${summary.invalidCount} invalid row(s) highlighted in red must be fixed before full batch dispatch.`
            : `Atomic Multi-Send Payroll: Dispatches ${satsToBchString(summary.totalSatoshis, 8)} BCH across ${summary.validCount} verified recipients in a single transaction.`,
        analysisMode,
      },
    };
  }, [rows, summary, analysisMode]);

  const reviewBatch = async () => {
    setPaymentError("");
    const wallet = wizardWalletSingleton.getAddresses();
    const issue = batchReviewError(draft.rows, rows, mode === 'MAINNET_MODE', wallet.isConnected && wallet.connectionType !== 'SANDBOX_DEMO' && wallet.utxoSource !== 'sandbox');
    if (issue) { setPaymentError(issue); return; }
    if (mode === 'MAINNET_MODE' && wallet.connectionType === 'WATCH_ONLY') {
      setPaymentError('Enable signing before reviewing this batch transfer.');
      return;
    }
    if (mode === "SANDBOX_MODE") {
      setPreparedPayment(undefined);
      setIsDrawerOpen(true);
      return;
    }
    setPreparing(true);
    try {
      const draftSnapshot = draftRef.current;
      const snapshot = rowsRef.current.filter(row => row.isValid);
      let paymentRows = snapshot;
      let quote: PreparedPayment["quote"];
      let refreshedLock: FxQuoteLock | undefined;
      if (snapshot.some((row) => row.currency !== "BCH")) {
        const response = await fetch("/api/rates?refresh=true", {
          signal: AbortSignal.timeout(15000),
        });
        const data = (await response.json()) as {
          quoteLock?: FxQuoteLock;
          tick?: { source?: string };
          error?: string;
        };
        const lock = data.quoteLock;
        const verifiedExpiry = freshFxExpiry(lock as FeedQuote | undefined);
        if (
          !response.ok ||
          !lock ||
          !Number.isFinite(lock.expiresAtMs) ||
          !Number.isFinite(lock.lockedAtMs) ||
          lock.lockedAtMs > Date.now() + 5000 ||
          lock.expiresAtMs <= Date.now() ||
          lock.expiresAtMs - lock.lockedAtMs > 65000 ||
          !lock.quoteId ||
          !lock.ratesToBch ||
          !verifiedExpiry
        )
          throw new Error(data.error || "A fresh FX quote is unavailable.");
        for (const row of snapshot) {
          const rate = row.currency && lock.ratesToBch[row.currency];
          if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
            throw new Error(`No valid rate for ${row.currency}.`);
        }
        refreshedLock = lock;
        paymentRows = snapshot.map((row) =>
          recalculatePayrollRow(row, {}, lock),
        );
        if (paymentRows.some((row) => !row.isValid))
          throw new Error(
            "Some rows are invalid under the refreshed quote. Check the amounts.",
          );
        quote = {
          id: lock.quoteId,
          expiresAtMs: verifiedExpiry,
          source: (lock as FeedQuote).fxSource || "live",
          freshnessVerified: true,
          rows: paymentRows.map((row) => ({
            amount: row.rawAmountText,
            currency: row.currency || "",
            satoshis: row.calculatedSats.toString(),
          })),
        };
      }
      if (walletKeyRef.current !== walletKey) return;
      if (draftRef.current !== draftSnapshot)
        throw new Error("Batch changed while loading rates. Review it again.");
      const wallet = await wizardWalletSingleton.refreshOnChainBalance();
      if (walletKeyRef.current !== walletKey) return;
      if (draftRef.current !== draftSnapshot)
        throw new Error("Batch changed while loading funds. Review it again.");
      const payment = preparePayment(
        wallet,
        paymentRows.map((r) => ({
          address: r.recipientAddress,
          satoshis: r.calculatedSats,
        })),
        analysisMode,
      );
      if (quote) {
        if (quote.expiresAtMs <= Date.now())
          throw new Error("The FX quote expired while preparing. Try again.");
        payment.quote = quote;
        payment.dag.audit.aiExplanation =
          "Review each BCH output against the locked fiat amounts before signing.";
        if (refreshedLock) setActiveQuote(refreshedLock);
      }
      if (hasFreshSpot((refreshedLock ?? activeQuote))) payment.receiptPriceUsd = (refreshedLock ?? activeQuote).bchUsdPrice;
      if (!activeRef.current || draftRef.current !== draftSnapshot) return;
      setPreparedPayment(payment);
      setIsDrawerOpen(true);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  };

  return (
    <section className="card batch-pay-card">
      <div className="section-heading"><div><span className="eyebrow">ONE TRANSACTION. EVERY RECIPIENT.</span></div><span className="badge badge-mainnet">Bitcoin Cash (BCH)</span></div>
      <p className="portfolio-note">Choose a unit of account for each recipient. Every row settles in native BCH on your wallet's Bitcoin Cash network. PUSD and USDT use the locked USD reference rate; no CashTokens or Tron assets are sent.</p>
      <div className="spreadsheet-dropzone" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); void importFile(event.dataTransfer.files[0]); }}><SpreadsheetFormatGuide active={active}/><Upload size={25}/><strong>Drop an .xlsx, .csv or .tsv spreadsheet</strong><span>Columns: Address, Amount, Currency, Label · Up to 100 recipients</span><label className="btn">Choose spreadsheet<input className="sr-only" aria-label="Import spreadsheet" type="file" accept=".xlsx,.csv,.tsv" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }}/></label></div>
      <datalist id="batch-currency-suggestions">{PAYROLL_CURRENCIES.map(currency => <option key={currency} value={currency}>{PAYROLL_CURRENCY_NAMES[currency]}</option>)}</datalist>
      <div className="batch-list-controls">
        <input className="input-field" aria-label="Transfer list name" placeholder="Name this transfer list" value={listName} onChange={e => setListName(e.target.value)} maxLength={80}/>
        <button type="button" className="btn" onClick={() => { try { setSavedLists(saveNamedBatch(listName, draft)); setStorageNotice('Transfer list saved.'); } catch (e) { setStorageNotice(e instanceof Error ? e.message : String(e)); } }}><Save size={14}/> Save Transfer List</button>
        <select className="select-field" aria-label="Saved Lists" value="" onChange={e => { const saved = savedLists.find(item => item.id === e.target.value); if (saved) { updateDraft(structuredClone(saved.draft)); setListName(saved.name); } }}><option value="">Saved Lists ({savedLists.length})</option>{savedLists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>
      {storageNotice && <p className="modal-note" role="status">{storageNotice}</p>}
      <details className="batch-raw-paste"><summary>Raw Text / Bulk Edit</summary><textarea aria-label="Raw Text / Bulk Edit" className="textarea-field" rows={6} value={rawInput} maxLength={100000} placeholder="bitcoincash:q… | 125 USD" onChange={e => editRaw(e.target.value)}/><p className="portfolio-note">Supports USD, PUSD, USDT, EUR, KZT, RUB, GBP and BCH. Changes sync with the rows below.</p></details>
      <div className="batch-editor-heading"><h3>Interactive Recipient Verification ({rows.length} Rows)</h3><button type="button" className="btn" disabled={!rows.length} onClick={() => updateDraft({ rows: [], rawText: '' })}>Clear All</button><button type="button" className="btn" disabled={rows.length >= 100} onClick={() => { const nextRows = [...draft.rows, ...createPayrollDraft(1)]; updateDraft({ rows: nextRows, rawText: serializePayrollDraft(nextRows) }); }}><Plus size={14}/> Add Row</button></div>
      <div className="batch-editor-rows">
        {rows.map((row, index) => { const input = draft.rows[index]; const touched = hasContent(index); return <div key={index} className={`payroll-row ${touched && !row.isValid ? 'invalid' : ''}`}>
          <div className="payroll-row-heading"><strong>Recipient {index + 1}</strong><div className="payroll-row-actions">{row.isValid ? <span className="badge badge-mainnet"><CheckCircle2 size={12}/>{satsToBchString(row.calculatedSats)} BCH</span> : touched ? <span className="badge badge-error"><AlertCircle size={12}/>Needs correction</span> : <span className="portfolio-note">Empty row</span>}<button type="button" className="icon-button" aria-label={`Remove recipient ${index + 1}`} onClick={() => { const nextRows = draft.rows.filter((_, i) => i !== index); updateDraft({ rows: nextRows, rawText: serializePayrollDraft(nextRows) }); }}><X size={14}/></button></div></div>
          <div className="batch-row-fields">
            <label>Recipient address<input aria-label={`Recipient ${index + 1} address`} className="input-field" value={input.recipientAddress} placeholder="bitcoincash: or bchtest:" onChange={e => handleRowEdit(index, e.target.value, input.rawAmountText, input.currency)}/></label>
            <label>Amount<input aria-label={`Recipient ${index + 1} amount`} className="input-field" inputMode="decimal" value={input.rawAmountText} placeholder="0.00" onChange={e => handleRowEdit(index, input.recipientAddress, e.target.value, input.currency)}/></label>
            <label>Currency<input aria-label={`Recipient ${index + 1} currency`} className="input-field" list="batch-currency-suggestions" autoComplete="off" value={input.currencyInput ?? input.currency ?? ''} onChange={e => editCurrency(index, e.target.value)} placeholder="USD, PUSD, BCH…"/></label>
          </div>
          <span className="confirmed-currency"><CheckCircle2 size={12}/>{input.currency ? `Confirmed: ${PAYROLL_CURRENCY_NAMES[input.currency]} → settles in BCH` : 'Currency needs confirmation'}</span>
          {touched && !row.isValid && <p className="row-error" role="alert">{row.errorMessages.join(' ')}</p>}
        </div>; })}
      </div>
      <div className="batch-review-summary"><div><strong>{summary.validCount} recipients · {satsToBchString(summary.totalSatoshis)} BCH</strong><p className="portfolio-note">{summary.invalidCount ? `${summary.invalidCount} row(s) need correction. ` : ''}Empty rows are not sent. Exact miner fee is calculated at review.</p>{freshFxExpiry(activeQuote as FeedQuote) ? <span className="badge badge-mainnet">Live FX rates locked · {secondsRemaining}s remaining</span> : <span className="badge badge-orange">A fresh FX quote is requested at review</span>}</div><button type="button" className="btn btn-primary" disabled={preparing} onClick={() => void reviewBatch()}><ShieldCheck size={15}/>{preparing ? 'Preparing…' : `Review & Send Batch (${summary.validCount})`}<Send size={14}/></button></div>
      {watchOnly && <div className="wallet-capability-note"><p>This wallet is Watch-only. Your recipient list stays available while you enable signing.</p><button type="button" className="btn" onClick={onRequestEnableSigning}>Enable signing</button></div>}
      {paymentError && <div className="modal-note batch-review-error" role="alert"><p>{paymentError}</p>{paymentError === DISCONNECTED_BATCH_MESSAGE && <button type="button" className="btn" onClick={onRequestConnectWallet}>Connect or select wallet</button>}</div>}
      {isDrawerOpen && (
        <RabbyUtxoInspector
          isDrawer
          dag={preparedPayment?.dag ?? batchDag}
          preparedPayment={preparedPayment}
          onSigningRequested={onSigningRequested}
          onApprovedSign={(receipt) => {
            if (preparedPayment) onTransaction?.(receipt, preparedPayment);
          }}
          mode={mode}
          engineTrack="CASHSCRIPT_WIZARD"
          analysisMode={analysisMode}
          onChangeAnalysisMode={onChangeAnalysisMode}
          onCloseDrawer={() => setIsDrawerOpen(false)}
          onRequestConnectWallet={() => {
            setIsDrawerOpen(false);
            onRequestConnectWallet();
          }}
          title={`Batch Payroll · ${summary.validCount} Recipients (${satsToBchString(
            summary.totalSatoshis,
            8,
          )} BCH)`}
        />
      )}
    </section>
  );
};
