type Cue = 'countdown' | 'start' | 'boost' | 'charge' | 'collision' | 'finish';

const cues: Record<Cue, [number, number, number, OscillatorType]> = {
  countdown: [440, 440, 0.08, 'sine'],
  start: [523, 890, 0.17, 'triangle'],
  boost: [210, 870, 0.24, 'triangle'],
  charge: [600, 980, 0.12, 'sine'],
  collision: [152, 43, 0.19, 'triangle'],
  finish: [480, 790, 0.29, 'sine'],
};

export class RaceAudio {
  private context: AudioContext | null = null;

  constructor(private readonly volume: number) {}

  unlock() {
    if (typeof AudioContext === 'undefined' || this.volume <= 0) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
    } catch {
      // A blocked or unavailable audio device leaves the race playable.
    }
  }

  cue(name: Cue) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    const [from, to, length, type] = cues[name];
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const amp = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + length);
    amp.gain.setValueAtTime(0.001, now);
    amp.gain.linearRampToValueAtTime(this.volume / 1_400, now + 0.014);
    amp.gain.exponentialRampToValueAtTime(0.001, now + length);
    oscillator.connect(amp).connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + length);
    oscillator.onended = () => { oscillator.disconnect(); amp.disconnect(); };
  }

  dispose() {
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}
