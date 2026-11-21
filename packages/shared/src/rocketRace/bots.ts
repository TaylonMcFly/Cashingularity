import { clamp, ROCKET_RADIUS, seededRandom, STEER_SPEED, TICK_RATE, type Difficulty, type RaceInput } from './model.js';
import { asteroidX, CORRIDOR_HALF_WIDTH, WAVE_CLEARANCE, type Track } from './track.js';

const tuning = {
  easy: { pace: 35, spread: 23, decision: 21, bias: 50, caution: 0.3 },
  normal: { pace: 65, spread: 22, decision: 13, bias: 38, caution: 0.6 },
  hard: { pace: 88, spread: 12, decision: 7, bias: 25, caution: 0.85 },
};
const laneOffsets = [-55, -32, -14, 0, 14, 32, 55] as const;

export interface PilotBrain {
  pace: number;
  bias: number;
  nextDecision: number;
  target: number;
  input: RaceInput;
}
interface BotRocket {
  x: number;
  z: number;
  vx: number;
  speed: number;
  charges: number;
  boostUntil: number;
  waveCursor: number;
}

export function createPilot(seed: number, id: number, difficulty: Difficulty, x: number): PilotBrain {
  const random = seededRandom(seed ^ Math.imul(id, 0x9e3779b9));
  const spec = tuning[difficulty];
  return {
    pace: spec.pace + Math.floor(random() * spec.spread),
    bias: Math.round((random() - 0.5) * spec.bias),
    nextDecision: 1 + Math.floor(random() * 5),
    target: x,
    input: { steer: 0, throttle: spec.pace, boost: false },
  };
}

export function pilotInput(brain: PilotBrain, rocket: BotRocket, track: Track, tick: number, difficulty: Difficulty) {
  const { input } = brain;
  const spec = tuning[difficulty];
  if (tick >= brain.nextDecision) {
    brain.nextDecision = tick + spec.decision;
    let wave = track.waves[rocket.waveCursor];
    // Once lined up through a wave, prepare for the gap in the next one.
    if (wave && rocket.z > wave.z + WAVE_CLEARANCE) wave = track.waves[rocket.waveCursor + 1];
    input.throttle = brain.pace;
    if (wave) {
      const arrival = Math.max(0, (wave.z - rocket.z) / rocket.speed);
      const lookTick = tick + Math.round(arrival * TICK_RATE);
      let bestCost = Infinity;
      let bestClearance = 0;
      for (const offset of laneOffsets) {
        const target = wave.corridor + offset;
        let clearance = CORRIDOR_HALF_WIDTH;
        for (const rock of wave.asteroids) {
          clearance = Math.min(clearance, Math.abs(target - asteroidX(rock, lookTick)) - rock.radius - ROCKET_RADIUS);
        }
        const risk = Math.max(0, 25 - clearance) * (1.5 + spec.caution * 5);
        const travel = Math.abs(rocket.x - target);
        const cost = risk + Math.abs(offset - brain.bias) + travel * (arrival < 0.4 ? 0.55 : 0.18);
        if (cost >= bestCost) continue;
        bestCost = cost;
        brain.target = target;
        bestClearance = clearance;
      }
      // Brake for an approach the current sideways momentum cannot make safely.
      const projectedX = rocket.x + rocket.vx * Math.min(0.22, arrival);
      if (arrival < 0.48 && Math.abs(projectedX - brain.target) > 70 - spec.caution * 21) input.throttle = -22;
      input.boost = rocket.charges > 0 && tick >= rocket.boostUntil && arrival > 0.42 &&
        bestClearance > 21 && Math.abs(rocket.x - brain.target) < 30;
    } else {
      input.boost = rocket.charges > 0 && tick >= rocket.boostUntil;
    }
  } else {
    input.boost = false;
  }
  // A damped steering controller uses the same speed and momentum limits as the player.
  input.steer = Math.round(clamp((brain.target - rocket.x) * 7.2 - rocket.vx * 0.62, -STEER_SPEED, STEER_SPEED) / STEER_SPEED * 100);
  return input;
}
