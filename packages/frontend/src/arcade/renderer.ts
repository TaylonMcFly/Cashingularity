import {
  asteroidX, asteroidZ, clamp, createRace, ROCKET_RADIUS, seededRandom, TRACK_WIDTH, WAVE_CLEARANCE,
  type Race, type Rocket,
} from '@cashingularity/shared/rocket-race';

const INK = '#0b1425';
export const PILOT_COLORS = ['#f2c14e', '#6bdaf5', '#f29cd4', '#9cdd87'] as const;
export const PILOT_NAMES = ['You', 'Vela', 'Ion', 'Kestrel'] as const;
const LOOK_DISTANCE = 1_380;

interface Star {
  x: number;
  y: number;
  layer: number;
  size: number;
}

export class RaceRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly stars: Star[];
  private readonly rockShapes: Path2D[];
  private readonly ships: Path2D[];
  private width = 1;
  private height = 1;
  private xScale = 1;
  private zScale = 1;
  private trackLeft = 0;
  private horizon: CanvasGradient | undefined;

  constructor(private readonly canvas: HTMLCanvasElement, seed: number, private readonly lowQuality: boolean, private reduced: boolean) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not open the race canvas.');
    this.context = context;
    const random = seededRandom(seed ^ 0x17e02b);
    this.stars = Array.from({ length: lowQuality ? 46 : 125 }, (_, i) => ({
      x: random(), y: random(), layer: i % 3, size: i % 7 ? 1 : 1.8,
    }));
    this.rockShapes = Array.from({ length: 8 }, () => {
      const path = new Path2D();
      for (let i = 0; i < 9; i++) {
        const angle = Math.PI * 2 * i / 9;
        const radius = 0.8 + random() * 0.19;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      return path;
    });
    this.ships = [
      new Path2D('M 0 -1.38 Q .33 -.98 .42 -.33 L 1 .78 .65 1.04 .32 .68 -.32 .68 -.65 1.04 -1 .78 -.42 -.33 Q -.33 -.98 0 -1.38 Z'),
      new Path2D('M 0 -1.30 L .35 -.87 .50 -.38 .99 .81 .52 .74 .34 1 -.34 1 -.52 .74 -.99 .81 -.50 -.38 -.35 -.87 Z'),
      new Path2D('M 0 -1.16 L .51 -.60 .58 -.10 1 .23 .86 1.06 .38 .71 -.38 .71 -.86 1.06 -1 .23 -.58 -.10 -.51 -.60 Z'),
      new Path2D('M 0 -1.45 Q .5 -.62 .59 .16 L 1 .60 .84 .90 .35 .77 .23 1.06 -.23 1.06 -.35 .77 -.84 .90 -1 .60 -.59 .16 Q -.5 -.62 0 -1.45 Z'),
    ];
  }

  setReducedMotion(value: boolean) {
    this.reduced = value;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const dpr = Math.min(devicePixelRatio || 1, this.lowQuality ? 1 : 1.75, Math.sqrt(1_500_000 / (this.width * this.height)));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const trackWidth = Math.min(this.width * 0.94, Math.max(this.height * 1.35, this.width * 0.66), 820);
    this.trackLeft = (this.width - trackWidth) / 2;
    this.xScale = trackWidth / TRACK_WIDTH;
    this.zScale = this.height / LOOK_DISTANCE;
    this.horizon = this.context.createLinearGradient(0, 0, this.width, this.height);
    this.horizon.addColorStop(0, '#111e34');
    this.horizon.addColorStop(0.56, '#0b1223');
    this.horizon.addColorStop(1, '#1f1930');
  }

  draw(race: Race, fraction: number, playerId = 0, names: readonly string[] = PILOT_NAMES) {
    const player = race.rockets[playerId];
    const camera = player.previousZ + (player.z - player.previousZ) * fraction;
    const tick = Math.max(0, race.tick - 1 + fraction);
    const baseline = this.height * 0.77;
    this.drawField(camera, baseline);
    if (tick < player.boostUntil && !this.reduced && !this.lowQuality) this.drawBoostStreaks(camera);
    this.drawFinish(race, camera, baseline);
    this.drawRocks(race, camera, tick, baseline);
    for (let index = race.rockets.length - 1; index >= 0; index--) {
      const ship = race.rockets[index];
      if (!ship.retired) this.drawShip(ship, camera, tick, fraction, baseline, ship.id === playerId ? 'YOU' : names[ship.id].toUpperCase());
    }
    const age = tick - player.lastCollision;
    if (!this.reduced && player.lastCollision >= 0 && age >= 0 && age < 12) {
      this.context.fillStyle = 'rgba(238,94,101,.4)';
      this.context.globalAlpha = (1 - age / 12) * 0.2;
      this.context.fillRect(0, 0, this.width, this.height);
      this.context.globalAlpha = 1;
    }
  }

  private drawField(progress: number, baseline: number) {
    const ctx = this.context;
    const { width, height, trackLeft, xScale, zScale } = this;
    const trackWidth = TRACK_WIDTH * xScale;
    ctx.fillStyle = this.horizon ?? INK;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#e6f1ff';
    for (const star of this.stars) {
      ctx.globalAlpha = 0.16 + star.layer * 0.18;
      const drift = this.reduced ? 0 : progress * zScale * (0.08 + star.layer * 0.14);
      ctx.fillRect(width * star.x, (height * star.y + drift) % height, star.size, star.size);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(121, 151, 206, .06)';
    ctx.fillRect(trackLeft, 0, trackWidth, height);
    ctx.fillStyle = 'rgba(148, 183, 226, .24)';
    ctx.fillRect(trackLeft, 0, 1, height);
    ctx.fillRect(trackLeft + trackWidth - 1, 0, 1, height);
    const spacing = 185 * zScale;
    const offset = (baseline + progress * zScale) % spacing;
    for (let y = offset - spacing; y < height; y += spacing) {
      ctx.fillStyle = 'rgba(139, 173, 224, .13)';
      for (let lane = 1; lane < 4; lane++) ctx.fillRect(trackLeft + trackWidth * lane / 4, y, 1, 25 * zScale);
      ctx.fillStyle = 'rgba(111, 208, 236, .38)';
      ctx.fillRect(trackLeft - 3, y, 7, 2);
      ctx.fillRect(trackLeft + trackWidth - 4, y, 7, 2);
    }
  }

  private drawBoostStreaks(progress: number) {
    const ctx = this.context;
    const edge = Math.max(6, this.trackLeft * 0.7);
    ctx.fillStyle = 'rgba(255,220,136,.32)';
    for (let index = 0; index < 6; index++) {
      const y = (progress * this.zScale * 1.65 + index * 73) % this.height;
      const x = edge * (0.33 + (index % 3) * 0.2);
      ctx.fillRect(x, y, 1.5, 13 + index % 3 * 7);
      ctx.fillRect(this.width - x - 1.5, (y + 41) % this.height, 1.5, 13 + index % 3 * 7);
    }
  }

  private drawFinish(race: Race, camera: number, baseline: number) {
    const ctx = this.context;
    if (race.track.length - camera <= LOOK_DISTANCE) {
      const y = baseline - (race.track.length - camera) * this.zScale;
      const unit = TRACK_WIDTH * this.xScale / 20;
      const bar = Math.max(4, 12 * this.zScale);
      for (let index = 0; index < 20; index++) {
        ctx.fillStyle = index % 2 ? '#334057' : '#f2c14e';
        ctx.fillRect(this.trackLeft + index * unit, y, unit, bar);
        ctx.fillStyle = index % 2 ? '#f2c14e' : '#334057';
        ctx.fillRect(this.trackLeft + index * unit, y + bar, unit, bar);
      }
      ctx.fillStyle = '#f8db8b';
      ctx.font = '600 11px Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('FINISH', this.width / 2, y - 8);
    }
  }

  private drawRocks(race: Race, camera: number, tick: number, baseline: number) {
    const ctx = this.context;
    const from = camera - (this.height - baseline) / this.zScale - WAVE_CLEARANCE;
    const to = camera + baseline / this.zScale + WAVE_CLEARANCE;
    for (const wave of race.track.waves) {
      if (wave.z < from) continue;
      if (wave.z > to) break;
      for (const rock of wave.asteroids) {
        const x = this.trackLeft + asteroidX(rock, tick) * this.xScale;
        const y = baseline - (asteroidZ(rock, wave.z, tick) - camera) * this.zScale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(rock.radius * this.xScale, rock.radius * this.zScale);
        ctx.beginPath();
        ctx.ellipse(0, 0, 1.03, 1.03, 0, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(61,35,33,.45)';
        ctx.fill();
        ctx.rotate(rock.phase + (this.reduced ? 0 : tick * rock.spin / 95));
        const sketch = this.rockShapes[rock.id % this.rockShapes.length];
        ctx.fillStyle = rock.sweep ? '#725557' : '#505465';
        ctx.fill(sketch);
        ctx.strokeStyle = rock.sweep ? '#d1a298' : '#a0aaba';
        ctx.lineWidth = 0.065;
        ctx.stroke(sketch);
        if (!this.lowQuality) {
          ctx.beginPath();
          ctx.moveTo(-0.65, 0.23);
          ctx.lineTo(-0.3, -0.64);
          ctx.lineTo(0.08, -0.27);
          ctx.lineTo(-0.12, 0.14);
          ctx.fillStyle = 'rgba(211,225,247,.14)';
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(-0.6, 0.12);
          ctx.lineTo(-0.24, -0.35);
          ctx.lineTo(0.06, -0.26);
          ctx.lineTo(0.35, -0.56);
          ctx.moveTo(-0.18, 0.67);
          ctx.lineTo(0.10, 0.23);
          ctx.lineTo(0.57, 0.37);
          ctx.strokeStyle = 'rgba(25,23,35,.8)';
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  private drawShip(rocket: Rocket, camera: number, tick: number, fraction: number, baseline: number, label: string) {
    const x = this.trackLeft + (rocket.previousX + (rocket.x - rocket.previousX) * fraction) * this.xScale;
    const z = rocket.previousZ + (rocket.z - rocket.previousZ) * fraction;
    const y = baseline - (z - camera) * this.zScale;
    if (y < -40 || y > this.height + 30) return;
    const ctx = this.context;
    const color = PILOT_COLORS[rocket.id];
    const scale = clamp((this.xScale * 0.65 + this.zScale * 0.35) * ROCKET_RADIUS, 7.5, 20);
    const boosting = tick < rocket.boostUntil;
    const glow = this.reduced ? 0.6 : 0.6 + 0.3 * Math.sin(tick * 0.5 + rocket.id);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.reduced ? 0 : rocket.vx / 1_250);
    ctx.scale(scale, scale);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.33;
    ctx.beginPath();
    ctx.moveTo(-0.35, 0.71);
    ctx.quadraticCurveTo(-0.52, 1.65, 0, boosting ? 4.6 + glow : 2.1 + glow);
    ctx.quadraticCurveTo(0.52, 1.65, 0.35, 0.71);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = boosting ? '#fef4cd' : color;
    ctx.beginPath();
    ctx.moveTo(-0.2, 0.76);
    ctx.lineTo(0, (boosting ? 2.4 : 1.42) + glow * 0.4);
    ctx.lineTo(0.2, 0.76);
    ctx.fill();
    ctx.fillStyle = '#172841';
    ctx.fill(this.ships[rocket.id]);
    ctx.lineWidth = 0.095;
    ctx.strokeStyle = color;
    ctx.stroke(this.ships[rocket.id]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, -0.15, 0.19, 0.43, 0, 0, Math.PI * 2);
    ctx.fill();
    if (rocket.lastCollision >= 0 && tick - rocket.lastCollision < 35) {
      ctx.globalAlpha = 0.7 * (1 - (tick - rocket.lastCollision) / 35);
      ctx.beginPath();
      ctx.arc(0, 0, this.reduced ? 1.35 : 1.22 + (tick - rocket.lastCollision) / 38, 0, 2 * Math.PI);
      ctx.strokeStyle = '#fea5a5';
      ctx.stroke();
    }
    ctx.restore();
    ctx.font = '700 11px Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(label, x, y - scale * 1.64 - 4, 110);
  }
}

export function drawRacePreview(canvas: HTMLCanvasElement) {
  const config = { seed: 31_798, difficulty: 'normal', rockets: 4 } as const;
  const race = createRace(config);
  const offsets = [[275, 990], [420, 1_240], [343, 830], [173, 1_055]];
  for (const rocket of race.rockets) {
    [rocket.x, rocket.z] = offsets[rocket.id];
    rocket.previousX = rocket.x;
    rocket.previousZ = rocket.z;
  }
  race.rockets[0].boostUntil = 100;
  race.tick = 49;
  const renderer = new RaceRenderer(canvas, config.seed, false, true);
  const resize = () => {
    renderer.resize(canvas.clientWidth, canvas.clientHeight);
    renderer.draw(race, 1);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  return () => observer.disconnect();
}
