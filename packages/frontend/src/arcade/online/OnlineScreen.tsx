import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Flag, Globe2, LogOut, Plus, Radio, RotateCcw, Trophy, Users } from 'lucide-react';
import { DIFFICULTIES, ROOM_CODE, type Difficulty, type GridSize, type RoomView } from '@cashingularity/shared/rocket-race';
import type { ArcadeView } from '../../services/workspaceRoutes.js';
import { ArcadeLink } from '../ArcadeLink.js';
import { RaceAudio } from '../raceAudio.js';
import { DIFFICULTY_LABELS, formatRaceTime } from '../raceFormat.js';
import type { ArcadePreferences } from '../raceStorage.js';
import { PILOT_COLORS } from '../renderer.js';
import { initialOnlineView, OnlineConnection, type OnlineView } from './connection.js';
import { OnlineRace } from './OnlineRace.js';
import './online.css';

function LinkStatus({ view }: { view: OnlineView }) {
  const label = { idle: 'Not connected', connecting: 'Connecting…', online: 'Connected', reconnecting: 'Reconnecting…' }[view.status];
  const quality = view.rtt === undefined ? '' : view.rtt < 90 ? 'Good' : view.rtt < 180 ? 'Moderate' : 'High latency';
  return <div className="online-link-status" data-status={view.status} aria-label="Connection quality">
    <Radio size={16} aria-hidden="true" /><strong role="status">{label}</strong>{view.rtt !== undefined && <small>{quality} · {view.rtt} ms</small>}
  </div>;
}

function Lobby({ room, view, client, ready }: { room: RoomView; view: OnlineView; client: OnlineConnection; ready: () => void }) {
  const [copied, setCopied] = useState('');
  const me = room.members.find(member => member.id === view.pilot?.id);
  const required = room.bots ? 2 : room.size;
  return <section className="arc-card online-lobby" aria-label="Race lobby">
    <div className="online-card-title"><div><h2>{room.private ? 'Private room' : 'Public lobby'}</h2>
      <p>{DIFFICULTY_LABELS[room.difficulty]} · {room.members.length}/{room.size} human seats</p></div>
      <button type="button" className="btn online-code" aria-label="Copy invite code" onClick={async () => {
        try { await navigator.clipboard.writeText(room.code); setCopied('Invite code copied.'); }
        catch { setCopied(`Invite code ${room.code}`); }
      }}><code data-room-code={room.code}>{room.code}</code><Copy size={15} aria-hidden="true" /></button>
    </div>
    {copied && <p role="status">{copied}</p>}
    <ul className="online-members" aria-label="Room participants">
      {Array.from({ length: room.size }, (_, index) => {
        const member = room.members[index];
        return <li key={member?.id ?? index}>
          <span className="race-pilot-dot" style={{ background: PILOT_COLORS[index] }} />
          <strong>{member?.name ?? (room.bots ? 'Open seat · AI if empty' : 'Open seat')}</strong>
          {member?.id === me?.id && member && <span className="race-pill">You</span>}
          <small data-online={member?.connected}>{member ? !member.connected ? 'Reconnecting' : member.ready ? 'Ready' : 'Connected' : 'Waiting'}</small>
        </li>;
      })}
    </ul>
    <p>{room.members.length < required
      ? `Waiting for ${required - room.members.length} more ${required - room.members.length === 1 ? 'pilot' : 'pilots'}.`
      : 'The countdown starts when every pilot is connected and ready.'}</p>
    <div className="race-setup-actions">
      <button type="button" className={`btn${me?.ready ? '' : ' btn-primary'}`} disabled={view.status !== 'online'}
        aria-pressed={!!me?.ready} onClick={ready}><Check size={17} aria-hidden="true" />{me?.ready ? 'Unready' : 'Ready'}</button>
      <button type="button" className="btn" onClick={() => client.leave()}><LogOut size={16} aria-hidden="true" />Leave Room</button>
    </div>
  </section>;
}

function Results({ room, view, client, unlock }: { room: RoomView; view: OnlineView; client: OnlineConnection; unlock: () => void }) {
  const game = room.game!;
  const result = game.outcome!;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [game.id]);
  const votes = room.members.filter(member => member.voted).length;
  const voted = room.members.find(member => member.id === view.pilot?.id)?.voted;
  const winner = result.winnerId === null ? null : game.grid[result.winnerId];
  return <section className="race-results arc-card online-results" aria-label="Online race results" data-race-id={game.id}>
    <div className="race-results-summary">
      <span className="race-result-icon"><Trophy size={26} aria-hidden="true" /></span>
      <div><p className="race-caption">Official race results</p>
        <h2 ref={heading} tabIndex={-1}>{winner ? `${winner.name} wins` : 'Time limit reached'}</h2>
        <p>{DIFFICULTY_LABELS[game.config.difficulty]} · Course {game.config.seed}</p></div>
      <span className="race-pill" data-tone={result.ranked ? 'gold' : undefined}>{result.ranked ? 'Verified · Ranked' : 'Unranked'}</span>
    </div>
    {!result.ranked && result.reason && <p>{result.reason}</p>}
    <table className="race-results-table">
      <thead><tr><th scope="col">Pilot</th><th scope="col">Finish</th><th scope="col">Dodges</th><th scope="col">Hits</th><th scope="col">Boosts</th><th scope="col">Points</th></tr></thead>
      <tbody>{result.standings.map(row => {
        const pilot = game.grid[row.id];
        return <tr key={row.id} data-seat={row.id} data-place={row.place} data-finish={row.finishMs ?? ''} data-player={pilot.id === view.pilot?.id}>
          <th scope="row"><span>{row.place}</span><i className="race-pilot-dot" style={{ background: PILOT_COLORS[row.id] }} />{pilot.name}</th>
          <td data-label="Finish">{row.finishMs === null ? `${row.remaining.toLocaleString()} m left` : formatRaceTime(row.finishMs)}</td>
          <td data-label="Dodges">{row.dodges}</td><td data-label="Hits">{row.collisions}</td><td data-label="Boosts">{row.boostsEarned}</td>
          <td data-label="Points">{row.points.toLocaleString()}</td>
        </tr>;
      })}</tbody>
    </table>
    <div className="race-setup-actions">
      <button className="btn btn-primary" type="button" aria-pressed={!!voted} disabled={view.status !== 'online'}
        onClick={() => { unlock(); client.act({ t: 'vote', race: game.id, code: room.code, value: !voted }); }}>
        <RotateCcw size={16} aria-hidden="true" />{voted ? 'Cancel rematch vote' : 'Vote for rematch'}
      </button>
      <span className="online-votes">{votes}/{room.members.length} in favor</span>
      <button type="button" className="btn" onClick={() => client.leave()}><LogOut size={16} aria-hidden="true" />Leave Room</button>
    </div>
  </section>;
}

export default function OnlineScreen({ preferences, onNavigate }: {
  preferences: ArcadePreferences;
  onNavigate: (view: ArcadeView) => void;
}) {
  const [view, setView] = useState(initialOnlineView);
  const [client] = useState(() => new OnlineConnection(setView));
  const [nickname, setNickname] = useState(preferences.nickname);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [size, setSize] = useState<GridSize>(4);
  const [bots, setBots] = useState(false);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const sound = useRef<RaceAudio | null>(null);
  const lastFinish = useRef<string>();
  useEffect(() => {
    client.start();
    return () => { client.stop(); sound.current?.dispose(); };
  }, [client]);
  useEffect(() => {
    const game = view.room?.game;
    if (game?.outcome && lastFinish.current !== game.id) {
      lastFinish.current = game.id;
      sound.current?.cue('finish');
    }
  }, [view.room?.game]);

  function unlock() {
    if (!preferences.sound) return;
    sound.current ??= new RaceAudio(preferences.volume);
    sound.current.unlock();
  }

  function join(event: FormEvent) {
    event.preventDefault();
    const invite = code.trim().toUpperCase();
    if (!ROOM_CODE.test(invite)) { setJoinError('Enter the six-character room code.'); return; }
    setJoinError('');
    client.run({ t: 'join', code: invite }, nickname);
  }

  const { room } = view;
  const active = (room?.phase === 'countdown' || room?.phase === 'racing') && room.game;
  const seat = active && active.grid.find(pilot => pilot.id === view.pilot?.id)?.seat;
  const busy = view.status === 'connecting' || view.status === 'reconnecting';
  return <div className="race-page online-page" data-running={!!active} data-reduced-effects={preferences.reducedEffects}>
    <header className="race-titlebar">
      <div className="race-title">
        <ArcadeLink view="home" onNavigate={onNavigate} className="race-back" label="Back to Arcade"><ArrowLeft size={18} aria-hidden="true" /><span>Arcade</span></ArcadeLink>
        <div><h1>Online Multiplayer</h1>{room && active && <p>{room.private ? 'Private' : 'Public'} · {DIFFICULTY_LABELS[room.difficulty]} · Course <span data-course-seed={active.config.seed}>{active.config.seed}</span></p>}</div>
      </div>
      <div className="online-header-actions"><LinkStatus view={view} />
        {active && <button type="button" className="btn" onClick={() => client.leave()}><LogOut size={16} aria-hidden="true" />Leave Room</button>}</div>
    </header>
    {view.error && <p role="alert" className="race-notice">{view.error}</p>}
    {!room && <div className="online-home">
      <section className="arc-card online-setup">
        <h2><Flag size={19} aria-hidden="true" />Find a race</h2>
        <div className="online-identity">
          <label>Pilot nickname<input className="input-field" maxLength={40} value={view.pilot?.name ?? nickname}
            readOnly={!!view.pilot} onChange={event => setNickname(event.target.value)} autoComplete="off" /></label>
          {(view.pilot || busy) && <button type="button" className="btn" onClick={() => client.useNewPilot()}>{view.pilot ? 'New pilot' : 'Cancel connection'}</button>}
        </div>
        <div className="arcade-setting-row">
          <label>Difficulty<select className="select-field" value={difficulty} onChange={event => setDifficulty(event.target.value as Difficulty)}>
            {DIFFICULTIES.map(mode => <option key={mode} value={mode}>{DIFFICULTY_LABELS[mode]}</option>)}</select></label>
          <label>Grid size<select className="select-field" value={size} onChange={event => setSize(Number(event.target.value) as GridSize)}>
            <option value={2}>2 rockets</option><option value={3}>3 rockets</option><option value={4}>4 rockets</option></select></label>
        </div>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => client.run({ t: 'quick', size, difficulty }, nickname)}>
          <Globe2 size={17} aria-hidden="true" />Quick Match</button>
        <div className="online-private">
          <label className="arcade-check"><input type="checkbox" checked={bots} onChange={event => setBots(event.target.checked)} />Fill spare private seats with AI</label>
          <button type="button" className="btn" disabled={busy} onClick={() => client.run({ t: 'create', size, difficulty, bots }, nickname)}>
            <Plus size={17} aria-hidden="true" />Create Room</button>
        </div>
      </section>
      <div className="online-join-column">
        <form className="arc-card online-setup" onSubmit={join}>
          <h2><Users size={19} aria-hidden="true" />Join with a code</h2>
          <div className="online-identity"><label>Invite code<input className="input-field" maxLength={6} value={code}
            onChange={event => { setCode(event.target.value.toUpperCase()); setJoinError(''); }} placeholder="ABC234" spellCheck={false} autoComplete="off" /></label>
            <button className="btn" disabled={busy}>Join Room <ArrowRight size={15} aria-hidden="true" /></button></div>
          {joinError && <p className="race-notice" role="alert">{joinError}</p>}
        </form>
        <section className="arc-card online-browser" aria-label="Public room browser">
          <div className="online-card-title"><h2>Public rooms</h2><button className="btn" type="button" disabled={busy}
            onClick={() => client.run({ t: 'browse' }, nickname)}>{view.pilot ? 'Refresh' : 'Browse Rooms'}</button></div>
          {view.rooms.length ? <ul>{view.rooms.map(lobby => <li key={lobby.code}>
            <span><strong>{DIFFICULTY_LABELS[lobby.difficulty]}</strong><small>{lobby.players}/{lobby.size} pilots</small></span>
            <button className="btn" type="button" disabled={busy} onClick={() => client.run({ t: 'join', code: lobby.code }, nickname)}>Join {lobby.code}</button>
          </li>)}</ul> : <p>{view.status === 'online' ? 'No open rooms. Quick Match opens one automatically.' : 'Connect to see open public lobbies.'}</p>}
        </section>
      </div>
    </div>}
    {room?.phase === 'lobby' && <Lobby room={room} view={view} client={client} ready={() => {
      unlock();
      client.act({ t: 'ready', code: room.code, value: !room.members.find(member => member.id === view.pilot?.id)?.ready });
    }} />}
    {room && active && typeof seat === 'number' && <OnlineRace key={active.id} game={active} seat={seat}
      phase={room.phase === 'countdown' ? 'countdown' : 'racing'} status={view.status} members={room.members}
      client={client} preferences={preferences} audio={sound.current} />}
    {room?.phase === 'results' && room.game?.outcome && <Results room={room} view={view} client={client} unlock={unlock} />}
    {room && !active && <p className="online-reconnect-note">A disconnected rocket coasts. Its pilot has {view.graceMs / 1_000} seconds to return after the server detects the disconnect.</p>}
  </div>;
}
