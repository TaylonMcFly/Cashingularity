import websocket, { type WebSocket } from '@fastify/websocket';
import {
  createRace, encodeShips, ONLINE_BOARD_PATH, ONLINE_FINISH_TICKS, ONLINE_STEP_MS, ONLINE_VERSION, ONLINE_WS_PATH, stepGrid,
  type ClientPacket, type GridSize, type OnlineSnapshot, type RoomView, type ServerPacket,
} from '@cashingularity/shared/rocket-race';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerOnlineRacing } from './rocketRaceOnline.js';

const Socket = createRequire(import.meta.url)('ws') as new (url: string, options: { origin: string }) => WebSocket;
type Welcome = Extract<ServerPacket, { t: 'welcome' }>;
type Wire = Awaited<ReturnType<typeof connect>>;

async function connect(origin: string, source = origin) {
  const socket = new Socket(origin.replace('http:', 'ws:') + ONLINE_WS_PATH, { origin: source });
  const packets: Partial<Record<ServerPacket['t'], ServerPacket>> = {};
  socket.on('message', (buffer: Buffer) => {
    const packet = JSON.parse(buffer.toString()) as ServerPacket;
    packets[packet.t] = packet;
  });
  const closed = new Promise<number>(resolve => socket.once('close', resolve));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let ping = 0;
  const send = (packet: object) => socket.send(JSON.stringify(packet));
  async function flush() {
    const id = ++ping;
    send({ t: 'ping', id });
    await until(() => packets.pong?.t === 'pong' && packets.pong.id === id);
  }
  const last = <T extends ServerPacket['t']>(type: T) => packets[type] as Extract<ServerPacket, { t: T }> | undefined;
  return { socket, last, send, flush, closed };
}

async function until(condition: () => unknown) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > 1_500) throw new Error('Timed out waiting for an online racing event.');
    await setImmediate();
  }
}

describe('authoritative online Rocket Race through independent WebSockets', () => {
  let app: ReturnType<typeof Fastify>;
  let directory: string;
  let origin: string;
  let now: number;
  let live: ReturnType<typeof registerOnlineRacing>;

  async function boot() {
    app = Fastify();
    await app.register(websocket, { options: { maxPayload: 32_768 } });
    live = registerOnlineRacing(app, directory, {
      now: () => now, seed: () => 157, graceMs: 30_000, maxRooms: 8, maxPeersPerIp: 20, manual: true,
    });
    origin = await app.listen({ port: 0, host: '127.0.0.1' });
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'rocket-online-test-'));
    now = 1_000;
    await boot();
  });
  afterEach(async () => {
    await app.close();
    for (const name of ['arcade-online.key', 'arcade-online-results.json', 'arcade-online-results.json.tmp']) {
      rmSync(join(directory, name), { force: true });
    }
    rmdirSync(directory);
  });

  async function pilot(credentials: { name: string } | { token: string }) {
    const wire = await connect(origin);
    wire.send({ t: 'hello', v: ONLINE_VERSION, ...credentials });
    await until(() => wire.last('welcome'));
    return { ...wire, auth: wire.last('welcome') as Welcome };
  }

  async function findRoom(wires: Wire[], size: GridSize, bots = false) {
    const leader = wires[0];
    leader.send(bots ? { t: 'create', bots, size, difficulty: 'normal' } : { t: 'quick', size, difficulty: 'normal' });
    await until(() => leader.last('room')?.room);
    const code = leader.last('room')!.room!.code;
    for (const wire of wires.slice(1)) {
      if (bots) expect(wire.last('rooms')?.rooms.some(room => room.code === code)).toBe(false);
      wire.send(bots ? { t: 'join', code } : { t: 'quick', size, difficulty: 'normal' });
      await until(() => wire.last('room')?.room?.code === code);
    }
    for (const wire of wires) await until(() => wire.last('room')?.room?.members.length === wires.length);
    return code;
  }

  async function start(wires: Wire[], code: string) {
    for (const wire of wires) { wire.send({ t: 'ready', code, value: true }); await wire.flush(); }
    for (const wire of wires) await until(() => wire.last('room')?.room?.phase === 'countdown');
    const game = wires[0].last('room')!.room!.game!;
    expect(game.startsInMs).toBe(3_000);
    for (const wire of wires) {
      expect(wire.last('room')!.room!.game).toEqual(game);
      expect(wire.last('s')).toBeUndefined();
    }
    now += 3_000;
    live!.advance();
    for (const wire of wires) await until(() => wire.last('room')?.room?.phase === 'racing');
    return game;
  }

  async function tick(amount: number, wires: Wire[]) {
    for (let ticks = amount; ticks > 0; ticks -= 3) {
      now += Math.min(3, ticks) * ONLINE_STEP_MS;
      live!.advance();
      await setImmediate();
    }
    await Promise.all(wires.map(wire => wire.flush()));
  }

  it.each([2, 3, 4] as const)('starts all %i humans together, applies controls and official results exactly once', async size => {
    const wires = await Promise.all(Array.from({ length: size }, (_, index) => pilot({ name: `Pilot ${index + 1}` })));
    const code = await findRoom(wires, size);
    const game = await start(wires, code);
    expect(game.grid.map(row => row.id)).toEqual(wires.map(w => w.auth.id));
    const reference = createRace(game.config, undefined, size);
    const controls = wires.map((_, i) => ({ steer: 0, throttle: 100 - i * 10, boost: false }));
    let seq = 0;
    let sawBoost = false;
    let sawCollision = false;
    while (!reference.result) {
      seq++;
      await Promise.all(wires.map(async (wire, i) => {
        const input = controls[i];
        wire.send({ t: 'i', race: game.id, seq, keys: [input.steer, input.throttle, 1] } satisfies ClientPacket);
        await wire.flush();
      }));
      for (let j = 0; j < 24 && !reference.result; j++) {
        const delta = controls.map(control => ({ ...control, boost: j === 0 }));
        stepGrid(reference, delta, ONLINE_FINISH_TICKS);
      }
      await tick(24, wires);
      const samples = wires.map(wire => wire.last('s') as OnlineSnapshot);
      const expected = encodeShips(reference);
      for (const [i, sample] of samples.entries()) {
        expect(sample.tick).toBe(reference.tick);
        expect(sample.ships).toEqual(expected);
        expect(sample.order).toEqual(reference.order.map(rocket => rocket.id));
        expect(sample.own[0]).toBe(seq);
      }
      sawBoost ||= expected.some(ship => ship[10] > 0);
      sawCollision ||= expected.some(ship => ship[7] > 0);
    }
    expect(sawBoost).toBe(true);
    expect(sawCollision).toBe(true);
    const result = { ...reference.result, ranked: true };
    expect(result.standings[0].finishMs).toBeGreaterThan(0);
    expect(result.standings[1].finishMs).toBeGreaterThanOrEqual(result.standings[0].finishMs!);
    for (const wire of wires) expect(wire.last('room')?.room?.game?.outcome).toEqual(result);
    const ranked = await app.inject(`${ONLINE_BOARD_PATH}?size=${size}&difficulty=normal`);
    expect(ranked.json()).toMatchObject({ count: 1, recent: [{ id: game.id, result: reference.result }] });
    expect(ranked.json().rankings).toHaveLength(size);
    expect(ranked.json().rankings.reduce((sum: number, pilot: { wins: number }) => sum + pilot.wins, 0)).toBe(1);
    expect((await app.inject({ method: 'POST', url: ONLINE_BOARD_PATH, payload: { winner: wires[0].auth.id, finishMs: 100 } })).statusCode).toBe(404);

    for (const wire of wires) { wire.send({ t: 'vote', code, race: game.id, value: true }); await wire.flush(); }
    for (const wire of wires) await until(() => wire.last('room')?.room?.phase === 'countdown');
    expect(wires[0].last('room')?.room?.code).toBe(code);
    expect(wires[0].last('room')?.room?.game?.id).not.toBe(game.id);
    expect((await app.inject(ONLINE_BOARD_PATH)).json().count).toBe(1);

    if (size === 2) {
      await app.close();
      expect(live!.metrics()).toEqual({ connections: 0, pilots: 0, rooms: 0 });
      await boot();
      const restored = await pilot({ token: wires[0].auth.token });
      expect(restored.auth.id).toBe(wires[0].auth.id);
      await until(() => restored.last('room'));
      expect(restored.last('room')?.room).toBeNull();
      expect((await app.inject(ONLINE_BOARD_PATH)).json().count).toBe(1);
    }
  }, 12_000);

  it('uses private codes, reserves human slots, fills remaining slots only after both humans ready', async () => {
    const first = await pilot({ name: 'Private One' });
    const second = await pilot({ name: 'Private Two' });
    second.send({ t: 'join', code: 'ZZ2222' });
    await until(() => second.last('error')?.code === 'room_unavailable');
    const code = await findRoom([first, second], 4, true);
    first.send({ t: 'ready', code, value: true });
    first.send({ t: 'ready', code, value: false });
    second.send({ t: 'ready', code, value: true });
    await second.flush();
    await first.flush();
    expect(first.last('room')?.room?.phase).toBe('lobby');
    expect(first.last('room')?.room?.members[0].ready).toBe(false);
    first.send({ t: 'ready', code, value: true });
    await until(() => first.last('room')?.room?.phase === 'countdown');
    const room = first.last('room')?.room as RoomView;
    expect(room.private).toBe(true);
    expect(room.game?.grid.slice(2).map(seat => seat.id)).toEqual([null, null]);
    await tick(186, [first, second]);
    expect(first.last('s')?.ships.every(ship => ship[1] > 0)).toBe(true);
    expect((await app.inject(ONLINE_BOARD_PATH)).json().count).toBe(0);
  });

  it('rejects duplicate and altered sessions, resumes a seat without rewinding, and retires expired seats', async () => {
    const a = await pilot({ name: 'Reconnect One' });
    const b = await pilot({ name: 'Reconnect Two' });
    const code = await findRoom([a, b], 2);
    const game = await start([a, b], code);
    const duplicate = await connect(origin);
    duplicate.send({ t: 'hello', v: ONLINE_VERSION, token: a.auth.token });
    expect(await duplicate.closed).toBe(4009);
    const forged = await connect(origin);
    forged.send({ t: 'hello', v: ONLINE_VERSION, token: (a.auth.token[0] === 'a' ? 'b' : 'a') + a.auth.token.slice(1) });
    expect(await forged.closed).toBe(4001);
    expect(live!.metrics().rooms).toBe(1);

    a.send({ t: 'i', seq: 1, race: game.id, keys: [100, 100, 0] });
    await a.flush();
    await tick(12, [a, b]);
    const before = a.last('s')!;
    expect(before.own[0]).toBe(1);
    a.socket.close();
    await a.closed;
    await until(() => !b.last('room')!.room!.members[0].connected);
    await tick(180, [b]);
    const coasting = b.last('s')!;
    const returned = await pilot({ token: a.auth.token });
    await until(() => returned.last('s'));
    const resumed = returned.last('s')!;
    expect(resumed.race).toBe(game.id);
    expect(resumed.tick).toBe(coasting.tick);
    expect(returned.last('room')?.room?.members).toHaveLength(2);
    expect(resumed.ships[0][1]).toBeGreaterThan(before.ships[0][1]);
    expect(resumed.ships[0][3]).toBe(4_350);
    expect(resumed.own[0]).toBe(1);

    // Replay, a wrong round, an out-of-window sequence, and a legal next input.
    returned.send({ t: 'i', seq: 1, race: game.id, keys: [100, 100, 0] });
    returned.send({ t: 'i', seq: 2, race: '00000000-0000-4000-8000-000000000000', keys: [100, 100, 0] });
    returned.send({ t: 'i', seq: 5_000, race: game.id, keys: [100, 100, 0] });
    await returned.flush();
    await tick(3, [returned, b]);
    expect(returned.last('s')?.own[0]).toBe(1);
    returned.send({ t: 'i', seq: 2, race: game.id, keys: [-100, 0, 0] });
    await returned.flush();
    await tick(3, [returned, b]);
    expect(returned.last('s')?.own[0]).toBe(2);
    expect(returned.last('s')!.ships[0][2]).toBeLessThan(0);

    returned.socket.close();
    await returned.closed;
    await until(() => !b.last('room')!.room!.members[0].connected);
    for (let i = 0; i < 7; i++) { now += 5_000; live!.advance(); await b.flush(); }
    const expired = await pilot({ token: a.auth.token });
    await until(() => expired.last('room'));
    expect(expired.last('room')!.room).toBeNull();
    await tick(6, [b]);
    expect(b.last('s')?.ships[0][12]).toBe(1);
    b.send({ t: 'leave' });
    await until(() => b.last('room')?.room === null);
    expect(live!.metrics().rooms).toBe(0);
  });

  it('validates origin, payload size, nicknames and impossible controls, and throttles bursts', async () => {
    await expect(connect(origin, 'https://unrelated.example')).rejects.toThrow(/403/);
    const bad = await connect(origin);
    bad.send({ t: 'hello', v: ONLINE_VERSION, name: '<script>' });
    bad.send({ t: 'hello', v: 99, name: 'Old Pilot' });
    bad.send({ t: 'hello', v: ONLINE_VERSION, name: 'bad\u200bname' });
    expect(await bad.closed).toBe(1008);
    const large = await connect(origin);
    large.send({ huge: 'x'.repeat(1_045) });
    expect(await large.closed).toBe(1009);
    const human = await pilot({ name: 'Inputs Only' });
    for (const invalid of [
      { t: 'i', race: human.auth.id, seq: 1, keys: [101, 0, 0] },
      { t: 'i', race: human.auth.id, seq: 1, keys: [0, -100, 2] },
      { t: 'i', race: human.auth.id, seq: 1, keys: [0, 0, 0], x: 10_000, score: 1_000 },
    ]) human.send(invalid);
    expect(await human.closed).toBe(1008);
    const flood = await pilot({ name: 'Flood Limit' });
    for (let i = 0; i < 60; i++) flood.send({ t: 'ping', id: i });
    expect(await flood.closed).toBe(1008);
  });

  it('cleans up concurrent abandoned and inactive rooms', async () => {
    const wires = await Promise.all(Array.from({ length: 6 }, (_, index) => pilot({ name: `Cleanup ${index}` })));
    for (const wire of wires) wire.send({ t: 'create', bots: false, difficulty: 'easy', size: 2 });
    await Promise.all(wires.map(wire => until(() => wire.last('room')?.room)));
    expect(live!.metrics()).toEqual({ connections: 6, rooms: 6, pilots: 6 });
    wires[0].send({ t: 'leave' });
    await until(() => wires[0].last('room')?.room === null);
    expect(live!.metrics().rooms).toBe(5);
    for (const wire of wires) wire.socket.close();
    await Promise.all(wires.map(wire => wire.closed));
    await until(() => live!.metrics().connections === 0);
    now += 30_001;
    live!.advance();
    expect(live!.metrics()).toEqual({ connections: 0, rooms: 0, pilots: 0 });
  });
});
