import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAppSessions } from './connectedApps.js';
afterEach(() => vi.unstubAllGlobals());
describe('verified browser application sessions', () => {
  it('starts empty, rejects spoofed handshakes, and grants only address access until disconnected', () => {
    let receive: (event: MessageEvent) => void = () => {};
    const host = { location: { origin: 'http://localhost:3000' }, addEventListener: (_: string, handler: typeof receive) => { receive = handler; }, setInterval: vi.fn(() => 1), clearInterval: vi.fn(), removeEventListener: vi.fn() } as unknown as Window;
    const sessions = new BrowserAppSessions(host); sessions.setScope('mainnet:wallet');
    expect(sessions.list('mainnet:wallet')).toEqual([]);
    expect(() => sessions.begin('wc:unverified-uri', 'mainnet:wallet', 'address')).toThrow();
    const id = sessions.begin('https://dapp.example', 'mainnet:wallet', 'bitcoincash:z-address');
    expect(sessions.list('mainnet:wallet')).toEqual([]);
    const source = { postMessage: vi.fn() } as unknown as Window;
    sessions.attachFrame(id, source);
    const challenge = sessions.frames()[0].challenge;
    const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null } as unknown as MessagePort;
    const event = { data: { type: 'CASHINGULARITY_CONNECT', version: 1, requestId: id, challenge }, origin: 'https://attacker.example', source, ports: [port] } as unknown as MessageEvent;
    receive(event); expect(() => sessions.approve(id)).toThrow();
    receive({ ...event, origin: 'https://dapp.example' } as MessageEvent);
    sessions.approve(id); expect(sessions.list('mainnet:wallet')[0].permissions).toEqual(['Read the approved BCH address']);
    port.onmessage?.({ data: { id: 1, method: 'bch_signTransaction' } } as MessageEvent);
    expect(port.postMessage).toHaveBeenLastCalledWith({ id: 1, error: { code: 4200, message: 'Only approved address access is supported. Signing is not authorized.' } });
    sessions.disconnect(id); expect(sessions.list('mainnet:wallet')).toEqual([]); expect(port.close).toHaveBeenCalled(); sessions.dispose();
  });
});
