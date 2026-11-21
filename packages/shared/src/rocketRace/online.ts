import {
  COLLISION_COOLDOWN, isDifficulty, isGridSize, normalizeNickname, TICK_RATE, ticksToMs,
  type Difficulty, type GridSize, type RaceConfig, type RaceResult,
} from './model.js';
import { RACE_ID_PATTERN } from './leaderboard.js';
import type { Race, Rocket } from './physics.js';
import type { Track } from './track.js';

export const ONLINE_VERSION = 1;
export const ONLINE_WS_PATH = '/ws/arcade/rocket-race';
export const ONLINE_BOARD_PATH = '/api/arcade/rocket-race/online/leaderboard';
export const ROOM_CODE = /^[2-9A-HJ-NP-Z]{6}$/;
export const MAX_SEQUENCE = 0x7fffffff;
export const ONLINE_STEP_MS = 1000 / TICK_RATE;
export const SNAPSHOT_EVERY = 3;
export const INPUT_INTERVAL_MS = 1000 / 30;
export const INPUT_STALE_MS = 850;
export const RECONNECT_MS = 30_000;
export const ONLINE_FINISH_TICKS = TICK_RATE * 12;

export type Controls = [steer: number, throttle: number, boost: 0 | 1];
export type ClientPacket =
  | { t: 'hello'; v: number; name: string }
  | { t: 'hello'; v: number; token: string }
  | { t: 'quick'; difficulty: Difficulty; size: GridSize }
  | { t: 'create'; difficulty: Difficulty; size: GridSize; bots: boolean }
  | { t: 'join'; code: string }
  | { t: 'ready'; code: string; value: boolean }
  | { t: 'vote'; code: string; race: string; value: boolean }
  | { t: 'browse' | 'idle' | 'leave' }
  | { t: 'ping'; id: number }
  | { t: 'i'; race: string; seq: number; keys: Controls };

export interface LobbySummary {
  code: string;
  size: GridSize;
  difficulty: Difficulty;
  players: number;
}
export interface RoomMember {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  voted: boolean;
}
export interface GridPilot {
  seat: number;
  id: string | null;
  name: string;
}
export interface OnlineOutcome extends RaceResult {
  ranked: boolean;
  reason?: string;
}
export interface RoomView extends Omit<LobbySummary, 'players'> {
  private: boolean;
  bots: boolean;
  phase: 'lobby' | 'countdown' | 'racing' | 'results';
  members: RoomMember[];
  game?: {
    id: string;
    config: RaceConfig;
    grid: GridPilot[];
    startsInMs: number;
    outcome?: OnlineOutcome;
  };
}

/** Kinematics in tenths of world units, followed by exact gameplay counters. */
export type WireRocket = [
  x: number, z: number, vx: number, speed: number, charges: number, streak: number,
  dodges: number, hits: number, earned: number, hitAt: number, boostAt: number, boostUntil: number, retired: 0 | 1,
  finishMs: number,
];
export type OwnState = [ack: number, wave: number, flags: number];
export interface OnlineSnapshot {
  t: 's';
  race: string;
  tick: number;
  ships: WireRocket[];
  order: number[];
  own: OwnState;
}
export type ServerPacket =
  | { t: 'welcome'; id: string; name: string; token: string; graceMs: number }
  | { t: 'room'; room: RoomView | null }
  | { t: 'rooms'; rooms: LobbySummary[] }
  | { t: 'pong'; id: number }
  | { t: 'error'; code: string; message: string }
  | OnlineSnapshot;

export interface OnlineRanking {
  id: string;
  name: string;
  wins: number;
  losses: number;
  races: number;
  finishes: number;
  bestMs: number | null;
  averagePlace: number;
}
export interface OnlineScorecard {
  id: string;
  config: RaceConfig;
  at: number;
  pilots: GridPilot[];
  result: RaceResult;
}

export function parseClientPacket(raw: unknown): ClientPacket | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const n = Object.keys(data).length;
  switch (data.t) {
    case 'hello':
      if (n !== 3 || data.v !== ONLINE_VERSION) return null;
      if (typeof data.token === 'string' && /^[A-Za-z0-9_-]{1,352}\.[A-Za-z0-9_-]{43}$/.test(data.token)) {
        return { t: 'hello', v: ONLINE_VERSION, token: data.token };
      }
      const name = normalizeNickname(data.name);
      return name ? { t: 'hello', v: ONLINE_VERSION, name } : null;
    case 'quick':
      return n === 3 && isDifficulty(data.difficulty) && isGridSize(data.size)
        ? { t: 'quick', difficulty: data.difficulty, size: data.size } : null;
    case 'create':
      return n === 4 && isDifficulty(data.difficulty) && isGridSize(data.size) && typeof data.bots === 'boolean'
        ? { t: 'create', difficulty: data.difficulty, size: data.size, bots: data.bots } : null;
    case 'join':
      return n === 2 && typeof data.code === 'string' && ROOM_CODE.test(data.code) ? { t: 'join', code: data.code } : null;
    case 'ready':
      return n === 3 && typeof data.code === 'string' && ROOM_CODE.test(data.code) && typeof data.value === 'boolean'
        ? { t: 'ready', code: data.code, value: data.value } : null;
    case 'vote':
      return n === 4 && typeof data.code === 'string' && ROOM_CODE.test(data.code) && typeof data.value === 'boolean' &&
        typeof data.race === 'string' && RACE_ID_PATTERN.test(data.race)
        ? { t: 'vote', code: data.code, race: data.race, value: data.value } : null;
    case 'browse':
    case 'idle':
    case 'leave':
      return n === 1 ? { t: data.t } : null;
    case 'ping':
      return n === 2 && sequence(data.id, 0) ? { t: 'ping', id: data.id } : null;
    case 'i': {
      const keys = data.keys;
      if (n !== 4 || typeof data.race !== 'string' || !RACE_ID_PATTERN.test(data.race) || !sequence(data.seq, 1) ||
          !Array.isArray(keys) || keys.length !== 3 || !keys.slice(0, 2).every(k => Number.isInteger(k) && Math.abs(k) <= 100) ||
          (keys[2] !== 0 && keys[2] !== 1)) return null;
      return { t: 'i', race: data.race, seq: data.seq, keys: keys as Controls };
    }
    default:
      return null;
  }
}

function sequence(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_SEQUENCE;
}

export function encodeShips(race: Race): WireRocket[] {
  return race.rockets.map(ship => [
    Math.round(ship.x * 10), Math.round(ship.z * 10), Math.round(ship.vx * 10), Math.round(ship.speed * 10),
    ship.charges, ship.streak, ship.dodges, ship.collisions, ship.boostsEarned, ship.lastCollision,
    ship.lastBoost, ship.boostUntil, ship.retired ? 1 : 0,
    ship.finishTick === null ? 0 : ticksToMs(ship.finishTick),
  ]);
}

export function ownState(track: Track, ship: Rocket, ack: number): OwnState {
  let flags = 0;
  // The waves' swept influence regions are disjoint. Only the current wave's flags can matter.
  track.waves[ship.waveCursor]?.asteroids.forEach((rock, i) => { flags |= ship.obstacleFlags[rock.id] << (3 * i); });
  return [ack, ship.waveCursor, flags];
}

export function restoreOnlineRocket(track: Track, rocket: Rocket, ship: WireRocket, own?: OwnState) {
  rocket.x = rocket.previousX = ship[0] / 10;
  rocket.z = rocket.previousZ = ship[1] / 10;
  rocket.vx = ship[2] / 10;
  rocket.speed = ship[3] / 10;
  [rocket.charges, rocket.streak, rocket.dodges, rocket.collisions, rocket.boostsEarned,
    rocket.lastCollision, rocket.lastBoost, rocket.boostUntil] = ship.slice(4, 12);
  rocket.invulnerableUntil = rocket.lastCollision < 0 ? 0 : rocket.lastCollision + COLLISION_COOLDOWN;
  rocket.retired = ship[12] === 1;
  rocket.finishTick = ship[13] ? ship[13] / ONLINE_STEP_MS : null;
  if (own) {
    rocket.waveCursor = own[1];
    rocket.obstacleFlags.fill(0);
    track.waves[own[1]]?.asteroids.forEach((rock, i) => { rocket.obstacleFlags[rock.id] = (own[2] >> (3 * i)) & 7; });
  }
}
