import { randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from '@fastify/websocket';
import {
  COUNTDOWN_TICKS, createRace, encodeShips, INPUT_STALE_MS, ONLINE_FINISH_TICKS, ONLINE_STEP_MS, ownState, parseClientPacket,
  SNAPSHOT_EVERY, stepGrid, type ClientPacket, type Difficulty, type GridPilot, type GridSize, type LobbySummary,
  type OnlineOutcome, type Race, type RaceInput, type RoomView, type ServerPacket,
} from '@cashingularity/shared/rocket-race';
import { OnlinePilotIdentity, type PilotIdentity } from './onlinePilotIdentity.js';
import { OnlineScoreboard } from './onlineScoreboard.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PING_MS = 8_000;
const HELLO_MS = 8_000;
const LOBBY_IDLE = 5 * 60_000;
const RESULTS_IDLE = 2 * 60_000;
const START_IN_MS = Math.round(COUNTDOWN_TICKS * ONLINE_STEP_MS);
const MAX_CATCH_UP = 8;
const MAX_COMMAND_GAP = 240;
const BOT_NAMES = ['Vela', 'Ion', 'Kestrel'];

interface Peer {
  socket: WebSocket;
  ip: string;
  opened: number;
  pongAt: number;
  budget: number;
  budgetAt: number;
  actions: number;
  actionAt: number;
  faults: number;
  pilot?: Pilot;
}
interface Pilot extends PilotIdentity {
  peer?: Peer;
  room?: Room;
  disconnectedAt?: number;
  ready: boolean;
  voted: boolean;
}
interface Seat {
  lastInput: number;
  received: number;
  ack: number;
  keys: RaceInput;
}
interface Run {
  id: string;
  startsAt: number;
  race: Race;
  grid: GridPilot[];
  seats: Seat[];
  inputs: RaceInput[];
  slotById: Map<string, number>;
  outcome?: OnlineOutcome;
}
interface Room {
  code: string;
  private: boolean;
  size: GridSize;
  difficulty: Difficulty;
  bots: boolean;
  phase: RoomView['phase'];
  members: Map<string, Pilot>;
  updated: number;
  run?: Run;
}
export interface RoomOptions {
  now: () => number;
  seed: () => number;
  graceMs: number;
  maxPeers: number;
  maxPeersPerIp: number;
  maxRooms: number;
}

export class OnlineRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new Map<WebSocket, Peer>();
  private readonly pilots = new Map<string, Pilot>();
  private readonly counts = new Map<string, number>();
  private readonly admissions = new Map<string, { since: number; count: number }>();
  private maintainAt = 0;
  private pingAt = 0;
  private closed = false;

  constructor(private readonly identity: OnlinePilotIdentity, private readonly board: OnlineScoreboard,
    private readonly options: RoomOptions) {}

  accept(socket: WebSocket, ip: string) {
    socket.on('error', () => socket.terminate());
    const count = this.counts.get(ip) ?? 0;
    if (this.closed || this.peers.size >= this.options.maxPeers || count >= this.options.maxPeersPerIp) {
      socket.close(1013, 'Online racing connection limit reached.');
      return;
    }
    const now = this.options.now();
    const peer: Peer = { socket, ip, opened: now, pongAt: now, budget: 52, budgetAt: now, actions: 10, actionAt: now, faults: 0 };
    this.peers.set(socket, peer);
    this.counts.set(ip, count + 1);
    socket.on('pong', () => { peer.pongAt = this.options.now(); });
    socket.once('close', () => this.disconnect(peer));
    socket.on('message', (raw: unknown, binary: boolean) => {
      if (this.closed || socket.readyState !== 1) return;
      const now = this.options.now();
      peer.budget = Math.min(52, peer.budget + (now - peer.budgetAt) * 0.060);
      peer.budgetAt = now;
      if (--peer.budget < 0) { this.end(peer, 1008, 'rate', 'Too many messages.'); return; }
      if (binary || !Buffer.isBuffer(raw) || raw.length > 1_024) {
        this.end(peer, 1009, 'payload', 'Online racing messages are limited to 1 KiB.');
        return;
      }
      let packet: ClientPacket | null;
      try { packet = parseClientPacket(JSON.parse(raw.toString())); } catch { packet = null; }
      if (!packet || (!peer.pilot && packet.t !== 'hello')) {
        if (++peer.faults >= 3) this.end(peer, 1008, 'packet', 'Invalid online racing message.');
        else this.error(peer, 'packet', 'Invalid online racing message.');
        return;
      }
      this.receive(peer, packet, now);
    });
  }

  advance() {
    if (this.closed) return;
    const now = this.options.now();
    if (now >= this.maintainAt) {
      this.maintainAt = now + 500;
      this.maintain(now);
    }
    for (const room of this.rooms.values()) {
      const run = room.run;
      if (!run || (room.phase !== 'countdown' && room.phase !== 'racing')) continue;
      if (room.phase === 'countdown' && now >= run.startsAt) {
        room.phase = 'racing';
        this.sendRoom(room);
      }
      if (room.phase !== 'racing') continue;
      const target = Math.floor((now - run.startsAt) / ONLINE_STEP_MS + 1e-7);
      const steps = Math.min(MAX_CATCH_UP, target - run.race.tick);
      if (steps <= 0) continue;
      for (const seat of run.seats) {
        if (now - seat.lastInput > INPUT_STALE_MS) this.neutral(seat);
      }
      let due = false;
      for (let i = 0; i < steps; i++) {
        stepGrid(run.race, run.inputs, ONLINE_FINISH_TICKS);
        for (const seat of run.seats) {
          seat.ack = seat.received;
          seat.keys.boost = false;
        }
        if (run.race.tick % SNAPSHOT_EVERY === 0) due = true;
        if (run.race.result) {
          this.publishSnapshot(room, run);
          this.finish(room, run, now);
          break;
        }
      }
      if (due && !run.outcome) this.publishSnapshot(room, run);
    }
  }

  metrics() {
    return { connections: this.peers.size, rooms: this.rooms.size, pilots: this.pilots.size };
  }

  close() {
    this.closed = true;
    for (const peer of this.peers.values()) peer.socket.terminate();
    this.rooms.clear();
    this.peers.clear();
    this.pilots.clear();
    this.counts.clear();
    this.admissions.clear();
  }

  private send(peer: Peer | undefined, packet: ServerPacket) {
    if (peer) this.wire(peer, JSON.stringify(packet));
  }

  private wire(peer: Peer, packet: string, snapshot = false) {
    if (peer.socket.readyState !== 1) return;
    if (peer.socket.bufferedAmount > 65_536) { peer.socket.terminate(); return; }
    if (!snapshot || peer.socket.bufferedAmount < 8_192) peer.socket.send(packet);
  }

  private error(peer: Peer, code: string, message: string) {
    this.send(peer, { t: 'error', code, message });
  }

  private end(peer: Peer, close: number, code: string, message: string) {
    this.error(peer, code, message);
    peer.socket.close(close, message);
  }

  private receive(peer: Peer, packet: ClientPacket, now: number) {
    if (packet.t === 'hello') { this.hello(peer, packet); return; }
    const pilot = peer.pilot!;
    const room = pilot.room;
    if (packet.t === 'ping') { this.send(peer, { t: 'pong', id: packet.id }); return; }
    if (packet.t === 'i') { this.controls(pilot, packet, now); return; }
    if (packet.t === 'idle') { this.resetSeat(pilot); return; }
    peer.actions = Math.min(10, peer.actions + (now - peer.actionAt) * 0.004);
    peer.actionAt = now;
    if (--peer.actions < 0) { this.error(peer, 'rate', 'Please wait before changing rooms again.'); return; }
    switch (packet.t) {
      case 'browse': this.send(peer, { t: 'rooms', rooms: this.publicRooms() }); return;
      case 'leave':
        this.remove(pilot);
        this.send(peer, { t: 'room', room: null });
        this.publishBrowser();
        return;
      case 'ready':
        if (room?.phase !== 'lobby' || packet.code !== room.code) return;
        pilot.ready = packet.value;
        room.updated = now;
        this.maybeStart(room, now);
        this.sendRoom(room);
        this.publishBrowser();
        return;
      case 'vote':
        if (room?.phase !== 'results' || packet.code !== room.code || packet.race !== room.run?.id) return;
        pilot.voted = packet.value;
        room.updated = now;
        this.maybeRematch(room, now);
        this.sendRoom(room);
        this.publishBrowser();
        return;
      case 'join':
      case 'quick':
      case 'create':
        if (room) { this.error(peer, 'in_room', 'Leave your current room first.'); return; }
        if (!this.admit(peer.ip, now)) { this.error(peer, 'rate', 'Too many room requests. Try again in a minute.'); return; }
        this.join(pilot, packet, now);
    }
  }

  private hello(peer: Peer, packet: Extract<ClientPacket, { t: 'hello' }>) {
    if (peer.pilot) { this.error(peer, 'session', 'This connection already has a pilot.'); return; }
    const created = 'name' in packet ? this.identity.create(packet.name) : undefined;
    const token = 'token' in packet ? packet.token : created!.token;
    const identity = created ?? this.identity.read(token);
    if (!identity) { this.end(peer, 4001, 'expired', 'Pilot session expired. Choose a nickname to reconnect.'); return; }
    const existing = this.pilots.get(identity.id);
    if (existing?.peer) { this.end(peer, 4009, 'duplicate', 'This pilot is connected in another tab.'); return; }
    if (existing?.room && existing.disconnectedAt !== undefined &&
        this.options.now() - existing.disconnectedAt >= this.options.graceMs) this.remove(existing);
    const pilot = existing ?? { id: identity.id, name: identity.name, ready: false, voted: false };
    pilot.peer = peer;
    pilot.disconnectedAt = undefined;
    peer.pilot = pilot;
    this.pilots.set(pilot.id, pilot);
    this.send(peer, { t: 'welcome', id: pilot.id, name: pilot.name, token, graceMs: this.options.graceMs });
    if (pilot.room) {
      this.sendRoom(pilot.room);
      const run = pilot.room.run;
      if (run && !run.outcome) this.publishSnapshot(pilot.room, run, pilot);
    } else {
      this.sendRoom(undefined, peer);
      this.send(peer, { t: 'rooms', rooms: this.publicRooms() });
    }
  }

  private admit(ip: string, now: number) {
    let bucket = this.admissions.get(ip);
    if (!bucket || now - bucket.since >= 60_000) {
      if (!bucket && this.admissions.size >= this.options.maxPeers * 4) return false;
      bucket = { since: now, count: 0 };
      this.admissions.set(ip, bucket);
    }
    return ++bucket.count <= 36;
  }

  private join(pilot: Pilot, packet: Extract<ClientPacket, { t: 'join' | 'quick' | 'create' }>, now: number) {
    let room = packet.t === 'join' ? this.rooms.get(packet.code) : packet.t === 'quick' ?
      [...this.rooms.values()].find(room => !room.private && room.phase === 'lobby' &&
        room.difficulty === packet.difficulty && room.size === packet.size && room.members.size < room.size) : undefined;
    if (!room && packet.t !== 'join') {
      if (this.rooms.size >= this.options.maxRooms) { this.error(pilot.peer!, 'capacity', 'All room slots are occupied.'); return; }
      let code: string;
      do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (this.rooms.has(code));
      room = { code, phase: 'lobby', private: packet.t === 'create', bots: packet.t === 'create' && packet.bots,
        size: packet.size, difficulty: packet.difficulty, members: new Map(), updated: now };
      this.rooms.set(code, room);
    }
    if (!room || room.phase !== 'lobby' || room.members.size >= room.size) {
      this.error(pilot.peer!, 'room_unavailable', 'That room is full, racing, or closed.');
      return;
    }
    pilot.room = room;
    pilot.ready = false;
    pilot.voted = false;
    room.members.set(pilot.id, pilot);
    room.updated = now;
    this.sendRoom(room);
    this.publishBrowser();
  }

  private maybeStart(room: Room, now: number) {
    const humans = [...room.members.values()];
    if (humans.length < (room.bots ? 2 : room.size) || humans.some(pilot => !pilot.peer || !pilot.ready)) return;
    const config = { seed: this.options.seed(), difficulty: room.difficulty, rockets: room.size };
    const grid: GridPilot[] = Array.from({ length: room.size }, (_, seat) => humans[seat]
      ? { seat, id: humans[seat].id, name: humans[seat].name }
      : { seat, id: null, name: `${BOT_NAMES[seat - humans.length]} (AI)` });
    const seats = humans.map(() => ({ lastInput: -Infinity, received: 0, ack: 0, keys: { steer: 0, throttle: 0, boost: false } }));
    room.run = {
      id: randomUUID(), startsAt: now + START_IN_MS, race: createRace(config, undefined, humans.length), grid,
      seats, inputs: seats.map(seat => seat.keys),
      slotById: new Map(humans.map((pilot, seat) => [pilot.id, seat])),
    };
    room.phase = 'countdown';
  }

  private maybeRematch(room: Room, now: number) {
    if (![...room.members.values()].every(pilot => pilot.peer && pilot.voted)) return;
    room.phase = 'lobby';
    room.run = undefined;
    for (const pilot of room.members.values()) { pilot.ready = true; pilot.voted = false; }
    this.maybeStart(room, now);
  }

  private controls(pilot: Pilot, packet: Extract<ClientPacket, { t: 'i' }>, now: number) {
    const run = pilot.room?.run;
    if (!run || run.id !== packet.race || pilot.room?.phase !== 'racing') return;
    const slot = run.slotById.get(pilot.id);
    if (slot === undefined) return;
    const seat = run.seats[slot];
    if (packet.seq <= seat.received || packet.seq > seat.received + MAX_COMMAND_GAP) return;
    seat.received = packet.seq;
    seat.lastInput = now;
    seat.keys.steer = packet.keys[0];
    seat.keys.throttle = packet.keys[1];
    seat.keys.boost ||= packet.keys[2] === 1;
  }

  private neutral(seat: Seat) {
    seat.keys.steer = 0;
    seat.keys.throttle = 0;
    seat.keys.boost = false;
  }

  private resetSeat(pilot: Pilot) {
    const run = pilot.room?.run;
    const slot = run?.slotById.get(pilot.id);
    if (run && slot !== undefined) {
      const seat = run.seats[slot];
      this.neutral(seat);
      seat.ack = seat.received;
      seat.lastInput = -Infinity;
    }
  }

  private finish(room: Room, run: Run, now: number) {
    const result = run.race.result!;
    let ranked = false;
    let reason = room.private ? 'Private room race' : 'At least two active human pilots and a finish are required for rankings.';
    if (!room.private && result.winnerId !== null && run.race.rockets.filter(rocket => !rocket.retired).length >= 2) {
      try {
        ranked = this.board.record({ id: run.id, config: run.race.config, at: Date.now(), pilots: run.grid, result });
      } catch {
        reason = 'Shared score storage is temporarily unavailable.';
      }
    }
    run.outcome = { ...result, ranked, ...(!ranked && { reason }) };
    room.phase = 'results';
    room.updated = now;
    this.sendRoom(room);
  }

  private sendRoom(room?: Room, peer?: Peer) {
    const packet: ServerPacket = { t: 'room', room: room ? {
      code: room.code, size: room.size, difficulty: room.difficulty, private: room.private, bots: room.bots, phase: room.phase,
      members: [...room.members.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, voted: p.voted, connected: !!p.peer })),
      game: room.run && {
        id: room.run.id, config: room.run.race.config, grid: room.run.grid,
        startsInMs: Math.max(0, room.run.startsAt - this.options.now()), outcome: room.run.outcome,
      },
    } : null };
    if (peer) this.send(peer, packet);
    else if (room) {
      const wire = JSON.stringify(packet);
      for (const pilot of room.members.values()) if (pilot.peer) this.wire(pilot.peer, wire);
    }
  }

  private publishSnapshot(room: Room, run: Run, only?: Pilot) {
    const data = JSON.stringify({ t: 's', race: run.id, tick: run.race.tick, ships: encodeShips(run.race),
      order: run.race.order.map(ship => ship.id) }).slice(0, -1);
    for (const pilot of only ? [only] : room.members.values()) {
      const slot = run.slotById.get(pilot.id);
      if (!pilot.peer || slot === undefined) continue;
      const own = ownState(run.race.track, run.race.rockets[slot], run.seats[slot].ack);
      this.wire(pilot.peer, `${data},"own":${JSON.stringify(own)}}`, true);
    }
  }

  private publicRooms(): LobbySummary[] {
    return [...this.rooms.values()].filter(r => !r.private && r.phase === 'lobby' && r.members.size < r.size)
      .slice(0, 24).map(r => ({ code: r.code, size: r.size, difficulty: r.difficulty, players: r.members.size }));
  }

  private publishBrowser() {
    const packet = JSON.stringify({ t: 'rooms', rooms: this.publicRooms() });
    for (const peer of this.peers.values()) if (peer.pilot && !peer.pilot.room) this.wire(peer, packet);
  }

  private disconnect(peer: Peer) {
    if (!this.peers.delete(peer.socket)) return;
    const remaining = this.counts.get(peer.ip)! - 1;
    if (remaining) this.counts.set(peer.ip, remaining);
    else this.counts.delete(peer.ip);
    const pilot = peer.pilot;
    if (!pilot || pilot.peer !== peer) return;
    pilot.peer = undefined;
    if (!pilot.room) { this.pilots.delete(pilot.id); return; }
    pilot.disconnectedAt = this.options.now();
    pilot.ready = false;
    pilot.voted = false;
    this.resetSeat(pilot);
    this.sendRoom(pilot.room);
  }

  private remove(pilot: Pilot) {
    const room = pilot.room;
    if (!room) return;
    this.resetSeat(pilot);
    const slot = room.run?.slotById.get(pilot.id);
    if (room.run && !room.run.outcome && slot !== undefined && room.run.race.rockets[slot].finishTick === null) {
      room.run.race.rockets[slot].retired = true;
    }
    room.members.delete(pilot.id);
    pilot.room = undefined;
    pilot.ready = false;
    pilot.voted = false;
    if (!pilot.peer) this.pilots.delete(pilot.id);
    if (!room.members.size) this.rooms.delete(room.code);
    else {
      const now = this.options.now();
      if (room.phase === 'results') this.maybeRematch(room, now);
      else if (room.phase === 'lobby') this.maybeStart(room, now);
      this.sendRoom(room);
    }
  }

  private maintain(now: number) {
    const ping = now >= this.pingAt;
    if (ping) this.pingAt = now + PING_MS;
    for (const peer of this.peers.values()) {
      if ((!peer.pilot && now - peer.opened > HELLO_MS) || now - peer.pongAt > 2 * PING_MS) peer.socket.terminate();
      else if (ping && peer.socket.readyState === 1) peer.socket.ping();
    }
    for (const [ip, bucket] of this.admissions) if (now - bucket.since >= 60_000) this.admissions.delete(ip);
    let changed = false;
    for (const pilot of this.pilots.values()) {
      if (!pilot.peer && pilot.disconnectedAt !== undefined && now - pilot.disconnectedAt >= this.options.graceMs) {
        this.remove(pilot);
        changed = true;
      }
    }
    for (const room of this.rooms.values()) {
      if ((room.phase === 'lobby' && now - room.updated > LOBBY_IDLE) ||
          (room.phase === 'results' && now - room.updated > RESULTS_IDLE)) {
        this.rooms.delete(room.code);
        for (const pilot of room.members.values()) {
          pilot.room = undefined;
          if (pilot.peer) {
            this.send(pilot.peer, { t: 'room', room: null });
            this.error(pilot.peer, 'idle_room', 'The room closed after inactivity.');
          } else this.pilots.delete(pilot.id);
        }
        changed = true;
      }
    }
    if (changed) this.publishBrowser();
  }
}
