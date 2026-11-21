import { describe, expect, it } from 'vitest';
import { createBotVerificationServer } from './botVerificationServer.js';

describe('isolated bot verification origin', () => {
  it('serves only the challenge, with explicit wallet parent origins and no wallet APIs', async () => {
    const app = createBotVerificationServer(['http://localhost:3000']);
    try {
      const response = await app.inject({url:'/verification-frame.html?parentOrigin=http%3A%2F%2Flocalhost%3A3000&nonce='+ 'ab'.repeat(16)});
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts allow-same-origin');
      expect(response.headers['content-security-policy']).toContain('frame-ancestors http://localhost:3000;');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await app.inject({url:'/verification-frame.html?parentOrigin=https%3A%2F%2Fevil.invalid&nonce='+ 'ab'.repeat(16)})).statusCode).toBe(403);
      for(const url of ['/wallet','/api/auth/login','/api/chain/utxos','/assets/index.js'])expect((await app.inject({url})).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('rejects malformed or missing parent-origin configuration', () => {
    expect(()=>createBotVerificationServer([])).toThrow();
    expect(()=>createBotVerificationServer(['http://localhost:3000/;script-src *'])).toThrow();
  });
});
