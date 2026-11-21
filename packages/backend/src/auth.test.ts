import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { buildBackendServer, type BackendServerContext } from './index.js';
import { base32, totp } from './authService.js';
const directory = mkdtempSync(resolve('.cashingularity-auth-test-'));
let ctx: BackendServerContext;
let now = 1800000000000;
beforeAll(async () => {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') { const body = JSON.parse(String(init?.body)); return {ok:true,json:async()=>({success:body.response==='XXXX.DUMMY.TOKEN.XXXX',hostname:'example.com'})} as Response; }
    return originalFetch(input,init);
  });
  ctx = await buildBackendServer({ dataDir: directory }); vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await ctx.app.close(); if (dirname(directory) !== resolve('.') || !basename(directory).startsWith('.cashingularity-auth-test-')) throw new Error('Unsafe test cleanup path.'); rmSync(directory, { recursive: true, force: true }); });
describe('password and RFC 6238 account security', () => {
  it('matches RFC SHA-1 vectors including timestamps beyond 2038', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    for (const [seconds, code] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']] as const) expect(totp(secret, seconds * 1000, 8)).toBe(code);
    expect(totp(secret, 59000)).toBe('287082');
  });
  it('encrypts account records, requires password+TOTP, prevents replay and survives server restart', async () => {
    const credentials = { username: 'security-audit-user', password: 'Strong-audit-password-123', cfTurnstileToken:'XXXX.DUMMY.TOKEN.XXXX' };
    const register = await ctx.app.inject({ method: 'POST', url: '/api/auth/register', payload: credentials });
    expect((await ctx.app.inject({method:'GET',url:'/api/news'})).statusCode).toBe(404);
    expect((await ctx.app.inject({method:'POST',url:'/api/auth/register',payload:{username:'no-bot-proof',password:'sufficient-password'}})).statusCode).toBe(403);
    expect(register.statusCode).toBe(200); const enrolled = register.json(); expect(enrolled.unlockKey).toMatch(/^[a-f0-9]{64}$/);
    const cookie = String(register.headers['set-cookie']).split(';')[0];
    expect(register.headers['set-cookie']).toContain('HttpOnly'); expect(register.headers['cache-control']).toBe('no-store');
    const noSession = await ctx.app.inject({ method: 'POST', url: '/api/auth/totp/setup', payload: { password: credentials.password } }); expect(noSession.statusCode).toBe(401);
    const setup = await ctx.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: { cookie }, payload: { password: credentials.password } });
    expect(setup.statusCode).toBe(200); const { secret, otpauthUri } = setup.json(); expect(secret).toMatch(/^[A-Z2-7]{32}$/); expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Cashingularity/);
    const verify = await ctx.app.inject({ method: 'POST', url: '/api/auth/totp/verify', headers: { cookie }, payload: { code: totp(secret, now) } }); expect(verify.json().account.totpEnabled).toBe(true);
    for (const body of [{ ...credentials, password: 'Incorrect-password' }, credentials, { ...credentials, code: totp(secret, now) }]) {
      const rejected = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: body }); expect(rejected.statusCode).toBe(401); expect(rejected.json().unlockKey).toBeUndefined();
    }
    now += 30000;
    const results = await Promise.all([1,2].map(() => ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...credentials, code: totp(secret, now) } })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200,401]);
    expect(results.find(r => r.statusCode === 200)!.json().unlockKey).toBe(enrolled.unlockKey);
    const disk = readFileSync(resolve(directory, 'cashingularity.db.json'), 'utf8');
    for (const sensitive of [secret, credentials.password, credentials.username, enrolled.unlockKey]) expect(disk).not.toContain(sensitive);
    const exported = await ctx.app.inject({ method: 'GET', url: '/api/analytics/export' }); expect(exported.body).not.toContain('securityAccounts'); expect(exported.body).not.toContain(enrolled.account.id);
    await ctx.app.close(); ctx = await buildBackendServer({ dataDir: directory }); now += 30000;
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...credentials, code: totp(secret, now) } }); expect(login.statusCode).toBe(200); expect(login.json().unlockKey).toBe(enrolled.unlockKey);
    now += 30000;
    const begin = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{...credentials,begin:true} });
    expect(begin.statusCode).toBe(200); expect(begin.json().challengeToken).toMatch(/^[a-f0-9]{64}$/); expect(begin.json().unlockKey).toBeUndefined(); expect(begin.headers['set-cookie']).toBeUndefined();
    const challengeToken = begin.json().challengeToken;
    const wrong = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{cfTurnstileToken:'XXXX.DUMMY.TOKEN.XXXX',challengeToken,code:'wrong'} }); expect(wrong.statusCode).toBe(401);
    const finish = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{cfTurnstileToken:'XXXX.DUMMY.TOKEN.XXXX',challengeToken,code:totp(secret,now)} }); expect(finish.statusCode).toBe(200); expect(finish.json().unlockKey).toBe(enrolled.unlockKey);
    const replay = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{cfTurnstileToken:'XXXX.DUMMY.TOKEN.XXXX',challengeToken,code:totp(secret,now)} }); expect(replay.statusCode).toBe(401);
    const pending = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{...credentials,begin:true} }); now += 120001;
    const expired = await ctx.app.inject({ method:'POST', url:'/api/auth/login', payload:{cfTurnstileToken:'XXXX.DUMMY.TOKEN.XXXX',challengeToken:pending.json().challengeToken,code:totp(secret,now)} }); expect(expired.statusCode).toBe(401);

  }, 20000);
});
