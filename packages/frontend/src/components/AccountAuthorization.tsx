import { TurnstileChallenge } from './TurnstileChallenge.js';
import { AuthenticatorCodeInput, isAuthenticatorCode } from './AuthenticatorCodeInput.js';
import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ActionPopup } from './ActionPopup.js';
import { authRequest, subscribeAuthorization, type AuthorizationRequest, type SecurityAccount } from '../services/accountSecurity.js';
export interface AuthResponse { account: SecurityAccount; unlockKey?: string; challengeToken?: string }
export const AccountAuthorization: React.FC = () => {
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [password, setPassword] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [botToken, setBotToken] = useState(''), [botReset, setBotReset] = useState(0);
  const input = useRef<HTMLInputElement>(null), generation = useRef(0);
  useEffect(() => subscribeAuthorization(setRequest), []);
  useEffect(() => { generation.current++; setPassword(request?.password ?? ''); setCode(''); setChallenge(request?.challengeToken ?? ''); setError(''); setBusy(false); }, [request]);
  useEffect(() => { if (challenge) { const timer = requestAnimationFrame(() => input.current?.focus()); return () => cancelAnimationFrame(timer); } }, [challenge]);
  return <ActionPopup open={!!request} title="Verify account security" layerClassName="account-authorization-layer" onClose={() => request?.reject(new Error('Authorization cancelled.'))}>
    {request && <form className="security-form" onSubmit={async event => {
      event.preventDefault(); if (!botToken || (challenge && !isAuthenticatorCode(code))) return; const current = generation.current; setBusy(true); setError('');
      try {
        const data = await authRequest<AuthResponse>('login', { ...(challenge ? { challengeToken: challenge, code } : { username: request.account.username, password, purpose: request.purpose, begin: true }), cfTurnstileToken: botToken });
        if (generation.current !== current) return;
        if (data.challengeToken) { setChallenge(data.challengeToken); setCode(''); }
        else if (data.unlockKey) request.resolve(password, data.account, data.unlockKey);
        else throw new Error('Account verification returned an incomplete response.');
      } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (generation.current === current) { setBusy(false); setBotToken(''); setBotReset(value => value + 1); } }
    }}>
      <p><ShieldCheck size={18}/> Verify <strong>{request.account.username}</strong> to {request.purpose === 'sign' ? 'sign this transaction' : request.purpose === 'reveal' ? 'reveal the recovery phrase' : 'unlock this wallet'}.</p>
      <span className="eyebrow">STEP {challenge ? '2 OF 2 · AUTHENTICATOR' : '1 · ACCOUNT PASSWORD'}</span>
      {!challenge ? <label>Password<input className="input-field" aria-label="Account authorization password" autoComplete="current-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8}/></label> : <><p>Your password is verified. Enter the current code from your Authenticator app.</p><label>6-digit Authenticator code<AuthenticatorCodeInput ref={input} label="Account authorization code" value={code} onChange={setCode}/></label></>}
      <TurnstileChallenge key={`${request.account.id}:${challenge}`} action="login" onToken={setBotToken} resetKey={botReset}/>
      {error && <p role="alert" className="modal-note">{error}</p>}
      <button className="btn btn-primary" disabled={busy || !botToken || (!!challenge && !isAuthenticatorCode(code))}>{busy ? 'Verifying…' : challenge ? 'Verify & continue' : 'Continue →'}</button>
      {challenge && <button type="button" className="btn" onClick={() => { setChallenge(''); setCode(''); setPassword(''); setError(''); }}>Back to password</button>}
    </form>}
  </ActionPopup>;
};
