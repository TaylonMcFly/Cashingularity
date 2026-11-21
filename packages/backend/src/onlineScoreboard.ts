import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isDifficulty, isGridSize, isSeed, normalizeNickname, RACE_ID_PATTERN, MAX_RACE_TICKS, ticksToMs,
  type Difficulty, type GridSize, type OnlineRanking, type OnlineScorecard,
} from '@cashingularity/shared/rocket-race';

const CAPACITY = 2_000;

function validRecord(value: unknown): value is OnlineScorecard {
  if (!value || typeof value !== 'object') return false;
  const card = value as OnlineScorecard;
  const { config, pilots, result } = card;
  if (typeof card.id !== 'string' || !RACE_ID_PATTERN.test(card.id) || !Number.isSafeInteger(card.at) ||
      !config || !isDifficulty(config.difficulty) || !isGridSize(config.rockets) || !isSeed(config.seed) ||
      !Array.isArray(pilots) || pilots.length !== config.rockets || !Array.isArray(result?.standings) ||
      result.standings.length !== pilots.length || !Number.isInteger(result.ticks) || result.ticks < 1 || result.ticks > MAX_RACE_TICKS) return false;
  const ids = new Set();
  for (const [index, pilot] of pilots.entries()) {
    if (!pilot || pilot.seat !== index || typeof pilot.id !== 'string' || !RACE_ID_PATTERN.test(pilot.id) ||
        ids.has(pilot.id) || typeof pilot.name !== 'string' || normalizeNickname(pilot.name) !== pilot.name) return false;
    ids.add(pilot.id);
  }
  const seats = new Set();
  for (const [index, row] of result.standings.entries()) {
    if (!row || row.place !== index + 1 || !Number.isInteger(row.id) || !pilots[row.id] || seats.has(row.id) ||
        (row.finishMs !== null && (!Number.isInteger(row.finishMs) || row.finishMs < 1 || row.finishMs > ticksToMs(result.ticks)))) return false;
    seats.add(row.id);
  }
  return result.winnerId === result.standings[0].id && result.standings[0].finishMs !== null;
}

export class OnlineScoreboard {
  private readonly file: string;
  private history: OnlineScorecard[] = [];
  private readonly cache = new Map<string, ReturnType<OnlineScoreboard['compute']>>();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'arcade-online-results.json');
    if (!existsSync(this.file)) return;
    const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid Arcade online scoreboard.');
    const ids = new Set<string>();
    this.history = saved.slice(0, CAPACITY).filter((value): value is OnlineScorecard => {
      if (!validRecord(value) || ids.has(value.id)) return false;
      ids.add(value.id);
      return true;
    });
  }

  record(card: OnlineScorecard) {
    if (!validRecord(card) || this.history.some(previous => previous.id === card.id)) return false;
    const next = [card, ...this.history.slice(0, CAPACITY - 1)];
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    this.history = next;
    this.cache.clear();
    return true;
  }

  view(difficulty?: Difficulty, size?: GridSize) {
    const key = `${difficulty ?? ''}:${size ?? ''}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const view = this.compute(difficulty, size);
    this.cache.set(key, view);
    return view;
  }

  private compute(difficulty?: Difficulty, size?: GridSize) {
    const games = this.history.filter(card => (!difficulty || card.config.difficulty === difficulty) && (!size || card.config.rockets === size));
    const pilots = new Map<string, OnlineRanking>();
    for (const card of games) {
      for (const place of card.result.standings) {
        const { id, name } = card.pilots[place.id];
        if (!id) continue;
        const row = pilots.get(id) ?? { id, name, wins: 0, losses: 0, races: 0, finishes: 0, bestMs: null, averagePlace: 0 };
        pilots.set(id, row);
        row.races++;
        row.averagePlace += place.place;
        if (card.result.winnerId === place.id) row.wins++;
        else row.losses++;
        if (place.finishMs !== null) {
          row.finishes++;
          row.bestMs = Math.min(row.bestMs ?? Infinity, place.finishMs);
        }
      }
    }
    const rankings = [...pilots.values()];
    for (const row of rankings) row.averagePlace /= row.races;
    rankings.sort((a, b) => b.wins - a.wins || a.averagePlace - b.averagePlace ||
      (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { rankings: rankings.slice(0, 100), recent: games.slice(0, 10), count: games.length, capacity: CAPACITY };
  }
}
