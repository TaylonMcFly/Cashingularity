import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeAccount, consumeAuthorization, subscribeAuthorization, markWalletSessionUnlocked, isWalletSessionUnlocked, clearProfileAuthorization, clearAccountAuthorization, type AuthorizationRequest } from './accountSecurity.js';
afterEach(()=>{clearAccountAuthorization();vi.restoreAllMocks();});
describe('sensitive wallet authorizations', () => {
  it('keeps only the selected wallet unlocked beyond thirty seconds, and revokes it on Lock',()=>{
    const account={id:'account-a',username:'alice',totpEnabled:true};
    markWalletSessionUnlocked('wallet-a',account);markWalletSessionUnlocked('wallet-b',account);
    const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+86400000);
    expect(isWalletSessionUnlocked('wallet-a',account)).toBe(true);
    expect(isWalletSessionUnlocked('wallet-a',{...account,id:'another-account'})).toBe(false);
    expect(isWalletSessionUnlocked('wallet-c',account)).toBe(false);
    // A signing-session flag never grants a seed-reveal approval.
    expect(()=>consumeAuthorization(account,'reveal','wallet-a')).toThrow(/required/);
    clearProfileAuthorization('wallet-a');expect(isWalletSessionUnlocked('wallet-a',account)).toBe(false);
    expect(isWalletSessionUnlocked('wallet-b',account)).toBe(true);
    clearAccountAuthorization();expect(isWalletSessionUnlocked('wallet-b',account)).toBe(false);
  });
  it('binds one-time security approvals to the selected profile and cancels pending work on Lock',async()=>{
    let request:AuthorizationRequest|null=null;const stop=subscribeAuthorization(next=>request=next);
    const account={id:'profile-account',username:'alice',totpEnabled:true};
    try{
      const approval=authorizeAccount(account,'reveal',undefined,undefined,'wallet-a');
      request!.resolve('password',account,'cd'.repeat(32));await approval;
      expect(()=>consumeAuthorization(account,'reveal','wallet-b')).toThrow(/required/);
      expect(()=>consumeAuthorization(account,'reveal','wallet-a')).not.toThrow();
      const pending=authorizeAccount(account,'unlock',undefined,undefined,'wallet-a');const rejected=expect(pending).rejects.toThrow(/locked/);
      clearProfileAuthorization('wallet-a');await rejected;
    }finally{stop();}
  });
  it('ignores late authentication responses after cancellation and keeps a later request intact', async () => {
    const requests: AuthorizationRequest[] = [];
    const stop = subscribeAuthorization(request => { if (request) requests.push(request); });
    const account = { id: 'cancelled-account', username: 'auditor', totpEnabled: true };
    try {
      const first = authorizeAccount(account, 'reveal');
      const rejected = expect(first).rejects.toThrow('Cancelled');
      requests[0].reject(new Error('Cancelled')); await rejected;
      const second = authorizeAccount(account, 'sign');
      requests[0].resolve('password', account, 'ab'.repeat(32));
      expect(() => consumeAuthorization(account, 'reveal')).toThrow(/required/);
      requests[1].resolve('password', account, 'ab'.repeat(32));
      await expect(second).resolves.toMatchObject({ account });
      expect(() => consumeAuthorization(account, 'sign')).not.toThrow();
      expect(() => consumeAuthorization(account, 'sign')).toThrow(/required/);
    } finally { stop(); }
  });
});
