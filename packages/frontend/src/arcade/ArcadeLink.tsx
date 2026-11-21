import type { ReactNode } from 'react';
import { ARCADE_PATHS, type ArcadeView } from '../services/workspaceRoutes.js';

export function ArcadeLink({ view, onNavigate, children, className, current, label }: {
  view: ArcadeView;
  onNavigate: (view: ArcadeView) => void;
  children: ReactNode;
  className?: string;
  current?: boolean;
  label?: string;
}) {
  return <a href={ARCADE_PATHS[view]} className={className} aria-current={current ? 'page' : undefined} aria-label={label}
    onClick={event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate(view);
    }}>{children}</a>;
}
