import { MAX_RACE_TICKS, type RaceConfig, type RaceInput, type RaceResult } from './model.js';
import { createRace, stepRace } from './physics.js';

export type InputRun = [ticks: number, steer: number, throttle: number, boost: 0 | 1];

export function recordInput(runs: InputRun[], input: Readonly<RaceInput>) {
  const previous = runs.at(-1);
  if (previous && previous[3] === 0 && !input.boost && previous[1] === input.steer && previous[2] === input.throttle) {
    previous[0]++;
  } else {
    runs.push([1, input.steer, input.throttle, input.boost ? 1 : 0]);
  }
}

export function validateReplay(raw: unknown): { runs: InputRun[]; ticks: number } | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RACE_TICKS) return null;
  let ticks = 0;
  for (const run of raw) {
    if (!Array.isArray(run) || run.length !== 4) return null;
    const [count, steer, throttle, boost] = run;
    if (!Number.isInteger(count) || count < 1 || count > MAX_RACE_TICKS ||
        !Number.isInteger(steer) || Math.abs(steer) > 100 || !Number.isInteger(throttle) || Math.abs(throttle) > 100 ||
        (boost !== 0 && boost !== 1) || (boost === 1 && count !== 1)) return null;
    ticks += count;
    if (ticks > MAX_RACE_TICKS) return null;
  }
  return { runs: raw as InputRun[], ticks };
}

export function replayRace(config: RaceConfig, raw: unknown): RaceResult | null {
  const replay = validateReplay(raw);
  if (!replay) return null;
  const race = createRace(config);
  const input: RaceInput = { steer: 0, throttle: 0, boost: false };
  for (const [count, steer, throttle, boost] of replay.runs) {
    input.steer = steer;
    input.throttle = throttle;
    input.boost = boost === 1;
    for (let tick = 0; tick < count; tick++) {
      if (race.result) return null; // A result must end exactly at the official last physics step.
      stepRace(race, input);
    }
  }
  return race.result;
}
