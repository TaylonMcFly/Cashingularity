import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnstileVerifier, TURNSTILE_TEST_SECRET } from './turnstileService.js';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const local = { hostname:'localhost', ip:'127.0.0.1' };
describe('Cloudflare Turnstile server-side enforcement', () => {
  it('requires tokens, validates against Siteverify, and fails closed on rejection or outage', async () => {
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('TURNSTILE_SECRET_KEY','');
    const fetch = vi.fn().mockResolvedValue({ok:true,json:async()=>({success:true,hostname:'example.com'})}); vi.stubGlobal('fetch',fetch);
    const verifier = new TurnstileVerifier();
    await expect(verifier.verify('',local,'register')).rejects.toMatchObject({statusCode:403}); expect(fetch).not.toHaveBeenCalled();
    await expect(verifier.verify('XXXX.DUMMY.TOKEN.XXXX',local,'register')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({secret:TURNSTILE_TEST_SECRET,response:'XXXX.DUMMY.TOKEN.XXXX',remoteip:local.ip});
    fetch.mockResolvedValueOnce({ok:true,json:async()=>({success:false})}); await expect(verifier.verify('rejected',local,'login')).rejects.toMatchObject({statusCode:403});
    fetch.mockRejectedValueOnce(new Error('offline')); await expect(verifier.verify('unavailable',local,'login')).rejects.toMatchObject({statusCode:503});
  });
  it('never defaults production or a remote deployment to a dummy secret', async () => {
    vi.stubEnv('NODE_ENV','production'); vi.stubEnv('TURNSTILE_SECRET_KEY',''); const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(new TurnstileVerifier().verify('token',local,'login')).rejects.toMatchObject({statusCode:503});
    vi.stubEnv('TURNSTILE_SECRET_KEY',TURNSTILE_TEST_SECRET);
    await expect(new TurnstileVerifier().verify('token',local,'login')).rejects.toMatchObject({statusCode:503});
    vi.stubEnv('NODE_ENV','development');vi.stubEnv('TURNSTILE_SECRET_KEY','');
    await expect(new TurnstileVerifier().verify('token',{hostname:'wallet.example',ip:'203.0.113.1'},'login')).rejects.toMatchObject({statusCode:503}); expect(fetch).not.toHaveBeenCalled();
  });
  it('checks real hostname/action and prevents concurrent or sequential token replays', async () => {
    vi.stubEnv('NODE_ENV','production');vi.stubEnv('TURNSTILE_SECRET_KEY','real-secret');vi.stubEnv('TURNSTILE_ALLOWED_HOSTNAMES','wallet.example');
    const request={hostname:'wallet.example',ip:'203.0.113.1'};
    let finish!: (value: unknown)=>void;
    const fetch=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);
    const verifier=new TurnstileVerifier(), first=verifier.verify('one-use-token',request,'login');
    await expect(verifier.verify('one-use-token',request,'login')).rejects.toMatchObject({statusCode:403});
    finish({ok:true,json:async()=>({success:true,hostname:'wallet.example',action:'login'})}); await first;
    await expect(verifier.verify('one-use-token',request,'login')).rejects.toMatchObject({statusCode:403}); expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce({ok:true,json:async()=>({success:true,hostname:'attacker.example',action:'login'})});await expect(verifier.verify('wrong-origin',request,'login')).rejects.toMatchObject({statusCode:403});
    fetch.mockResolvedValueOnce({ok:true,json:async()=>({success:true,hostname:'wallet.example',action:'register'})});await expect(verifier.verify('wrong-action',request,'login')).rejects.toMatchObject({statusCode:403});
  });
});
