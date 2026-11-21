import { TurnstileChallenge } from './TurnstileChallenge.js';
import { ConnectedWallets } from './ConnectedWallets.js';
import { WatchUpgradeForm } from './WatchUpgradeForm.js';
import { startWizardPairing } from '../services/wizardSessions.js';
import { authRequest, authorizeAccount, consumeAuthorization, markWalletSessionUnlocked, type SecurityAccount } from '../services/accountSecurity.js';
import React, { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, LoaderCircle, QrCode, RefreshCw, ScanLine, X } from "lucide-react";
import { profileManager } from "../services/profileManager.js";
import {
  bchWalletService,
  type WalletNetwork,
} from "../services/bchWalletService.js";
import {
  connectInjectedBchProvider,
  detectInjectedBchProviders,
  type ConnectedWalletProfile,
  type InjectedBchProvider,
  wizardWalletSingleton,
} from "../services/walletRuntime.js";
type Tab = "CONNECTED" | "WIZARD_CONNECT" | "CREATE" | "IMPORT" | "RECEIVE_QR";
export const SessionWalletModal: React.FC<{
  isOpen: boolean;
  initialTab?: "CONNECTED" | "WIZARD_CONNECT" | "BUILTIN_HD" | "RECEIVE_QR" | "IMPORT";
  initialUpgradeProfileId?: string;
  initialUnlockProfileId?: string;
  walletProfile: ConnectedWalletProfile;
  paper: boolean;
  onClose: () => void;
  onWalletUpdated: (profile: ConnectedWalletProfile) => void;
  onWalletSessionEnded: (profile: ConnectedWalletProfile) => void;
  onWalletManaged?: (profile: ConnectedWalletProfile) => void;
  onSandbox: () => void;
  onNotify: (message: string) => void;
}> = ({
  isOpen,
  initialTab = "WIZARD_CONNECT",
  initialUpgradeProfileId,
  initialUnlockProfileId,
  walletProfile,
  paper,
  onClose,
  onWalletUpdated,
  onWalletSessionEnded,
  onWalletManaged,
  onSandbox,
  onNotify,
}) => {
  const [tab, setTab] = useState<Tab>("CONNECTED");
  const [upgradeId, setUpgradeId] = useState<string>();
  const [network, setNetwork] = useState<WalletNetwork>("mainnet");
  const [accountIndex, setAccountIndex] = useState('0');
  const [phrase, setPhrase] = useState("");
  const [importPhrase, setImportPhrase] = useState("");
  const [backup, setBackup] = useState(false);
  const [uri, setUri] = useState("");
  const [qrUri, setQrUri] = useState('');
  const [reconnectId, setReconnectId] = useState<string>();
  const [pairAttempt, setPairAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [pairingMessage, setPairingMessage] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(true);
  const [password, setPassword] = useState("");
  const [lockWithPassword, setLockWithPassword] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [botToken, setBotToken] = useState(''), [botReset, setBotReset] = useState(0);
  const [linkAccount, setLinkAccount] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [watchAddress, setWatchAddress] = useState("");
  const [extensions, setExtensions] = useState<InjectedBchProvider[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const activationGeneration = useRef(0);
  const callbacks = useRef({ onWalletUpdated, onWalletSessionEnded, onNotify });
  callbacks.current = { onWalletUpdated, onWalletSessionEnded, onNotify };
  const persistenceRef = useRef({ remember, lockWithPassword, password });
  persistenceRef.current = { remember, lockWithPassword, password };
  useEffect(() => {
    if (isOpen) {
      setTab(initialTab === "BUILTIN_HD" ? "CREATE" : initialTab);
      setUpgradeId(initialUpgradeProfileId);
      setReconnectId(initialTab === 'WIZARD_CONNECT' ? initialUnlockProfileId : undefined);
      setMessage("");
      setExtensions(detectInjectedBchProviders());
    } else {
      setTab('CONNECTED');
      setUpgradeId(undefined);
      setPhrase("");
      setImportPhrase("");
      setAccountIndex('0');
      setBackup(false);
      setUri("");
      setQrUri('');
      setReconnectId(undefined);
      setPassword(""); setAccountName("");
      setLockWithPassword(false);
      setProfileName("");
      setWatchAddress("");
    }
    activationGeneration.current++;
  }, [isOpen, initialTab, initialUpgradeProfileId, initialUnlockProfileId]);
  useEffect(() => {
    if (!isOpen || tab !== 'WIZARD_CONNECT' || upgradeId) return;
    setUri('');
    setQrUri('');
    setCopyFeedback('');
    const reconnect = profileManager.getSavedWizardProfiles().find(row => row.id === reconnectId);
    setPairingMessage(reconnectId ? `Open WizardConnect in ${reconnect?.name || 'your wallet'} to resume.` : '');
    return startWizardPairing({
      profileId: reconnectId,
      onPairingCode: (code, qr) => { setUri(code); setQrUri(qr); },
      onStatus: setPairingMessage,
      onRestored: profile => callbacks.current.onWalletUpdated(profile),
      onApproved: profile => {
        setUri('');
        setQrUri('');
        setMessage('');
        setTab('CONNECTED');
        callbacks.current.onWalletUpdated(profile);
        callbacks.current.onNotify(`${profile.walletLabel} approved. Syncing BCH balance and history…`);
      },
      onEnded: profile => callbacks.current.onWalletSessionEnded(profile),
      onPersistenceError: () => callbacks.current.onNotify('Pairing storage unavailable. Reconnect after reload using a new QR code.'),
    });
  }, [isOpen, tab, upgradeId, reconnectId, pairAttempt]);
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog?.contains(previous)) dialog?.querySelector<HTMLButtonElement>('.wallet-modal-close')?.focus({ preventScroll: true });
    return () => {
      if (previous?.getClientRects().length && (document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if ((event.key !== 'Escape' && event.key !== 'Tab') || event.defaultPrevented) return;
      const dialog = dialogRef.current;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(node => node.getClientRects().length);
      if (!dialog || dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      const controls = [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, iframe, [tabindex]')]
        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);
  if (!isOpen) return null;
  const saveIfRequested = (confirmation: string, unlockKey?: string) => {
    if (remember)
      void profileManager
        .rememberActive(lockWithPassword ? password : undefined, unlockKey)
        .then(() => onNotify(`${confirmation} · encrypted and saved`))
        .catch((e: unknown) =>
          onNotify(
            `Profile is session-only: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
  };
  const activate = async (mnemonic: string, selection: WalletNetwork, account = 0) => {
    if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) { setMessage('Enter a valid BCH account index.'); return; }
    if (remember && lockWithPassword && password.length < 8) {
      setMessage(
        "Enter a custom password of at least 8 characters, or uncheck custom password protection.",
      );
      return;
    }
    if (lockWithPassword && !botToken) { setMessage('Complete the bot verification before continuing.'); return; }
    setBusy(true);
    try {
      const generation = activationGeneration.current;
      let security = lockWithPassword ? await authRequest<{ account: SecurityAccount; unlockKey?: string; challengeToken?: string }>(linkAccount ? 'login' : 'register', { username: accountName, password, begin: true, cfTurnstileToken: botToken }) : undefined;
      if (security?.challengeToken) { const verified = await authorizeAccount(security.account, 'unlock', password, security.challengeToken); consumeAuthorization(security.account, 'unlock'); security = verified; }
      if (activationGeneration.current !== generation) return;
      if (security && !security.unlockKey) throw new Error('Account verification is incomplete.');
      const profile = profileManager.addLocal(
        mnemonic,
        selection,
        false,
        profileName,
        security?.account,
        account,
      );
      if(security)markWalletSessionUnlocked(profileManager.getActiveId(),security.account);
      onWalletUpdated(profile);
      const confirmation = `${profile.network === "chipnet" ? "Chipnet" : "Mainnet"} wallet ready: ${profile.receiveTokenAddress.slice(0, 20)}…${profile.receiveTokenAddress.slice(-6)}`;
      saveIfRequested(confirmation, security?.unlockKey);
      setImportPhrase("");
      const id = profileManager.getActiveId();
      onClose();
      onNotify(confirmation);
      void wizardWalletSingleton
          .refreshOnChainBalance()
          .then((p) => {
            if (profileManager.getActiveId() === id) {
              profileManager.updateCurrent(p);
              onWalletUpdated(p);
            }
          })
          .catch(() => {
            if (profileManager.getActiveId() === id) {
              const p = wizardWalletSingleton.getAddresses();
              profileManager.updateCurrent(p);
              onWalletUpdated(p);
            }
          });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setBotToken(''); setBotReset(value => value + 1); }
  };
  const addWatch = () => {
    if (remember && lockWithPassword && password.length < 8) {
      setMessage(
        "Enter a custom password of at least 8 characters, or uncheck custom password protection.",
      );
      return;
    }
    try {
      const profile = profileManager.addWatch(
        watchAddress.trim(),
        network === "chipnet" ? "chipnet" : "mainnet",
        profileName,
      );
      onWalletUpdated(profile);
      saveIfRequested("Watch-only profile added.");
      const id = profileManager.getActiveId();
      onClose();
      onNotify("Watch-only profile added.");
      void wizardWalletSingleton
        .refreshOnChainBalance()
        .then((p) => {
          if (profileManager.getActiveId() === id) {
            profileManager.updateCurrent(p);
            onWalletUpdated(p);
          }
        })
        .catch(() => {
          if (profileManager.getActiveId() === id) {
            const p = wizardWalletSingleton.getAddresses();
            profileManager.updateCurrent(p);
            onWalletUpdated(p);
          }
        });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const connectExtension = async (provider: InjectedBchProvider) => {
    setBusy(true);
    setMessage("");
    try {
      const { receiveAddress, changeAddress, network: extNet } =
        await connectInjectedBchProvider(provider);
      const profile = profileManager.addExtension(
        receiveAddress,
        changeAddress,
        extNet,
        profileName || provider.name,
        provider,
      );
      onWalletUpdated(profile);
      saveIfRequested(`${provider.name} connected`);
      const id = profileManager.getActiveId();
      onClose();
      onNotify(
        `${provider.name} connected (${extNet}): ${profile.receiveTokenAddress.slice(0, 18)}…`,
      );
      void wizardWalletSingleton
        .refreshOnChainBalance()
        .then((p) => {
          if (profileManager.getActiveId() === id) {
            profileManager.updateCurrent(p);
            onWalletUpdated(p);
          }
        })
        .catch(() => {
          if (profileManager.getActiveId() === id) {
            const p = wizardWalletSingleton.getAddresses();
            profileManager.updateCurrent(p);
            onWalletUpdated(p);
          }
        });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      onWalletUpdated(await wizardWalletSingleton.refreshOnChainBalance());
      setMessage("Balance refreshed.");
    } catch {
      onWalletUpdated(wizardWalletSingleton.getAddresses());
      setMessage("On-chain balance is unavailable.");
    } finally {
      setBusy(false);
    }
  };
  const networkSelect = (
    <label className="wallet-network-select">
      Network{" "}
      <select
        value={network}
        onChange={(e) => setNetwork(e.target.value as WalletNetwork)}
      >
        <option value="mainnet">Mainnet</option>
        <option value="chipnet">Chipnet</option>
      </select>
    </label>
  );
  const persistence = (
    <div className="profile-save-settings">
      <label>
        Profile name{" "}
        <input
          className="input-field"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          placeholder="Optional name"
        />
      </label>
      <label className="seed-confirm">
        <input
          type="checkbox"
          aria-label="Remember this profile in this browser"
          checked={remember}
          onChange={(e) => { setRemember(e.target.checked); if (!e.target.checked) setLockWithPassword(false); }}
        />{" "}
        <span>Remember this profile in this browser<small>Keep an encrypted backup so this wallet is available after a reload.</small></span>
      </label>
      {remember && (
        <>
          <label className="seed-confirm">
            <input
              type="checkbox"
              aria-label="Lock with custom password (8+ chars)"
              checked={lockWithPassword}
              onChange={(e) => setLockWithPassword(e.target.checked)}
            />{" "}
            <span>Lock with custom password (8+ chars)<small>Require your password to unlock this saved profile.</small></span>
          </label>
          {lockWithPassword ? (
            <div className="security-form">
            <label>Account name<input className="input-field" aria-label="Wallet security account name" value={accountName} onChange={e => setAccountName(e.target.value)} autoComplete="username"/></label>
            <div className="security-segments"><button type="button" className={!linkAccount ? 'selected' : ''} onClick={() => setLinkAccount(false)}>Create New Protection</button><button type="button" className={linkAccount ? 'selected' : ''} onClick={() => setLinkAccount(true)}>Sign In to Existing Account</button></div>
            <label>
              Profile password{" "}
              <input
                type="password"
                autoComplete="new-password"
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>{tab !== 'CREATE' && <TurnstileChallenge action={linkAccount ? 'login' : 'register'} onToken={setBotToken} resetKey={botReset}/>}</div>
          ) : (
            <small>{tab === 'WIZARD_CONNECT'
              ? 'This browser saves the public address for your watch-only profile.'
              : 'Saved with a device key. Anyone with access to this browser storage can recover the seed. A custom password offers stronger protection.'}</small>
          )}
        </>
      )}
      {!remember && (
        <small>
          Session only: this profile disappears when the page reloads.
        </small>
      )}
    </div>
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal-card wallet-connection-modal${tab === 'WIZARD_CONNECT' && !upgradeId ? ' wallet-connection-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Wallet connection"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>
              <img
                src="/logo-wallet.png"
                alt=""
                className="modal-brand-icon"
              />{" "}
              {upgradeId ? 'Enable signing' : tab === 'RECEIVE_QR' ? 'Receive BCH' : tab === 'CONNECTED' ? 'Wallet profiles' : 'Connect a wallet'}
            </h2>
          </div>
          <button type="button" className="icon-button wallet-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {upgradeId ? <WatchUpgradeForm key={upgradeId} id={upgradeId} onBack={() => setUpgradeId(undefined)} onUpgraded={(id, next, saved) => {
          onWalletUpdated(next);
          onClose();
          onNotify(saved ? 'Signing enabled and saved.' : 'Signing enabled for this session.');
          const current = () => profileManager.getActiveId() === id && wizardWalletSingleton.getAddresses().localProfileId === id;
          void wizardWalletSingleton.refreshOnChainBalance().then(updated => {
            if (current() && wizardWalletSingleton.getAddresses() === updated) onWalletUpdated(updated);
          }).catch(() => { if (current()) onWalletUpdated(wizardWalletSingleton.getAddresses()); });
        }} /> : <>
        {tab !== "RECEIVE_QR" && (
          <div className="modal-tabs wallet-section-tabs" role="group" aria-label="Wallet sections">
            <button aria-pressed={tab === 'CONNECTED'} className={tab === 'CONNECTED' ? 'selected' : ''} onClick={()=>{setMessage('');setTab('CONNECTED');}}>Profiles</button>
            <button
              aria-pressed={tab === "WIZARD_CONNECT"}
              className={tab === "WIZARD_CONNECT" ? "selected" : ""}
              onClick={() => {
                setMessage("");
                setReconnectId(undefined);
                setTab("WIZARD_CONNECT");
              }}
            >
              Connect
            </button>
            <button
              aria-pressed={tab === "CREATE"}
              className={tab === "CREATE" ? "selected" : ""}
              onClick={() => {
                setMessage("");
                setTab("CREATE");
              }}
            >
              Create
            </button>
            <button
              aria-pressed={tab === "IMPORT"}
              className={tab === "IMPORT" ? "selected" : ""}
              onClick={() => {
                setMessage("");
                setTab("IMPORT");
              }}
            >
              Import
            </button>
          </div>
        )}
        {tab === 'CONNECTED' && <ConnectedWallets selectedProfileId={initialUnlockProfileId} paper={paper} onProfileChange={onWalletManaged??onWalletUpdated}
          onNotify={onNotify} onSandbox={onSandbox} onReconnect={id => { setReconnectId(id); setTab('WIZARD_CONNECT'); }}
          onUpgrade={id => { setMessage(''); setUpgradeId(id); }} />}
        {tab === "CREATE" && (
          <div className="connect-body">
            {!phrase ? (
              <>
                <p>Choose a network and name for your new wallet.</p>
                {networkSelect}
                {persistence}
                <button
                  className="btn btn-primary wallet-connect"
                  onClick={() => {
                    try {
                      setPhrase(bchWalletService.createLocalWallet());
                      setBackup(false);
                      setMessage("");
                    } catch (error) {
                      setMessage(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  }}
                >
                  Generate 12-Word Recovery Phrase
                </button>
              </>
            ) : (
              <>
                <p>
                  Write down these 12 words in order and keep them somewhere
                  safe.
                </p>
                <div className="seed-grid">
                  {phrase
                    .split(" ")
                    .filter(Boolean)
                    .map((word, i) => (
                      <div key={i}>
                        <span>{i + 1}</span>
                        {word}
                      </div>
                    ))}
                </div>
                <button
                  className="btn"
                  disabled={!phrase}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(phrase)
                      .then(() =>
                        setMessage(
                          "Recovery phrase copied. Clear your clipboard after saving it.",
                        ),
                      )
                      .catch(() =>
                        setMessage(
                          "Copy unavailable. Write down the phrase instead.",
                        ),
                      )
                  }
                >
                  <Copy size={14} /> Copy Phrase
                </button>
                {remember && lockWithPassword && <TurnstileChallenge action={linkAccount ? 'login' : 'register'} onToken={setBotToken} resetKey={botReset}/>}
                <label className="seed-confirm">
                  <input
                    type="checkbox"
                    checked={backup}
                    onChange={(e) => setBackup(e.target.checked)}
                  />{" "}
                  I have saved my 12-word phrase
                </label>
                <button
                  className="btn btn-primary wallet-connect"
                  disabled={!phrase || !backup || busy || (remember && lockWithPassword && !botToken)}
                  onClick={() => void activate(phrase, network)}
                >
                  Confirm &amp; Create Wallet
                </button>
                <button
                  className="btn wallet-connect"
                  onClick={() => {
                    setPhrase("");
                    setBackup(false);
                  }}
                >
                  Back
                </button>
                <p className="modal-note">
                  Back up these words. You can reveal them in Settings
                  while the profile is unlocked.
                </p>
              </>
            )}
          </div>
        )}
        {tab === "IMPORT" && (
          <div className="connect-body">
            <p>
              Restore a standard BIP39 wallet. Your phrase stays in this browser
              session.
            </p>
            {networkSelect}
            <label className="seed-input-label">BIP44 account index<input className="input-field" inputMode="numeric" pattern="[0-9]+" value={accountIndex} onChange={event => setAccountIndex(event.target.value.replace(/[^0-9]/g, ''))} /></label>
            <label className="seed-input-label">
              Recovery phrase
              <textarea
                className="textarea-field"
                rows={4}
                autoComplete="off"
                spellCheck={false}
                placeholder="Enter 12 or 24 words"
                value={importPhrase}
                onChange={(e) => setImportPhrase(e.target.value)}
              />
            </label>
            {persistence}
            <button
              className="btn btn-primary wallet-connect"
              disabled={!importPhrase.trim() || busy || (remember && lockWithPassword && !botToken)}
              onClick={() => activate(importPhrase, network, accountIndex === '' ? 0 : Number(accountIndex))}
            >
              Import wallet
            </button>
            <p className="modal-note">
              BIP39 passphrases and nonstandard derivation paths are not
              supported.
            </p>
          </div>
        )}
        {tab === "WIZARD_CONNECT" && (
          <div className="connect-body">
            <section className={`wallet-pairing${uri && qrUri ? ' has-pairing-qr' : ''}`} aria-label="WizardConnect">
              {uri && qrUri && <div className="qr-box pairing-qr" role="img" aria-label="WizardConnect pairing QR code">
                <QRCodeSVG value={qrUri} size={190} marginSize={4} />
              </div>}
              <div className="wallet-pairing-copy">
                <div className="wallet-pairing-heading"><QrCode size={20} aria-hidden="true" /><h3>WizardConnect</h3></div>
                <p>Scan with Selene or Paytaca and approve the BCH Mainnet connection on your phone.</p>
                <div className="wallet-pairing-status" role="status" data-waiting={!!(uri && qrUri)}>
                  {uri && qrUri ? <ScanLine size={16} aria-hidden="true" /> : pairingMessage ? <QrCode size={16} aria-hidden="true" /> : <LoaderCircle className="pairing-spinner" size={16} aria-hidden="true" />}
                  <span>{pairingMessage || (uri && qrUri ? 'Waiting for wallet approval' : 'Preparing your pairing code…')}</span>
                </div>
                <div className="wallet-modal-actions pairing-actions">
                  {uri && qrUri && <button type="button" className="btn btn-primary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(uri);
                        setCopyFeedback('Pairing link copied.');
                      } catch {
                        setCopyFeedback('Copy unavailable. Scan the pairing QR code.');
                      }
                    }}>
                    <Copy size={15} aria-hidden="true" />Copy pairing link
                  </button>}
                  <button type="button" className="btn" onClick={() => setPairAttempt(attempt => attempt + 1)}>
                    <RefreshCw size={15} aria-hidden="true" />{reconnectId ? 'Retry saved pairing' : 'Refresh pairing QR'}
                  </button>
                  {reconnectId && <button type="button" className="btn" onClick={() => setReconnectId(undefined)}>Show a new pairing QR</button>}
                </div>
                <span className="pairing-copy-feedback" aria-live="polite">{copyFeedback}</span>
                {uri && qrUri && <details className="pairing-uri"><summary>Show pairing link</summary><code className="uri-text">{uri}</code></details>}
              </div>
            </section>
            {extensions.length > 0 && <div className="wallet-modal-actions extension-options">
              {extensions.map((ext) => (
                  <button
                    key={ext.key}
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void connectExtension(ext)}
                  >
                    Connect {ext.name}
                  </button>
              ))}
            </div>}
            <div className="watch-profile-form">
              <div><h3>Watch-only</h3><p>View an address balance and transaction history without signing access.</p></div>
              {networkSelect}
              <label>
                Watch-only address
                <input
                  className="input-field"
                  value={watchAddress}
                  onChange={(e) => setWatchAddress(e.target.value)}
                  placeholder="bitcoincash:q… or bchtest:q…"
                />
              </label>
              {persistence}
              <button
                className="btn wallet-connect"
                disabled={!watchAddress.trim()}
                onClick={addWatch}
              >
                Add watch-only profile
              </button>
            </div>
          </div>
        )}
        {tab === "RECEIVE_QR" && (
          <div className="connect-body">
            {walletProfile.isConnected ? (
              <>
                <p>Token-aware address ({walletProfile.network})</p>
                <div className="qr-box">
                  <QRCodeSVG
                    value={walletProfile.receiveTokenAddress}
                    size={172}
                  />
                </div>
                <code className="uri-text">
                  {walletProfile.receiveTokenAddress}
                </code>
                <div className="wallet-modal-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        walletProfile.receiveTokenAddress,
                      )
                    }
                  >
                    <Copy size={14} /> Copy address
                  </button>
                  <button
                    className="btn"
                    disabled={busy || walletProfile.utxoSource === "sandbox"}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Connect a wallet to receive BCH.</p>
                <button
                  className="btn"
                  onClick={() => setTab("WIZARD_CONNECT")}
                >
                  Connect wallet
                </button>
              </>
            )}
          </div>
        )}
        {message && (
          <p className="modal-note" role="status">
            {message}
          </p>
        )}
        </>}
      </div>
    </div>
  );
};
