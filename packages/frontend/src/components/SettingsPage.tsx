import React, { useEffect, useRef, useState } from 'react';
import { AppWindow, Hourglass, KeyRound, LockKeyhole, Network, ShieldCheck, Trash2 } from 'lucide-react';
import type { ExecutionMode } from '@cashingularity/shared';
import type { ConnectedWalletProfile } from '../services/walletRuntime.js';
import { wizardWalletSingleton } from '../services/walletRuntime.js';
import { profileManager } from '../services/profileManager.js';
import { disconnectWizardProfile } from '../services/wizardSessions.js';
import { AccountSecuritySettings } from './AccountSecuritySettings.js';
import { ConnectedApps } from './ConnectedApps.js';

export const SettingsPage: React.FC<{
  profile: ConnectedWalletProfile;
  scope: string;
  mode: ExecutionMode;
  onToggleMode: (mode: ExecutionMode) => void;
  onProfileChange: (profile: ConnectedWalletProfile) => void;
  onLock: () => void;
  onNotify: (message: string) => void;
  onConnect: () => void;
  onEnableSigning: () => void;
}> = ({ profile, scope, mode, onToggleMode, onProfileChange, onLock, onNotify, onConnect, onEnableSigning }) => {
  const local = profile.isConnected && profile.connectionType === 'BUILTIN_HD_XO';
  const watching = profile.connectionType === 'WATCH_ONLY';
  const paper = mode === 'SANDBOX_MODE';
  const liveNetworkLabel = profile.isConnected ? (profile.network === 'chipnet' ? 'BCH Chipnet' : 'BCH Mainnet') : 'BCH Mainnet';
  const identity = `${profileManager.getActiveId()}:${profile.connectionType}:${profile.network}:${profile.receiveAddress}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const [backup, setBackup] = useState<{ identity: string; phrase: string }>();
  const seed = local && backup?.identity === identity ? backup.phrase : '';
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => { setBackup(undefined); setError(''); }, [identity]);
  const toggleBackup = async () => {
    if (seed) { setBackup(undefined); return; }
    if (!local) return;
    try {
      const phrase = await profileManager.revealAuthorizedSeed();
      if (activeIdentity.current === identity) { setBackup({ identity, phrase }); setError(''); }
    } catch (error) {
      if (activeIdentity.current === identity) setError(error instanceof Error ? error.message : String(error));
    }
  };
  const switchNetwork = async (network: 'mainnet' | 'chipnet') => {
    setSwitching(true);
    try {
      if (profileManager.list().find(row => row.active)?.kind !== 'local') throw new Error('Select a local HD wallet in the header to change its network.');
      const next = await profileManager.switchLocalNetwork(network);
      onProfileChange(next);
      const id = profileManager.getActiveId();
      onNotify(`${network === 'chipnet' ? 'Chipnet' : 'Mainnet'} wallet selected.`);
      try {
        const updated = await wizardWalletSingleton.refreshOnChainBalance();
        if (profileManager.getActiveId() === id && wizardWalletSingleton.getAddresses() === updated) onProfileChange(updated);
      } catch {
        const current = wizardWalletSingleton.getAddresses();
        if (profileManager.getActiveId() === id && current.network === network) onProfileChange(current);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSwitching(false); }
  };
  const removeWallet = async () => {
    const selected = profileManager.list().find(row => row.active);
    if (!selected || selected.kind === 'sandbox') return;
    setRemoving(true);
    try {
      const next = selected.kind === 'wizard'
        ? await disconnectWizardProfile(selected.id)
        : profileManager.removeProfile(selected.id);
      onProfileChange(next);
      setBackup(undefined);
      onNotify('Wallet removed from this browser.');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally { setRemoving(false); }
  };
  return <div className="settings-page">
    <header className="workspace-heading"><h1>Settings</h1><p>Manage wallet access, networks and connected applications.</p></header>
    <div className="settings-content">
      <nav className="settings-section-nav" aria-label="Settings sections">
        <a href="#wallet-security"><ShieldCheck size={17} aria-hidden="true" />Wallet security</a>
        {local && <a href="#account-protection"><KeyRound size={17} aria-hidden="true" />Account protection</a>}
        <a href="#connected-apps"><AppWindow size={17} aria-hidden="true" />Connected apps</a>
        <a href="#developer"><Hourglass size={17} aria-hidden="true" />Developer</a>
        <a href="#remove-wallet"><Trash2 size={17} aria-hidden="true" />Remove wallet</a>
      </nav>
      <div className="settings-panels">
    <section id="wallet-security" className="card settings-wallet-card"><div className="section-heading"><h2>Wallet security</h2><ShieldCheck size={19} aria-hidden="true" /></div>
      <div className="settings-row"><span><Network size={18}/><strong>Bitcoin Cash network</strong><small>{profile.isConnected ? profile.network === 'chipnet' ? 'Chipnet' : 'Mainnet' : 'No live wallet connected'}</small></span>{local && <div className="settings-networks"><button className={`btn ${profile.network === 'mainnet' ? 'selected' : ''}`} disabled={switching || profile.network === 'mainnet'} onClick={() => switchNetwork('mainnet')}>Mainnet</button><button className={`btn ${profile.network === 'chipnet' ? 'selected' : ''}`} disabled={switching || profile.network === 'chipnet'} onClick={() => switchNetwork('chipnet')}>Chipnet</button></div>}</div>
      {local && <div className="settings-row"><span><KeyRound size={18}/><strong>Seed backup</strong><small>Available for your unlocked local wallet.</small></span><button className="btn" onClick={() => void toggleBackup()}>{seed ? 'Hide recovery phrase' : 'Reveal recovery phrase'}</button></div>}
      {watching && <div className="settings-row"><span><KeyRound size={18}/><strong>Watch-only access</strong><small>Enable signing to spend funds from this address.</small></span><button type="button" className="btn" onClick={onEnableSigning}>Enable signing</button></div>}
      {seed && <div className="seed-grid settings-seed" role="status" aria-label="Recovery phrase">{seed.split(' ').map((word, index) => <div key={index}><span>{index + 1}</span>{word}</div>)}</div>}
      <div className="settings-row"><span><LockKeyhole size={18}/><strong>Session lock</strong><small>Lock keys in memory. Encrypted profiles stay saved.</small></span><button className="btn" onClick={() => { setBackup(undefined); onLock(); }}>Log out & lock session</button></div>
      {!profile.isConnected && <button className="btn btn-primary settings-connect" onClick={onConnect}>Connect wallet</button>}
      {error && <p className="modal-note" role="alert">{error}</p>}
    </section>
    {local && <div id="account-protection"><AccountSecuritySettings key={identity} profile={profile} onProfileChange={onProfileChange}/></div>}
    <section id="connected-apps" className="card"><ConnectedApps scope={scope} address={profile.isConnected && profile.connectionType !== 'SANDBOX_DEMO' ? profile.receiveTokenAddress : null}/></section>
    <section id="developer" className="card settings-developer-card">
      <div className="section-heading"><h2>Developer</h2><Hourglass size={19} aria-hidden="true" /></div>
      <div className="settings-row settings-sandbox-row">
        <span>
          <Hourglass size={18} aria-hidden="true" />
          <strong>Sandbox</strong>
          <small>
            {paper
              ? `Sandbox active · Simulated virtual BCH only (${liveNetworkLabel} wallet state is preserved).`
              : `Test wallet transfers and market positions with simulated virtual BCH without switching your ${liveNetworkLabel} network.`}
          </small>
        </span>
        <div className="settings-networks">
          <button
            type="button"
            className={`btn ${paper ? 'selected' : ''}`.trim()}
            aria-pressed={paper}
            onClick={() => onToggleMode(paper ? 'MAINNET_MODE' : 'SANDBOX_MODE')}
          >
            {paper ? 'Exit Sandbox' : 'Enable Sandbox'}
          </button>
        </div>
      </div>
    </section>
    <section id="remove-wallet" className="card danger-zone"><div><h3>Remove wallet</h3><p>Remove this profile and its encrypted backup or pairing from this browser.</p></div><button className="btn" disabled={removing || profileManager.getActiveId() === 'sandbox'} onClick={() => void removeWallet()}><Trash2 size={14} aria-hidden="true" /> Remove Wallet</button></section>
      </div>
    </div>
  </div>;
};
