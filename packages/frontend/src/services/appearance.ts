export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';
export type OutcomePanelLayout = 'right' | 'below' | 'left';
export const THEME_KEY = 'cashingularity.theme.v1';
export const OUTCOME_LAYOUT_KEY = 'cashingularity.outcomePanelLayout.v1';
export const DARK_THEME_QUERY = '(prefers-color-scheme: dark)';
export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch { return 'system'; }
}
export function resolveTheme(preference: ThemePreference, prefersDark?: boolean): Theme {
  if (preference !== 'system') return preference;
  return (prefersDark ?? globalThis.matchMedia?.(DARK_THEME_QUERY).matches) ? 'dark' : 'light';
}
export function readTheme(): Theme {
  return resolveTheme(readThemePreference());
}
export function applyTheme(preference: ThemePreference, prefersDark?: boolean): Theme {
  const theme = resolveTheme(preference, prefersDark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try { localStorage.setItem(THEME_KEY, preference); } catch { /* The current session can still change theme. */ }
  return theme;
}
export function readOutcomeLayout(): OutcomePanelLayout {
  try { const value = localStorage.getItem(OUTCOME_LAYOUT_KEY); return value === 'left' || value === 'below' ? value : 'right'; } catch { return 'right'; }
}
export function saveOutcomeLayout(layout: OutcomePanelLayout): void {
  try { localStorage.setItem(OUTCOME_LAYOUT_KEY, layout); } catch { /* Keep the selected layout in memory. */ }
}
