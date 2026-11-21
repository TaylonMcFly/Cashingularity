import React, { useEffect, useState } from 'react';
import { AppWindow, Link2, Unplug } from 'lucide-react';
import { appSessions, type AppConnection } from '../services/connectedApps.js';
import { ActionPopup } from './ActionPopup.js';
export const ConnectedApps: React.FC<{ scope: string; address: string | null }> = ({ scope, address }) => {
  const [, redraw] = useState(0), [uri, setUri] = useState(''), [details, setDetails] = useState<AppConnection | null>(null), [message, setMessage] = useState(''), [pairOpen, setPairOpen] = useState(false), [pairing, setPairing] = useState(false);
  useEffect(() => appSessions().subscribe(() => redraw(value => value + 1)), []);
  useEffect(() => { setDetails(null); setMessage(''); }, [scope]);
  const apps = appSessions().list(scope);
  return <section className="connected-apps">
    <div className="section-heading"><h2>Connected Applications</h2>{apps.length > 0 && <span className="settings-app-count">{apps.length} connected {apps.length === 1 ? 'app' : 'apps'}</span>}</div>
    <p className="portfolio-note">Review the permissions you approved for each connected application.</p>
    <div className="connected-app-list">{apps.length ? apps.map(app => <article className="connected-app-row" key={app.id}><span className="connected-app-icon"><Link2 size={22}/></span><div className="connected-app-info"><strong>{app.name}</strong><small>{app.domain} · {app.network}</small><span className="badge badge-mainnet">Active session</span></div><div className="connected-app-actions"><button className="btn" onClick={() => setDetails(app)}>Details</button><button className="btn" onClick={() => { appSessions().disconnect(app.id); setDetails(null); }}> <Unplug size={14}/>Disconnect</button></div></article>) : <p className="empty-state settings-app-empty"><AppWindow size={19} aria-hidden="true" />0 connected apps</p>}</div>
    <button className="btn btn-primary" disabled={!address} onClick={() => { setPairOpen(true); setMessage(''); }}><Link2 size={15}/>Connect dApp / Paste Pairing Code</button>
    {!address && <p className="portfolio-note">Connect a live wallet in the header before connecting an application.</p>}
    <ActionPopup open={pairOpen} title="Connect dApp" onClose={() => { setPairOpen(false); setUri(''); setMessage(''); }}>
      <div className="security-segments" role="group" aria-label="dApp connection method"><button className={!pairing ? 'selected' : ''} onClick={() => { setPairing(false); setMessage(''); }}>Browser dApp</button><button className={pairing ? 'selected' : ''} onClick={() => { setPairing(true); setMessage(''); }}>Pairing Code</button></div>
      <p className="portfolio-note">A compatible browser dApp must complete a verified handshake. You then approve its displayed address-access permissions. Pasting a URL alone grants no access.</p>
      {pairing && <p className="modal-note">Use a Cashingularity browser pairing link (cashingularity://connect?url=…). WalletConnect codes begin with wc: and require a WalletConnect relay connector, which this browser handshake flow does not provide. A wiz:// code pairs an external wallet through WizardConnect in the header.</p>}
      <form className="security-form" onSubmit={event => { event.preventDefault(); try {
        let input = uri.trim();
        if (/^wc:/i.test(input)) throw new Error('This is a WalletConnect relay code. Request the app’s compatible browser connection URL instead; no session has been created.');
        if (/^wiz:/i.test(input)) throw new Error('Use Connect wallet in the header to pair an external wallet with WizardConnect.');
        if (/^cashingularity:/i.test(input)) { const link = new URL(input); if (link.hostname !== 'connect' || !link.searchParams.get('url')) throw new Error('Invalid browser pairing link.'); input = link.searchParams.get('url')!; }
        appSessions().begin(input, scope, address || ''); setUri(''); setPairOpen(false); setMessage('');
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } }}><label>{pairing ? 'Browser pairing link' : 'Compatible browser dApp URL'}<input className="input-field" aria-label="dApp connection input" value={uri} maxLength={2048} onChange={e => setUri(e.target.value)} placeholder={pairing ? 'Paste a pairing code or link' : 'https://compatible-dapp.example'} required/></label><button className="btn btn-primary" disabled={!address}>Continue →</button></form>
      {message && <p className="modal-note" role="status">{message}</p>}
    </ActionPopup>
    <ActionPopup open={!!details && apps.some(app => app.id === details.id)} title="Application connection details" onClose={() => setDetails(null)}>{details && <div className="app-details"><h3>{details.name}</h3><dl className="receipt-fields"><dt>Domain</dt><dd>{details.domain}</dd><dt>Status</dt><dd>Active browser session</dd><dt>Connected address</dt><dd>{details.address}</dd><dt>Session start</dt><dd>{new Date(details.startedAtMs).toLocaleString()}</dd><dt>Network</dt><dd>{details.network}</dd><dt>Permissions granted</dt><dd>{details.permissions.join(' · ')}</dd><dt>Signing scope</dt><dd>{details.signingScope}</dd></dl></div>}</ActionPopup>
  </section>;
};
