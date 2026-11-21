import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COUNTDOWN_TICKS, createRace, makeRaceEntry, NEUTRAL_INPUT, recordInput, replayRace, stepRace,
  type InputRun, type RaceConfig,
} from '@cashingularity/shared/rocket-race';
import { parseArcadePath, parseWorkspacePath } from '../services/workspaceRoutes.js';
import { RaceControls } from './raceInput.js';
import { FixedFrameClock, RaceSession } from './raceSession.js';
import { defaultPreferences, PREFS_KEY, readPreferences, readScores, recordLocalScore, savePreferences, saveScores, SCORE_KEY } from './raceStorage.js';

const config: RaceConfig = { seed: 4332, difficulty: 'normal', rockets: 3 };
afterEach(() => vi.unstubAllGlobals());

describe('Rocket Race session', () => {
  it('pauses and resumes at the same countdown or race tick, then creates a clean restart from the same seed', () => {
    const session = new RaceSession(config);
    for (let i = 0; i < 50; i++) session.step(() => NEUTRAL_INPUT);
    expect(session.pause()).toBe(true);
    for (let i = 0; i < 200; i++) session.step(() => NEUTRAL_INPUT);
    expect(session.countdown).toBe(COUNTDOWN_TICKS - 50);
    expect(session.resume()).toBe(true);
    for (let i = 0; i < COUNTDOWN_TICKS - 50; i++) session.step(() => NEUTRAL_INPUT);
    expect(session.phase).toBe('racing');
    expect(session.race.tick).toBe(0);
    session.step(() => ({ steer: 70, throttle: 100, boost: false }));
    expect(session.pause()).toBe(true);
    session.step(() => NEUTRAL_INPUT);
    expect(session.race.tick).toBe(1);
    expect(session.replay).toEqual([[1, 70, 100, 0]]);
    session.resume();
    session.step(() => NEUTRAL_INPUT);
    expect(session.race.tick).toBe(2);
    const restart = new RaceSession(config);
    expect(restart.race.track).toEqual(session.race.track);
    expect(restart.replay).toHaveLength(0);
    expect(restart.phase).toBe('countdown');
  });

  it('steps the same race at 30, 60, and 144 FPS and discards accumulated wake-up time', () => {
    const frames = [30, 60, 144].map(rate => {
      const clock = new FixedFrameClock();
      const race = createRace(config);
      for (let frame = 0; frame <= 4 * rate; frame++) {
        clock.advance(frame * 1_000 / rate, () => stepRace(race, NEUTRAL_INPUT));
      }
      expect(race.tick).toBe(240);
      return race.rockets.map(rocket => [rocket.x, rocket.z]);
    });
    expect(frames[0]).toEqual(frames[1]);
    expect(frames[2]).toEqual(frames[1]);
    const clock = new FixedFrameClock();
    const step = vi.fn();
    clock.advance(0, step);
    clock.advance(100_000, step);
    expect(step).toHaveBeenCalledTimes(5);
    clock.reset();
    clock.advance(200_000, step);
    expect(step).toHaveBeenCalledTimes(5);
  });

  it('records controls once and ends on exactly the same step as authoritative replay', () => {
    const session = new RaceSession(config);
    while (!session.race.result) {
      session.step(() => ({ steer: 50, throttle: 100, boost: session.race.tick % 30 === 1 }));
    }
    expect(session.phase).toBe('finished');
    const count = session.replay.length;
    session.step(() => NEUTRAL_INPUT);
    expect(session.replay).toHaveLength(count);
    expect(replayRace(config, session.replay)).toEqual(session.race.result);
  });
});

describe('Rocket Race controls', () => {
  it('gathers simultaneous keyboard inputs, consumes boost on a new press, and clears released keys', () => {
    const input = new RaceControls('both', 1, 1);
    expect(input.keyDown('KeyD')).toBe(true);
    input.keyDown('ArrowUp');
    input.keyDown('Space');
    expect(input.read()).toEqual({ steer: 80, throttle: 100, boost: true });
    input.keyDown('Space', true);
    expect(input.read()).toEqual({ steer: 80, throttle: 100, boost: false });
    input.keyUp('KeyD');
    expect(input.read()).toEqual({ steer: 0, throttle: 100, boost: false });
    input.clear();
    expect(input.read()).toEqual(NEUTRAL_INPUT);
  });

  it('combines analog steering with a separate boost touch and ignores stale or unrelated pointers', () => {
    const control = new RaceControls('wasd', 0.5, 1.25);
    expect(control.keyDown('ArrowLeft')).toBe(false);
    control.keyDown('KeyD');
    expect(control.read().steer).toBe(40);
    control.keyUp('KeyD');
    expect(control.beginPointer(8)).toBe(true);
    expect(control.beginPointer(17)).toBe(false);
    expect(control.movePointer(17, 1, 1)).toBe(false);
    control.movePointer(8, 0.4, -0.45);
    control.requestBoost();
    expect(control.read()).toEqual({ steer: 50, throttle: 56, boost: true });
    expect(control.endPointer(17)).toBe(false);
    expect(control.read().steer).toBe(50);
    control.endPointer(8);
    expect(control.read()).toEqual(NEUTRAL_INPUT);
  });
});

describe('Arcade preferences, local scores and routes', () => {
  function storage() {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    return values;
  }

  it('persists independent settings and safely resets malformed stored values', () => {
    const values = storage();
    const prefs = { ...defaultPreferences, nickname: 'Comet Pilot', desktopSensitivity: 1.15,
      leftHanded: true, touchSensitivity: 0.8, touchSize: 120, showMarket: false, lowQuality: true };
    expect(savePreferences(prefs)).toBe(true);
    expect(readPreferences()).toEqual(prefs);
    values.set(PREFS_KEY, '{"nickname":"<html>","touchSize":-1000,"desktopSensitivity":50}');
    expect(readPreferences()).toEqual(defaultPreferences);
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(savePreferences(prefs)).toBe(false);
    expect(readPreferences()).toEqual(defaultPreferences);
  });

  it('flushes scores, ignores duplicate and implausible records, and recovers from corrupt storage', () => {
    const values = storage();
    const race = createRace(config);
    const runs: InputRun[] = [];
    while (!race.result) { recordInput(runs, NEUTRAL_INPUT); stepRace(race, NEUTRAL_INPUT); }
    const entry = makeRaceEntry('00000000-0000-4000-8000-000000000022', 'Comet Pilot', config, race.result, 10_000);
    const scores = recordLocalScore(readScores(), entry);
    expect(scores).toEqual([entry]);
    expect(recordLocalScore(scores, entry)).toBe(scores);
    expect(recordLocalScore(scores, { ...entry, points: 100_000 })).toBe(scores);
    expect(saveScores(scores)).toBe(true);
    expect(readScores()).toEqual(scores);
    values.set(SCORE_KEY, 'invalid JSON');
    expect(readScores()).toEqual([]);
  });

  it('keeps all Arcade entry points in the Arcade workspace and preserves legacy routes', () => {
    for (const [path, view] of [['/arcade/', 'home'], ['/arcade/rocket-race', 'play'],
      ['/arcade/leaderboard', 'leaderboard'], ['/arcade/settings', 'settings'], ['/arcade/how-to-play', 'guide']]) {
      expect(parseArcadePath(path)).toBe(view);
      expect(parseWorkspacePath(path)).toEqual({ route: '/arcade', marketSlug: null, batch: false });
    }
    expect(parseWorkspacePath('/')).toEqual({ route: '/wallet', marketSlug: null, batch: false });
    expect(parseWorkspacePath('/batch').batch).toBe(true);
    expect(parseWorkspacePath('/settings').route).toBe('/settings');
    expect(parseWorkspacePath('/market/bchusd-5m-flash').marketSlug).toBe('bchusd-5m-flash');
  });
});
