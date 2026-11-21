import { applyTheme, readThemePreference } from './services/appearance.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

applyTheme(readThemePreference());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root #root element not found in index.html');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
