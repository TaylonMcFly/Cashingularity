import { createContext } from 'react';
import type { Theme } from './appearance.js';
export const ThemeContext = createContext<Theme>('light');
