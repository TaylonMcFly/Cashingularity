import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { DUST_LIMIT_SATS, validateAndConvertCashAddr, type AiExecutionMode, type ExecutionMode, type FxQuoteLock } from '@cashingularity/shared';
import { wizardWalletSingleton, type ConnectedWalletProfile, type SignedTransactionReceipt } from '../services/walletRuntime.js';
import { preparePayment, type PreparedPayment } from '../services/paymentService.js';
import { prepareTokenPayment } from '../services/tokenPayment.js';
import { resolvePaytacaBcmrMetadata } from '../services/bcmrService.js';
import { formatAssetUnits, parseAssetUnits } from '../services/walletAssets.js';
import { RabbyUtxoInspector } from './RabbyUtxoInspector.js';
interface Props {
  profile: ConnectedWalletProfile; paperBalance: bigint; onPaperTransfer: (sats: bigint) => void; onSwitchPaper?: () => void;
  mode: ExecutionMode; active?: boolean; analysisMode: AiExecutionMode; onChangeAnalysisMode: (mode: AiExecutionMode) => void;
  onRequestConnectWallet: () => void; onRequestEnableSigning: () => void; onOpenBatch: () => void; quoteLock: FxQuoteLock; onBack?: () => void;
  onTransaction?: (receipt: SignedTransactionReceipt, payment: PreparedPayment) => void;
  onSigningRequested?: (payment: PreparedPayment) => void;
}
const paymentWalletKey = (profile: ConnectedWalletProfile) => `${profile.profileId ?? ''}:${profile.connectionType}:${profile.network}:${profile.receiveAddress}`;

export const SendBch: React.FC<Props> = ({ profile, paperBalance, onPaperTransfer, onSwitchPaper, mode, active = true, analysisMode, onChangeAnalysisMode, onRequestConnectWallet, onRequestEnableSigning, onOpenBatch, onTransaction, onSigningRequested, onBack }) => {
  const [draft] = useState(() => { try { const saved = JSON.parse(sessionStorage.getItem('cashingularity.send.draft.v1') || '{}'); return { address: typeof saved.address === 'string' ? saved.address : '', amount: typeof saved.amount === 'string' ? saved.amount : '', asset: typeof saved.asset === 'string' ? saved.asset : 'BCH' }; } catch { return { address: '', amount: '', asset: 'BCH' }; } });
  const [address, setAddress] = useState(draft.address), [amount, setAmount] = useState(draft.amount), [assetId, setAssetId] = useState(draft.asset);
  const [metadata, setMetadata] = useState<Record<string, { symbol: string; decimals: number }>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [payment, setPayment] = useState<PreparedPayment | null>(null);
  const paper = mode === 'SANDBOX_MODE';
  const signingIssue = paper ? undefined : wizardWalletSingleton.getPaymentSigningIssue();
  const balanceReady = paper || (profile.isConnected && !!profile.utxoSource && !['syncing', 'unavailable', 'sandbox'].includes(profile.utxoSource));
  const walletKey = paymentWalletKey(profile);
  const readinessId = useId();
  const tokens = useMemo(() => {
    const balances = new Map<string, bigint>();
    if (!paper) for (const utxo of profile.utxos) if (utxo.token?.amount) { const id = utxo.token.categoryId.toLowerCase(); balances.set(id, (balances.get(id) ?? 0n) + utxo.token.amount); }
    return [...balances].filter(([, balance]) => balance > 0n).map(([id, balance]) => ({ id, balance }));
  }, [profile.utxos, paper]);
  useEffect(() => { let current = true; for (const token of tokens) void resolvePaytacaBcmrMetadata(token.id).then(meta => { if (current) setMetadata(previous => ({ ...previous, [token.id]: { symbol: typeof meta.symbol === 'string' && meta.symbol !== 'UNKNOWN' ? meta.symbol : `CashToken ${token.id.slice(0, 8)}`, decimals: Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 18 ? meta.decimals : 0 } })); }); return () => { current = false; }; }, [tokens]);
  const nativeBalance = paper ? paperBalance : profile.balanceSats;
  const assets = [{ id: 'BCH', symbol: 'BCH', decimals: 8, balance: nativeBalance }, ...tokens.map(token => ({ ...token, symbol: metadata[token.id]?.symbol ?? `CashToken ${token.id.slice(0, 8)}`, decimals: metadata[token.id]?.decimals ?? 0 }))];
  const selected = assets.find(asset => asset.id === assetId) ?? assets[0];
  const syncing = profile.utxoSource === 'syncing';
  const reviewBlock = signingIssue?.message ?? (
    !balanceReady ? (syncing ? 'Refreshing wallet balance…' : 'Wallet balance unavailable. Retry balance sync.') :
    selected.balance <= 0n ? `Insufficient balance (0 ${selected.symbol} available). ${paper ? 'Set a virtual balance in Wallet.' : 'Fund this wallet or select another.'}` :
    selected.id !== 'BCH' && !metadata[selected.id] ? 'Loading asset details…' : undefined
  );
  useEffect(() => { if (!assets.some(asset => asset.id === assetId)) setAssetId('BCH'); }, [paper, profile.receiveAddress, tokens]);
  const currentForm = useRef({ address, amount, assetId, active, mode, paperBalance, walletKey }); currentForm.current = { address, amount, assetId, active, mode, paperBalance, walletKey };
  useEffect(() => { try { sessionStorage.setItem('cashingularity.send.draft.v1', JSON.stringify({ address, amount, asset: assetId })); } catch {} setPayment(null); setError(''); }, [address, amount, assetId]);
  useEffect(() => { setPayment(null); setError(''); }, [active, mode, walletKey]);
  const retryBalance = async () => {
    setError('');
    setBusy(true);
    try { await wizardWalletSingleton.refreshOnChainBalance(true); }
    catch (e) { if (currentForm.current.active) setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const review = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !active) return;
    if (reviewBlock) { setError(reviewBlock); return; }
    setError(''); setBusy(true);
    try {
      const recipient = address.trim();
      if (!recipient) throw new Error('Enter a recipient address.');
      const checked = validateAndConvertCashAddr(recipient);
      if (!checked.valid || checked.network !== profile.network) throw new Error(`Enter a valid BCH ${profile.network === 'mainnet' ? 'Mainnet' : 'Chipnet'} recipient address.`);
      if (!amount.trim()) throw new Error('Enter an amount to send.');
      const quantity = parseAssetUnits(amount, selected.decimals);
      if (selected.id === 'BCH' && quantity < DUST_LIMIT_SATS) throw new Error(`Enter at least ${DUST_LIMIT_SATS} sats.`);
      let prepared: PreparedPayment;
      if (paper) {
        if (quantity > paperBalance) throw new Error('Insufficient virtual BCH balance.');
        const source = wizardWalletSingleton.getAddresses();
        const practice: ConnectedWalletProfile = { ...source, isConnected: true, utxoSource: 'paper', balanceSats: paperBalance, utxos: [{ txid: 'ff'.repeat(32), vout: 0, address: source.receiveAddress, tokenAddress: source.receiveTokenAddress, satoshis: paperBalance, derivationScope: 'receive', addressIndex: 0, isGenesisCapable: false }] };
        prepared = preparePayment(practice, [{ address: recipient, satoshis: quantity }], analysisMode);
      } else {
        if (paymentWalletKey(wizardWalletSingleton.getAddresses()) !== walletKey) throw new Error('Wallet changed. Review the payment again.');
        const live = await wizardWalletSingleton.refreshOnChainBalance(true);
        const issue = wizardWalletSingleton.getPaymentSigningIssue();
        if (issue) throw new Error(issue.message);
        prepared = selected.id === 'BCH' ? preparePayment(live, [{ address: recipient, satoshis: quantity }], analysisMode) : prepareTokenPayment(live, recipient, selected.id, quantity, analysisMode);
        if (selected.id !== 'BCH') prepared.assetTransfer = { categoryId: selected.id, symbol: selected.symbol, amount: formatAssetUnits(quantity, selected.decimals) };
      }
      const current = currentForm.current;
      if (!current.active) return;
      if (current.mode !== mode || current.walletKey !== walletKey || current.address !== address || current.amount !== amount || current.assetId !== assetId) {
        throw new Error('The wallet or transfer details changed. Review the payment again.');
      }
      setPayment(prepared);
    } catch (e) { if (currentForm.current.active) setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <section className="card"><span className="eyebrow">BITCOIN CASH ASSETS</span><div className="send-heading"><span className="badge badge-mainnet">{selected.symbol}</span>{onBack && <button className="btn" onClick={onBack}>Wallet home</button>}<button className="btn" onClick={onOpenBatch}>Advanced: Multi-Recipient Batch Pay →</button></div>
    <p className="portfolio-note">{paper ? 'Paper transfer — virtual BCH only. No on-chain transaction is broadcast.' : 'Only native BCH and positive CashToken balances held by this wallet are available. Every live transfer uses the selected Bitcoin Cash network.'}</p>
    <form className="send-form" onSubmit={review} noValidate><label>Recipient address<input className="input-field" value={address} onChange={e => setAddress(e.target.value)} placeholder="bitcoincash: or bchtest:" required/></label><label>Amount<div className="amount-input"><input aria-label="Send amount" className="input-field" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" maxLength={100} required/><select aria-label="Send asset" className="select-field" value={selected.id} onChange={e => setAssetId(e.target.value)}>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.symbol}</option>)}</select></div></label>
      {balanceReady && selected.balance > 0n && <p className="portfolio-note">Available: {formatAssetUnits(selected.balance, selected.decimals)} {selected.symbol}{paper ? ' (virtual)' : ''}</p>}
      {reviewBlock && <p id={readinessId} className="modal-note" role="status">{reviewBlock}</p>}
      <p className="portfolio-note">Miner fee is calculated at review. CashToken change returns to this wallet.</p>
      {error && error !== reviewBlock && <p className="modal-note" role="alert">{error}</p>}
      <div className="send-actions">
        {signingIssue?.kind === 'watch' && <button type="button" className="btn btn-primary" onClick={onRequestEnableSigning}>Enable signing</button>}
        {signingIssue && signingIssue.kind !== 'watch' && <button type="button" className="btn btn-primary" onClick={onRequestConnectWallet}>{signingIssue.kind === 'connect' ? 'Connect wallet' : signingIssue.kind === 'locked' ? 'Unlock wallet' : signingIssue.kind === 'reconnect' ? 'Manage connection' : 'Select signing wallet'}</button>}
        {!signingIssue && !balanceReady && !syncing && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retryBalance()}>Retry balance sync</button>}
        <button type="submit" className="btn btn-primary" disabled={busy || !!reviewBlock} aria-describedby={reviewBlock ? readinessId : undefined}><ShieldCheck size={16}/>{busy && !reviewBlock ? 'Preparing payment…' : paper ? 'Review Paper Transfer' : 'Review & Send'}<ArrowUpRight size={16}/></button>
        {!paper && (!profile.isConnected || (balanceReady && selected.balance <= 0n)) && onSwitchPaper && <button type="button" className="btn" onClick={onSwitchPaper}>Switch to Paper Trading</button>}
      </div>
    </form>
    {payment && <RabbyUtxoInspector isDrawer dag={payment.dag} preparedPayment={payment} onSigningRequested={onSigningRequested} mode={mode} engineTrack="CASHSCRIPT_WIZARD" analysisMode={analysisMode} onChangeAnalysisMode={onChangeAnalysisMode} onCloseDrawer={() => setPayment(null)} onRequestConnectWallet={onRequestConnectWallet} title={paper ? 'Review paper transfer' : `Review ${selected.symbol} payment`} onBeforeApprove={() => { if (paper && payment.dag.outputs.filter(o => !o.isChange).reduce((sum,o) => sum + o.satoshis, payment.dag.audit.minerFeeSats) > currentForm.current.paperBalance) throw new Error('Paper balance changed. Prepare this transfer again.'); }} onApprovedSign={receipt => { if (paper) onPaperTransfer(payment.dag.outputs.filter(o => !o.isChange).reduce((sum,o) => sum + o.satoshis, payment.dag.audit.minerFeeSats)); else onTransaction?.(receipt, payment); }}/>}
  </section>;
};
