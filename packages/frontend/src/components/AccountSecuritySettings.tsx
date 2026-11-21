import { TurnstileChallenge } from './TurnstileChallenge.js';
import { AuthenticatorCodeInput, isAuthenticatorCode } from './AuthenticatorCodeInput.js';
import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { authRequest, authorizeAccount, consumeAuthorization, type SecurityAccount } from '../services/accountSecurity.js';
import { profileManager } from '../services/profileManager.js';
import type { ConnectedWalletProfile } from '../services/walletRuntime.js';
import type { AuthResponse } from './AccountAuthorization.js';
import { ActionPopup } from './ActionPopup.js';
interface Pending { challengeToken: string; password: string; profileId: string }
export const AccountSecuritySettings: React.FC<{ profile: ConnectedWalletProfile; onProfileChange: (profile: ConnectedWalletProfile) => void }> = ({ profile, onProfileChange }) => {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [existing, setExisting] = useState(false), [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState(''), [popupError, setPopupError] = useState(''), [busy, setBusy] = useState(false);
  const [botToken, setBotToken] = useState(''), [botReset, setBotReset] = useState(0), [popupBotToken, setPopupBotToken] = useState(''), [popupBotReset, setPopupBotReset] = useState(0);
  const digit = useRef<HTMLInputElement>(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (pending || setup) { const timer = requestAnimationFrame(() => digit.current?.focus()); return () => cancelAnimationFrame(timer); } }, [pending, setup]);
  const account = profile.securityAccount;
  const closeStep = () => { generation.current++; setPending(null); setSetup(null); setCode(''); setPopupError(''); setBusy(false); };
  const beginSetup = async (pass: string) => { setSetup(await authRequest('totp/setup', { password: pass })); setCode(''); };
  const protect = async (data: AuthResponse, pass: string, id: string) => {
    if (profileManager.getActiveId() !== id) throw new Error('Wallet changed. Open security settings again.');
    if (!data.unlockKey) throw new Error('Account verification is incomplete.');
    await profileManager.protectActive(data.account, pass, data.unlockKey); onProfileChange(profileManager.getCurrentWallet());
  };
  return <section className="card"><h2>Password & Authenticator</h2><p className="portfolio-note">Protect this wallet with an account password and a phone Authenticator. Your recovery phrase stays in this browser.</p>
    {!account ? <><div className="security-segments" role="group" aria-label="Account protection"><button className={!existing ? 'selected' : ''} aria-pressed={!existing} onClick={() => { setExisting(false); setError(''); }}>Create New Protection</button><button className={existing ? 'selected' : ''} aria-pressed={existing} onClick={() => { setExisting(true); setError(''); }}>Sign In to Existing Account</button></div>
    <form className="security-form" onSubmit={async e => {
      e.preventDefault(); if (!botToken) return; setBusy(true); setError(''); const id = profileManager.getActiveId(), current = generation.current;
      try {
        const data = await authRequest<AuthResponse>(existing ? 'login' : 'register', { username, password, begin: true, cfTurnstileToken: botToken });
        if (generation.current !== current || profileManager.getActiveId() !== id) return;
        if (data.challengeToken) setPending({ challengeToken: data.challengeToken, password, profileId: id });
        else { await protect(data, password, id); if (!data.account.totpEnabled) await beginSetup(password); }
        setPassword('');
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setBotToken(''); setBotReset(value => value + 1); }
    }}><label>Account Name<input aria-label="Security account name" className="input-field" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required/></label><label>Password<input aria-label="Security account password" className="input-field" type="password" autoComplete={existing ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8}/></label>{!pending && !setup && profile.connectionType === 'BUILTIN_HD_XO' && <TurnstileChallenge action={existing ? 'login' : 'register'} onToken={setBotToken} resetKey={botReset}/>}<button className="btn btn-primary" disabled={busy || !botToken || profile.connectionType !== 'BUILTIN_HD_XO'}>{busy ? 'Verifying…' : 'Continue →'}</button></form></> : <div className="security-form"><p className="badge badge-mainnet">Account: {account.username} · {account.totpEnabled ? 'Authenticator enabled' : 'Password protected'}</p>
      {!account.totpEnabled && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const verified = await authorizeAccount(account, 'unlock'); consumeAuthorization(account, 'unlock'); await beginSetup(verified.password); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>Set up Authenticator</button>}
    </div>}
    {error && <p className="modal-note" role="alert">{error}</p>}
    <ActionPopup open={!!pending || !!setup} title={setup ? 'Set up Authenticator' : 'Authenticator verification'} onClose={closeStep}>
      <span className="eyebrow">STEP 2 OF 2 · AUTHENTICATOR</span>
      {setup ? <><p>Scan this code with Google Authenticator or Authy, then verify a code to activate 2FA.</p><div className="qr-box authenticator-qr"><QRCodeSVG value={setup.otpauthUri} size={190}/></div><details><summary>Manual setup key</summary><code className="uri-text">{setup.secret}</code></details></> : <p>Your account password is verified. Enter the 6-digit code from your Authenticator.</p>}
      <form className="security-form" onSubmit={async e => {
        e.preventDefault(); if (!isAuthenticatorCode(code) || (pending && !popupBotToken)) return; setBusy(true); setPopupError(''); const current = generation.current;
        try {
          if (pending) { const data = await authRequest<AuthResponse>('login', { challengeToken: pending.challengeToken, code, cfTurnstileToken: popupBotToken }); if (current !== generation.current) return; await protect(data, pending.password, pending.profileId); }
          else { const data = await authRequest<{ account: SecurityAccount }>('totp/verify', { code }); if (current !== generation.current) return; profileManager.updateSecurityAccount(data.account); onProfileChange(profileManager.getCurrentWallet()); }
          closeStep();
        } catch (e) { if (current === generation.current) setPopupError(e instanceof Error ? e.message : String(e)); } finally { if (current === generation.current) { setBusy(false); setPopupBotToken(''); setPopupBotReset(value => value + 1); } }
      }}><label>6-digit Authenticator code<AuthenticatorCodeInput ref={digit} label="Protection authenticator code" value={code} onChange={setCode}/></label>{pending && <TurnstileChallenge action="login" onToken={setPopupBotToken} resetKey={popupBotReset}/>}<button className="btn btn-primary" disabled={busy || !isAuthenticatorCode(code) || (!!pending && !popupBotToken)}>{busy ? 'Verifying…' : setup ? 'Verify & enable Authenticator' : 'Verify & protect wallet'}</button></form>
      {popupError && <p className="modal-note" role="alert">{popupError}</p>}
    </ActionPopup>
  </section>;
};
