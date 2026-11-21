import { clamp, type RaceInput } from '@cashingularity/shared/rocket-race';

export type DesktopKeys = 'both' | 'wasd' | 'arrows';
export type TouchScheme = 'joystick' | 'drag';

const WASD = ['KeyA', 'KeyD', 'KeyW', 'KeyS'];
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

export class RaceControls {
  private readonly pressed = new Set<string>();
  private readonly keys: string[];
  private pointer: number | null = null;
  private x = 0;
  private y = 0;
  private boostPressed = false;
  private readonly input: RaceInput = { steer: 0, throttle: 0, boost: false };

  constructor(keys: DesktopKeys, private readonly desktopSensitivity: number, private readonly touchSensitivity: number) {
    this.keys = keys === 'wasd' ? WASD : keys === 'arrows' ? ARROWS : [...WASD, ...ARROWS];
  }

  keyDown(code: string, repeat = false) {
    if (code === 'Space') {
      if (!repeat && !this.pressed.has(code)) this.requestBoost();
    } else if (!this.keys.includes(code)) {
      return false;
    }
    this.pressed.add(code);
    return true;
  }

  keyUp(code: string) {
    return this.pressed.delete(code);
  }

  requestBoost() {
    this.boostPressed = true;
  }

  beginPointer(id: number) {
    if (this.pointer !== null) return false;
    this.pointer = id;
    return true;
  }

  movePointer(id: number, x: number, y: number) {
    if (this.pointer !== id) return false;
    const scale = Math.max(1, Math.hypot(x, y));
    this.x = x / scale;
    this.y = y / scale;
    return true;
  }

  endPointer(id: number) {
    if (this.pointer !== id) return false;
    this.pointer = null;
    this.x = 0;
    this.y = 0;
    return true;
  }

  clearKeys() {
    this.pressed.clear();
    this.boostPressed = false;
  }

  clear() {
    this.clearKeys();
    if (this.pointer !== null) this.endPointer(this.pointer);
  }

  read = () => {
    const has = (code1: string, code2: string) => Number(this.pressed.has(code1) || this.pressed.has(code2));
    const horizontal = has('KeyD', 'ArrowRight') - has('KeyA', 'ArrowLeft');
    const vertical = has('KeyW', 'ArrowUp') - has('KeyS', 'ArrowDown');
    const steer = horizontal * 0.8 * this.desktopSensitivity + this.x * this.touchSensitivity;
    const throttle = vertical - this.y * this.touchSensitivity;
    this.input.steer = Math.round(clamp(steer, -1, 1) * 100);
    this.input.throttle = Math.round(clamp(throttle, -1, 1) * 100);
    this.input.boost = this.boostPressed;
    this.boostPressed = false;
    return this.input;
  };
}
