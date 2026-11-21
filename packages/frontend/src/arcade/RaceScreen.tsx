import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Flag, Rocket, RotateCcw, Trophy, Zap } from 'lucide-react';
import {
  DIFFICULTIES, isSeed, makeRaceEntry, normalizeNickname, TRACK_LENGTH,
  type Difficulty, type GridSize, type InputRun, type RaceConfig, type RaceEntry, type RaceResult,
} from '@cashingularity/shared/rocket-race';
import type { ArcadeView } from '../services/workspaceRoutes.js';
import { ArcadeLink } from './ArcadeLink.js';
import { openRankedChallenge, submitRankedResult, type RankedChallenge } from './arcadeApi.js';
import { MarketWidget, type ArcadeMarketData } from './MarketWidget.js';
import { RaceAudio } from './raceAudio.js';
import { DIFFICULTY_LABELS, formatRaceTime } from './raceFormat.js';
import { PILOT_COLORS, PILOT_NAMES } from './renderer.js';
import { RaceStage } from './RaceStage.js';
import type { ArcadePreferences } from './raceStorage.js';

const modes: Record<Difficulty, string> = {
  easy: 'Open lanes and slower rivals',
  normal: 'Moving rocks and faster rivals',
  hard: 'Dense fields and aggressive boosts',
};

interface Attempt {
  id: string;
  config: RaceConfig;
  nickname: string;
  ranked?: RankedChallenge;
}
interface Finish {
  result: RaceResult;
  entry: RaceEntry;
  replay: InputRun[];
  personalBest: boolean;
  saved: boolean;
}
interface Props {
  preferences: ArcadePreferences;
  market: ArcadeMarketData;
  onMarkets: () => void;
  onNavigate: (view: ArcadeView) => void;
  onNickname: (nickname: string) => void;
  onRecord: (entry: RaceEntry) => { personalBest: boolean; saved: boolean };
}

export default memo(function RaceScreen({ preferences, market, onMarkets, onNavigate, onNickname, onRecord }: Props) {
  const [nickname, setNickname] = useState(preferences.nickname);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [rockets, setRockets] = useState<GridSize>(4);
  const [seed, setSeed] = useState('');
  const [ranked, setRanked] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>();
  const [finish, setFinish] = useState<Finish>();
  const [requesting, setRequesting] = useState(false);
  const [posting, setPosting] = useState<'idle' | 'sending' | 'verified' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const operation = useRef<AbortController>();
  const audio = useRef<RaceAudio | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { operation.current?.abort(); audio.current?.dispose(); }, []);
  useEffect(() => { if (finish) resultHeading.current?.focus(); }, [finish]);

  function startRequest() {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    return controller;
  }

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requesting) return;
    const pilot = normalizeNickname(nickname);
    if (!pilot) { setMessage('Use a nickname with 2–20 letters, numbers, spaces, dashes, or underscores.'); return; }
    const customSeed = seed.trim();
    if (!ranked && customSeed && (!/^\d{1,10}$/.test(customSeed) || !isSeed(Number(customSeed)))) {
      setMessage('The course seed must be a whole number from 0 to 4294967295.');
      return;
    }
    if (preferences.sound) {
      audio.current ??= new RaceAudio(preferences.volume);
      audio.current.unlock();
    }
    setMessage('');
    let next: Attempt;
    if (ranked) {
      const controller = startRequest();
      setRequesting(true);
      try {
        const challenge = await openRankedChallenge(pilot, difficulty, rockets, controller.signal);
        if (controller.signal.aborted) return;
        next = { id: challenge.id, config: challenge.config, nickname: pilot, ranked: challenge };
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Shared racing is unavailable. Try a local race.');
        return;
      } finally {
        if (!controller.signal.aborted) setRequesting(false);
      }
    } else {
      const course = customSeed ? Number(customSeed) : crypto.getRandomValues(new Uint32Array(1))[0];
      next = { id: crypto.randomUUID(), config: { seed: course, difficulty, rockets }, nickname: pilot };
    }
    onNickname(pilot);
    setNickname(pilot);
    window.scrollTo(0, 0);
    setAttempt(next);
  }

  const submit = useCallback(async (challenge: RankedChallenge, replay: InputRun[]) => {
    const controller = startRequest();
    setPosting('sending');
    setMessage('');
    try {
      await submitRankedResult(challenge, replay, controller.signal);
      if (!controller.signal.aborted) setPosting('verified');
    } catch (error) {
      if (!controller.signal.aborted) {
        setPosting('error');
        setMessage(error instanceof Error ? error.message : 'Could not submit the shared score.');
      }
    }
  }, []);

  const complete = useCallback((result: RaceResult, replay: InputRun[]) => {
    if (!attempt) return;
    const entry = makeRaceEntry(attempt.id, attempt.nickname, attempt.config, result, Date.now());
    const record = onRecord(entry);
    setFinish({ result, entry, replay, ...record });
    if (attempt.ranked) void submit(attempt.ranked, replay);
  }, [attempt, onRecord, submit]);

  const restart = useCallback(() => {
    operation.current?.abort();
    audio.current?.unlock();
    setFinish(undefined);
    setMessage('');
    setPosting('idle');
    window.scrollTo(0, 0);
    const id = crypto.randomUUID();
    setAttempt(previous => previous && { id, config: previous.config, nickname: previous.nickname });
  }, []);

  function reset() {
    operation.current?.abort();
    setFinish(undefined);
    setAttempt(undefined);
    setMessage('');
    setSeed('');
    setPosting('idle');
  }

  return <div className="race-page" data-running={!!attempt && !finish} data-reduced-effects={preferences.reducedEffects}>
    <header className="race-titlebar">
      <div className="race-title">
        <ArcadeLink view="home" onNavigate={onNavigate} className="race-back" label="Back to Arcade"><ArrowLeft size={18} aria-hidden="true" /><span>Arcade</span></ArcadeLink>
        <div><h1>Rocket Race</h1>{attempt && <p>{DIFFICULTY_LABELS[attempt.config.difficulty]} · Seed {attempt.config.seed} · {attempt.ranked ? 'Ranked' : 'Local'}</p>}</div>
      </div>
      {preferences.showMarket && <MarketWidget market={market} onMarkets={onMarkets} />}
    </header>
    {attempt && !finish && <RaceStage key={attempt.id} config={attempt.config} preferences={preferences}
      audio={audio.current} onFinish={complete} onRestart={restart} />}
    {!attempt && <form className="race-setup arc-card" onSubmit={begin}>
      <div className="race-setup-heading">
        <div><Flag size={22} aria-hidden="true" /><h2>Starting grid</h2></div>
        <p>{(TRACK_LENGTH / 1_000).toFixed(1)} km · First across the line wins.</p>
      </div>
      <div className="race-setup-fields">
        <label>Pilot nickname<input value={nickname} maxLength={40} onChange={event => setNickname(event.target.value)}
          className="input-field" autoComplete="off" spellCheck={false} required /></label>
        <fieldset className="race-segments"><legend>Rockets</legend>
          {([2, 3, 4] as const).map(size => <button key={size} type="button" className="btn" aria-pressed={rockets === size} onClick={() => setRockets(size)}>{size}</button>)}
        </fieldset>
      </div>
      <fieldset className="race-difficulty"><legend>Difficulty</legend>
        {DIFFICULTIES.map(mode => <button key={mode} type="button" aria-pressed={difficulty === mode} onClick={() => setDifficulty(mode)}>
          <strong>{DIFFICULTY_LABELS[mode]}</strong><small>{modes[mode]}</small>
        </button>)}
      </fieldset>
      <div className="race-setup-fields">
        <fieldset className="race-segments"><legend>Race type</legend>
          <button type="button" className="btn" aria-pressed={!ranked} onClick={() => { setRanked(false); setMessage(''); }}>Local</button>
          <button type="button" className="btn" aria-pressed={ranked} onClick={() => { setRanked(true); setMessage(''); }}>Ranked</button>
        </fieldset>
        {!ranked ? <label>Course seed <span>(optional)</span><input className="input-field" inputMode="numeric" maxLength={10}
          value={seed} onChange={event => setSeed(event.target.value)} placeholder="Random course" /></label>
          : <p>Ranked races use a server-issued course and replay verification for shared scores.</p>}
      </div>
      {message && <p role="alert" className="race-notice"><CircleAlert size={16} aria-hidden="true" />{message}</p>}
      <div className="race-setup-actions">
        <button className="btn btn-primary" disabled={requesting}><Rocket size={18} aria-hidden="true" />{requesting ? 'Opening ranked race…' : 'Start race'}</button>
        <ArcadeLink view="guide" onNavigate={onNavigate} className="btn">How to play <ArrowRight size={15} aria-hidden="true" /></ArcadeLink>
      </div>
    </form>}
    {finish && attempt && <section className="race-results arc-card" aria-label="Race results">
      <div className="race-results-summary">
        <span className="race-result-icon"><Trophy size={27} aria-hidden="true" /></span>
        <div><p className="race-caption">Race results</p><h2 ref={resultHeading} tabIndex={-1}>
          {finish.result.winnerId === 0 ? 'You win!' : finish.result.winnerId === null ? 'Race ended' : `${PILOT_NAMES[finish.result.winnerId]} wins`}
        </h2><p>Your place {finish.entry.place} of {attempt.config.rockets} · {finish.entry.points.toLocaleString()} points</p></div>
        {finish.personalBest && <span className="race-pill" data-tone="gold"><Zap size={15} aria-hidden="true" /> Personal best</span>}
      </div>
      <div className="race-results-meta"><span>Race time <strong>{formatRaceTime(finish.entry.elapsedMs)}</strong></span>
        <span>{finish.saved ? 'Saved on this browser' : 'Saved for this visit'}</span>
      </div>
      <table className="race-results-table">
        <thead><tr><th scope="col">Pilot</th><th scope="col">Finish</th><th scope="col">Dodges</th><th scope="col">Hits</th><th scope="col">Boosts</th><th scope="col">Points</th></tr></thead>
        <tbody>{finish.result.standings.map(row => <tr key={row.id} data-player={row.id === 0}>
          <th scope="row"><span>{row.place}</span><i className="race-pilot-dot" style={{ background: PILOT_COLORS[row.id] }} />{row.id === 0 ? attempt.nickname : PILOT_NAMES[row.id]}</th>
          <td data-label="Finish">{row.finishMs === null ? <span>{row.remaining.toLocaleString()} m left</span> : formatRaceTime(row.finishMs)}</td>
          <td data-label="Dodges">{row.dodges}</td><td data-label="Hits">{row.collisions}</td><td data-label="Boosts">{row.boostsEarned}</td><td data-label="Points">{row.points.toLocaleString()}</td>
        </tr>)}</tbody>
      </table>
      {attempt.ranked && <div className="race-ranking-feedback" role="status">
        {posting === 'sending' && 'Verifying race replay…'}
        {posting === 'verified' && <><Check size={17} aria-hidden="true" /> Server-verified shared score</>}
        {posting === 'error' && <><span>{message}</span><button type="button" className="btn" onClick={() => void submit(attempt.ranked!, finish.replay)}>Retry submission</button></>}
      </div>}
      <div className="race-setup-actions">
        <button className="btn btn-primary" type="button" onClick={restart}><RotateCcw size={17} aria-hidden="true" />Replay course</button>
        <button className="btn" type="button" onClick={reset}>New race</button>
        <ArcadeLink view="leaderboard" onNavigate={onNavigate} className="btn">Leaderboard <ArrowRight size={15} aria-hidden="true" /></ArcadeLink>
      </div>
    </section>}
  </div>;
});
