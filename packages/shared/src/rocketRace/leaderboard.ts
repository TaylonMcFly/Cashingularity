import {
  BOOST_SPEED, COLLISION_COOLDOWN, computeRacePoints, DODGES_PER_BOOST, isDifficulty, isGridSize, isSeed, MAX_RACE_TICKS,
  normalizeNickname, RACE_VERSION, ticksToMs, TOP_SPEED, TRACK_LENGTH, type Difficulty, type GridSize, type RaceConfig, type RaceResult,
} from './model.js';

export const LOCAL_HISTORY_LIMIT = 500;
export const SHARED_HISTORY_LIMIT = 2_000;
export const RACE_ID_PATTERN = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export const RANK_SORTS = ['points', 'time', 'wins', 'dodges'] as const;
export type RankSort = typeof RANK_SORTS[number];

export interface RaceEntry extends RaceConfig {
  version: number;
  id: string;
  nickname: string;
  recordedAt: number;
  elapsedMs: number;
  place: number;
  finishMs: number | null;
  dodges: number;
  collisions: number;
  boostsEarned: number;
  points: number;
}
export interface RaceFilters {
  difficulty?: Difficulty;
  rockets?: GridSize;
  sort: RankSort;
}
export interface RankRow {
  nickname: string;
  bestMs: number | null;
  points: number;
  wins: number;
  dodges: number;
  races: number;
}

export function makeRaceEntry(id: string, nickname: string, config: RaceConfig, result: RaceResult, recordedAt: number): RaceEntry {
  const pilot = result.standings.find(standing => standing.id === 0)!;
  return {
    ...config, version: RACE_VERSION, id, nickname, recordedAt, elapsedMs: ticksToMs(result.ticks),
    place: pilot.place, finishMs: pilot.finishMs, dodges: pilot.dodges, collisions: pilot.collisions,
    boostsEarned: pilot.boostsEarned, points: pilot.points,
  };
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isRaceEntry(value: unknown): value is RaceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RaceEntry>;
  return entry.version === RACE_VERSION && typeof entry.id === 'string' && RACE_ID_PATTERN.test(entry.id) &&
    typeof entry.nickname === 'string' && normalizeNickname(entry.nickname) === entry.nickname &&
    isSeed(entry.seed) && isDifficulty(entry.difficulty) && isGridSize(entry.rockets) &&
    integerIn(entry.recordedAt, 0, 8_640_000_000_000_000) &&
    integerIn(entry.elapsedMs, Math.floor(TRACK_LENGTH / (TOP_SPEED + BOOST_SPEED) * 1000), ticksToMs(MAX_RACE_TICKS)) &&
    integerIn(entry.place, 1, entry.rockets) &&
    (entry.finishMs === null || integerIn(entry.finishMs, entry.elapsedMs - 17, entry.elapsedMs)) &&
    integerIn(entry.dodges, 0, 200) && integerIn(entry.collisions, 0, Math.ceil(entry.elapsedMs / ticksToMs(COLLISION_COOLDOWN))) &&
    integerIn(entry.boostsEarned, 0, Math.floor(entry.dodges / DODGES_PER_BOOST)) &&
    entry.points === computeRacePoints(entry.dodges, entry.collisions, entry.boostsEarned, entry.place === 1 && entry.finishMs !== null);
}

export function readRaceEntries(raw: unknown, limit: number) {
  const entries: RaceEntry[] = [];
  const ids = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw.slice(0, limit)) {
      if (isRaceEntry(entry) && !ids.has(entry.id)) {
        ids.add(entry.id);
        entries.push(entry);
      }
    }
  }
  return entries;
}

export function buildLeaderboard(entries: ReadonlyArray<RaceEntry>, filters: RaceFilters) {
  const players = new Map<string, RankRow>();
  const recent: RaceEntry[] = [];
  let count = 0;
  for (const race of entries) {
    if ((filters.difficulty && race.difficulty !== filters.difficulty) || (filters.rockets && race.rockets !== filters.rockets)) continue;
    count++;
    if (recent.length < 12) recent.push(race);
    const key = race.nickname.toLowerCase();
    let row = players.get(key);
    if (!row) {
      row = { nickname: race.nickname, bestMs: null, points: 0, wins: 0, dodges: 0, races: 0 };
      players.set(key, row);
    }
    row.races++;
    row.points += race.points;
    row.dodges += race.dodges;
    if (race.finishMs !== null) {
      if (race.place === 1) row.wins++;
      row.bestMs = Math.min(row.bestMs ?? Infinity, race.finishMs);
    }
  }
  const rankings = [...players.values()].sort((a, b) => {
    const byTime = (a.bestMs ?? 100_000) - (b.bestMs ?? 100_000);
    const primary = filters.sort === 'time' ? byTime : b[filters.sort] - a[filters.sort];
    return primary || b.points - a.points || byTime || a.nickname.localeCompare(b.nickname);
  });
  return { rankings: rankings.slice(0, 100), recent, count };
}
