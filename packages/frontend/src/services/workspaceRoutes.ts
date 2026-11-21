import { parseMarketSlug } from './marketRoutes.js';

export const WORKSPACES = [
  { route: '/wallet', path: '/', label: 'Wallet' },
  { route: '/market', path: '/market', label: 'Market' },
  { route: '/arcade', path: '/arcade', label: 'Arcade' },
  { route: '/settings', path: '/settings', label: 'Settings' },
] as const;

export type Workspace = typeof WORKSPACES[number]['route'];

export const ARCADE_PATHS = {
  home: '/arcade', play: '/arcade/rocket-race', leaderboard: '/arcade/leaderboard',
  online: '/arcade/rocket-race/online', settings: '/arcade/settings', guide: '/arcade/how-to-play',
} as const;
export type ArcadeView = keyof typeof ARCADE_PATHS;

export function parseArcadePath(pathname: string): ArcadeView | undefined {
  const normalized = pathname.replace(/\/+$/, '');
  return (Object.keys(ARCADE_PATHS) as ArcadeView[]).find(view => ARCADE_PATHS[view] === normalized);
}

export function parseWorkspacePath(pathname: string): { route: Workspace; marketSlug: string | null; batch: boolean } {
  const path = pathname.replace(/\/+$/, '') || '/';
  const marketSlug = parseMarketSlug(path);
  if (path === '/market' || marketSlug) return { route: '/market', marketSlug, batch: false };
  if (parseArcadePath(path)) return { route: '/arcade', marketSlug: null, batch: false };
  if (path === '/settings') return { route: '/settings', marketSlug: null, batch: false };
  return { route: '/wallet', marketSlug: null, batch: path === '/batch' };
}
