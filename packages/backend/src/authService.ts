import { TurnstileVerifier } from './turnstileService.js';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CashingularityWalStore } from './db.js';

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let value = 0, bits = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decode32(secret: string): Buffer {
  let value = 0, bits = 0; const result: number[] = [];
  for (const char of secret.replace(/=+$/, '').toUpperCase()) { const n = alphabet.indexOf(char); if (n < 0) throw new Error('Invalid Base32 secret.'); value = (value << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; result.push((value >>> bits) & 255); } }
  return Buffer.from(result);
}
/** RFC 6238 / HOTP dynamic truncation, SHA-1, 30-second steps. */
export function totp(secret: string, nowMs = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
  const digest = createHmac('sha1', decode32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
interface Account { id: string; username: string; salt: string; hash: string; unlockKey: string; secret?: string; pending?: { secret: string; expiresAt: number }; lastStep: number }
export interface EncryptedAccount { id: string; lookup: string; iv: string; ciphertext: string; tag: string }
class AuthError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export function registerAuthRoutes(app: FastifyInstance, store: CashingularityWalStore, dataDir: string): void {
  const turnstile = new TurnstileVerifier();
  const keyPath = join(dataDir, 'account-security.key');
  if (!existsSync(keyPath)) { try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (!existsSync(keyPath)) throw error; } }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Invalid account-security encryption key.');
  const sessions = new Map<string, { accountId: string; expiresAt: number; authenticatedAt: number }>();
  const challenges = new Map<string, { accountId: string; ip: string; expiresAt: number; attempts: number }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const lookup = (name: string) => createHmac('sha256', key).update(name).digest('hex');
  const open = (record: EncryptedAccount): Account => {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'hex'));
    cipher.setAAD(Buffer.from(record.id)); cipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.ciphertext, 'hex')), cipher.final()]).toString('utf8'));
  };
  const save = (account: Account) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(account.id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()]);
    store.saveSecurityAccount({ id: account.id, lookup: lookup(account.username), iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
  };
  const publicAccount = (a: Account) => ({ id: a.id, username: a.username, totpEnabled: !!a.secret });
  const username = (raw: unknown) => { if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9_.@+-]{2,127}$/i.test(raw.trim())) throw new AuthError('Use an account name with 3–128 letters, digits or . _ @ + -.'); return raw.trim().toLowerCase(); };
  const password = (raw: unknown) => { if (typeof raw !== 'string' || raw.length < 8 || raw.length > 1024) throw new AuthError('Password must contain 8–1024 characters.'); return raw; };
  const passwordHash = async (raw: string, salt: string) => (await derive(raw, salt)).toString('hex');
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const limit = (req: FastifyRequest, name: string) => {
    const k = `${req.ip}:${name}`, now = Date.now();
    const ipKey = `${req.ip}:*`, previousIp = attempts.get(ipKey);
    const ip = previousIp && previousIp.until > now ? previousIp : { count: 0, until: now + 300000 };
    if (++ip.count > 60) throw new AuthError('Too many authentication attempts. Try again later.', 429);
    attempts.set(ipKey, ip);
    if (attempts.size > 2000) for (const [key, a] of attempts) if (a.until < now) attempts.delete(key);
    if (attempts.size > 4000 && !attempts.has(k)) throw new AuthError('Too many authentication requests.', 429);
    const current = attempts.get(k); const a = current && current.until > now ? current : { count: 0, until: now + 300000 };
    if (++a.count > 30) throw new AuthError('Too many authentication attempts. Try again in five minutes.', 429);
    attempts.set(k, a);
  };
  const checkCode = (account: Account, code: unknown, secret = account.secret): number => {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !secret) throw new AuthError('A valid 6-digit authenticator code is required.', 401);
    const step = Math.floor(Date.now() / 30000);
    for (const delta of [-1, 0, 1]) if (equal(totp(secret, (step + delta) * 30000), code)) {
      if (step + delta <= account.lastStep) throw new AuthError('Code already used. Wait for your authenticator’s next code.', 401);
      return step + delta;
    }
    throw new AuthError('Invalid authenticator code.', 401);
  };
  const issueSession = (account: Account, request: FastifyRequest, reply: FastifyReply) => {
    const token = randomBytes(32).toString('hex'), now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt < now) sessions.delete(key);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    sessions.set(createHash('sha256').update(token).digest('hex'), { accountId: account.id, expiresAt: now + 900000, authenticatedAt: now });
    reply.header('Set-Cookie', `cashingularity_session=${token}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=900${request.protocol === 'https' ? '; Secure' : ''}`);
    return { account: publicAccount(account), unlockKey: account.unlockKey };
  };
  const sessionAccount = (request: FastifyRequest): Account => {
    const token = request.headers.cookie?.match(/(?:^|;\s*)cashingularity_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const session = token ? sessions.get(createHash('sha256').update(token).digest('hex')) : undefined;
    if (!session || session.expiresAt <= Date.now()) throw new AuthError('Sign in again to manage account security.', 401);
    const encrypted = store.findSecurityAccountById(session.accountId);
    if (!encrypted) throw new AuthError('Account not found.', 401);
    return open(encrypted);
  };
  app.addHook('onSend', async (req, reply, body) => { if (req.url.startsWith('/api/auth/')) reply.header('Cache-Control', 'no-store'); return body; });
  const bodySchema = (required: string[]) => ({ body: { type: 'object', required, properties: { cfTurnstileToken: { type: 'string', maxLength: 2048 }, username: { type: 'string', minLength: 3, maxLength: 128 }, password: { type: 'string', minLength: 8, maxLength: 1024 }, code: { type: 'string', maxLength: 6 }, purpose: { type: 'string', enum: ['unlock', 'reveal', 'sign'] } } } });
  app.post('/api/auth/register', { schema: bodySchema(['username', 'password']) }, async (request, reply) => {
    const body = request.body as Record<string, unknown>, name = username(body.username); limit(request, name);
    await turnstile.verify(body.cfTurnstileToken, request, 'register');
    const pass = password(body.password);
    if (store.findSecurityAccount(lookup(name))) throw new AuthError('An account with this name already exists.', 409);
    const salt = randomBytes(16).toString('hex'), hash = await passwordHash(pass, salt);
    if (store.findSecurityAccount(lookup(name))) throw new AuthError('An account with this name already exists.', 409);
    const account: Account = { id: randomUUID(), username: name, salt, hash, unlockKey: randomBytes(32).toString('hex'), lastStep: -1 }; save(account);
    return issueSession(account, request, reply);
  });
  app.post('/api/auth/login', { schema: { body: { ...bodySchema([]).body, anyOf: [{ required: ['username', 'password'] }, { required: ['challengeToken', 'code'] }], properties: { ...bodySchema([]).body.properties, begin: { type: 'boolean' }, challengeToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } } }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (typeof body.challengeToken === 'string') {
      const key = createHash('sha256').update(body.challengeToken).digest('hex'), challenge = challenges.get(key);
      if (!challenge || challenge.expiresAt <= Date.now() || challenge.ip !== request.ip) { challenges.delete(key); throw new AuthError('Verification expired. Enter your password again.', 401); }
      const record = store.findSecurityAccountById(challenge.accountId);
      if (!record) throw new AuthError('Account not found.', 401);
      const account = open(record); limit(request, account.username);
      await turnstile.verify(body.cfTurnstileToken, request, 'login');
      // Provider verification is asynchronous: re-check the single-use challenge and latest counter.
      if (challenges.get(key) !== challenge || challenge.expiresAt <= Date.now()) throw new AuthError('Verification expired. Enter your password again.', 401);
      const latest = open(store.findSecurityAccountById(account.id)!);
      if (++challenge.attempts > 5) { challenges.delete(key); throw new AuthError('Too many codes. Enter your password again.', 401); }
      latest.lastStep = checkCode(latest, body.code); save(latest); challenges.delete(key);
      return issueSession(latest, request, reply);
    }
    const name = username(body.username); limit(request, name);
    await turnstile.verify(body.cfTurnstileToken, request, 'login');
    const pass = password(body.password), encrypted = store.findSecurityAccount(lookup(name));
    const account = encrypted ? open(encrypted) : undefined;
    const hash = await passwordHash(pass, account?.salt ?? 'unknown-account-timing-salt');
    if (!account || !equal(hash, account.hash)) throw new AuthError('Invalid account name or password.', 401);
    // Reload after asynchronous password hashing so concurrent requests cannot replay one code.
    const current = open(store.findSecurityAccountById(account.id)!);
    if (current.secret && body.begin === true) {
      for (const [key, value] of challenges) if (value.expiresAt <= Date.now()) challenges.delete(key);
      if (challenges.size >= 1000) challenges.delete(challenges.keys().next().value!);
      const challengeToken = randomBytes(32).toString('hex');
      challenges.set(createHash('sha256').update(challengeToken).digest('hex'), { accountId: current.id, ip: request.ip, expiresAt: Date.now() + 120000, attempts: 0 });
      return { account: publicAccount(current), challengeToken };
    }
    if (current.secret) { current.lastStep = checkCode(current, body.code); save(current); }
    return issueSession(current, request, reply);
  });
  app.post('/api/auth/totp/setup', { schema: bodySchema(['password']) }, async (request) => {
    const account = sessionAccount(request), body = request.body as Record<string, unknown>; limit(request, account.username);
    if (!equal(await passwordHash(password(body.password), account.salt), account.hash)) throw new AuthError('Incorrect password.', 401);
    const current = open(store.findSecurityAccountById(account.id)!);
    if (current.secret) throw new AuthError('Authenticator is already enabled.', 409);
    const secret = base32(randomBytes(20)); current.pending = { secret, expiresAt: Date.now() + 600000 }; save(current);
    return { secret, otpauthUri: `otpauth://totp/${encodeURIComponent(`Cashingularity:${account.username}`)}?secret=${secret}&issuer=Cashingularity&algorithm=SHA1&digits=6&period=30` };
  });
  app.post('/api/auth/totp/verify', { schema: bodySchema(['code']) }, async (request) => {
    const account = sessionAccount(request), body = request.body as Record<string, unknown>; limit(request, account.username);
    if (!account.pending || account.pending.expiresAt <= Date.now()) throw new AuthError('Start authenticator setup again.');
    account.lastStep = checkCode(account, body.code, account.pending.secret); account.secret = account.pending.secret; delete account.pending; save(account);
    return { account: publicAccount(account) };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.headers.cookie?.match(/cashingularity_session=([a-f0-9]{64})/)?.[1];
    if (token) sessions.delete(createHash('sha256').update(token).digest('hex'));
    reply.header('Set-Cookie', 'cashingularity_session=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0'); return { ok: true };
  });
}
