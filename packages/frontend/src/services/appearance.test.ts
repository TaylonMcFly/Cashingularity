import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, readTheme, readThemePreference, readOutcomeLayout, saveOutcomeLayout, THEME_KEY, OUTCOME_LAYOUT_KEY } from './appearance.js';
import { chartThemeOptions } from './chartAppearance.js';
function browser() {
  const saved = new Map<string,string>();
  vi.stubGlobal('localStorage', { getItem:(key:string)=>saved.get(key) ?? null, setItem:(key:string,value:string)=>saved.set(key,value) });
  const root={dataset:{} as Record<string,string>,style:{colorScheme:''}};
  vi.stubGlobal('document',{documentElement:root});
  return {saved,root};
}
afterEach(()=>vi.unstubAllGlobals());
describe('appearance preferences',()=>{
  it('stores System itself and applies the current system palette', () => {
    const { saved, root } = browser();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(readThemePreference()).toBe('system');
    expect(readTheme()).toBe('dark');
    applyTheme('system', false);
    expect(saved.get(THEME_KEY)).toBe('system');
    expect(root.dataset.theme).toBe('light');
    applyTheme('light', true);
    expect(root.dataset.theme).toBe('light');
  });
  it('restores theme and updates the browser palette and persisted preference together',()=>{
    const {saved,root}=browser(); expect(readTheme()).toBe('light');
    applyTheme('dark');expect(saved.get(THEME_KEY)).toBe('dark');expect(readTheme()).toBe('dark');expect(root.dataset.theme).toBe('dark');expect(root.style.colorScheme).toBe('dark');
    applyTheme('light');expect(readTheme()).toBe('light');expect(root.dataset.theme).toBe('light');
    saved.set(THEME_KEY,'unrecognized');expect(readTheme()).toBe('light');
  });
  it('defaults to the right ticket and restores either alternative layout',()=>{
    const {saved}=browser();expect(readOutcomeLayout()).toBe('right');
    for(const layout of ['left','below','right'] as const){saveOutcomeLayout(layout);expect(readOutcomeLayout()).toBe(layout);}
    saved.set(OUTCOME_LAYOUT_KEY,'corrupt');expect(readOutcomeLayout()).toBe('right');
  });
  it('keeps theme and layout usable when browser storage is blocked',()=>{
    const {root}=browser();vi.stubGlobal('localStorage',{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}});
    expect(readTheme()).toBe('light');expect(readOutcomeLayout()).toBe('right');expect(()=>saveOutcomeLayout('left')).not.toThrow();expect(()=>applyTheme('dark')).not.toThrow();expect(root.dataset.theme).toBe('dark');
  });
  it('provides distinct light and dark chart surfaces with matching axis and grid palettes',()=>{
    const light=chartThemeOptions('light'),dark=chartThemeOptions('dark');
    expect(light.layout.background.color).toBe('#ffffff');expect(dark.layout.background.color).toBe('#1c2028');
    expect(dark.layout.textColor).not.toBe(light.layout.textColor);expect(dark.grid.horzLines.color).not.toBe(light.grid.horzLines.color);expect(dark.grid.vertLines.color).toBe(dark.grid.horzLines.color);expect(dark.timeScale.borderColor).toBe(dark.rightPriceScale.borderColor);
  });
});
