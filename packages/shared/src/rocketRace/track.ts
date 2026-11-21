import { clamp, ROCKET_RADIUS, seededRandom, TRACK_LENGTH, TRACK_WIDTH, type RaceConfig } from './model.js';

export const MAX_ROCK_RADIUS = 44;
export const MAX_ROCK_DEPTH = 30;
export const WAVE_SPACING = 525;
export const WAVE_CLEARANCE = MAX_ROCK_RADIUS + MAX_ROCK_DEPTH + ROCKET_RADIUS;
export const CORRIDOR_HALF_WIDTH = 71;
export const MAX_CORRIDOR_SHIFT = 54;

export interface Asteroid {
  id: number;
  x: number;
  radius: number;
  sweep: number;
  depth: number;
  period: number;
  phase: number;
  spin: number;
}
export interface Wave {
  z: number;
  corridor: number;
  asteroids: Asteroid[];
}
export interface Track {
  length: number;
  waves: Wave[];
  asteroidCount: number;
}

function sway(tick: number, period: number, phase: number) {
  const fraction = ((tick + phase) % period) / period;
  const triangle = fraction < 0.5 ? 4 * fraction - 1 : 3 - 4 * fraction;
  return triangle * (1.5 - 0.5 * triangle * triangle);
}

export function asteroidX(asteroid: Asteroid, tick: number) {
  return asteroid.x + asteroid.sweep * sway(tick, asteroid.period, asteroid.phase);
}

export function asteroidZ(asteroid: Asteroid, waveZ: number, tick: number) {
  return waveZ + asteroid.depth * sway(tick, asteroid.period, asteroid.phase + asteroid.period / 4);
}

export function generateTrack({ seed, difficulty }: RaceConfig): Track {
  const random = seededRandom(seed);
  const waves: Wave[] = [];
  let asteroidCount = 0;
  let corridor = TRACK_WIDTH / 2;
  const difficultyDensity = { easy: 1, normal: 2, hard: 3 }[difficulty];
  for (let z = 950; z < TRACK_LENGTH - 700; z += WAVE_SPACING + Math.floor(random() * 125)) {
    const intensity = z / TRACK_LENGTH;
    corridor = clamp(corridor + Math.round((random() * 2 - 1) * MAX_CORRIDOR_SHIFT), 205, TRACK_WIDTH - 205);
    const asteroids: Asteroid[] = [];
    const target = difficultyDensity + Math.floor(intensity * 2.7);
    const leadSide = random() < 0.5 ? -1 : 1;
    for (let attempt = 0; attempt < 25 && asteroids.length < target; attempt++) {
      const lead = asteroids.length === 0;
      const radius = 21 + Math.floor(random() * (14 + intensity * 10));
      const moving = random() < 0.25 + 0.5 * intensity + (difficulty === 'hard' ? 0.12 : 0);
      const sweep = moving ? 8 + Math.floor(random() * (13 + intensity * 21)) : 0;
      const depth = moving ? Math.floor(random() * (MAX_ROCK_DEPTH + 1)) : 0;
      const side = lead ? leadSide : random() < 0.5 ? -1 : 1;
      const inner = corridor + side * (CORRIDOR_HALF_WIDTH + radius + sweep);
      const outer = side < 0 ? radius + sweep + 6 : TRACK_WIDTH - radius - sweep - 6;
      if ((outer - inner) * side < 0) continue;
      // One rock hugs the corridor so driving the safe line still earns genuine near misses.
      const x = Math.round(lead ? inner : inner + (outer - inner) * random());
      if (asteroids.some(rock => Math.abs(rock.x - x) < rock.radius + rock.sweep + radius + sweep + 9)) continue;
      const period = 90 + Math.floor(random() * 200);
      asteroids.push({
        id: asteroidCount++, x, radius, sweep, depth, period,
        phase: Math.floor(random() * period), spin: (random() < 0.5 ? -1 : 1) * (0.4 + random() * 1.1),
      });
    }
    waves.push({ z, corridor, asteroids });
  }
  return { length: TRACK_LENGTH, waves, asteroidCount };
}
