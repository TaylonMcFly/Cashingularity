import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, Trophy } from 'lucide-react';
import { DIFFICULTIES, ONLINE_BOARD_PATH, type OnlineRanking, type OnlineScorecard } from '@cashingularity/shared/rocket-race';
import type { ArcadeView } from '../../services/workspaceRoutes.js';
import { ArcadeLink } from '../ArcadeLink.js';
import { DIFFICULTY_LABELS, formatRaceTime } from '../raceFormat.js';
import './online.css';

type Board = { rankings: OnlineRanking[]; recent: OnlineScorecard[]; count: number; capacity: number };

export default function OnlineLeaderboard({ onNavigate }: { onNavigate: (view: ArcadeView) => void }) {
  const [difficulty, setDifficulty] = useState('');
  const [grid, setGrid] = useState('');
  const [revision, retry] = useState(0);
  const [response, setResponse] = useState<{ key: string; board?: Board; error?: string }>();
  const key = [difficulty, grid, revision].join(':');
  useEffect(() => {
    const params = new URLSearchParams();
    if (difficulty) params.set('difficulty', difficulty);
    if (grid) params.set('size', grid);
    const controller = new AbortController();
    void (async () => {
      try {
        const reply = await fetch(`${ONLINE_BOARD_PATH}?${params}`, { signal: controller.signal, credentials: 'omit' });
        if (!reply.ok) throw new Error();
        const board = await reply.json() as Board;
        if (!Array.isArray(board.rankings) || !Array.isArray(board.recent)) throw new Error();
        if (!controller.signal.aborted) setResponse({ key, board });
      } catch {
        if (!controller.signal.aborted) setResponse({ key, error: 'Online rankings are unavailable.' });
      }
    })();
    return () => controller.abort();
  }, [difficulty, grid, key]);
  const current = response?.key === key ? response : undefined;
  const board = current?.board;
  return <section className="arc-card arcade-leaderboard-card online-board">
    <div className="leaderboard-filter-bar">
      <label>Difficulty<select className="select-field" value={difficulty} onChange={event => setDifficulty(event.target.value)}>
        <option value="">All difficulties</option>{DIFFICULTIES.map(mode => <option key={mode} value={mode}>{DIFFICULTY_LABELS[mode]}</option>)}
      </select></label>
      <label>Grid size<select className="select-field" value={grid} onChange={event => setGrid(event.target.value)}>
        <option value="">Any size</option><option value="2">2 rockets</option><option value="3">3 rockets</option><option value="4">4 rockets</option>
      </select></label>
    </div>
    <p className="leaderboard-source">Server-verified public races · Ranked by wins, average place, then best time
      {board && ` · Up to ${board.capacity.toLocaleString()} recent races`}</p>
    {!board && <div className="arcade-empty" role="status">{current?.error ?
      <><p>{current.error}</p><button type="button" className="btn" onClick={() => retry(value => value + 1)}>Retry</button></> :
      <p>Loading online rankings…</p>}</div>}
    {board && !board.rankings.length && <div className="arcade-empty">
      <Trophy size={26} aria-hidden="true" /><p>No ranked races for these filters yet.</p>
      <ArcadeLink view="online" onNavigate={onNavigate} className="btn">Race Online <ArrowRight size={15} aria-hidden="true" /></ArcadeLink>
    </div>}
    {!!board?.rankings.length && <>
      <table className="race-results-table rank-table">
        <thead><tr><th scope="col">Pilot</th><th scope="col">Wins</th><th scope="col">Losses</th><th scope="col">Avg. place</th>
          <th scope="col">Best time</th><th scope="col">Finishes</th><th scope="col">Races</th></tr></thead>
        <tbody>{board.rankings.map((pilot, index) => <tr key={pilot.id}><th scope="row"><span>{index + 1}</span>{pilot.name}</th>
          <td data-label="Wins">{pilot.wins}</td><td data-label="Losses">{pilot.losses}</td>
          <td data-label="Avg. place">{pilot.averagePlace.toFixed(2)}</td>
          <td data-label="Best time">{pilot.bestMs === null ? '—' : formatRaceTime(pilot.bestMs)}</td>
          <td data-label="Finishes">{pilot.finishes}</td><td data-label="Races">{pilot.races}</td>
        </tr>)}</tbody>
      </table>
      <section className="race-recent-results">
        <h3><Clock3 size={18} aria-hidden="true" /> Recent races</h3>
        <ul>{board.recent.map(race => <li key={race.id}><div>
          <strong>{race.pilots[race.result.standings[0].id].name} wins</strong>
          <small>{DIFFICULTY_LABELS[race.config.difficulty]} · {race.config.rockets} rockets · Course {race.config.seed}</small>
        </div><div><strong>{formatRaceTime(race.result.standings[0].finishMs!)}</strong>
          <small>{new Date(race.at).toLocaleDateString()}</small></div></li>)}</ul>
      </section>
    </>}
  </section>;
}
