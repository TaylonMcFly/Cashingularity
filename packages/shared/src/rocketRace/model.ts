export const RACE_VERSION = 1;
export const TICK_RATE = 60;
export const STEP_SECONDS = 1 / TICK_RATE;
export const COUNTDOWN_TICKS = 3 * TICK_RATE;
export const MAX_RACE_TICKS = 95 * TICK_RATE;
export const TRACK_WIDTH = 640;
export const TRACK_LENGTH = 21_120;
export const ROCKET_RADIUS = 17;
export const STEER_SPEED = 330;
export const STEER_ACCEL = 1_760;
export const START_SPEED = 295;
export const CRUISE_SPEED = 435;
export const TOP_SPEED = 625;
export const BOOST_SPEED = 205;
export const BOOST_TICKS = 132;
export const COLLISION_COOLDOWN = 54;
export const DODGES_PER_BOOST = 5;
export const DODGE_MARGIN = 78;

export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type Difficulty = typeof DIFFICULTIES[number];
export type GridSize = 2 | 3 | 4;
export interface RaceConfig {
  seed: number;
  difficulty: Difficulty;
  rockets: GridSize;
}
export interface RaceInput {
  /** Signed integer percentages from -100 to 100. */
  steer: number;
  throttle: number;
  boost: boolean;
}
export const NEUTRAL_INPUT: Readonly<RaceInput> = { steer: 0, throttle: 0, boost: false };

export interface RaceStanding {
  id: number;
  place: number;
  finishMs: number | null;
  remaining: number;
  dodges: number;
  collisions: number;
  boostsEarned: number;
  points: number;
}
export interface RaceResult {
  ticks: number;
  winnerId: number | null;
  standings: RaceStanding[];
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function ticksToMs(ticks: number) {
  return Math.round(ticks * 1_000 / TICK_RATE);
}

export function computeRacePoints(dodges: number, collisions: number, boostsEarned: number, won: boolean) {
  return Math.max(0, dodges * 100 + boostsEarned * 40 + (won ? 400 : 0) - collisions * 30);
}

export function isDifficulty(value: unknown): value is Difficulty {
  return DIFFICULTIES.some(difficulty => difficulty === value);
}

export function isGridSize(value: unknown): value is GridSize {
  return value === 2 || value === 3 || value === 4;
}

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  const length = [...name].length;
  return length >= 2 && length <= 20 && /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name) ? name : null;
}

export function seededRandom(seed: number) {
  // Mulberry32 gives seed zero the same treatment as every other course seed.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return ((word ^ (word >>> 14)) >>> 0) / 4294967296;
  };
}
