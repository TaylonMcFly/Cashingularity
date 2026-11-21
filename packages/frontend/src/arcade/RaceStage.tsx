import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { TICK_RATE, type InputRun, type RaceConfig, type RaceResult } from '@cashingularity/shared/rocket-race';
import { RaceControls } from './raceInput.js';
import { RaceSession, FixedFrameClock } from './raceSession.js';
import { RaceRenderer } from './renderer.js';
import { RaceBoard, RaceFooter, RaceHud, RACE_MOTION_QUERY, useRaceTouch } from './RaceDisplay.js';
import type { ArcadePreferences } from './raceStorage.js';
import type { RaceAudio } from './raceAudio.js';
const HUD_INTERVAL = 105;

function readHud(session: RaceSession) {
  const { race } = session;
  const rocket = race.rockets[0];
  return {
    phase: session.phase, countdown: Math.ceil(session.countdown / TICK_RATE), tick: race.tick,
    speed: race.tick ? Math.round(rocket.speed * 3.6) : 0, progress: Math.min(race.track.length, Math.round(rocket.z)),
    distance: Math.max(0, Math.ceil(race.track.length - rocket.z)), length: race.track.length,
    place: race.order.indexOf(rocket) + 1, charges: rocket.charges, streak: rocket.streak,
    dodges: rocket.dodges, collisions: rocket.collisions, boosting: race.tick < rocket.boostUntil,
    standings: race.order.map(pilot => ({ id: pilot.id, remaining: Math.max(0, Math.ceil(race.track.length - pilot.z)) })),
  };
}

interface Props {
  config: RaceConfig;
  preferences: ArcadePreferences;
  audio: RaceAudio | null;
  onFinish: (result: RaceResult, replay: InputRun[]) => void;
  onRestart: () => void;
}

export function RaceStage({ config, preferences, audio, onFinish, onRestart }: Props) {
  const [session] = useState(() => new RaceSession(config));
  const [controls] = useState(() => new RaceControls(preferences.keys, preferences.desktopSensitivity, preferences.touchSensitivity));
  const [hud, setHud] = useState(() => readHud(session));
  const touch = useRaceTouch();
  const [error, setError] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const flipPause = useRef<() => void>(() => {});
  const complete = useRef(onFinish);
  complete.current = onFinish;

  useEffect(() => {
    const root = stage.current;
    const host = field.current;
    const surface = canvas.current;
    if (!root || !host || !surface) return;
    const motion = matchMedia(RACE_MOTION_QUERY);
    let renderer: RaceRenderer;
    try {
      renderer = new RaceRenderer(surface, config.seed, preferences.lowQuality, preferences.reducedEffects || motion.matches);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The race canvas is unavailable.');
      return;
    }
    const clock = new FixedFrameClock();
    let animation = 0;
    let lastHud = -HUD_INTERVAL;
    let completed = false;
    const player = session.race.rockets[0];
    const draw = (alpha = 1) => { if (!document.hidden) renderer.draw(session.race, alpha); };
    const syncHud = () => setHud(readHud(session));
    const resize = () => { renderer.resize(host.clientWidth, host.clientHeight); draw(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const onMotionChange = () => { renderer.setReducedMotion(preferences.reducedEffects || motion.matches); draw(); };

    const stop = () => {
      cancelAnimationFrame(animation);
      animation = 0;
      clock.reset();
    };
    const step = () => {
      const countdown = session.countdown;
      const lastBoost = player.lastBoost;
      const lastCollision = player.lastCollision;
      const earned = player.boostsEarned;
      session.step(controls.read);
      if (countdown !== session.countdown && session.countdown % TICK_RATE === 0) audio?.cue(session.countdown ? 'countdown' : 'start');
      if (lastBoost !== player.lastBoost) audio?.cue('boost');
      if (lastCollision !== player.lastCollision) audio?.cue('collision');
      if (earned !== player.boostsEarned) audio?.cue('charge');
    };
    const frame = (now: number) => {
      animation = 0;
      if (document.hidden || session.phase === 'paused') return;
      const phase = session.phase;
      draw(clock.advance(now, step));
      if (phase !== session.phase || now - lastHud >= HUD_INTERVAL) {
        lastHud = now;
        syncHud();
      }
      if (session.race.result && !completed) {
        draw();
        completed = true;
        audio?.cue('finish');
        complete.current(session.race.result, session.replay);
        return;
      }
      if (!completed) animation = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!animation && !completed && !document.hidden) animation = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (!session.pause()) return;
      controls.clear();
      stop();
      draw();
      syncHud();
    };
    flipPause.current = () => {
      if (session.resume()) {
        controls.clear();
        host.focus({ preventScroll: true });
        audio?.unlock();
        start();
        syncHud();
      } else {
        pause();
      }
    };
    const visibility = () => {
      if (document.hidden) pause();
      else draw();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
      if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.code === 'Escape') {
        if (!event.repeat) flipPause.current();
        event.preventDefault();
      } else if (session.phase !== 'paused' && session.phase !== 'finished' &&
          !event.target.closest('button,a,summary') && controls.keyDown(event.code, event.repeat)) {
        event.preventDefault();
      }
    };
    const release = (event: KeyboardEvent) => { controls.keyUp(event.code); };
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) controls.clearKeys();
    };
    root.addEventListener('keydown', keyDown);
    root.addEventListener('focusout', focusOut);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', onMotionChange);
    if (!document.hidden) {
      host.focus({ preventScroll: true });
      audio?.cue('countdown');
      start();
    } else {
      pause();
    }
    return () => {
      stop();
      observer.disconnect();
      root.removeEventListener('keydown', keyDown);
      root.removeEventListener('focusout', focusOut);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', pause);
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', onMotionChange);
      controls.clear();
      flipPause.current = () => {};
      surface.width = surface.height = 1;
    };
  }, [session, controls, config.seed, preferences.lowQuality, preferences.reducedEffects, audio]);

  useEffect(() => {
    if (hud.phase === 'paused' && stage.current?.contains(document.activeElement)) resumeButton.current?.focus({ preventScroll: true });
  }, [hud.phase]);

  if (error) return <p role="alert" className="race-notice">{error}</p>;
  const active = hud.phase === 'racing' || hud.phase === 'countdown';
  const keys = preferences.keys === 'wasd' ? 'WASD' : preferences.keys === 'arrows' ? 'Arrow keys' : 'WASD or arrows';
  const description = touch
    ? 'Steer sideways. Push up for thrust or down to brake.'
    : `${keys} to steer and adjust thrust. Space to boost. Esc to pause.`;
  const style = { '--pad-size': `${preferences.touchSize}px`, '--pad-inset': `${preferences.touchInset}px` } as CSSProperties;

  return <div ref={stage} className="race-game" data-phase={hud.phase} data-touch={touch}
    data-handed={preferences.leftHanded ? 'left' : 'right'} style={style}>
    <div className="race-toolbar">
      <div className="race-toolbar-status"><span className="race-status-dot" data-active={active} />
        {hud.phase === 'countdown' ? 'Starting grid' : hud.phase === 'paused' ? 'Paused' : 'Race in progress'}
      </div>
      <button type="button" className="btn" onClick={() => flipPause.current()}>
        {hud.phase === 'paused' ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
        {hud.phase === 'paused' ? 'Resume race' : 'Pause race'}
      </button>
      <button type="button" className="btn" onClick={onRestart}><RotateCcw size={15} aria-hidden="true" />Restart <span className="race-restart-more">course</span></button>
    </div>

    <RaceHud hud={hud} rockets={config.rockets} />
    <RaceBoard field={field} canvas={canvas} controls={controls} touch={touch} method={preferences.touch}
      active={hud.phase === 'racing'} charges={hud.charges} boosting={hud.boosting}>
        {hud.phase === 'countdown' && <div className="race-stage-overlay race-countdown" role="status" aria-atomic="true">
          <span>Launch in</span><strong key={hud.countdown}>{hud.countdown}</strong>
        </div>}
        {hud.phase === 'racing' && hud.tick < 31 && <div className="race-stage-overlay race-countdown" role="status">
          <strong>GO</strong>
        </div>}
        {hud.phase === 'paused' && <div className="race-stage-overlay race-paused">
          <div><Pause size={23} aria-hidden="true" /><h2>Race paused</h2>
            <button ref={resumeButton} type="button" className="btn btn-primary" onClick={() => flipPause.current()}><Play size={16} aria-hidden="true" />Resume</button>
          </div>
        </div>}
    </RaceBoard>
    <RaceFooter hud={hud} description={description} />
  </div>;
}
