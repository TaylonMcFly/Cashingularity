import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock3, Medal, Trophy } from 'lucide-react';
import { buildLeaderboard, DIFFICULTIES, isGridSize, LOCAL_HISTORY_LIMIT, type RaceEntry, type RaceFilters, type RankSort } from '@cashingularity/shared/rocket-race';
import type { ArcadeView } from '../services/workspaceRoutes.js';
import { ArcadeLink } from './ArcadeLink.js';
import { fetchSharedLeaderboard, type SharedLeaderboard } from './arcadeApi.js';
import { DIFFICULTY_LABELS, formatRaceTime } from './raceFormat.js';

const OnlineLeaderboard = lazy(() => import('./online/OnlineLeaderboard.js'));
type BoardProps = {
  local: RaceEntry[];
  nickname: string;
  onNavigate: (view: ArcadeView) => void;
};

export function Leaderboard(props: BoardProps) {
  const [online, setOnline] = useState(false);
  return <div className="arcade-leaderboard">
    <header className="arcade-page-heading"><h2>Leaderboard</h2></header>
    <fieldset className="race-segments"><legend>Race mode</legend>
      <button type="button" className="btn" aria-pressed={!online} onClick={() => setOnline(false)}>Single Player</button>
      <button type="button" className="btn" aria-pressed={online} onClick={() => setOnline(true)}>Online Multiplayer</button>
    </fieldset>
    {online ? <Suspense fallback={<p role="status">Loading online rankings…</p>}>
      <OnlineLeaderboard onNavigate={props.onNavigate} />
    </Suspense> : <SinglePlayerLeaderboard {...props} />}
  </div>;
}

function SinglePlayerLeaderboard({ local, nickname, onNavigate }: BoardProps) {
  const [shared, setShared] = useState(false);
  const [difficulty, setDifficulty] = useState<RaceFilters['difficulty']>();
  const [rockets, setRockets] = useState<RaceFilters['rockets']>();
  const [sort, setSort] = useState<RankSort>('points');
  const [loadRevision, setLoadRevision] = useState(0);
  const [payload, setPayload] = useState<{ key: string; board?: SharedLeaderboard; error?: string }>();
  const filters = useMemo(() => ({ difficulty, rockets, sort }), [difficulty, rockets, sort]);
  const key = JSON.stringify([filters, loadRevision]);
  useEffect(() => {
    if (!shared) return;
    const controller = new AbortController();
    setPayload(undefined);
    void fetchSharedLeaderboard(filters, controller.signal).then(board => {
      if (!controller.signal.aborted) setPayload({ key, board });
    }).catch(error => {
      if (!controller.signal.aborted) setPayload({ key, error: error instanceof Error ? error.message : 'Shared rankings are unavailable.' });
    });
    return () => controller.abort();
  }, [shared, filters, key]);

  const localBoard = useMemo(() => ({ ...buildLeaderboard(local, filters), capacity: LOCAL_HISTORY_LIMIT }), [local, filters]);
  const response = payload?.key === key ? payload : undefined;
  const board = shared ? response?.board : localBoard;
  const markedName = nickname.toLowerCase();
  const best = board?.rankings.find(row => row.nickname.toLowerCase() === markedName)?.bestMs;
  return <section className="arc-card arcade-leaderboard-card">
      <div className="leaderboard-filter-bar">
        <fieldset className="race-segments"><legend>Rankings</legend>
          <button type="button" className="btn" aria-pressed={!shared} onClick={() => setShared(false)}>Local</button>
          <button type="button" className="btn" aria-pressed={shared} onClick={() => setShared(true)}>Shared</button>
        </fieldset>
        <label>Difficulty<select className="select-field" value={difficulty ?? ''}
          onChange={event => setDifficulty((event.target.value || undefined) as RaceFilters['difficulty'])}>
          <option value="">All difficulties</option>
          {DIFFICULTIES.map(mode => <option key={mode} value={mode}>{DIFFICULTY_LABELS[mode]}</option>)}
        </select></label>
        <label>Grid size<select className="select-field" value={rockets ?? ''} onChange={event => {
          const count = Number(event.target.value);
          setRockets(isGridSize(count) ? count : undefined);
        }}><option value="">Any size</option><option value="2">2 rockets</option><option value="3">3 rockets</option><option value="4">4 rockets</option></select></label>
        <label>Sort by<select className="select-field" value={sort} onChange={event => setSort(event.target.value as RankSort)}>
          <option value="points">Total points</option><option value="time">Best race time</option><option value="wins">Wins</option><option value="dodges">Successful dodges</option>
        </select></label>
      </div>
      <p className="leaderboard-source">{shared ? 'Server-verified replays · Nicknames are public' : 'Races saved on this browser'}
        {board ? ` · Totals cover up to ${board.capacity.toLocaleString()} recent races` : ''}</p>

      {!board && <div className="arcade-empty" role="status">{response?.error
        ? <><p>{response.error}</p><button type="button" className="btn" onClick={() => setLoadRevision(value => value + 1)}>Retry</button></>
        : <p>Loading shared rankings…</p>}</div>}
      {board && !board.rankings.length && <div className="arcade-empty">
        <Trophy size={27} aria-hidden="true" /><p>{board.count ? 'No matching pilots.' : 'No results for these filters yet.'}</p>
        <ArcadeLink view="play" onNavigate={onNavigate} className="btn">Play Rocket Race <ArrowRight size={15} aria-hidden="true" /></ArcadeLink>
      </div>}
      {!!board?.rankings.length && <>
        <table className="race-results-table rank-table">
          <thead><tr><th scope="col">Pilot</th><th scope="col">Best time</th><th scope="col">Points</th><th scope="col">Wins</th><th scope="col">Dodges</th><th scope="col">Races</th></tr></thead>
          <tbody>{board.rankings.map((row, index) => <tr key={row.nickname} data-player={row.nickname.toLowerCase() === markedName}>
            <th scope="row"><span>{index + 1}</span>{row.nickname}{!shared && row.nickname.toLowerCase() === markedName && <span className="race-pill">You</span>}</th>
            <td data-label="Best time">{row.bestMs === null ? '—' : formatRaceTime(row.bestMs)}</td><td data-label="Points">{row.points.toLocaleString()}</td>
            <td data-label="Wins">{row.wins}</td><td data-label="Dodges">{row.dodges.toLocaleString()}</td><td data-label="Races">{row.races}</td>
          </tr>)}</tbody>
        </table>
        <section className="race-recent-results">
          <h3><Clock3 size={18} aria-hidden="true" /> Recent results</h3>
          <ul>{board.recent.map(entry => <li key={entry.id}>
            <div><strong>{entry.nickname}</strong>
              <small>{DIFFICULTY_LABELS[entry.difficulty]} · {entry.rockets} rockets · Seed {entry.seed}</small></div>
            <div><strong>{entry.place === 1 && entry.finishMs !== null ? 'Won' : `Place ${entry.place}`} · {entry.points.toLocaleString()} pts</strong>
              <small>{entry.finishMs === null ? 'Race ended before finish' : formatRaceTime(entry.finishMs)}
                {' · '}{new Date(entry.recordedAt).toLocaleDateString()}</small></div>
            {!shared && entry.nickname.toLowerCase() === markedName && entry.finishMs !== null && entry.finishMs === best &&
              <span className="race-pill" data-tone="gold"><Medal size={14} aria-hidden="true" /> Personal best</span>}
          </li>)}</ul>
        </section>
      </>}
  </section>;
}
