import {
  isDifficulty, isGridSize, isRaceEntry, isSeed, RACE_ID_PATTERN, RACE_VERSION,
  type InputRun, type RaceConfig, type RaceEntry, type RaceFilters, type RankRow,
} from '@cashingularity/shared/rocket-race';

const ROOT = '/api/arcade/rocket-race';

export interface RankedChallenge {
  id: string;
  config: RaceConfig;
  version: number;
}
export interface SharedLeaderboard {
  rankings: RankRow[];
  recent: RaceEntry[];
  count: number;
  capacity: number;
}

async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(ROOT + path, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      cache: 'no-store', credentials: 'omit',
      ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Shared racing is unavailable. Local play is available.');
  }
  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    throw new Error(typeof json?.error === 'string' ? json.error : 'Shared racing is unavailable. Local play is available.');
  }
  return json as T;
}

export async function openRankedChallenge(nickname: string, difficulty: RaceConfig['difficulty'], rockets: RaceConfig['rockets'], signal: AbortSignal) {
  const challenge = await request<RankedChallenge>('/challenges', signal, { nickname, difficulty, rockets });
  if (challenge.version !== RACE_VERSION || typeof challenge.id !== 'string' || !RACE_ID_PATTERN.test(challenge.id) ||
      !isSeed(challenge.config?.seed) || !isDifficulty(challenge.config?.difficulty) || !isGridSize(challenge.config?.rockets)) {
    throw new Error('This server uses a different version of Rocket Race.');
  }
  return challenge;
}

export async function submitRankedResult(challenge: RankedChallenge, inputs: InputRun[], signal: AbortSignal) {
  const response = await request<{ entry: RaceEntry }>('/results', signal, { challengeId: challenge.id, version: challenge.version, inputs });
  if (!isRaceEntry(response.entry) || response.entry.id !== challenge.id) throw new Error('The server could not verify this result.');
  return response.entry;
}

export function fetchSharedLeaderboard(filters: RaceFilters, signal: AbortSignal) {
  const query = new URLSearchParams({ sort: filters.sort });
  if (filters.difficulty) query.set('difficulty', filters.difficulty);
  if (filters.rockets) query.set('rockets', String(filters.rockets));
  return request<SharedLeaderboard>(`/leaderboard?${query}`, signal).then(board => {
    if (!Array.isArray(board.rankings) || !Array.isArray(board.recent)) throw new Error('Shared rankings are unavailable.');
    return board;
  });
}
