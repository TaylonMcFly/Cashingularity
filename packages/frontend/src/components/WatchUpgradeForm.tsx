import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { profileManager } from '../services/profileManager.js';
import type { ConnectedWalletProfile } from '../services/walletRuntime.js';

export function WatchUpgradeForm({ id, onBack, onUpgraded }: {
  id: string;
  onBack: () => void;
  onUpgraded: (id: string, profile: ConnectedWalletProfile, saved: boolean) => void;
}) {
  const watch = profileManager.describeWatchUpgrade(id);
  const selection = useRef(profileManager.getActiveId());
  const request = useRef<AbortController>();
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!watch?.supported || busy) return;
    setPhrase('');
    setPassword('');
    if (selection.current !== profileManager.getActiveId()) {
      setError('Wallet selection changed. Open Enable signing again.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setBusy(true);
    try {
      const profile = await profileManager.upgradeWatchProfile(id, phrase, { save, password: password || undefined, signal: controller.signal });
      if (!controller.signal.aborted) onUpgraded(id, profile, save);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Signing could not be enabled.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <form className="connect-body watch-upgrade-form" onSubmit={submit}>
      {watch ? <>
        <div className="watch-upgrade-address">
          <strong>{watch.name}</strong>
          <small>{watch.network === 'chipnet' ? 'Chipnet' : 'Mainnet'} · Watch-only</small>
          <code>{watch.address}</code>
        </div>
        {watch.supported ? <>
          <p>Enter the recovery phrase for this address. The match is checked in this browser.</p>
          <label>Recovery phrase
            <input className="input-field" type="password" value={phrase} required autoComplete="off" autoFocus
              spellCheck={false} autoCapitalize="none" maxLength={320} disabled={busy} onChange={event => setPhrase(event.target.value)} />
          </label>
          <label className="seed-confirm">
            <input type="checkbox" checked={save} disabled={busy} onChange={event => { setSave(event.target.checked); setPassword(''); }} />
            <span>Save signing wallet in this browser
              <small>{save ? (watch.protected ? 'The encrypted backup keeps your existing protection.' : 'The phrase is encrypted with a key stored in this browser.') : watch.saved ? 'Lock returns to Watch-only. Reload restores your saved Watch-only profile.' : 'Signing lasts for this session. This profile is kept in memory.'}</small>
            </span>
          </label>
          {save && watch.needsSavePassword && (
            <label>Existing profile password
              <input className="input-field" type="password" value={password} autoComplete="current-password" required disabled={busy} onChange={event => setPassword(event.target.value)} />
            </label>
          )}
        </> : <p>This address requires a wallet that supports its script. You can continue monitoring it as Watch-only.</p>}
      </> : <p>This profile is no longer available for upgrading.</p>}
      {error && <p className="modal-note" role="alert">{error}</p>}
      <div className="watch-upgrade-actions">
        <button type="button" className="btn" onClick={onBack}>Back to connected wallets</button>
        {watch?.supported && <button type="submit" className="btn btn-primary" disabled={busy || !phrase.trim()}><KeyRound size={15} aria-hidden="true" /> {busy ? 'Checking wallet…' : 'Enable signing'}</button>}
      </div>
    </form>
  );
}
