import type { Difficulty } from '@cashingularity/shared/rocket-race';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

export function formatRaceTime(ms: number, decimals = 3) {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor(ms / 1_000) % 60;
  const fraction = String(ms % 1_000).padStart(3, '0').slice(0, decimals);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${fraction}`;
}
