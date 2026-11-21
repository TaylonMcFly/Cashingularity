import React from "react";
import { Github } from "lucide-react";
import { WORKSPACES, type Workspace } from '../services/workspaceRoutes.js';
import {
  ExecutionMode,
} from "@cashingularity/shared";
export interface BlazeBannerProps {
  mode: ExecutionMode;
  network: 'mainnet' | 'chipnet';
  walletStatus: 'unconnected' | 'watch-only' | 'connected' | 'offline';
  onToggleMode?: (mode: ExecutionMode) => void;
  bchUsdPrice: number;
  priceSource: "live" | "fallback";
  activeRoute: Workspace;
  onNavigate: (route: Workspace) => void;
  walletSelector: React.ReactNode;
  notifications: React.ReactNode;
}
export const BlazeBanner: React.FC<BlazeBannerProps> = ({
  mode,
  network,
  walletStatus,
  bchUsdPrice,
  priceSource,
  activeRoute,
  onNavigate,
  walletSelector,
  notifications,
}) => {
  const demo = mode === "SANDBOX_MODE";
  const networkLabel = demo ? 'Sandbox · Paper' : network === 'chipnet' ? 'BCH Chipnet' : 'BCH Mainnet';
  const connectionLabel = {
    unconnected: 'No wallet selected',
    'watch-only': 'Watch-only',
    connected: 'Wallet connected',
    offline: 'Waiting for wallet',
  }[walletStatus];
  const logoSrc =
    activeRoute !== "/market"
      ? "/logo-wallet.png"
      : "/logo-market.png";
  return (
    <header className="blaze-banner">
      <div className="header-market-group">
        <a href="/" className="brand" aria-label="Cashingularity wallet home" onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onNavigate('/wallet');
        }}>
          <img src={logoSrc} alt="Cashingularity" className="brand-logo" />
          <span>CASHINGULARITY</span>
        </a>
        <nav className="primary-navigation" aria-label="Primary navigation">{WORKSPACES.filter(({ route }) => route !== '/settings').map(({ route, path, label }) => {
          const isActive = activeRoute === route;
          return (
            <a
              key={route}
              href={path}
              className={`header-nav-item ${isActive ? 'active' : ''}`.trim()}
              aria-current={isActive ? 'page' : undefined}
              onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onNavigate(route);
              }}
            >
              {label}
            </a>
          );
        })}</nav>
      </div>
      <div className="header-spacer" aria-hidden="true" />
      <div className="header-account">
        <div className="header-context-group">
          <div className="ticker" data-price-source={priceSource}>
            <span className="status-dot" aria-hidden="true" />
            <span>BCH/USD</span>
            <strong>
              {priceSource === "live"
                ? `$${bchUsdPrice.toFixed(2)}`
                : "Unavailable"}
            </strong>
          </div>
          <div className="header-mode">
            <span className={`mode-indicator ${demo ? 'practice' : ''}`.trim()} data-wallet-status={demo ? 'paper' : walletStatus}
              title={demo ? 'Sandbox · Paper Trading (Simulated BCH)' : `${networkLabel} · ${connectionLabel}`}>
              <span className="status-dot" aria-hidden="true" />
              <span className="header-network-name">{networkLabel}</span>
              {!demo && <span className="header-connection-status"><span aria-hidden="true">· </span>{connectionLabel}</span>}
            </span>
          </div>
        </div>
        <div className="header-controls-group">
          <a href="https://github.com/TaylonMcFly/Cashingularity" className="header-icon-button header-source-link"
            target="_blank" rel="noopener noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub">
            <Github size={17} aria-hidden="true" /><span>Source code</span>
          </a>
          {notifications}
          {walletSelector}
        </div>
      </div>
    </header>
  );
};
