import React, { useEffect, useRef, useState } from 'react';
import { appSessions } from '../services/connectedApps.js';
import { authorizeAccount, consumeAuthorization } from '../services/accountSecurity.js';
import type { ConnectedWalletProfile } from '../services/walletRuntime.js';
import { ActionPopup } from './ActionPopup.js';
export const DappSessionHost: React.FC<{ scope: string; profile: ConnectedWalletProfile }> = ({ scope, profile }) => {
  const [, redraw] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [timeoutOrigin, setTimeoutOrigin] = useState('');
  const timers = useRef(new Map<string, number>());
  useEffect(() => appSessions().subscribe(() => redraw(value => value + 1)), []);
  useEffect(() => { appSessions().setScope(scope); setError(''); }, [scope]);
  const frames = appSessions().frames();
  const waiting = frames.filter(pair => pair.status === 'WAITING').map(pair => pair.id).join(':');
  useEffect(() => {
    const current = appSessions().frames().filter(pair => pair.status === 'WAITING');
    for (const [id, timer] of timers.current) if (!current.some(pair => pair.id === id)) { clearTimeout(timer); timers.current.delete(id); }
    for (const pair of current) if (!timers.current.has(pair.id)) timers.current.set(pair.id, window.setTimeout(() => {
      timers.current.delete(pair.id);
      if (appSessions().frames().some(frame => frame.id === pair.id && frame.status === 'WAITING')) { appSessions().disconnect(pair.id); setTimeoutOrigin(pair.origin); }
    }, 10000));
  }, [waiting]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); }, []);
  return <><ActionPopup open={!!timeoutOrigin} title="Application connection timed out" onClose={() => setTimeoutOrigin('')}><p>{timeoutOrigin} did not complete the browser handshake within 10 seconds. No connection or permissions were granted.</p><button className="btn" onClick={() => setTimeoutOrigin('')}>Close</button></ActionPopup>{frames.map(pair => <ActionPopup key={pair.id} open={pair.status !== 'ACTIVE'} title={pair.status === 'REQUESTED' ? 'Approve dApp connection' : 'Connect browser application'} wide onClose={() => appSessions().disconnect(pair.id)}>
    <p className="portfolio-note">{pair.origin} · {pair.status === 'REQUESTED' ? 'Verified handshake received. This app requests read-only access to your BCH address.' : 'Waiting for the application handshake. Incompatible apps will not create a session.'}</p>
    <iframe title={`Pair ${pair.origin}`} src={pair.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" className="dapp-pairing-frame" onLoad={event => { if (event.currentTarget.contentWindow) appSessions().attachFrame(pair.id, event.currentTarget.contentWindow); }}/>
    {pair.status === 'REQUESTED' && <dl className="receipt-fields"><dt>Requesting app</dt><dd>{pair.origin}</dd><dt>Network</dt><dd>{profile.network}</dd><dt>Connected address</dt><dd>{pair.address}</dd><dt>Permissions</dt><dd>Read the approved BCH address only. No signing or token approvals.</dd></dl>}
    <button className="btn btn-primary" disabled={pair.status !== 'REQUESTED' || busy} onClick={async () => { setBusy(true); setError(''); try { if (profile.securityAccount) { await authorizeAccount(profile.securityAccount, 'unlock'); consumeAuthorization(profile.securityAccount, 'unlock'); } appSessions().approve(pair.id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>Approve</button><button className="btn" onClick={() => appSessions().disconnect(pair.id)}>Reject</button>
    {error && <p className="modal-note" role="alert">{error}</p>}
  </ActionPopup>)}</>;
};
