import { describe, expect, it } from 'vitest';
import {
  asteroidX, asteroidZ, BOOST_SPEED, BOOST_TICKS, buildLeaderboard, COLLISION_COOLDOWN, computeRacePoints,
  CORRIDOR_HALF_WIDTH, createRace, DIFFICULTIES, generateTrack, isRaceEntry, makeRaceEntry, MAX_CORRIDOR_SHIFT,
  MAX_RACE_TICKS, NEUTRAL_INPUT, normalizeNickname, readRaceEntries, recordInput, replayRace, ROCKET_RADIUS,
  STEER_ACCEL, STEER_SPEED, stepRace, sweptDistanceSquared, TOP_SPEED, TRACK_WIDTH, validateReplay, WAVE_CLEARANCE,
  type Asteroid, type InputRun, type Race, type RaceConfig, type RaceEntry, type Track,
} from './index.js';

const config: RaceConfig = { seed: 193, difficulty: 'normal', rockets: 4 };
const full = { steer: 0, throttle: 100, boost: false };
function fixture(waves: { z: number; x: number[] }[], length = 10_000): Track {
  let id = 0;
  return {
    length,
    waves: waves.map(({ z, x }) => ({
      z, corridor: 320, asteroids: x.map((value): Asteroid => ({
        id: id++, x: value, radius: 24, sweep: 0, depth: 0, period: 120, phase: 0, spin: 1,
      })),
    })),
    get asteroidCount() { return id; },
  };
}

function fixedLine(track: Track) {
  const race = createRace(config, track);
  race.rockets[0].x = race.rockets[0].previousX = TRACK_WIDTH / 2;
  return race;
}

function run(count: number, race: Race, input = NEUTRAL_INPUT) {
  for (let tick = 0; tick < count; tick++) stepRace(race, input);
}

describe('Rocket Race physics', () => {
  it('accelerates, steers, brakes and retains momentum within the track', () => {
    const race = fixedLine(fixture([]));
    const player = race.rockets[0];
    const initial = player.speed;
    stepRace(race, { steer: 100, throttle: 100, boost: false });
    expect(player.speed).toBeGreaterThan(initial);
    expect(player.speed).toBeLessThan(TOP_SPEED);
    expect(player.vx).toBeGreaterThan(0);
    expect(player.vx).toBeLessThan(STEER_SPEED);
    const moved = player.x;
    stepRace(race, NEUTRAL_INPUT);
    expect(player.x).toBeGreaterThanOrEqual(moved);
    run(120, race, { steer: 100, throttle: -100, boost: false });
    expect(player.x).toBe(TRACK_WIDTH - ROCKET_RADIUS);
    expect(player.vx).toBe(0);
    expect(player.speed).toBe(215);
  });

  it('detects crossings that miss both step endpoints, including a moving rock', () => {
    expect(sweptDistanceSquared(-60, 20, 60, 20)).toBe(400);
    expect(sweptDistanceSquared(3, 4, 3, 4)).toBe(25);
    const track = fixture([{ z: 1_000, x: [368] }]);
    const moving = track.waves[0].asteroids[0];
    moving.sweep = 40;
    moving.period = 108;
    const race = fixedLine(track);
    const player = race.rockets[0];
    player.z = 975;
    run(14, race, full);
    expect(player.collisions).toBe(1);
    expect(player.dodges).toBe(0);
  });

  it('counts a close pass exactly once, and never awards distant rocks or mere approaches', () => {
    const race = fixedLine(fixture([{ z: 610, x: [389, 31] }]));
    const player = race.rockets[0];
    while (player.z < 604) stepRace(race, full);
    expect(player.dodges).toBe(0);
    run(40, race, full);
    expect(player.dodges).toBe(1);
    run(100, race, full);
    expect(player.dodges).toBe(1);
  });

  it('stores one boost after five consecutive passes, uses it only on command, and expires it', () => {
    const race = fixedLine(fixture(Array.from({ length: 5 }, (_, i) => ({ z: 650 + 600 * i, x: [391] }))));
    const player = race.rockets[0];
    while (player.dodges < 4) stepRace(race, full);
    expect(player.charges).toBe(0);
    while (!player.charges) stepRace(race, full);
    expect(player.dodges).toBe(5);
    expect(player.streak).toBe(0);
    expect(player.lastBoost).toBe(-1);
    const speed = player.speed;
    stepRace(race, { ...full, boost: true });
    expect(player.speed).toBeGreaterThan(speed);
    expect(player.charges).toBe(0);
    expect(player.boostUntil).toBe(race.tick + BOOST_TICKS);
    run(BOOST_TICKS - 1, race, full);
    expect(player.speed).toBe(TOP_SPEED + BOOST_SPEED);
    stepRace(race, full);
    expect(player.speed).toBeLessThan(TOP_SPEED + BOOST_SPEED);
    run(40, race, full);
    expect(player.speed).toBe(TOP_SPEED);
  });

  it('slows once for overlapping objects, excludes the whole contact from dodges and resets the streak', () => {
    const race = fixedLine(fixture([{ z: 610, x: [319, 321] }, { z: 1_400, x: [320] }]));
    const player = race.rockets[0];
    player.streak = 4;
    player.charges = 1;
    while (!player.collisions) stepRace(race, full);
    expect(player.speed).toBeCloseTo(TOP_SPEED * 0.56);
    expect(player.streak).toBe(0);
    expect(player.charges).toBe(1);
    run(COLLISION_COOLDOWN - 1, race, full);
    expect(player.collisions).toBe(1);
    while (player.z < 1_520) stepRace(race, full);
    expect(player.collisions).toBe(2);
    expect(player.dodges).toBe(0);
  });

  it('does not re-penalize the same prolonged contact after the protection window', () => {
    const race = fixedLine(fixture([{ z: 615, x: [320] }]));
    const player = race.rockets[0];
    for (let i = 0; i < COLLISION_COOLDOWN + 10; i++) {
      player.z = 615; // Hold the test craft inside the same obstacle to stress prolonged overlap.
      stepRace(race, { ...NEUTRAL_INPUT, throttle: -100 });
    }
    expect(player.collisions).toBe(1);
    expect(player.dodges).toBe(0);
  });

  it('ranks by progress, resolves a same-tick finish by crossing time, then freezes the race', () => {
    const race = createRace(config, fixture([], 100));
    race.rockets[0].z = 93;
    race.rockets[1].z = 95;
    race.rockets[1].speed = TOP_SPEED;
    race.rockets[0].speed = TOP_SPEED;
    race.rockets[3].z = 30;
    stepRace(race, full);
    expect(race.result?.winnerId).toBe(1);
    expect(race.result?.standings.map(item => item.id)).toEqual([1, 0, 3, 2]);
    expect(race.result?.standings[0].finishMs).toBeLessThan(race.result!.standings[1].finishMs!);
    expect(race.result?.standings[2].finishMs).toBeNull();
    run(60, race, full);
    expect(race.tick).toBe(1);
  });
});

describe('Seeded track and competitors', () => {
  it('reproduces layouts, with moving and stationary rocks and increasing density', () => {
    const track = generateTrack(config);
    expect(track).toEqual(generateTrack(config));
    expect(track).not.toEqual(generateTrack({ ...config, seed: 194 }));
    const rocks = track.waves.flatMap(wave => wave.asteroids);
    expect(rocks.some(rock => rock.sweep === 0)).toBe(true);
    expect(rocks.some(rock => rock.sweep > 0 && asteroidX(rock, 0) !== asteroidX(rock, 19) &&
      asteroidZ(rock, 1_000, 0) !== asteroidZ(rock, 1_000, 19))).toBe(true);
    const sum = (rows: typeof track.waves) => rows.reduce((total, wave) => total + wave.asteroids.length, 0);
    expect(sum(track.waves.slice(-10))).toBeGreaterThan(sum(track.waves.slice(0, 10)));
    expect(generateTrack({ ...config, difficulty: 'hard' }).asteroidCount)
      .toBeGreaterThan(generateTrack({ ...config, difficulty: 'easy' }).asteroidCount);
  });

  it('bounds full motion envelopes and allows safe lane changes at maximum boost speed across 360 generated tracks', () => {
    for (const difficulty of DIFFICULTIES) {
      for (let seed = 0; seed < 120; seed++) {
        const track = generateTrack({ ...config, seed, difficulty });
        let previous = { z: 0, corridor: TRACK_WIDTH / 2 };
        for (const wave of track.waves) {
          const shift = Math.abs(previous.corridor - wave.corridor);
          expect(shift).toBeLessThanOrEqual(MAX_CORRIDOR_SHIFT);
          const gapSeconds = (wave.z - previous.z - 2 * WAVE_CLEARANCE) / (TOP_SPEED + BOOST_SPEED);
          const rampDistance = STEER_SPEED ** 2 / STEER_ACCEL;
          const steerSeconds = shift <= rampDistance ? 2 * Math.sqrt(shift / STEER_ACCEL)
            : 2 * STEER_SPEED / STEER_ACCEL + (shift - rampDistance) / STEER_SPEED;
          expect(gapSeconds).toBeGreaterThan(steerSeconds);
          for (const rock of wave.asteroids) {
            expect(Math.abs(rock.x - wave.corridor) - rock.sweep - rock.radius).toBeGreaterThanOrEqual(CORRIDOR_HALF_WIDTH);
            expect(rock.x - rock.sweep - rock.radius).toBeGreaterThan(0);
            expect(rock.x + rock.sweep + rock.radius).toBeLessThan(TRACK_WIDTH);
          }
          previous = wave;
        }
      }
    }
  });

  it('runs rivals with real steering, earned boosts, and faster hard-mode completion', () => {
    const times = DIFFICULTIES.map(difficulty => {
      const race = createRace({ ...config, difficulty, rockets: 2 });
      const rival = race.rockets[1];
      const initialPosition = rival.x;
      run(100, race, NEUTRAL_INPUT);
      expect(Math.abs(rival.x - initialPosition)).toBeGreaterThan(5);
      while (!race.result) stepRace(race, NEUTRAL_INPUT);
      expect(race.result.winnerId).toBe(1);
      expect(rival.boostsEarned).toBeGreaterThan(0);
      expect(rival.lastBoost).toBeGreaterThanOrEqual(0);
      return race.result.ticks;
    });
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });
});

describe('Replay and scoreboard', () => {
  const race = createRace(config);
  const runs: InputRun[] = [];
  while (!race.result) {
    const input = { steer: Math.floor(race.tick / 55) % 2 === 0 ? -35 : 35, throttle: 80, boost: race.tick % 61 === 0 };
    recordInput(runs, input);
    stepRace(race, input);
  }
  const result = race.result;
  const entry = makeRaceEntry('00000000-0000-4000-8000-000000000001', 'Pilot Alpha', config, result, 35_000);

  it('replays unchanged physics and input between machines and validates full duration', () => {
    expect(replayRace(config, JSON.parse(JSON.stringify(runs)))).toEqual(result);
    expect(replayRace(config, runs.slice(0, -1))).toBeNull();
    expect(replayRace(config, [...runs, [1, 0, 0, 0]])).toBeNull();
    for (const invalid of [[], [[0, 0, 0, 0]], [[1, 101, 0, 0]], [[2, 0, 0, 1]], [[1, 0, 0, true]],
      [[1, 0, 0.5, 0]], [[MAX_RACE_TICKS, 0, 0, 0], [1, 0, 0, 0]]]) expect(validateReplay(invalid)).toBeNull();
  });

  it('rejects edited scoring records and duplicate IDs and filters actual history', () => {
    const won: RaceEntry = { ...entry, id: '00000000-0000-4000-8000-000000000002', place: 1, finishMs: entry.elapsedMs,
      nickname: 'PILOT ALPHA', points: computeRacePoints(entry.dodges, entry.collisions, entry.boostsEarned, true) };
    const invalid = { ...entry, points: entry.points + 1 };
    expect(isRaceEntry(invalid)).toBe(false);
    expect(isRaceEntry({ ...entry, elapsedMs: 20 })).toBe(false);
    const saved = readRaceEntries(JSON.parse(JSON.stringify([won, entry, invalid, won])), 10);
    expect(saved).toEqual([won, entry]);
    expect(buildLeaderboard(saved, { sort: 'wins', difficulty: 'normal' }).rankings).toEqual([{
      nickname: won.nickname, bestMs: won.finishMs, races: 2, wins: won.place === entry.place ? 2 : 1,
      dodges: won.dodges + entry.dodges, points: won.points + entry.points,
    }]);
    expect(buildLeaderboard(saved, { sort: 'time', rockets: 3 }).count).toBe(0);
    expect(computeRacePoints(0, 32, 0, false)).toBe(0);
  });

  it('normalizes real nicknames and rejects markup, invisible controls and oversized names', () => {
    expect(normalizeNickname('  Étoile   7  ')).toBe('Étoile 7');
    for (const name of ['<script>', 'a', 'Pilot\nB', 'Pilot\u200bB', 'a'.repeat(21), null]) expect(normalizeNickname(name)).toBeNull();
  });
});
