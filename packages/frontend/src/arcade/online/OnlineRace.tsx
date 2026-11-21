import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ONLINE_STEP_MS, TICK_RATE, TRACK_LENGTH, type OnlineSnapshot, type RoomView } from '@cashingularity/shared/rocket-race';
import { RaceBoard, RaceFooter, RaceHud, RACE_MOTION_QUERY, useRaceTouch } from '../RaceDisplay.js';
import { RaceControls } from '../raceInput.js';
import type { RaceAudio } from '../raceAudio.js';
import { FixedFrameClock } from '../raceSession.js';
import type { ArcadePreferences } from '../raceStorage.js';
import { RaceRenderer } from '../renderer.js';
import { formatRaceTime } from '../raceFormat.js';
import type { OnlineConnection, OnlineView } from './connection.js';
import { OnlineMotion } from './motion.js';

type Game = NonNullable<RoomView['game']>;
function hudFor(game: Game, seat: number, sample?: OnlineSnapshot) {
  const ship = sample?.ships[seat];
  const order = sample?.order ?? game.grid.map(pilot => pilot.seat);
  const progress = Math.min(TRACK_LENGTH, Math.round((ship?.[1] ?? 0) / 10));
  return {
    tick: sample?.tick ?? 0, speed: sample?.tick && ship ? Math.round(ship[3] * 0.36) : 0,
    progress, length: TRACK_LENGTH, distance: TRACK_LENGTH - progress, place: order.indexOf(seat) + 1,
    finish: ship?.[13] || undefined,
    charges: ship?.[4] ?? 0, streak: ship?.[5] ?? 0, dodges: ship?.[6] ?? 0, collisions: ship?.[7] ?? 0,
    boosting: !!ship && (sample?.tick ?? 0) < ship[11],
    standings: order.map(id => ({
      id, name: seat === id ? 'You' : game.grid[id].name,
      remaining: Math.max(0, Math.round(TRACK_LENGTH - (sample?.ships[id]?.[1] ?? 0) / 10)),
      retired: sample?.ships[id]?.[12] === 1,
      finish: sample?.ships[id]?.[13] || undefined,
    })),
  };
}

export function OnlineRace({ game, seat, phase, status, client, preferences, audio, members }: {
  game: Game; seat: number; phase: 'countdown' | 'racing'; status: OnlineView['status']; client: OnlineConnection;
  preferences: ArcadePreferences; audio: RaceAudio | null; members: RoomView['members'];
}) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [controls] = useState(() => new RaceControls(preferences.keys, preferences.desktopSensitivity, preferences.touchSensitivity));
  const [motion] = useState(() => new OnlineMotion(game.config, seat));
  const [hud, setHud] = useState(() => hudFor(game, seat));
  const [countdown, setCountdown] = useState(3);
  const [error, setError] = useState('');
  const live = useRef({ phase, status, deadline: performance.now() + game.startsInMs });
  const touch = useRaceTouch();
  useEffect(() => {
    live.current = { phase, status, deadline: performance.now() + game.startsInMs };
    if (status !== 'online') { controls.clear(); motion.forgetPrediction(); }
  }, [phase, status, game.startsInMs, controls, motion]);

  useEffect(() => {
    const stage = root.current;
    const host = field.current;
    const surface = canvas.current;
    if (!stage || !host || !surface) return;
    const media = matchMedia(RACE_MOTION_QUERY);
    const { lowQuality, reducedEffects } = preferences;
    let renderer: RaceRenderer;
    try { renderer = new RaceRenderer(surface, game.config.seed, lowQuality, reducedEffects || media.matches); } catch {
      setError('The race canvas is unavailable.');
      return;
    }
    const names = game.grid.map(pilot => pilot.name);
    const clock = new FixedFrameClock();
    let request = 0;
    let lastHud = -Infinity;
    let queuedBoostUntil = 0;
    let cue = 3;
    const draw = (now: number, fraction: number) => {
      if (!document.hidden) renderer.draw(motion.paint(now, fraction), 1, seat, names);
    };
    const resize = () => { renderer.resize(host.clientWidth, host.clientHeight); draw(performance.now(), 1); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const onMotion = () => { renderer.setReducedMotion(reducedEffects || media.matches); draw(performance.now(), 1); };
    media.addEventListener('change', onMotion);
    const unwatch = client.watch(sample => {
      if (sample.race !== game.id || document.hidden) return;
      const previous = motion.sample?.ships[seat];
      const next = sample.ships[seat];
      if (previous) {
        if (next[9] > previous[9]) audio?.cue('collision');
        if (next[10] > previous[10]) audio?.cue('boost');
        if (next[8] > previous[8]) audio?.cue('charge');
      }
      motion.accept(sample, performance.now());
    });

    function frame(now: number) {
      request = 0;
      if (document.hidden) return;
      const fraction = clock.advance(now, () => {
        if (live.current.phase !== 'racing' || live.current.status !== 'online' || motion.sample?.ships[seat][13]) return;
        const input = controls.read();
        if (input.boost) queuedBoostUntil = now + 550;
        const boost = now < queuedBoostUntil;
        const seq = client.sendControls(input.steer, input.throttle, boost, now);
        if (boost && seq !== null) queuedBoostUntil = 0;
        motion.advance(input.steer, input.throttle, boost ? seq : null);
      });
      draw(now, fraction);
      if (now - lastHud >= 90) {
        lastHud = now;
        setHud(hudFor(game, seat, motion.sample));
        const next = live.current.phase === 'countdown' ? Math.max(1, Math.ceil((live.current.deadline - now) / (TICK_RATE * ONLINE_STEP_MS))) : 0;
        if (next !== cue) {
          if (live.current.status === 'online') audio?.cue(next ? 'countdown' : 'start');
          setCountdown(cue = next);
        }
      }
      request = requestAnimationFrame(frame);
    }

    const neutral = () => {
      controls.clear();
      queuedBoostUntil = 0;
      client.idle();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (live.current.status !== 'online' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented ||
        !(event.target instanceof HTMLElement) || event.target.closest('input,textarea,select,button,a,summary,[contenteditable]')) return;
      if (controls.keyDown(event.code, event.repeat)) event.preventDefault();
    };
    const keyUp = (event: KeyboardEvent) => { controls.keyUp(event.code); };
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !stage.contains(event.relatedTarget)) neutral();
    };
    const visibility = () => {
      if (document.hidden) {
        neutral();
        motion.forgetPrediction();
        cancelAnimationFrame(request);
        request = 0;
        clock.reset();
      } else if (!request) request = requestAnimationFrame(frame);
    };
    stage.addEventListener('keydown', keyDown);
    stage.addEventListener('focusout', focusOut);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', neutral);
    document.addEventListener('visibilitychange', visibility);
    host.focus({ preventScroll: true });
    visibility();

    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      unwatch();
      media.removeEventListener('change', onMotion);
      stage.removeEventListener('keydown', keyDown);
      stage.removeEventListener('focusout', focusOut);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', neutral);
      document.removeEventListener('visibilitychange', visibility);
      neutral();
      surface.width = surface.height = 1;
    };
    // A race ID owns this renderer. Status and countdown changes update live.current.
  }, [client, controls, motion, preferences, game.id, seat, audio]);

  if (error) return <p role="alert" className="race-notice">{error}</p>;
  const playing = phase === 'racing' && status === 'online' && hud.finish === undefined;
  const order = { ...hud, standings: hud.standings.map(pilot => {
    const id = game.grid[pilot.id].id;
    return { ...pilot, reconnecting: !!id && members.some(member => member.id === id && !member.connected) };
  }) };
  const style = { '--pad-size': `${preferences.touchSize}px`, '--pad-inset': `${preferences.touchInset}px` } as CSSProperties;
  return <div ref={root} className="race-game online-race" data-race-id={game.id} data-phase={phase} data-touch={touch}
    data-handed={preferences.leftHanded ? 'left' : 'right'} style={style}>
    <RaceHud hud={hud} rockets={game.config.rockets} />
    <RaceBoard field={field} canvas={canvas} controls={controls} touch={touch} method={preferences.touch}
      active={playing} charges={hud.charges} boosting={hud.boosting}>
      {status !== 'online' ? <div className="race-stage-overlay race-paused" role="status">
        <div><h2>Reconnecting</h2><p>Your race continues on the server.</p></div>
      </div> : phase === 'countdown' ? <div className="race-stage-overlay race-countdown" role="status">
        <span>Launch in</span><strong key={countdown}>{countdown}</strong>
      </div> : hud.finish !== undefined ? <div className="race-stage-overlay race-paused" role="status">
        <div><h2>Finished · {formatRaceTime(hud.finish)}</h2><p>Waiting for the pilots still on course.</p></div>
      </div> : hud.tick < 28 && <div className="race-stage-overlay race-countdown"><strong>GO</strong></div>}
    </RaceBoard>
    <RaceFooter hud={order} seat={seat} description={touch ? 'Steer and change thrust with touch.' : 'Steer with WASD or arrows. Space boosts.'} />
  </div>;
}
