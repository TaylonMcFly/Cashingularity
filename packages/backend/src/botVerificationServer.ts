import Fastify from 'fastify';
import { readFileSync } from 'node:fs';

/** A separate origin with no wallet pages, credentials, cookies, storage or APIs. */
export function createBotVerificationServer(walletOrigins: string[]) {
  const origins = walletOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('Invalid verification parent origin.');
    return url.origin;
  });
  if (!origins.length) throw new Error('Configure TURNSTILE_WALLET_ORIGINS.');
  const app = Fastify();
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', `sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; img-src data: https://challenges.cloudflare.com; frame-ancestors ${origins.join(' ')}; base-uri 'none'; object-src 'none'`);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  for (const [name, type] of [['verification-frame.html','text/html'],['verification-frame.js','application/javascript'],['verification-frame.css','text/css']]) {
    const body = readFileSync(new URL(`../public/bot-verification/${name}`, import.meta.url));
    app.get(`/${name}`, async (request, reply) => {
      if (name.endsWith('.html')) {
        const query = request.query as Record<string, string>;
        if (!origins.includes(query.parentOrigin) || !/^[a-f0-9]{32}$/.test(query.nonce ?? '')) return reply.code(403).send('Invalid verification parent.');
      }
      return reply.type(`${type}; charset=utf-8`).send(body);
    });
  }
  return app;
}
