import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Eye, Hourglass, Link2, LockKeyhole, Wallet } from 'lucide-react';
import { profileManager, type ProfileSummary } from '../services/profileManager.js';
import { wizardWalletSingleton, type ConnectedWalletProfile } from '../services/walletRuntime.js';
import { disconnectWizardProfile } from '../services/wizardSessions.js';

type Row =
  | { kind: 'open'; id: string; profile: ProfileSummary }
  | { kind: 'locked'; id: string; name: string; device: boolean }
  | { kind: 'pairing'; id: string; name: string };

function rowDetails(row: Row) {
  if (row.kind === 'locked') return { name: row.name, info: 'Encrypted · Locked', icon: LockKeyhole };
  if (row.kind === 'pairing') return { name: row.name, info: 'WizardConnect · Reconnect to sign', icon: Link2 };
  const profile = row.profile;
  const network = profile.network === 'chipnet' ? 'Chipnet' : 'Mainnet';
  if (profile.paperOnly) return { name: profile.name, info: 'Sandbox · Virtual BCH', icon: Hourglass };
  if (profile.kind === 'watch') return { name: profile.name, info: `Watch-only · ${network}`, icon: Eye };
  if (profile.kind === 'local') return { name: profile.name, info: `${profile.sessionSigning ? 'Session signing' : 'Local signer'} · ${network}`, icon: Wallet };
  if (profile.kind === 'wizard') return {
    name: profile.name, info: `WizardConnect · ${profile.externalSigningReady ? 'Connected' : 'Waiting for wallet'}`, icon: Link2,
  };
  return { name: profile.name, info: `Browser wallet · ${network}`, icon: Link2 };
}

interface Props {
  selectedProfileId?: string;
  paper: boolean;
  onProfileChange: (profile: ConnectedWalletProfile) => void;
  onNotify: (message: string) => void;
  onReconnect: (id: string) => void;
  onSandbox: () => void;
  onUpgrade: (id: string) => void;
}

export function ConnectedWallets({ selectedProfileId, paper, onProfileChange, onNotify, onReconnect, onSandbox, onUpgrade }: Props) {
  const [, update] = useState(0);
  const [selectedId, setSelectedId] = useState(selectedProfileId ?? profileManager.getActiveId());
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const unlockRequest = useRef<AbortController>();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => profileManager.subscribe(() => update(n => n + 1)), []);
  useEffect(() => () => unlockRequest.current?.abort(), []);
  useEffect(() => {
    if (selectedProfileId) {
      setSelectedId(selectedProfileId);
      const action = detailRef.current?.querySelector<HTMLElement>('input[type="password"], button[type="submit"]');
      (action ?? rowRefs.current.get(selectedProfileId))?.focus();
    }
  }, [selectedProfileId]);

  const profiles = profileManager.list();
  const openRows = profiles.map(profile => ({ kind: 'open' as const, id: profile.id, profile }));
  const rows: Row[] = [
    ...openRows.filter(row => row.id !== 'sandbox'),
    ...profileManager.getLockedProfiles().map(row => ({ kind: 'locked' as const, id: row.id, name: row.label, device: row.device })),
    ...profileManager.getSavedWizardProfiles().map(row => ({ kind: 'pairing' as const, ...row })),
    ...openRows.filter(row => row.id === 'sandbox'),
  ];
  const selected = rows.find(row => row.id === selectedId) ?? rows.find(row => row.id === profileManager.getActiveId())!;
  const details = rowDetails(selected);
  const isActive = (row: Row) => row.kind === 'open' && (row.id === 'sandbox' ? paper : row.profile.active && !paper);
  const choose = (id: string) => {
    unlockRequest.current?.abort();
    setSelectedId(id);
    setPassword('');
    setError('');
  };
  const activate = (id: string) => {
    const next = profileManager.switchTo(id);
    onProfileChange(next);
    if (next.utxoSource === 'syncing') void wizardWalletSingleton.refreshOnChainBalance().catch(() => {});
  };
  const manage = async (action: () => void | Promise<void>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await action();
      onNotify(message);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  };
  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected.kind !== 'locked') return;
    const request = new AbortController();
    unlockRequest.current = request;
    await manage(async () => {
      await profileManager.unlockSaved(password, selected.id, request.signal);
      request.signal.throwIfAborted();
      setPassword('');
      activate(selected.id);
    }, 'Wallet unlocked and activated.');
    if (unlockRequest.current === request) unlockRequest.current = undefined;
  };
  const disconnectWizard = (id: string) => manage(async () => {
    onProfileChange(await disconnectWizardProfile(id));
  }, 'WizardConnect pairing removed.');

  return <div className="connected-wallets">
    <div className="profile-manager-heading"><strong>Local account</strong><small>{rows.length} {rows.length === 1 ? 'profile' : 'profiles'} in this browser</small></div>
    <ul className="profile-manager-list" aria-label="Wallet profiles">
      {rows.map(row => {
        const { name, info, icon: Icon } = rowDetails(row);
        return <li key={row.id}>
          <button type="button" className="profile-manager-row" aria-pressed={selected.id === row.id}
            disabled={busy} onClick={() => choose(row.id)} ref={node => {
              if (node) rowRefs.current.set(row.id, node); else rowRefs.current.delete(row.id);
            }}>
            <Icon size={16} aria-hidden="true"/><span><strong>{name}</strong><small>{info}</small></span>
            {isActive(row) && <span className="badge badge-mainnet"><Check size={12} aria-hidden="true"/> Active</span>}
          </button>
        </li>;
      })}
    </ul>
    <section ref={detailRef} className="profile-manager-detail" aria-label={`${details.name} profile actions`}>
      {selected.kind === 'open' && selected.id !== 'sandbox' && <code>{selected.profile.address}</code>}
      {selected.kind === 'open' && selected.id === 'sandbox' && <p className="portfolio-note">Practice wallet with its own virtual balance and activity.</p>}
      {selected.kind === 'pairing' && <p className="portfolio-note">Open WizardConnect on your device to confirm this saved pairing.</p>}
      {selected.kind === 'locked' && <form onSubmit={event => void unlock(event)} className="profile-manager-unlock">
        {!selected.device && <label>Profile password<input type="password" className="input-field" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label>}
        <button type="submit" className="btn btn-primary" disabled={busy || (!selected.device && !password)}><LockKeyhole size={13}/> Unlock &amp; activate</button>
      </form>}
      {selected.kind === 'pairing' && <div className="connected-wallet-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onReconnect(selected.id)}>Reconnect</button>
        <button type="button" className="btn connected-remove" disabled={busy} onClick={() => void disconnectWizard(selected.id)}>Forget pairing</button>
      </div>}
      {selected.kind === 'open' && <div className="connected-wallet-actions">
        {!isActive(selected) && <button type="button" className="btn btn-primary" disabled={busy}
          onClick={() => selected.id === 'sandbox' ? onSandbox() : void manage(() => activate(selected.id), `${details.name} activated.`)}>Activate</button>}
        {selected.profile.kind === 'watch' && <button type="button" className="btn" disabled={busy} onClick={() => onUpgrade(selected.id)}>Enable signing</button>}
        {selected.profile.kind === 'local' && <button type="button" className="btn" disabled={busy || (!selected.profile.saved && !selected.profile.sessionSigning)}
          title="Lock just this profile" onClick={() => void manage(() => onProfileChange(profileManager.lockProfile(selected.id)), `${details.name} locked.`)}><LockKeyhole size={13}/> Lock</button>}
        {selected.profile.kind === 'wizard' && <button type="button" className="btn connected-remove" disabled={busy} onClick={() => void disconnectWizard(selected.id)}>Disconnect</button>}
        {selected.profile.kind === 'extension' && <button type="button" className="btn" disabled={busy}
          onClick={() => void manage(() => onProfileChange(profileManager.disconnectExternal(selected.id)), 'Browser wallet disconnected. Address retained as watch-only.')}>Disconnect</button>}
      </div>}
      {selected.id !== 'sandbox' && selected.kind !== 'pairing' && !(selected.kind === 'open' && selected.profile.kind === 'wizard') &&
        <button type="button" className="btn connected-remove" disabled={busy}
          onClick={() => void manage(() => onProfileChange(profileManager.removeProfile(selected.id)), 'Profile removed from this browser.')}>Remove</button>}
      {error && <p className="modal-note" role="alert">{error}</p>}
    </section>
  </div>;
}
