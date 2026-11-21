import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
class TurnstileError extends Error { constructor(message: string, public statusCode: number) { super(message); } }
const loopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
/** Each auth server instance keeps a replay guard in addition to Cloudflare's Siteverify check. */
export class TurnstileVerifier {
  private spent = new Map<string, number>();
  async verify(token: unknown, request: Pick<FastifyRequest, 'ip' | 'hostname'>, action: 'register' | 'login'): Promise<void> {
    const configured = process.env.TURNSTILE_SECRET_KEY?.trim();
    const testSecret = /^[123]x0+AA$/.test(configured ?? '');
    const local = process.env.NODE_ENV === 'test' || process.env.NODE_ENV !== 'production' && loopback(request.hostname) && loopback(request.ip);
    if ((!configured || testSecret) && !local) throw new TurnstileError('Bot protection is not configured for this deployment.', 503);
    const secret = configured || TURNSTILE_TEST_SECRET;
    const testing = /^[123]x0+AA$/.test(secret);
    if (typeof token !== 'string' || !token.trim() || token.length > 2048) throw new TurnstileError('Complete the bot verification before continuing.', 403);
    const digest = createHash('sha256').update(token).digest('hex'), now = Date.now();
    for (const [key, expires] of this.spent) if (expires <= now) this.spent.delete(key);
    if (!testing) {
      if (this.spent.has(digest)) throw new TurnstileError('Verification already used. Complete a new challenge.', 403);
      if (this.spent.size >= 10000) throw new TurnstileError('Bot verification is busy. Try again shortly.', 503);
      // Reserve before awaiting the provider so concurrent requests cannot reuse one token.
      this.spent.set(digest, now + 300000);
    }
    let result: { success?: boolean; hostname?: string; action?: string };
    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token, remoteip: request.ip }), signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Siteverify unavailable.');
      result = await response.json() as typeof result;
    } catch { throw new TurnstileError('Bot verification is unavailable. Please retry.', 503); }
    if (result?.success !== true) throw new TurnstileError('Bot verification failed or expired. Please retry.', 403);
    if (!testing) {
      const allowed = process.env.TURNSTILE_ALLOWED_HOSTNAMES?.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) ?? [request.hostname.toLowerCase()];
      if (typeof result.hostname !== 'string' || !allowed.includes(result.hostname.toLowerCase()) || result.action !== action) throw new TurnstileError('Bot verification does not match this application.', 403);
    }
  }
}
