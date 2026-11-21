import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRace, encodeShips, ONLINE_STEP_MS, ownState, stepGrid, type OnlineSnapshot, type Race, type RoomView,
} from '@cashingularity/shared/rocket-race';
import { OnlineConnection, PILOT_KEY, socketUrl, type OnlineView } from './connection.js';
import { OnlineMotion } from './motion.js';

const id = '20000000-0000-4000-8000-000000000001';
const config = { seed: 157, difficulty: 'normal', rockets: 2 } as const;
const neutral = { steer: 0, throttle: 0, boost: false };
const fast = { steer: 5, throttle: 100, boost: false };
function snapshot(race: Race, ack: number): OnlineSnapshot {
  return {
    t: 's', race: id, tick: race.tick, ships: encodeShips(race),
    order: race.order.map(ship => ship.id), own: ownState(race.track, race.rockets[0], ack),
  };
}

describe('online race client prediction and delivery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('uses WSS on HTTPS and rejects hidden credentials and insecure endpoints', () => {
    const location = { href: 'https://race.example/arcade/rocket-race/online', protocol: 'https:' };
    expect(socketUrl(undefined, location)).toBe('wss://race.example/ws/arcade/rocket-race');
    expect(socketUrl('https://games.example/ws/arcade/beta', location)).toBe('wss://games.example/ws/arcade/beta');
    for (const url of ['ws://games.example/race', 'wss://user:token@games.example/ws', 'wss://games.example/ws?secret=2', '#socket']) {
      expect(() => socketUrl(url, location)).toThrow('Invalid online racing endpoint.');
    }
  });

  it('buffers jitter, ignores old samples, and freezes remote rockets across missing updates', () => {
    const authoritative = createRace(config, undefined, 2);
    const motion = new OnlineMotion(config, 0);
    motion.accept(snapshot(authoritative, 0), 0);
    let prior!: OnlineSnapshot;
    for (let i = 1; i <= 9; i++) {
      stepGrid(authoritative, [neutral, fast]);
      if (i === 3) prior = snapshot(authoritative, 0);
    }
    // The tick-3 and tick-6 packets are lost. A stale tick-3 later arrives out of order.
    motion.accept(snapshot(authoritative, 0), 155);
    motion.accept(prior, 160);
    const early = motion.paint(165, 1).rockets[1].z;
    const later = motion.paint(230, 1).rockets[1].z;
    const stalled = motion.paint(1_100, 1).rockets[1].z;
    expect(motion.sample?.tick).toBe(9);
    expect(early).toBeLessThan(later);
    expect(stalled).toBeCloseTo(authoritative.rockets[1].z, 1);
    expect(motion.paint(1_500, 1).rockets[1].z).toBe(stalled);
  });

  it('limits prediction lead, reconciles an acknowledged boost once, and resets on long gaps', () => {
    const authoritative = createRace(config, undefined, 2);
    authoritative.rockets[0].charges = 2;
    const motion = new OnlineMotion(config, 0);
    motion.accept(snapshot(authoritative, 0), 0);
    motion.advance(fast.steer, fast.throttle, 1);
    for (let i = 0; i < 30; i++) motion.advance(fast.steer, fast.throttle, null);
    expect(motion.paint(33, 1).tick).toBe(12);
    expect(motion.paint(33, 1).rockets[0].boostUntil).toBeGreaterThan(100);
    for (let i = 0; i < 3; i++) stepGrid(authoritative, [{ ...fast, boost: i === 0 }, neutral]);
    motion.accept(snapshot(authoritative, 1), 70);
    expect(motion.paint(90, 1).rockets[0].boostUntil).toBe(authoritative.rockets[0].boostUntil);
    for (let i = 0; i < 40; i++) stepGrid(authoritative, [neutral, neutral]);
    motion.accept(snapshot(authoritative, 1), 1_100);
    const corrected = motion.paint(1_100, 1);
    expect(corrected.tick).toBe(authoritative.tick);
    expect(corrected.rockets[0].z).toBeCloseTo(authoritative.rockets[0].z, 1);
    expect(motion.sample?.ships[0][4]).toBe(1);
  });

  it('retires stale sockets and rebases outgoing sequences on reconnect', () => {
    vi.useFakeTimers();
    const browser = new EventTarget();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const data = new Map([[PILOT_KEY, 'test-token']]);
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      static CLOSING = 2;
      readyState = 0;
      bufferedAmount = 0;
      sent: Array<Record<string, unknown>> = [];
      constructor() { super(); sockets.push(this); }
      open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
      send(value: string) { this.sent.push(JSON.parse(value)); }
      message(value: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    }
    vi.stubGlobal('window', Object.assign(browser, { location: { href: 'http://local.test/arcade', protocol: 'http:' },
      setTimeout, setInterval, clearTimeout, clearInterval }));
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => data.get(key), setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key) });
    vi.stubGlobal('WebSocket', FakeSocket);
    let latest: OnlineView | undefined;
    const client = new OnlineConnection(view => { latest = view; });
    client.start();
    const room: RoomView = { code: 'ABC234', private: false, size: 2, difficulty: 'normal', bots: false,
      phase: 'racing', members: [], game: { id, config, startsInMs: 0, grid: [] } };
    function welcome(socket: FakeSocket) {
      socket.open();
      socket.message({ t: 'welcome', id, name: 'Pilot One', token: 'test-token', graceMs: 30_000 });
      socket.message({ t: 'room', room });
    }
    welcome(sockets[0]);
    const race = createRace(config, undefined, 2);
    sockets[0].message(snapshot(race, 12));
    expect(client.sendControls(100, 0, false, ONLINE_STEP_MS)).toBe(13);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sockets[0].sent.at(-1)).toEqual({ t: 'idle' });
    expect(sockets).toHaveLength(1);
    sockets[0].close();
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(1);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    welcome(sockets[1]);
    sockets[0].message({ t: 'room', room: null });
    expect(latest?.room?.game?.id).toBe(id);
    for (let i = 0; i < 4; i++) stepGrid(race, [neutral, neutral]);
    sockets[1].message(snapshot(race, 12));
    expect(client.sendControls(-100, 0, false, 1_000)).toBe(13);
    client.stop();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);
    expect(sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
});
