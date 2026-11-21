import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Flag, Gauge, Zap } from 'lucide-react';
import { DODGES_PER_BOOST, ticksToMs } from '@cashingularity/shared/rocket-race';
import type { RaceControls, TouchScheme } from './raceInput.js';
import { TouchControls, useTouchSteering } from './TouchControls.js';
import { PILOT_COLORS, PILOT_NAMES } from './renderer.js';
import { formatRaceTime } from './raceFormat.js';

const TOUCH_QUERY = '(pointer: coarse), (max-width: 768px)';
export const RACE_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function useRaceTouch() {
  const [touch, setTouch] = useState(() => matchMedia(TOUCH_QUERY).matches);
  useEffect(() => {
    const query = matchMedia(TOUCH_QUERY);
    const update = () => setTouch(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return touch;
}

export function RaceBoard({ field, canvas, controls, touch, method, active, charges, boosting, children }: {
  field: RefObject<HTMLDivElement>; canvas: RefObject<HTMLCanvasElement>; controls: RaceControls;
  touch: boolean; method: TouchScheme; active: boolean; charges: number; boosting: boolean; children?: ReactNode;
}) {
  const drag = useTouchSteering(controls, touch && method === 'drag' && active, false);
  return <div className="race-board">
    <div ref={field} className="race-field" tabIndex={0} aria-label="Rocket Race track" aria-describedby="race-instructions"
      {...drag.handlers} onPointerDown={event => {
        if (event.target !== canvas.current && event.target !== field.current) return;
        field.current?.focus({ preventScroll: true });
        drag.handlers.onPointerDown(event);
      }}>
      <canvas ref={canvas} aria-label="Scrolling space race with rockets and asteroids" role="img" />
      {children}
    </div>
    {touch && <TouchControls controls={controls} joystick={method === 'joystick'} enabled={active} charges={charges} boosting={boosting} />}
  </div>;
}

export interface Telemetry {
  speed: number; place: number; distance: number; tick: number; charges: number; boosting: boolean; progress: number; length: number;
}

export function RaceHud({ hud, rockets }: { hud: Telemetry; rockets: number }) {
  return <>
    <div className="race-hud" aria-label="Race telemetry">
      <div><span><Gauge size={13} aria-hidden="true" /> Speed</span><strong>{hud.speed} <small>km/h</small></strong></div>
      <div><span>Place</span><strong>{hud.place}<small> / {rockets}</small></strong></div>
      <div><span><Flag size={13} aria-hidden="true" /> To finish</span><strong>{(hud.distance / 1_000).toFixed(2)} <small>km</small></strong></div>
      <div><span>Time</span><strong data-race-tick={hud.tick}>{formatRaceTime(ticksToMs(hud.tick), 1)}</strong></div>
      <div className="race-hud-charge"><span><Zap size={13} aria-hidden="true" /> Boost</span><strong>{hud.boosting ? 'Active' : hud.charges}</strong></div>
    </div>
    <progress className="race-progress" aria-label="Player race progress" value={hud.progress} max={hud.length} />
  </>;
}

export function RaceFooter({ hud, description, seat = 0 }: {
  hud: { streak: number; dodges: number; collisions: number;
    standings: { id: number; remaining: number; name?: string; retired?: boolean; finish?: number; reconnecting?: boolean }[] };
  description: string;
  seat?: number;
}) {
  return <>
    <footer className="race-track-footer">
      <div className="race-streak" aria-label={`Dodge streak ${hud.streak} of ${DODGES_PER_BOOST}`}>
        <span>Dodge streak</span>
        {Array.from({ length: DODGES_PER_BOOST }, (_, i) => <i key={i} data-filled={i < hud.streak} />)}
        <small>{hud.dodges} dodged · {hud.collisions} hit</small>
      </div>
      <p id="race-instructions">{description}</p>
    </footer>
    <ol className="race-live-order" aria-label="Live race order">
      {hud.standings.map((pilot, index) => <li key={pilot.id} data-pilot={pilot.id} data-player={pilot.id === seat}>
        <span>{index + 1}</span><span className="race-pilot-dot" style={{ background: PILOT_COLORS[pilot.id] }} />
        <strong title={pilot.name}>{pilot.name ?? PILOT_NAMES[pilot.id]}</strong>
        <small>{pilot.retired ? 'Retired' : pilot.finish !== undefined ? formatRaceTime(pilot.finish)
          : pilot.reconnecting ? 'Reconnecting' : `${(pilot.remaining / 1_000).toFixed(2)} km left`}</small>
      </li>)}
    </ol>
  </>;
}
