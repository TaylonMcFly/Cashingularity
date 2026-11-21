import {
  COUNTDOWN_TICKS, createRace, recordInput, stepRace, TICK_RATE,
  type InputRun, type RaceConfig, type RaceInput,
} from '@cashingularity/shared/rocket-race';

export type RacePhase = 'countdown' | 'racing' | 'paused' | 'finished';

export class RaceSession {
  readonly race;
  readonly replay: InputRun[] = [];
  phase: RacePhase = 'countdown';
  countdown = COUNTDOWN_TICKS;
  private resumePhase: 'countdown' | 'racing' = 'countdown';

  constructor(config: RaceConfig) {
    this.race = createRace(config);
  }

  step(read: () => Readonly<RaceInput>) {
    if (this.phase === 'countdown') {
      if (--this.countdown === 0) this.phase = 'racing';
    } else if (this.phase === 'racing') {
      const input = read();
      recordInput(this.replay, input);
      stepRace(this.race, input);
      if (this.race.result) this.phase = 'finished';
    }
  }

  pause() {
    if (this.phase !== 'countdown' && this.phase !== 'racing') return false;
    this.resumePhase = this.phase;
    this.phase = 'paused';
    return true;
  }

  resume() {
    if (this.phase !== 'paused') return false;
    this.phase = this.resumePhase;
    return true;
  }
}

const STEP_MS = 1_000 / TICK_RATE;
const MAX_CATCH_UP = 5 * STEP_MS;

export class FixedFrameClock {
  private previous: number | undefined;
  private accumulator = 0;

  reset() {
    this.previous = undefined;
    this.accumulator = 0;
  }

  advance(now: number, step: () => void) {
    if (this.previous !== undefined) {
      this.accumulator += Math.min(MAX_CATCH_UP, Math.max(0, now - this.previous));
    }
    this.previous = now;
    // The tolerance prevents a fractional millisecond from deferring a whole physics step.
    while (this.accumulator + 1e-7 >= STEP_MS) {
      step();
      this.accumulator = Math.max(0, this.accumulator - STEP_MS);
    }
    return this.accumulator / STEP_MS;
  }
}
