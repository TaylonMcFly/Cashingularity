import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { isWalletSessionUnlocked } from '../services/accountSecurity.js';
import { tokensEqual } from '../services/tokenPayment.js';
import { wizardWalletSingleton, type ConnectedWalletProfile } from '../services/walletRuntime.js';

type Role = 'A' | 'B';
type Pending = { id: string; raw: string; parents: string[]; walletInputIndex: number; label: string; role: Role; address: string; feeSats: string };
type Round = {
  marketId: number; label?: string; strikePriceCents: number; expiry: number;
  locked?: { sats: string; reserveSats: string; totalStakeSats: string };
  stakes?: { role: Role; outcome: string; sats: number; txid: string }[];
  payout?: { winner: Role; poolPayoutSats: string; txid: string; losingClaimRejected: boolean };
  cancellation?: { txid: string };
  reserveRecovery?: { txid: string; reserveReturnedSats: string };
  refunds?: { role: Role; txid: string; principalSats: number }[];
};
type ProofState = {
  viewOnly: boolean;
  pending?: Pending;
  report: {
    status?: string; error?: string; network: 'chipnet';
    wallets?: { role: Role; address: string; beforeSats?: string; afterSats?: string; feesSats?: string; receiptSats?: string; funding?: { txid: string } }[];
    rounds: Round[];
    transactions: { label: string; txid: string; feeSats: string; observedAt?: string; confirmed?: { height: number } }[];
    oracle?: { source: string; url: string; close: string };
  };
};

function decode(raw: string) {
  if (!/^(?:[a-f0-9]{2})+$/.test(raw)) throw new Error('Invalid transaction bytes.');
  const transaction = decodeTransaction(hexToBin(raw));
  if (typeof transaction === 'string') throw new Error(transaction);
  return transaction;
}

function reviewRequest(pending: Pending) {
  const tx = decode(pending.raw);
  const lock = cashAddressToLockingBytecode(pending.address);
  if (!pending.address.startsWith('bchtest:') || typeof lock === 'string' ||
      pending.parents.length !== tx.inputs.length || tx.inputs.length < 1 || tx.inputs.length > 2) {
    throw new Error('The signing request is outside the Chipnet proof format.');
  }
  const sources = tx.inputs.map((input, i) => {
    const raw = pending.parents[i];
    const parent = decode(raw);
    if (hashTransaction(hexToBin(raw)) !== binToHex(input.outpointTransactionHash) || !parent.outputs[input.outpointIndex]) {
      throw new Error('The review does not include the exact funding output.');
    }
    return parent.outputs[input.outpointIndex];
  });
  const owned = sources[pending.walletInputIndex];
  if (!owned || binToHex(owned.lockingBytecode) !== binToHex(lock.bytecode) ||
      tx.inputs.some((input, i) => (i === pending.walletInputIndex) !== (input.unlockingBytecode.length === 0))) {
    throw new Error('Expected one unsigned wallet input and completed covenant unlocks.');
  }
  const fee = sources.reduce((sum, source) => sum + source.valueSatoshis, 0n) - tx.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (fee <= 0n || fee > 2200n || fee.toString() !== pending.feeSats) throw new Error('The reviewed fee exceeds the Chipnet test limit.');
  return { tx, sources, owned };
}

const sats = (value: string | number | undefined) => value === undefined ? '—' : BigInt(value).toLocaleString('en-US') + ' sats';
const usd = (price: number) => '$' + price.toFixed(2);
const TxLink = ({ id }: { id: string }) => <a href={'https://chipnet.chaingraph.cash/tx/' + id} target="_blank" rel="noreferrer"><code>{id}</code></a>;

export const ChipnetProofPanel: React.FC<{ port: number; token: string; profile: ConnectedWalletProfile; paper: boolean }> = ({ port, token, profile, paper }) => {
  const [state, setState] = useState<ProofState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const call = useCallback(async (path: string, payload?: object, signal?: AbortSignal) => {
    const response = await fetch('http://127.0.0.1:' + port + path, {
      method: payload ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(payload && { 'Content-Type': 'application/json' }) },
      body: payload ? JSON.stringify(payload) : undefined, signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The local proof console returned an error.');
    return data;
  }, [port, token]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await call('/state', undefined, controller.signal) as ProofState;
        if (data.report.network !== 'chipnet') throw new Error('This console accepts Chipnet proofs only.');
        if (controller.signal.aborted) return;
        setState(data);
        if (data.viewOnly || ['Confirmed and reconciled', 'Stopped'].includes(data.report.status ?? '')) return;
      } catch {
        if (!controller.signal.aborted) setError('Open the current link from the running local Chipnet console.');
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 1400);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [call]);

  const pending = state?.pending;
  const review = useMemo(() => {
    if (!pending) return;
    try { return { data: reviewRequest(pending) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [pending]);
  const eligible = !paper && profile.isConnected && profile.network === 'chipnet' && profile.connectionType === 'BUILTIN_HD_XO';
  const act = async (operation: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { actionPending.current = false; setBusy(false); }
  };
  const approve = async () => {
    if (!pending || !review?.data || !eligible || pending.address !== profile.receiveAddress) return;
    const runtime = wizardWalletSingleton;
    const current = await runtime.refreshOnChainBalance(true);
    if (current.profileId !== profile.profileId || current.network !== 'chipnet' || current.connectionType !== 'BUILTIN_HD_XO' ||
        current.receiveAddress !== pending.address || runtime.getPaymentSigningIssue()) {
      throw new Error('Select the assigned unlocked Chipnet profile.');
    }
    if (current.securityAccount && !isWalletSessionUnlocked(current.localProfileId, current.securityAccount)) {
      throw new Error('Unlock the profile through Wallet settings before signing.');
    }
    const { tx, sources, owned } = review.data;
    const input = tx.inputs[pending.walletInputIndex];
    const live = current.utxos.find(coin => coin.txid === binToHex(input.outpointTransactionHash) && coin.vout === input.outpointIndex);
    const token = owned.token && {
      categoryId: binToHex(owned.token.category), amount: owned.token.amount,
      nft: owned.token.nft && { capability: owned.token.nft.capability, commitment: binToHex(owned.token.nft.commitment) },
    };
    if (!live || live.derivationScope !== 'receive' || live.addressIndex !== 0 ||
        owned.valueSatoshis !== live.satoshis || !tokensEqual(token, live.token)) {
      throw new Error('Sync the wallet or have the runner prepare the current input again.');
    }
    const signed = await runtime.getLocalWallet().signChipnetProofInput(tx, sources, pending.walletInputIndex);
    const active = runtime.getAddresses();
    if (active.profileId !== current.profileId || active.network !== 'chipnet' || active.receiveAddress !== current.receiveAddress || runtime.getPaymentSigningIssue()) {
      throw new Error('The Chipnet wallet changed during approval.');
    }
    await call('/signature', { id: pending.id, raw: binToHex(encodeTransaction(signed)) });
    setState(previous => previous?.pending?.id === pending.id ? { ...previous, pending: undefined } : previous);
  };

  const report = state?.report;
  return <section className="card chipnet-proof-panel" aria-label="Chipnet integration proof">
    <div><span className="badge badge-mainnet">BCH CHIPNET</span><h2>UP / DOWN integration proof</h2></div>
    <p role="status">{report?.status ?? (state?.viewOnly ? 'Archived Chipnet receipts' : 'Connecting to the local proof console…')}</p>
    {(error || report?.error) && <p role="alert" className="modal-note">{error || report?.error}</p>}
    <div className="grid-2">{report?.wallets?.map(wallet => <div className="card" key={wallet.role}>
      <h3>Wallet {wallet.role} · {wallet.role === 'A' ? 'UP' : 'DOWN'}</h3><code>{wallet.address}</code>
      <dl><dt>Before</dt><dd>{sats(wallet.beforeSats)}</dd><dt>After</dt><dd>{sats(wallet.afterSats)}</dd><dt>Paid in fees</dt><dd>{sats(wallet.feesSats)}</dd>
      <dt>Remaining NFT output value</dt><dd>{sats(wallet.receiptSats)}</dd></dl>
      {wallet.funding && <p>Confirmed funding <TxLink id={wallet.funding.txid}/></p>}
    </div>)}</div>
    {!state?.viewOnly && report?.status === 'Waiting for wallets' && <div>
      <p>Select an unlocked built-in Chipnet profile in the header, then assign its role.</p>
      <div className="chipnet-proof-actions">{(['A', 'B'] as const).map(role => <button className="btn" key={role} disabled={busy || !eligible}
        onClick={() => void act(async () => { await call('/wallets', { role, address: profile.receiveAddress }); })}>Assign active profile to Wallet {role}</button>)}</div>
    </div>}
    {!state?.viewOnly && pending && <div className="card">
      <h3>{pending.label}</h3><p>Wallet {pending.role} · {pending.address}</p>
      {review?.error && <p role="alert">{review.error}</p>}
      {review?.data && <>
        <p>Miner fee <strong>{sats(pending.feeSats)}</strong></p>
        <ol>{review.data.tx.outputs.map((output, i) => {
          const address = lockingBytecodeToCashAddress({ bytecode: output.lockingBytecode, prefix: 'bchtest', tokenSupport: !!output.token });
          return <li key={i}><strong>{sats(output.valueSatoshis.toString())}</strong> · <code>{typeof address === 'string' ? binToHex(output.lockingBytecode) : address.address}</code>
            {output.token && <small> · {output.token.nft?.capability === 'minting' ? 'Round reserve and pool state' : 'Position NFT receipt'}</small>}</li>;
        })}</ol>
      </>}
      {(!eligible || pending.address !== profile.receiveAddress) && <p>Select the assigned Wallet {pending.role} profile to approve.</p>}
      <button className="btn btn-primary" disabled={busy || !review?.data || !eligible || pending.address !== profile.receiveAddress}
        onClick={() => void act(approve)}>{busy ? 'Verifying selected wallet…' : 'Sign & broadcast on Chipnet'}</button>
    </div>}
    {report?.oracle && <p>Oracle close <strong>{usd(Number(report.oracle.close))}</strong> · <a href={report.oracle.url} target="_blank" rel="noreferrer">{report.oracle.source}</a></p>}
    {report?.rounds.map(round => <div className="card" key={round.marketId}>
      <h3>{round.label ?? 'Archived round ' + round.marketId}</h3>
      <p>Strike {usd(round.strikePriceCents / 100)} · {new Date(round.expiry * 1000).toLocaleString()}</p>
      {round.locked && <p>Confirmed pool {sats(round.locked.sats)} · stakes {sats(round.locked.totalStakeSats)} · reserve {sats(round.locked.reserveSats)}</p>}
      {round.stakes?.map(stake => <p key={stake.txid}>Wallet {stake.role} · {stake.outcome} · {sats(stake.sats)} · <TxLink id={stake.txid}/></p>)}
      {round.payout && <p>Wallet {round.payout.winner} won {sats(round.payout.poolPayoutSats)} · <TxLink id={round.payout.txid}/>{round.payout.losingClaimRejected && ' · Losing claim rejected by CashVM'}</p>}
      {round.refunds?.map(refund => <p key={refund.txid}>Wallet {refund.role} recovered {sats(refund.principalSats)} principal · <TxLink id={refund.txid}/></p>)}
      {round.cancellation && <p>Unfilled funding input spent back to Wallet B · <TxLink id={round.cancellation.txid}/></p>}
      {round.reserveRecovery && <p>Reserve returned {sats(round.reserveRecovery.reserveReturnedSats)} · <TxLink id={round.reserveRecovery.txid}/></p>}
    </div>)}
    {!!report?.transactions.some(tx => tx.observedAt) && <div><h3>Chipnet transactions</h3><ul>
      {report.transactions.filter(tx => tx.observedAt).map(tx => <li key={tx.txid}>
        <strong>{tx.label}</strong> · {sats(tx.feeSats)} fee · {tx.confirmed ? 'Block ' + tx.confirmed.height : 'Observed by both peers'} · <TxLink id={tx.txid}/>
      </li>)}</ul></div>}
  </section>;
};
