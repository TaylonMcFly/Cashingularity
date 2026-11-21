import { useState, type CSSProperties } from 'react';
import { Gamepad2, Keyboard, MonitorCog, Smartphone, UserRound } from 'lucide-react';
import { normalizeNickname } from '@cashingularity/shared/rocket-race';
import { defaultPreferences, type ArcadePreferences } from './raceStorage.js';

export function ArcadeSettings({ preferences, update }: {
  preferences: ArcadePreferences;
  update: (patch: Partial<ArcadePreferences>) => boolean;
}) {
  const [nickname, setNickname] = useState(preferences.nickname);
  const [message, setMessage] = useState('');
  const [nameError, setNameError] = useState(false);
  const save = (patch: Partial<ArcadePreferences>) => {
    const saved = update(patch);
    setNameError(false);
    setMessage(saved ? 'Preferences saved.' : 'Browser storage is unavailable. Changes apply for this visit.');
  };

  const controlsStyle = { '--preview-pad-size': `${preferences.touchSize}px`, '--preview-inset': `${preferences.touchInset}px` } as CSSProperties;
  return <div className="arcade-settings">
    <header className="arcade-page-heading"><h2>Arcade settings</h2><p>Tune Rocket Race controls, visuals, and sound on this device.</p></header>
    <section className="arc-card">
      <h3><UserRound size={18} aria-hidden="true" /> Pilot identity</h3>
      <form className="arcade-name-form" onSubmit={event => {
        event.preventDefault();
        const name = normalizeNickname(nickname);
        if (!name) { setNameError(true); setMessage('Use 2–20 letters, numbers, spaces, dashes, or underscores.'); return; }
        setNickname(name);
        save({ nickname: name });
      }}>
        <label>Pilot nickname<input className="input-field" value={nickname} onChange={event => setNickname(event.target.value)}
          maxLength={40} required aria-invalid={nameError} autoComplete="off" /></label>
        <button className="btn">Save nickname</button>
      </form>
    </section>
    <div className="arcade-control-settings">
      <section className="arc-card">
        <h3><Keyboard size={19} aria-hidden="true" /> Desktop controls</h3>
        <label>Movement keys<select className="select-field" value={preferences.keys}
          onChange={event => save({ keys: event.target.value as ArcadePreferences['keys'] })}>
          <option value="both">WASD and arrows</option><option value="wasd">WASD</option><option value="arrows">Arrow keys</option>
        </select></label>
        <label className="arcade-range"><span>Steering sensitivity <output>{Math.round(preferences.desktopSensitivity * 100)}%</output></span>
          <input aria-label="Desktop steering sensitivity" type="range" min={0.5} max={1.5} step={0.05}
            value={preferences.desktopSensitivity} onChange={event => save({ desktopSensitivity: Number(event.target.value) })} />
        </label>
        <p>Space activates a boost. Esc pauses or resumes while the race has focus.</p>
      </section>
      <section className="arc-card">
        <h3><Smartphone size={19} aria-hidden="true" /> Mobile controls</h3>
        <div className="arcade-setting-row">
          <label>Steering method<select className="select-field" value={preferences.touch}
            onChange={event => save({ touch: event.target.value as ArcadePreferences['touch'] })}>
            <option value="joystick">Virtual joystick</option><option value="drag">Drag on the track</option>
          </select></label>
          <label>Boost hand<select className="select-field" value={preferences.leftHanded ? 'left' : 'right'}
            onChange={event => save({ leftHanded: event.target.value === 'left' })}>
            <option value="right">Right hand</option><option value="left">Left hand</option>
          </select></label>
        </div>
        <label className="arcade-range"><span>Touch sensitivity <output>{Math.round(preferences.touchSensitivity * 100)}%</output></span>
          <input aria-label="Touch steering sensitivity" type="range" min={0.5} max={1.5} step={0.05}
            value={preferences.touchSensitivity} onChange={event => save({ touchSensitivity: Number(event.target.value) })} />
        </label>
        <label className="arcade-range"><span>Control size <output>{preferences.touchSize} px</output></span>
          <input aria-label="Touch control size" type="range" min={72} max={132} step={4} value={preferences.touchSize}
            onChange={event => save({ touchSize: Number(event.target.value) })} />
        </label>
        <label className="arcade-range"><span>Distance from screen edge <output>{preferences.touchInset} px</output></span>
          <input aria-label="Touch control inset" type="range" min={0} max={32} step={2} value={preferences.touchInset}
            onChange={event => save({ touchInset: Number(event.target.value) })} />
        </label>
        <div className="arcade-control-preview" data-left-handed={preferences.leftHanded} style={controlsStyle}
          aria-label={`Control preview, boost on the ${preferences.leftHanded ? 'left' : 'right'}`}>
          <span>{preferences.touch === 'joystick' ? 'Steer' : 'Drag'}</span><span>Boost</span>
        </div>
      </section>
    </div>
    <section className="arc-card arcade-display-settings">
      <h3><MonitorCog size={19} aria-hidden="true" /> Display and sound</h3>
      <div className="arcade-setting-row">
        <label>Rendering quality<select className="select-field" value={preferences.lowQuality ? 'low' : 'standard'}
          onChange={event => save({ lowQuality: event.target.value === 'low' })}>
          <option value="standard">Standard</option><option value="low">Low · fewer effects</option>
        </select></label>
        <label className="arcade-range"><span>Sound volume <output>{preferences.volume}%</output></span>
          <input aria-label="Sound volume" type="range" min={0} max={100} step={5} value={preferences.volume}
            disabled={!preferences.sound} onChange={event => save({ volume: Number(event.target.value) })} />
        </label>
      </div>
      <label className="arcade-check"><input type="checkbox" checked={preferences.sound} onChange={event => save({ sound: event.target.checked })} />Play race sounds</label>
      <label className="arcade-check"><input type="checkbox" checked={preferences.reducedEffects}
        onChange={event => save({ reducedEffects: event.target.checked })} />Reduce motion and flashes</label>
      <label className="arcade-check"><input type="checkbox" checked={preferences.showMarket}
        onChange={event => save({ showMarket: event.target.checked })} />Show the BCH market widget on desktop</label>
    </section>
    <div className="race-setup-actions">
      <button type="button" className="btn" onClick={() => { setNickname(defaultPreferences.nickname); save(defaultPreferences); }}><Gamepad2 size={16} aria-hidden="true" /> Restore defaults</button>
      <span className="arcade-settings-feedback" role={nameError ? 'alert' : 'status'}>{message}</span>
    </div>
  </div>;
}
