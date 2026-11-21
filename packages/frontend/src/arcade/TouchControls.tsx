import { useEffect, useRef, type PointerEvent } from 'react';
import { Move, Zap } from 'lucide-react';
import type { RaceControls } from './raceInput.js';

interface PointerOrigin {
  id: number;
  x: number;
  y: number;
  radius: number;
}

export function useTouchSteering(controls: RaceControls, enabled: boolean, centered: boolean) {
  const origin = useRef<PointerOrigin>();
  const knob = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!enabled && origin.current) {
      controls.endPointer(origin.current.id);
      origin.current = undefined;
      if (knob.current) knob.current.style.transform = '';
    }
  }, [controls, enabled]);
  function move(event: PointerEvent<HTMLElement>) {
    const start = origin.current;
    if (start?.id !== event.pointerId) return;
    const x = (event.clientX - start.x) / start.radius;
    const y = (event.clientY - start.y) / start.radius;
    if (!controls.movePointer(event.pointerId, x, y)) return;
    if (knob.current) {
      const magnitude = Math.max(1, Math.hypot(x, y));
      knob.current.style.transform = `translate(${x / magnitude * start.radius}px, ${y / magnitude * start.radius}px)`;
    }
  }

  function finish(event: PointerEvent<HTMLElement>) {
    if (origin.current?.id !== event.pointerId) return;
    origin.current = undefined;
    controls.endPointer(event.pointerId);
    if (knob.current) knob.current.style.transform = '';
  }

  return {
    knob,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (!enabled || event.button !== 0 || (!centered && event.pointerType === 'mouse')) return;
        if (!controls.beginPointer(event.pointerId)) return;
        const target = event.currentTarget;
        const bounds = target.getBoundingClientRect();
        origin.current = {
          id: event.pointerId,
          x: centered ? bounds.left + bounds.width / 2 : event.clientX,
          y: centered ? bounds.top + bounds.height / 2 : event.clientY,
          radius: centered ? Math.max(16, bounds.width * 0.35) : 68,
        };
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          origin.current = undefined;
          controls.endPointer(event.pointerId);
          return;
        }
        event.preventDefault();
        move(event);
      },
      onPointerMove: move,
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
    },
  };
}

export function TouchControls({ controls, joystick, enabled, charges, boosting }: {
  controls: RaceControls;
  joystick: boolean;
  enabled: boolean;
  charges: number;
  boosting: boolean;
}) {
  const pad = useTouchSteering(controls, enabled, true);
  return <>
    <div className="race-steering-deck">
      {joystick ? <div className="race-joystick" role="group" aria-label="Touch joystick" {...pad.handlers}>
        <span className="race-joystick-ring" aria-hidden="true" />
        <span className="race-joystick-knob" ref={pad.knob} aria-hidden="true"><Move size={21} /></span>
      </div> : <span className="race-drag-hint"><Move size={16} aria-hidden="true" /> Drag on the track</span>}
    </div>
    <div className="race-boost-deck">
      <button type="button" className="race-boost-button" aria-label={`Boost · ${charges} charged`}
        data-ready={charges > 0} data-boosting={boosting} disabled={!enabled || charges === 0 || boosting}
        onPointerDown={event => { event.preventDefault(); controls.requestBoost(); }}
        onClick={event => { if (event.detail === 0) controls.requestBoost(); }}>
        <Zap size={25} aria-hidden="true" /><strong>Boost</strong><small>{boosting ? 'Active' : `${charges} ready`}</small>
      </button>
    </div>
  </>;
}
