import { ColorType } from 'lightweight-charts';
import type { Theme } from './appearance.js';
export const CHART_PALETTES = {
  light: { background:'#ffffff', text:'#535b67', grid:'#f0eee9', border:'#e5e2da', target:'#535b67', accent:'#9a680a', fill:'rgba(179,129,28,.18)' },
  dark: { background:'#1c2028', text:'#a8afba', grid:'#282d36', border:'#343943', target:'#a8afba', accent:'#f2c14e', fill:'rgba(242,193,78,.18)' },
} as const;
export function chartAreaOptions(theme: Theme) {
  const { accent, fill } = CHART_PALETTES[theme];
  return { lineColor: accent, topColor: fill, bottomColor: 'rgba(0,0,0,0)' };
}
export function chartThemeOptions(theme: Theme) {
  const palette = CHART_PALETTES[theme];
  return { layout:{ attributionLogo:false, background:{type:ColorType.Solid as const,color:palette.background},textColor:palette.text,fontFamily:'Roboto, sans-serif' },
    grid:{vertLines:{color:palette.grid},horzLines:{color:palette.grid}},
    rightPriceScale:{borderColor:palette.border},timeScale:{borderColor:palette.border} };
}
