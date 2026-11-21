import {
  isRaceEntry, LOCAL_HISTORY_LIMIT, normalizeNickname, readRaceEntries, type RaceEntry,
} from '@cashingularity/shared/rocket-race';
import type { DesktopKeys, TouchScheme } from './raceInput.js';

export const PREFS_KEY = 'cashingularity.rocketRace.preferences.v1';
export const SCORE_KEY = 'cashingularity.rocketRace.scores.v1';

export interface ArcadePreferences {
  nickname: string;
  keys: DesktopKeys;
  desktopSensitivity: number;
  touch: TouchScheme;
  touchSensitivity: number;
  touchSize: number;
  touchInset: number;
  leftHanded: boolean;
  lowQuality: boolean;
  reducedEffects: boolean;
  showMarket: boolean;
  sound: boolean;
  volume: number;
}

export const defaultPreferences: Readonly<ArcadePreferences> = {
  nickname: 'Pilot',
  keys: 'both',
  desktopSensitivity: 1,
  touch: 'joystick',
  touchSensitivity: 1,
  touchSize: 96,
  touchInset: 10,
  leftHanded: false,
  lowQuality: false,
  reducedEffects: false,
  showMarket: true,
  sound: false,
  volume: 45,
};

function readStorage(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readPreferences(): ArcadePreferences {
  const raw = readStorage(PREFS_KEY);
  const saved = raw && typeof raw === 'object' ? raw as Partial<ArcadePreferences> : {};
  const number = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    nickname: normalizeNickname(saved.nickname) ?? defaultPreferences.nickname,
    keys: saved.keys === 'wasd' || saved.keys === 'arrows' ? saved.keys : 'both',
    desktopSensitivity: number(saved.desktopSensitivity, 0.5, 1.5, 1),
    touch: saved.touch === 'drag' ? 'drag' : 'joystick',
    touchSensitivity: number(saved.touchSensitivity, 0.5, 1.5, 1),
    touchSize: number(saved.touchSize, 72, 132, 96),
    touchInset: number(saved.touchInset, 0, 32, 10),
    leftHanded: saved.leftHanded === true,
    lowQuality: saved.lowQuality === true,
    reducedEffects: saved.reducedEffects === true,
    showMarket: saved.showMarket !== false,
    sound: saved.sound === true,
    volume: number(saved.volume, 0, 100, 45),
  };
}

export function savePreferences(preferences: ArcadePreferences) {
  return writeStorage(PREFS_KEY, preferences);
}

export function readScores() {
  return readRaceEntries(readStorage(SCORE_KEY), LOCAL_HISTORY_LIMIT);
}

export function recordLocalScore(previous: RaceEntry[], entry: RaceEntry) {
  if (!isRaceEntry(entry) || previous.some(item => item.id === entry.id)) return previous;
  return [entry, ...previous.slice(0, LOCAL_HISTORY_LIMIT - 1)];
}

export function saveScores(scores: RaceEntry[]) {
  return writeStorage(SCORE_KEY, scores);
}
