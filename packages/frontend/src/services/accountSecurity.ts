export interface SecurityAccount { id: string; username: string; totpEnabled: boolean }
export type SecurityPurpose = 'unlock' | 'reveal' | 'sign';
export interface AuthorizationRequest { account: SecurityAccount; purpose: SecurityPurpose; profileId?: string; password?: string; challengeToken?: string; resolve: (password: string, account: SecurityAccount, unlockKey: string) => void; reject: (reason: Error) => void }
const listeners = new Set<(request: AuthorizationRequest | null) => void>();
const approvals = new Map<string, number>();
// This map contains only profile/account IDs. Credentials and decryption factors
// are never retained here, and the map disappears when the document reloads.
const unlockedWallets = new Map<string,string>();
export function isWalletSessionUnlocked(profileId:string|undefined,account:SecurityAccount):boolean {
  return !!profileId&&unlockedWallets.get(profileId)===account.id;
}
export function markWalletSessionUnlocked(profileId:string,account:SecurityAccount):void { unlockedWallets.set(profileId,account.id); }
export function clearProfileAuthorization(profileId:string):void {
  const wasUnlocked=unlockedWallets.has(profileId);
  unlockedWallets.delete(profileId);
  for(const key of approvals.keys())if(key.endsWith(`:${profileId}`))approvals.delete(key);
  if(pending?.profileId===profileId)pending.reject(new Error('Wallet locked.'));
  if(wasUnlocked&&!unlockedWallets.size)void authRequest('logout',{}).catch(()=>{});
}
const approvalKey=(account:SecurityAccount,purpose:SecurityPurpose,profileId?:string)=>`${account.id}:${purpose}:${profileId??''}`;
let pending: AuthorizationRequest | null = null;
export function subscribeAuthorization(listener: (request: AuthorizationRequest | null) => void): () => void { listeners.add(listener); listener(pending); return () => { listeners.delete(listener); }; }
export async function authRequest<T>(path: string, body: object): Promise<T> {
  if (typeof window !== 'undefined' && !window.isSecureContext) throw new Error('Account authentication requires HTTPS or localhost.');
  const response = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Authentication failed.');
  return data as T;
}
export function authorizeAccount(account: SecurityAccount, purpose: SecurityPurpose, password?: string, challengeToken?: string, profileId?:string): Promise<{ password: string; account: SecurityAccount; unlockKey: string }> {
  if (pending) return Promise.reject(new Error('Finish the current security request first.'));
  if (!listeners.size) return Promise.reject(new Error('Account authorization is unavailable.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { settled = true; pending = null; for (const listener of listeners) listener(null); };
    pending = { account, purpose, profileId, password, challengeToken, resolve: (password, verified, unlockKey) => { if (settled) return; if (verified.id !== account.id || !/^[a-f0-9]{64}$/i.test(unlockKey)) { finish(); reject(new Error('Account does not match this wallet.')); return; } approvals.set(approvalKey(account,purpose,profileId), Date.now() + 30000); finish(); resolve({ password, account: verified, unlockKey }); }, reject: reason => { if (settled) return; finish(); reject(reason); } };
    for (const listener of listeners) listener(pending);
  });
}
export function consumeAuthorization(account: SecurityAccount, purpose: SecurityPurpose,profileId?:string): void {
  const key = approvalKey(account,purpose,profileId), expires = approvals.get(key) ?? 0; approvals.delete(key);
  if (expires <= Date.now()) throw new Error(`Password and authenticator authorization required to ${purpose}.`);
}
export function clearAccountAuthorization(): void { unlockedWallets.clear(); approvals.clear(); pending?.reject(new Error('Session locked.')); void authRequest('logout', {}).catch(() => {}); }
