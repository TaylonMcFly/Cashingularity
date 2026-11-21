import {
  clamp, createRace, ONLINE_STEP_MS, restoreOnlineRocket, stepRocket,
  type OnlineSnapshot, type Race, type RaceConfig, type RaceInput, type Rocket,
} from '@cashingularity/shared/rocket-race';

const HISTORY = 48;
const MAX_LEAD = 12;
const BUFFER_TICKS = 6;
const SAMPLES = 12;

export class OnlineMotion {
  readonly scene: Race;
  private readonly player: Rocket;
  private readonly ticks = new Int32Array(HISTORY).fill(-1);
  private readonly steer = new Int8Array(HISTORY);
  private readonly throttle = new Int8Array(HISTORY);
  private readonly samples: OnlineSnapshot[] = [];
  private pending?: { sequence: number; tick: number };
  private input: RaceInput = { steer: 0, throttle: 0, boost: false };
  private tick = 0;
  private remoteTick = 0;
  private received = 0;
  private offsetX = 0;
  private offsetZ = 0;
  private paintedAt = 0;
  sample?: OnlineSnapshot;

  constructor(config: RaceConfig, readonly seat: number) {
    this.scene = createRace(config, undefined, config.rockets);
    this.player = { ...this.scene.rockets[seat], obstacleFlags: new Uint8Array(this.scene.track.asteroidCount) };
  }

  forgetPrediction() {
    this.ticks.fill(-1);
    this.pending = undefined;
    this.input.steer = this.input.throttle = 0;
    this.samples.length = 0;
    this.offsetX = this.offsetZ = 0;
  }

  accept(sample: OnlineSnapshot, now: number) {
    if (this.sample && sample.tick < this.sample.tick) return;
    const snap = !this.sample || now - this.received > 420 || this.samples.length === 0;
    if (snap) this.forgetPrediction();
    const oldX = this.player.x;
    const oldZ = this.player.z;
    const until = snap ? sample.tick : clamp(this.tick, sample.tick, sample.tick + MAX_LEAD);
    this.sample = sample;
    this.received = now;
    this.samples.push(sample);
    if (this.samples.length > SAMPLES) this.samples.shift();

    restoreOnlineRocket(this.scene.track, this.player, sample.ships[this.seat], sample.own);
    if (this.pending && this.pending.sequence <= sample.own[0]) this.pending = undefined;
    const pending = this.pending ? Math.max(this.pending.tick, sample.tick + 1) : Infinity;
    const beforeSteer = this.input.steer;
    const beforeThrottle = this.input.throttle;
    for (let tick = sample.tick + 1; tick <= until && !this.player.retired && this.player.finishTick === null; tick++) {
      const index = tick % HISTORY;
      this.input.steer = this.ticks[index] === tick ? this.steer[index] : beforeSteer;
      this.input.throttle = this.ticks[index] === tick ? this.throttle[index] : beforeThrottle;
      this.input.boost = tick === pending;
      stepRocket(this.scene.track, tick, this.player, this.input);
    }
    this.input.steer = beforeSteer;
    this.input.throttle = beforeThrottle;
    this.tick = until;
    if (snap) this.remoteTick = sample.tick;
    else {
      this.offsetX = clamp(this.offsetX + oldX - this.player.x, -90, 90);
      this.offsetZ = clamp(this.offsetZ + oldZ - this.player.z, -130, 130);
    }
  }

  advance(steer: number, throttle: number, boostSequence: number | null) {
    if (!this.sample || this.player.retired || this.tick >= this.sample.tick + MAX_LEAD || this.player.finishTick !== null) return;
    const tick = ++this.tick;
    const index = tick % HISTORY;
    this.ticks[index] = tick;
    this.steer[index] = this.input.steer = steer;
    this.throttle[index] = this.input.throttle = throttle;
    this.input.boost = boostSequence !== null;
    if (boostSequence !== null) this.pending = { sequence: boostSequence, tick };
    stepRocket(this.scene.track, tick, this.player, this.input);
  }

  paint(now: number, fraction: number) {
    if (!this.sample) return this.scene;
    const decay = Math.exp(-Math.max(0, now - this.paintedAt) / 85);
    this.paintedAt = now;
    this.offsetX *= decay;
    this.offsetZ *= decay;
    const newest = this.sample.tick;
    const target = Math.min(newest, newest + (now - this.received) / ONLINE_STEP_MS - BUFFER_TICKS);
    this.remoteTick = Math.max(this.remoteTick, target);
    let before = this.samples[0] ?? this.sample;
    let after = this.sample;
    for (const sample of this.samples) {
      if (sample.tick <= this.remoteTick) before = sample;
      else { after = sample; break; }
    }
    const mix = after.tick > before.tick ? clamp((this.remoteTick - before.tick) / (after.tick - before.tick), 0, 1) : 0;
    for (const rocket of this.scene.rockets) {
      if (rocket.id === this.seat) {
        rocket.x = rocket.previousX = this.player.previousX + (this.player.x - this.player.previousX) * fraction + this.offsetX;
        rocket.z = rocket.previousZ = this.player.previousZ + (this.player.z - this.player.previousZ) * fraction + this.offsetZ;
        rocket.vx = this.player.vx;
        rocket.lastCollision = this.player.lastCollision;
        rocket.boostUntil = this.player.boostUntil;
        rocket.retired = this.player.retired;
      } else {
        const a = before.ships[rocket.id];
        const b = after.ships[rocket.id];
        rocket.x = rocket.previousX = (a[0] + (b[0] - a[0]) * mix) / 10;
        rocket.z = rocket.previousZ = (a[1] + (b[1] - a[1]) * mix) / 10;
        rocket.vx = (a[2] + (b[2] - a[2]) * mix) / 10;
        rocket.lastCollision = a[9];
        rocket.boostUntil = a[11];
        rocket.retired = this.sample.ships[rocket.id][12] === 1;
      }
    }
    this.scene.tick = this.tick;
    return this.scene;
  }
}
