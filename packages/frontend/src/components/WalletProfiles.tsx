import React, { useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Hourglass, KeyRound, Link2, LockKeyhole, Monitor, Moon, Plus, Settings, Sun, Wallet } from 'lucide-react';
import type { ThemePreference } from '../services/appearance.js';
import type { ProfileSummary } from '../services/profileManager.js';
import type { SavedWizardProfile } from '../services/wizardCredentials.js';
import type { Workspace } from '../services/workspaceRoutes.js';
import { HeaderPopover } from './HeaderPopover.js';

type View = 'main' | 'profiles' | 'appearance';
const appearances = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

function profileCapability(profile: ProfileSummary) {
  if (profile.paperOnly) return 'Paper Trading';
  const network = profile.network === 'chipnet' ? 'Chipnet' : 'Mainnet';
  if (profile.kind === 'wizard' && !profile.externalSigningReady) return `${network} · Waiting for wallet`;
  return `${network} · ${profile.kind === 'watch' ? 'Watch-only' : profile.kind === 'local' ? 'Can sign' : 'External signer'}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paper: boolean;
  profiles: ProfileSummary[];
  locked: { id: string; label: string }[];
  savedPairings: SavedWizardProfile[];
  appearance: ThemePreference;
  onAppearance: (appearance: ThemePreference) => void;
  onNavigate: (route: Workspace) => void;
  onActivate: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onManage: (lockedId?: string) => void;
  onReconnect: (id: string) => void;
  onSandbox: () => void;
}

export function WalletProfiles({ open, onOpenChange, paper, profiles, locked, savedPairings, appearance, onAppearance,
  onNavigate, onActivate, onCreate, onImport, onManage, onReconnect, onSandbox }: Props) {
  const [view, setView] = useState<View>('main');
  const [backTarget, setBackTarget] = useState<Exclude<View, 'main'>>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active = profiles.find(profile => profile.active && !profile.paperOnly);
  const name = paper ? 'Paper Trading Account' : active?.name ?? 'Select profile';
  const detail = paper ? 'Sandbox · Virtual BCH' : active ? profileCapability(active) : 'No active wallet';
  const changeOpen = (next: boolean) => {
    if (next) {
      setView('main');
      setBackTarget(undefined);
    }
    onOpenChange(next);
  };
  const select = (action: () => void) => {
    changeOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    action();
  };
  const back = () => {
    if (view !== 'main') setBackTarget(view);
    setView('main');
  };

  return <HeaderPopover label="Profile menu" triggerLabel="Switch wallet profile" triggerDescription={`${name} · ${detail}`} open={open} onOpenChange={changeOpen}
    triggerClass="profile-switcher-trigger header-profile-trigger" triggerRef={triggerRef} focusKey={view}
    trigger={<><Wallet size={16} aria-hidden="true" /><span className="header-profile-label"><strong>{name}</strong>{(active || paper) && <small>{detail}</small>}</span><ChevronDown size={14} aria-hidden="true" /></>}>
    {view === 'main' ? <>
      <div className="header-menu-rows">
        <button type="button" className="header-menu-row" onClick={() => select(() => onNavigate('/wallet'))}>
          <Wallet size={17} aria-hidden="true" /><span>Wallet</span>
        </button>
        <button type="button" className="header-menu-row" onClick={() => select(() => onNavigate('/settings'))}>
          <Settings size={17} aria-hidden="true" /><span>Settings</span>
        </button>
        <button type="button" className="header-menu-row" data-menu-focus={backTarget === 'appearance' ? '' : undefined} onClick={() => setView('appearance')}>
          <Monitor size={17} aria-hidden="true" /><span>Appearance</span><ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="header-profile-summary" data-menu-focus={backTarget === 'profiles' ? '' : undefined}
        onClick={() => setView('profiles')}>
        <span className="header-profile-icon"><Wallet size={19} aria-hidden="true" /></span>
        <span><strong>{name}</strong><small>{detail}</small></span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </> : <>
      <div className="header-popover-heading">
        <button type="button" className="icon-button" aria-label="Back to profile menu" data-menu-focus onClick={back}><ArrowLeft size={18} aria-hidden="true" /></button>
        <h2>{view === 'profiles' ? 'Switch Profile' : 'Appearance'}</h2>
      </div>
      {view === 'appearance' ? <div className="header-menu-rows" role="group" aria-label="Theme">
        {appearances.map(({ value, label, icon: Icon }) => (
          <button key={value} type="button" className="header-menu-row" aria-pressed={appearance === value} onClick={() => onAppearance(value)}>
            <Icon size={17} aria-hidden="true" /><span>{label}</span>{appearance === value && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
      </div> : <div className="header-menu-rows" role="group" aria-label="Wallet profiles">
        {profiles.filter(profile => profile.kind !== 'sandbox').map(profile => (
          <button key={profile.id} type="button" className="header-menu-row profile-option" aria-pressed={profile.active && !paper}
            onClick={() => select(() => onActivate(profile.id))}>
            <Wallet size={17} aria-hidden="true" /><span><strong>{profile.name}</strong><small>{profileCapability(profile)}</small></span>
            {profile.active && !paper && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
        {locked.map(profile => (
          <button key={profile.id} type="button" className="header-menu-row" onClick={() => select(() => onManage(profile.id))}>
            <LockKeyhole size={17} aria-hidden="true" /><span><strong>{profile.label}</strong><small>Locked</small></span>
          </button>
        ))}
        {savedPairings.map(profile => (
          <button key={profile.id} type="button" className="header-menu-row" onClick={() => select(() => onReconnect(profile.id))}>
            <Link2 size={17} aria-hidden="true" /><span><strong>{profile.name}</strong><small>WizardConnect · Reconnect</small></span>
          </button>
        ))}
        <button type="button" className="header-menu-row profile-option" aria-pressed={paper} onClick={() => select(onSandbox)}>
          <Hourglass size={17} aria-hidden="true" /><span><strong>{paper ? 'Paper Trading Account' : 'Explore Sandbox'}</strong><small>Virtual BCH · Paper Trading</small></span>
          {paper && <Check size={16} aria-hidden="true" />}
        </button>
        <div className="header-menu-divider" />
        <button type="button" className="header-menu-row" onClick={() => select(onCreate)}><Plus size={17} aria-hidden="true" /><span>Create Profile</span></button>
        <button type="button" className="header-menu-row" onClick={() => select(onImport)}><KeyRound size={17} aria-hidden="true" /><span>Import Profile</span></button>
        <button type="button" className="header-menu-row" onClick={() => select(() => onManage())}><Settings size={17} aria-hidden="true" /><span>Connected wallets</span></button>
      </div>}
    </>}
  </HeaderPopover>;
}
