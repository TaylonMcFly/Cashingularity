import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeNickname, RACE_ID_PATTERN } from '@cashingularity/shared/rocket-race';

const LIFETIME = 90 * 24 * 60 * 60_000;
export interface PilotIdentity {
  id: string;
  name: string;
}

export class OnlinePilotIdentity {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'arcade-online.key');
    try {
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.key = readFileSync(file);
    if (this.key.length !== 32) throw new Error('Invalid Arcade multiplayer identity key.');
  }

  create(name: string) {
    const id = randomUUID();
    const payload = Buffer.from(JSON.stringify([id, name, Date.now() + LIFETIME])).toString('base64url');
    return { id, name, token: `${payload}.${this.sign(payload).toString('base64url')}` };
  }

  read(token: string): PilotIdentity | null {
    try {
      const [payload, signature] = token.split('.');
      const mac = Buffer.from(signature, 'base64url');
      if (mac.length !== 32 || !timingSafeEqual(mac, this.sign(payload))) return null;
      const [id, name, expires] = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return typeof id === 'string' && RACE_ID_PATTERN.test(id) && normalizeNickname(name) === name &&
        Number.isSafeInteger(expires) && expires > Date.now() ? { id, name } : null;
    } catch {
      return null;
    }
  }

  private sign(payload: string) {
    return createHmac('sha256', this.key).update(payload).digest();
  }
}
