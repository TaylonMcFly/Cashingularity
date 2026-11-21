import { createPilot, pilotInput, type PilotBrain } from './bots.js';
import {
  BOOST_SPEED, BOOST_TICKS, clamp, COLLISION_COOLDOWN, computeRacePoints, CRUISE_SPEED,
  DODGE_MARGIN, DODGES_PER_BOOST, MAX_RACE_TICKS, NEUTRAL_INPUT, ROCKET_RADIUS, START_SPEED, STEER_ACCEL,
  STEER_SPEED, STEP_SECONDS, ticksToMs, TOP_SPEED, TRACK_WIDTH, type RaceConfig,
  type RaceInput, type RaceResult,
} from './model.js';
import { asteroidX, asteroidZ, generateTrack, WAVE_CLEARANCE, type Track } from './track.js';

const NEAR = 1;
const CONTACT = 2;
const PASSED = 4;

export interface Rocket {
  id: number;
  x: number;
  z: number;
  previousX: number;
  previousZ: number;
  vx: number;
  speed: number;
  dodges: number;
  streak: number;
  collisions: number;
  charges: number;
  boostsEarned: number;
  lastCollision: number;
  lastBoost: number;
  boostUntil: number;
  invulnerableUntil: number;
  finishTick: number | null;
  waveCursor: number;
  obstacleFlags: Uint8Array;
  retired?: boolean;
  brain?: PilotBrain;
}
export interface Race {
  config: RaceConfig;
  track: Track;
  rockets: Rocket[];
  order: Rocket[];
  tick: number;
  result: RaceResult | null;
  winnerTick?: number;
}

export function createRace(config: RaceConfig, track = generateTrack(config), humanSeats = 1): Race {
  const rockets = Array.from({ length: config.rockets }, (_, id): Rocket => {
    const x = TRACK_WIDTH * (id + 1) / (config.rockets + 1);
    return {
      id, x, z: 0, previousX: x, previousZ: 0, vx: 0, speed: START_SPEED, dodges: 0, streak: 0,
      collisions: 0, charges: 0, boostsEarned: 0, lastCollision: -1, lastBoost: -1, boostUntil: 0,
      invulnerableUntil: 0, finishTick: null, waveCursor: 0, obstacleFlags: new Uint8Array(track.asteroidCount),
      brain: id >= humanSeats ? createPilot(config.seed, id, config.difficulty, x) : undefined,
    };
  });
  return { config, track, rockets, order: [...rockets], tick: 0, result: null };
}

function approach(current: number, target: number, amount: number) {
  return current + clamp(target - current, -amount, amount);
}

/** Closest approach during the step in the moving obstacle's reference frame. */
export function sweptDistanceSquared(x0: number, z0: number, x1: number, z1: number) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const travel = dx * dx + dz * dz;
  const time = travel > 0 ? clamp(-(x0 * dx + z0 * dz) / travel, 0, 1) : 0;
  return (x0 + time * dx) ** 2 + (z0 + time * dz) ** 2;
}

function resolveObstacles(track: Track, tick: number, rocket: Rocket) {
  let dodges = 0;
  let collided = false;
  for (let index = rocket.waveCursor; index < track.waves.length; index++) {
    const wave = track.waves[index];
    if (wave.z - WAVE_CLEARANCE - DODGE_MARGIN > rocket.z) break;
    const clearedWave = rocket.z > wave.z + WAVE_CLEARANCE;
    for (const obstacle of wave.asteroids) {
      let flags = rocket.obstacleFlags[obstacle.id];
      if (flags & PASSED) continue;
      const radius = obstacle.radius + ROCKET_RADIUS;
      const distance = sweptDistanceSquared(
        rocket.previousX - asteroidX(obstacle, tick - 1), rocket.previousZ - asteroidZ(obstacle, wave.z, tick - 1),
        rocket.x - asteroidX(obstacle, tick), rocket.z - asteroidZ(obstacle, wave.z, tick),
      );
      if (distance <= radius * radius) {
        if (!(flags & CONTACT)) collided = true;
        flags |= CONTACT;
      } else if (distance <= (radius + DODGE_MARGIN) ** 2) {
        flags |= NEAR;
      }
      if (rocket.z > wave.z + obstacle.depth + radius) {
        flags |= PASSED;
        if ((flags & (NEAR | CONTACT)) === NEAR) dodges++;
      }
      rocket.obstacleFlags[obstacle.id] = flags;
    }
    if (clearedWave) rocket.waveCursor = index + 1;
  }
  if (collided && tick >= rocket.invulnerableUntil) {
    rocket.collisions++;
    rocket.streak = 0;
    rocket.speed *= 0.56;
    rocket.lastCollision = tick;
    rocket.invulnerableUntil = tick + COLLISION_COOLDOWN;
  }
  if (dodges > 0) {
    rocket.dodges += dodges;
    rocket.streak += dodges;
    const earned = Math.floor(rocket.streak / DODGES_PER_BOOST);
    rocket.charges += earned;
    rocket.boostsEarned += earned;
    rocket.streak %= DODGES_PER_BOOST;
  }
}

export function stepRocket(track: Track, tick: number, rocket: Rocket, input: Readonly<RaceInput>) {
  if (input.boost && rocket.charges > 0 && tick >= rocket.boostUntil) {
    rocket.charges--;
    rocket.lastBoost = tick;
    rocket.boostUntil = tick + BOOST_TICKS;
  }
  const boost = tick < rocket.boostUntil;
  const throttle = input.throttle / 100;
  const targetSpeed = CRUISE_SPEED + throttle * (throttle >= 0 ? TOP_SPEED - CRUISE_SPEED : CRUISE_SPEED - 215) + (boost ? BOOST_SPEED : 0);
  const acceleration = targetSpeed < rocket.speed ? 520 : boost ? 630 : 300;
  rocket.previousX = rocket.x;
  rocket.previousZ = rocket.z;
  rocket.speed = approach(rocket.speed, targetSpeed, acceleration * STEP_SECONDS);
  rocket.vx = approach(rocket.vx, input.steer / 100 * STEER_SPEED, STEER_ACCEL * STEP_SECONDS);
  rocket.x = clamp(rocket.x + rocket.vx * STEP_SECONDS, ROCKET_RADIUS, TRACK_WIDTH - ROCKET_RADIUS);
  if (rocket.x === ROCKET_RADIUS || rocket.x === TRACK_WIDTH - ROCKET_RADIUS) rocket.vx = 0;
  rocket.z += rocket.speed * STEP_SECONDS;
  resolveObstacles(track, tick, rocket);
  if (rocket.z >= track.length) {
    rocket.finishTick = tick - 1 + (track.length - rocket.previousZ) / (rocket.z - rocket.previousZ);
  }
}

function compareRockets(a: Rocket, b: Rocket) {
  if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;
  if (a.finishTick !== null || b.finishTick !== null) {
    const difference = (a.finishTick ?? Infinity) - (b.finishTick ?? Infinity);
    if (difference !== 0) return difference;
    return a.id - b.id;
  }
  return b.z - a.z || a.id - b.id;
}

function advanceRace(race: Race, input: Readonly<RaceInput>, seats?: ReadonlyArray<Readonly<RaceInput>>, finishWindow = 0) {
  if (race.result) return;
  race.tick++;
  for (const rocket of race.rockets) {
    if (rocket.retired || rocket.finishTick !== null) continue;
    const controls = rocket.brain ? pilotInput(rocket.brain, rocket, race.track, race.tick, race.config.difficulty) : seats?.[rocket.id] ?? input;
    stepRocket(race.track, race.tick, rocket, controls);
  }
  race.order.sort(compareRockets);
  const winnerId = race.order[0].finishTick !== null ? race.order[0].id : null;
  if (winnerId === null && race.tick < MAX_RACE_TICKS) return;
  if (winnerId !== null) {
    race.winnerTick ??= race.tick;
    if (race.tick < Math.min(MAX_RACE_TICKS, race.winnerTick + finishWindow) &&
        race.rockets.some(rocket => !rocket.retired && rocket.finishTick === null)) return;
  }
  race.result = {
    ticks: race.tick,
    winnerId,
    standings: race.order.map((rocket, index) => ({
      id: rocket.id, place: index + 1, remaining: Math.max(0, Math.ceil(race.track.length - rocket.z)),
      finishMs: rocket.finishTick === null ? null : ticksToMs(rocket.finishTick),
      dodges: rocket.dodges, collisions: rocket.collisions, boostsEarned: rocket.boostsEarned,
      points: computeRacePoints(rocket.dodges, rocket.collisions, rocket.boostsEarned, winnerId === rocket.id),
    })),
  };
}

export function stepRace(race: Race, input: Readonly<RaceInput>) {
  advanceRace(race, input);
}

export function stepGrid(race: Race, inputs: ReadonlyArray<Readonly<RaceInput>>, finishWindow = 0) {
  advanceRace(race, NEUTRAL_INPUT, inputs, finishWindow);
}
