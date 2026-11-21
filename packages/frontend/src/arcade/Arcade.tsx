import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Crosshair, Flag, Gamepad2, Globe2, Rocket, Settings2, Trophy, Zap } from 'lucide-react';
import { DODGES_PER_BOOST, type RaceEntry } from '@cashingularity/shared/rocket-race';
import type { ArcadeView } from '../services/workspaceRoutes.js';
import { ArcadeLink } from './ArcadeLink.js';
import { ArcadeSettings } from './ArcadeSettings.js';
import { Leaderboard } from './Leaderboard.js';
import type { ArcadeMarketData } from './MarketWidget.js';
import { drawRacePreview } from './renderer.js';
import { readPreferences, readScores, recordLocalScore, savePreferences, saveScores, SCORE_KEY, type ArcadePreferences } from './raceStorage.js';
import './arcade.css';

const RaceScreen = lazy(() => import('./RaceScreen.js'));
const OnlineScreen = lazy(() => import('./online/OnlineScreen.js'));

const sections = [
  { view: 'home', label: 'Overview', Icon: Gamepad2 },
  { view: 'play', label: 'Single Player', Icon: Rocket },
  { view: 'online', label: 'Online Multiplayer', Icon: Globe2 },
  { view: 'leaderboard', label: 'Leaderboard', Icon: Trophy },
  { view: 'settings', label: 'Settings', Icon: Settings2 },
  { view: 'guide', label: 'How to Play', Icon: BookOpen },
] as const;

function TrackPreview() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    try { return drawRacePreview(canvas.current); } catch { return; }
  }, []);
  return <div className="arcade-preview" aria-hidden="true"><canvas ref={canvas} /></div>;
}

function ArcadeHome({ onNavigate }: { onNavigate: (view: ArcadeView) => void }) {
  return <>
    <section className="arcade-hero">
      <div className="arcade-hero-copy">
        <div className="arcade-hero-mark"><Rocket size={29} aria-hidden="true" /></div>
        <h2>Rocket Race</h2>
        <p>Thread moving asteroids, bank your boosts, and race up to three rival pilots offline or online.</p>
        <div className="arcade-hero-actions">
          <ArcadeLink view="play" onNavigate={onNavigate} className="btn btn-primary">Play Rocket Race <ArrowRight size={18} aria-hidden="true" /></ArcadeLink>
          <ArcadeLink view="online" onNavigate={onNavigate} className="btn arcade-hero-online"><Globe2 size={17} aria-hidden="true" />Race Online</ArcadeLink>
        </div>
      </div>
      <TrackPreview />
    </section>
    <div className="arcade-home-links">
      <ArcadeLink view="leaderboard" onNavigate={onNavigate} className="arc-card">
        <Trophy size={23} aria-hidden="true" /><div><strong>Leaderboard</strong><p>Local records and verified shared races.</p></div><ArrowRight size={16} aria-hidden="true" />
      </ArcadeLink>
      <ArcadeLink view="settings" onNavigate={onNavigate} className="arc-card">
        <Settings2 size={23} aria-hidden="true" /><div><strong>Controls</strong><p>Set up keyboard or touch for your device.</p></div><ArrowRight size={16} aria-hidden="true" />
      </ArcadeLink>
    </div>
  </>;
}

function ArcadeGuide({ onNavigate }: { onNavigate: (view: ArcadeView) => void }) {
  return <div className="arcade-guide">
    <header className="arcade-page-heading"><h2>How to play</h2><p>The first rocket across the finish line ends the race.</p></header>
    <div className="arcade-guide-grid">
      <section className="arc-card"><h3><Crosshair size={19} aria-hidden="true" /> Steer and dodge</h3>
        <p>The rocket cruises on its own. Steer into open gaps, increase thrust on straights, and brake before tight passes. A dodge counts only after clearing a nearby asteroid without contact.</p>
        <dl><dt>Keyboard</dt><dd><kbd>A</kbd> <kbd>D</kbd> or <kbd>←</kbd> <kbd>→</kbd> to steer. <kbd>W</kbd> <kbd>S</kbd> or <kbd>↑</kbd> <kbd>↓</kbd> to thrust and brake.</dd>
          <dt>Touch</dt><dd>Push the joystick to steer and change thrust, or select drag steering in Settings.</dd></dl>
      </section>
      <section className="arc-card"><h3><Zap size={19} aria-hidden="true" /> Bank a boost</h3>
        <p>Every {DODGES_PER_BOOST} consecutive dodges earn one charge. Press <kbd>Space</kbd> or tap Boost for 2.2 seconds of higher acceleration and speed. Crashes slow the rocket and reset the streak. Banked charges stay available.</p>
      </section>
      <section className="arc-card"><h3><Flag size={19} aria-hidden="true" /> Race the clock</h3>
        <p>Rivals steer, brake, and earn boosts under the same rules. Pause a solo race with <kbd>Esc</kbd>. In an online race, trailing pilots have up to 12 seconds to cross after the winner.</p>
      </section>
      <section className="arc-card"><h3><Trophy size={19} aria-hidden="true" /> Score points</h3>
        <p>Earn 100 points per dodge, 40 per charge earned, and 400 for winning. Each collision costs 30 points. Ranked races send control inputs for server replay. Local results stay on this device.</p>
      </section>
    </div>
    <ArcadeLink view="play" onNavigate={onNavigate} className="btn btn-primary">Play Rocket Race <ArrowRight size={17} aria-hidden="true" /></ArcadeLink>
  </div>;
}

export default memo(function Arcade({ view, onNavigate, market, onMarkets }: {
  view: ArcadeView;
  onNavigate: (view: ArcadeView) => void;
  market: ArcadeMarketData;
  onMarkets: () => void;
}) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [scores, setScores] = useState(readScores);
  const prefs = useRef(preferences);
  const history = useRef(scores);
  useEffect(() => {
    function readOtherTab(event: StorageEvent) {
      if (event.key === SCORE_KEY) setScores(history.current = readScores());
    }
    window.addEventListener('storage', readOtherTab);
    return () => window.removeEventListener('storage', readOtherTab);
  }, []);

  const update = useCallback((patch: Partial<ArcadePreferences>) => {
    const next = { ...prefs.current, ...patch };
    prefs.current = next;
    setPreferences(next);
    return savePreferences(next);
  }, []);
  const chooseNickname = useCallback((nickname: string) => { update({ nickname }); }, [update]);
  const record = useCallback((entry: RaceEntry) => {
    const previous = history.current;
    const personalBest = entry.finishMs !== null && !previous.some(prior =>
      prior.nickname.toLowerCase() === entry.nickname.toLowerCase() && prior.difficulty === entry.difficulty &&
      prior.rockets === entry.rockets && prior.finishMs !== null && prior.finishMs <= entry.finishMs!);
    const next = recordLocalScore(previous, entry);
    const saved = next === previous || saveScores(next);
    history.current = next;
    setScores(next);
    return { personalBest, saved };
  }, []);

  return <div className="arcade" data-arcade-view={view}>
    {view === 'play' ? <Suspense fallback={<p className="arcade-loading" role="status">Loading Rocket Race…</p>}>
      <RaceScreen preferences={preferences} market={market} onMarkets={onMarkets} onNavigate={onNavigate}
        onNickname={chooseNickname} onRecord={record} />
    </Suspense> : view === 'online' ? <Suspense fallback={<p className="arcade-loading" role="status">Loading online racing…</p>}>
      <OnlineScreen preferences={preferences} onNavigate={onNavigate} />
    </Suspense> : <>
      <header className="arcade-header">
        <h1><Gamepad2 size={25} aria-hidden="true" /> Arcade</h1>
        <nav aria-label="Arcade navigation">
          {sections.map(({ view: destination, label, Icon }) => <ArcadeLink key={destination} view={destination} onNavigate={onNavigate} current={view === destination}>
            <Icon size={16} aria-hidden="true" /> {label}
          </ArcadeLink>)}
        </nav>
      </header>
      {view === 'home' && <ArcadeHome onNavigate={onNavigate} />}
      {view === 'leaderboard' && <Leaderboard nickname={preferences.nickname} local={scores} onNavigate={onNavigate} />}
      {view === 'settings' && <ArcadeSettings preferences={preferences} update={update} />}
      {view === 'guide' && <ArcadeGuide onNavigate={onNavigate} />}
    </>}
  </div>;
});
