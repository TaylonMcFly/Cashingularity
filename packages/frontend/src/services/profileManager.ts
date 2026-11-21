import { authorizeAccount, consumeAuthorization, clearAccountAuthorization, clearProfileAuthorization, markWalletSessionUnlocked, type SecurityAccount } from './accountSecurity.js';
import { accountDerivationPaths, BchWalletService, type WalletNetwork } from "./bchWalletService.js";
import {
  wizardWalletSingleton as runtime,
  wizardProfile,
  type ConnectedWalletProfile,
  type InjectedBchProvider,
} from "./walletRuntime.js";
import type { DappConnectionManager } from "@wizardconnect/dapp";
import type { WalletScan } from './walletChainSync.js';
import { validateAndConvertCashAddr } from "@cashingularity/shared";
import { CashAddressType, decodeCashAddress } from '@bitauth/libauth';
import { clearWizardCredentials, forgetWizardCredentials, listWizardProfiles, saveWizardCredentials, type SavedWizardProfile, type WizardCredentials } from './wizardCredentials.js';

const STORAGE_KEY = "cashingularity.profiles.v1";
export const ACTIVE_LIVE_PROFILE_KEY = "cashingularity.activeLiveProfileId.v1";
const DEVICE_KEY_PREFIX = `${STORAGE_KEY}.device-key.`;
const NETWORK_KEY_PREFIX = `${STORAGE_KEY}.network.`;
const KDF_ROUNDS = 310_000;
type ProfileKind = "sandbox" | "local" | "watch" | "wizard" | "extension";
export interface ProfileSummary {
  id: string;
  name: string;
  kind: ProfileKind;
  network: WalletNetwork;
  address: string;
  active: boolean;
  saved: boolean;
  sessionSigning: boolean;
  paperOnly: boolean;
  externalSigningReady?: boolean;
}
interface SessionProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  profile: ConnectedWalletProfile;
  wallet?: BchWalletService;
  mnemonic?: string;
  manager?: DappConnectionManager;
  wizardScan?: WalletScan;
  provider?: InjectedBchProvider;
  sandbox?: boolean;
  securityAccount?: SecurityAccount;
  watchFallback?: SessionProfile;
}
interface StoredProfile {
  id: string;
  name: string;
  kind: "local" | "watch";
  network: WalletNetwork;
  accountIndex?: number;
  mnemonic?: string;
  address?: string;
  sandbox?: boolean;
  securityAccount?: SecurityAccount;
}
interface Envelope {
  securityAccount?: SecurityAccount;
  id: string;
  mode?: "device" | "password";
  salt: number[];
  iv: number[];
  ciphertext: number[];
}
const encode = new TextEncoder();
const additionalData = encode.encode("cashingularity-profiles-v1");
async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encode.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: KDF_ROUNDS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function importDeviceKey(encoded: string | null): Promise<CryptoKey> {
  if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded))
    throw new Error(
      "The local device key is missing or invalid. Restore this wallet using its recovery phrase.",
    );
  const bytes = Uint8Array.from(encoded.match(/../g)!, (hex) =>
    parseInt(hex, 16),
  );
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}

function newDeviceKeyMaterial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
  finally { bytes.fill(0); }
}

async function decryptProfile(envelope: Envelope, key: CryptoKey): Promise<StoredProfile> {
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(envelope.iv), additionalData }, key, new Uint8Array(envelope.ciphertext),
  );
  const plaintext = new Uint8Array(bytes);
  try { return JSON.parse(new TextDecoder().decode(plaintext)) as StoredProfile; }
  finally { plaintext.fill(0); }
}
function readEnvelopes(): Envelope[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    throw new Error("Saved profile data could not be read.");
  }
}

function savedNetwork(id: string, fallback: WalletNetwork): WalletNetwork {
  try {
    const value = localStorage.getItem(`${NETWORK_KEY_PREFIX}${id}`);
    return value === 'mainnet' || value === 'chipnet' ? value : fallback;
  } catch { return fallback; }
}

export class ProfileManager {
  private entries: SessionProfile[] = [
    {
      id: "sandbox",
      name: "Paper Trading Account",
      kind: "sandbox",
      profile: runtime.getAddresses(),
    },
  ];
  private activeId = "sandbox";
  private savedWizardProfiles: SavedWizardProfile[] = [];
  private subscribers = new Set<() => void>();
  private storageQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private profileVersions = new Map<string,number>();
  subscribe(fn: () => void) {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
  private emit() {
    this.subscribers.forEach((fn) => fn());
  }
  list(): ProfileSummary[] {
    let savedIds = new Set<string>();
    try { savedIds = new Set(readEnvelopes().map(row=>row.id)); } catch {}
    for (const profile of this.savedWizardProfiles) savedIds.add(profile.id);
    return this.entries.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      network: e.profile.network,
      address: e.profile.receiveTokenAddress,
      active: e.id === this.activeId,
      saved: savedIds.has(e.id),
      sessionSigning: !!e.watchFallback,
      paperOnly: e.kind === 'sandbox' || e.sandbox === true,
      externalSigningReady: e.profile.externalSigningReady,
    }));
  }
  getActiveId() {
    return this.activeId;
  }
  getWizardConnection(id:string) { return this.entries.find(entry=>entry.id===id)?.manager; }
  getSavedWizardProfiles() {
    return this.savedWizardProfiles.filter(saved => !this.entries.some(entry => entry.id === saved.id));
  }
  getPreferredWizardProfile() {
    try {
      const id = localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY);
      return this.getSavedWizardProfiles().find(profile => profile.id === id);
    } catch { return undefined; }
  }
  async refreshWizardProfiles() {
    this.savedWizardProfiles = await listWizardProfiles();
    this.emit();
  }
  async rememberWizardProfile(id: string, credentials: WizardCredentials, replace = false) {
    await saveWizardCredentials(id, credentials, replace);
    await this.refreshWizardProfiles();
  }
  async forgetWizardProfile(id: string) {
    await forgetWizardCredentials(id);
    this.savedWizardProfiles = this.savedWizardProfiles.filter(row => row.id !== id);
    if (localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY) === id) localStorage.removeItem(ACTIVE_LIVE_PROFILE_KEY);
    this.emit();
  }
  disconnectExternal(id:string):ConnectedWalletProfile {
    const entry=this.entries.find(row=>row.id===id);
    if(!entry || entry.kind !== 'extension') throw Error('Select a connected browser wallet.');
    entry.kind='watch';entry.provider=undefined;
    entry.profile={...entry.profile,connectionType:'WATCH_ONLY',walletLabel:`${entry.name} (watch-only)`};
    if(entry.id===this.activeId)entry.profile=runtime.activateSavedProfile(entry.profile);
    this.emit();return runtime.getAddresses();
  }
  lockProfile(id:string):ConnectedWalletProfile {
    const entry=this.entries.find(row=>row.id===id);
    if(!entry||entry.kind!=='local')throw Error('Select an unlocked local wallet.');
    if(!entry.watchFallback && !readEnvelopes().some(row=>row.id===id))throw Error('Save an encrypted backup before locking this session-only wallet.');
    this.profileVersions.set(id,(this.profileVersions.get(id)??0)+1);
    clearProfileAuthorization(id);entry.wallet?.lock();
    entry.mnemonic = undefined;
    if (entry.watchFallback) {
      const watch = entry.watchFallback;
      this.entries = this.entries.map(row => row === entry ? watch : row);
      if (this.activeId === id) watch.profile = runtime.activateSavedProfile(watch.profile);
      this.emit();
      return runtime.getAddresses();
    }
    this.entries=this.entries.filter(row=>row.id!==id);
    if(this.activeId===id){this.activeId='sandbox';runtime.connectSandboxDemo(true);}
    this.emit();return runtime.getAddresses();
  }
  getActiveProfile() {
    return this.entries.find((e) => e.id === this.activeId)!;
  }
  private isLive(entry: SessionProfile): boolean {
    return entry.kind !== 'sandbox' && !entry.sandbox && entry.profile.isConnected && entry.profile.utxoSource !== 'sandbox';
  }
  private rememberLiveSelection(entry: SessionProfile): void {
    if (this.isLive(entry)) { try { localStorage.setItem(ACTIVE_LIVE_PROFILE_KEY, entry.id); } catch { /* Selection still works in memory when browser storage is unavailable. */ } }
  }
  /** Activate only an already-unlocked live profile; protected profiles still require explicit unlocking. */
  activatePreferredLiveProfile(): ConnectedWalletProfile | undefined {
    const active = this.entries.find(entry => entry.id === this.activeId);
    if (active && this.isLive(active)) return runtime.getAddresses();
    let preferred: string | null = null;
    try { preferred = localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY); } catch {}
    const next = this.entries.find(entry => entry.id === preferred && this.isLive(entry)) ?? this.entries.find(entry => this.isLive(entry));
    return next ? this.switchTo(next.id) : undefined;
  }
  getLockedProfiles(): Array<{ id: string; label: string; device: boolean }> {
    try {
      const ids = new Set(this.entries.map(e => e.id));
      return readEnvelopes().filter(e => e && typeof e.id === 'string' && !ids.has(e.id)).map(e => ({ id:e.id, label:`${e.securityAccount?.username || 'Saved wallet'} · ${e.id.slice(0,8)}`, device:e.mode === 'device' }));
    } catch { return []; }
  }
  lockedCount(): number { return this.getLockedProfiles().length; }
  updateCurrent(profile: ConnectedWalletProfile) {
    const active = this.entries.find((e) => e.id === this.activeId);
    if (active && active.id === profile.profileId && profile === runtime.getAddresses()) {
      const changed = active.profile.externalSigningReady !== profile.externalSigningReady;
      active.profile = profile;
      if (changed) this.emit();
    }
  }
  addWizard(id: string, credentials: WizardCredentials, manager: DappConnectionManager, scan?: WalletScan): ConnectedWalletProfile {
    if (this.entries.some(entry => entry.id === id) || readEnvelopes().some(entry => entry.id === id)) {
      throw new Error('This pairing conflicts with an existing profile. Disconnect it before reconnecting.');
    }
    const profile = { ...wizardProfile(credentials.receiveAddress, credentials.changeAddress, credentials.walletName, 'mainnet', false), profileId: id };
    const entry: SessionProfile = { id, name: credentials.walletName, kind: 'wizard', profile, manager, wizardScan: scan };
    this.entries.push(entry);
    return this.switchTo(id);
  }
  updateWizardScan(manager: DappConnectionManager, scan: WalletScan): void {
    const entry = this.entries.find(item => item.manager === manager);
    if (!entry) return;
    entry.wizardScan = scan;
    if (entry.id === this.activeId) runtime.updateWizardScan(manager, scan);
  }
  suspendWizard(manager: DappConnectionManager): ConnectedWalletProfile | null {
    const entry = this.entries.find(e => e.manager === manager);
    if (!entry) return null;
    this.entries = this.entries.filter(row => row !== entry);
    const wasActive = entry.id === this.activeId;
    if (wasActive) {
      this.activeId = 'sandbox';
      runtime.connectSandboxDemo(true);
    }
    this.emit();
    return wasActive ? runtime.getAddresses() : null;
  }
  setWizardReady(manager: DappConnectionManager, ready: boolean): void {
    const entry = this.entries.find(profile => profile.manager === manager);
    if (!entry || entry.profile.externalSigningReady === ready) return;
    if (entry.id === this.activeId) {
      runtime.updateWizardAvailability(manager, ready);
      entry.profile = runtime.getAddresses();
    }
    else { entry.profile = { ...entry.profile, externalSigningReady: ready }; this.emit(); }
  }
  addLocal(
    mnemonic: string,
    network: WalletNetwork,
    sandbox: boolean,
    name: string,
    securityAccount?: SecurityAccount,
    accountIndex = 0,
  ): ConnectedWalletProfile {
    const wallet = new BchWalletService();
    const addresses = wallet.importLocalWallet(mnemonic, network, accountIndex);
    const duplicate = this.entries.find(
      (e) =>
        e.kind === "local" &&
        e.profile.receiveAddress === addresses.receiveAddress &&
        e.profile.network === network &&
        Boolean(e.sandbox) === sandbox,
    );
    if (duplicate) {
      if (securityAccount) {
        if (duplicate.securityAccount && duplicate.securityAccount.id !== securityAccount.id) throw new Error('This wallet is linked to another security account.');
        duplicate.securityAccount = securityAccount; duplicate.profile = { ...duplicate.profile, securityAccount };
      }
      wallet.lock();
      return this.switchTo(duplicate.id);
    }
    const profile = runtime.setLocalProfile(addresses, sandbox, wallet);
    profile.securityAccount = securityAccount;
    profile.walletLabel = name.trim() || `${network === "chipnet" ? "Chipnet" : "Mainnet"} HD Wallet`;
    const entry: SessionProfile = {
      id: crypto.randomUUID(),
      name:
        name.trim() ||
        `${network === "chipnet" ? "Chipnet" : "Mainnet"} HD Wallet`,
      kind: "local",
      profile,
      wallet,
      sandbox,
      securityAccount,
      mnemonic: mnemonic
        .normalize("NFKD")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .join(" "),
    };
    entry.profile.profileId = entry.id;
    entry.profile.localProfileId = entry.id;
    this.entries.push(entry);
    this.activeId = entry.id;
    this.rememberLiveSelection(entry);
    this.emit();
    return profile;
  }
  addWatch(
    address: string,
    network: WalletNetwork,
    name: string,
  ): ConnectedWalletProfile {
    const profile = runtime.setWatchProfile(
      address,
      network,
      name.trim() || "Watch-only wallet",
    );
    const entry: SessionProfile = {
      id: crypto.randomUUID(),
      name: profile.walletLabel,
      kind: "watch",
      profile,
    };
    entry.profile.profileId = entry.id;
    this.entries.push(entry);
    this.activeId = entry.id;
    this.rememberLiveSelection(entry);
    this.emit();
    return profile;
  }
  describeWatchUpgrade(id: string) {
    const entry = this.entries.find(row => row.id === id && row.kind === 'watch');
    if (!entry) return;
    const address = decodeCashAddress(entry.profile.receiveAddress);
    const supported = typeof address !== 'string' && address.type === CashAddressType.p2pkh && address.payload.length === 20;
    let saved: Envelope | undefined;
    try { saved = readEnvelopes().find(row => row.id === id); } catch { /* Session signing is still available. */ }
    return {
      name: entry.name,
      network: entry.profile.network,
      address: entry.profile.receiveTokenAddress,
      supported,
      saved: !!saved,
      protected: !!(saved && saved.mode !== 'device' || entry.securityAccount),
      needsSavePassword: !!saved && saved.mode !== 'device' && !saved.securityAccount,
    };
  }

  async upgradeWatchProfile(id: string, phrase: string, options: {
    save: boolean;
    password?: string;
    signal?: AbortSignal;
  }): Promise<ConnectedWalletProfile> {
    const entry = this.entries.find(row => row.id === id && row.kind === 'watch');
    if (!entry) throw new Error('Select a Watch-only profile to enable signing.');
    if (!this.describeWatchUpgrade(id)?.supported) throw new Error('This address requires a wallet that supports its script.');

    const startingId = this.activeId;
    const generation = this.generation;
    const version = this.profileVersions.get(id) ?? 0;
    const checkCurrent = () => {
      if (options.signal?.aborted || startingId !== this.activeId || generation !== this.generation ||
          version !== (this.profileVersions.get(id) ?? 0) || !this.entries.includes(entry) || entry.kind !== 'watch') {
        throw new Error('Wallet selection changed. Open Enable signing again.');
      }
      if (this.entries.some(row => row.id !== id && row.kind !== 'watch' && row.kind !== 'sandbox' && !row.sandbox &&
          row.profile.network === entry.profile.network && row.profile.receiveAddress === entry.profile.receiveAddress)) {
        throw new Error('A signing wallet is already available for this address. Activate it from Connected wallets.');
      }
    };
    checkCurrent();

    const wallet = new BchWalletService();
    let committed = false;
    try {
      const mnemonic = phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
      const addresses = wallet.importLocalWallet(mnemonic, entry.profile.network);
      if (addresses.receiveAddress !== entry.profile.receiveAddress || addresses.network !== entry.profile.network) {
        throw new Error('This recovery phrase does not match the watched address on this network.');
      }

      let previous: Envelope | undefined;
      try { previous = readEnvelopes().find(row => row.id === id); }
      catch (error) { if (options.save) throw error; }
      const account = previous?.securityAccount ?? entry.securityAccount;
      let password = options.password;
      let unlockKey: string | undefined;
      let verifiedAccount = account;
      if (account) {
        const cancelAuthorization = () => clearProfileAuthorization(id);
        options.signal?.addEventListener('abort', cancelAuthorization, { once: true });
        try {
          const authorized = await authorizeAccount(account, 'unlock', undefined, undefined, id);
          consumeAuthorization(account, 'unlock', id);
          ({ password, unlockKey, account: verifiedAccount } = authorized);
        } finally { options.signal?.removeEventListener('abort', cancelAuthorization); }
      }
      checkCurrent();

      const candidate: SessionProfile = {
        id, name: entry.name, kind: 'local', wallet, mnemonic, securityAccount: verifiedAccount,
        watchFallback: options.save ? undefined : entry,
        profile: {
          ...entry.profile, ...addresses, connectionType: 'BUILTIN_HD_XO', localProfileId: id,
          walletLabel: entry.name, securityAccount: verifiedAccount, balanceSats: 0n, utxos: [], utxoSource: 'syncing',
        },
      };
      const activate = () => {
        this.profileVersions.set(id, version + 1);
        this.entries = this.entries.map(row => row === entry ? candidate : row);
        if (verifiedAccount) markWalletSessionUnlocked(id, verifiedAccount);
        committed = true;
        return this.switchTo(id);
      };
      if (!options.save) return activate();

      return await this.queueStorage(async () => {
        const checkBackup = () => {
          checkCurrent();
          const latest = readEnvelopes().find(row => row.id === id);
          if (JSON.stringify(previous) !== JSON.stringify(latest)) throw new Error('The saved profile changed. Open Enable signing again.');
        };
        checkBackup();
        if (previous && previous.mode !== 'device') {
          try {
            if (!password) throw new Error('Password required');
            const secret = account ? `${password}\0${unlockKey}` : password;
            const saved = await decryptProfile(previous, await deriveKey(secret, new Uint8Array(previous.salt)));
            if (saved.id !== id || saved.kind !== 'watch' || saved.network !== addresses.network ||
                validateAndConvertCashAddr(saved.address ?? '').standardAddress !== addresses.receiveAddress ||
                saved.securityAccount?.id !== account?.id) throw new Error('Backup mismatch');
          } catch { throw new Error('Enter the existing saved profile password to keep its protection.'); }
        }
        await this.writeEncryptedProfile({ id, name: entry.name, kind: 'local', network: addresses.network, mnemonic, securityAccount: verifiedAccount }, password, unlockKey, checkBackup);
        return activate();
      });
    } finally {
      if (!committed) wallet.lock();
    }
  }

  addExtension(
    receiveAddress: string,
    changeAddress: string,
    network: WalletNetwork,
    name: string,
    provider: InjectedBchProvider,
  ): ConnectedWalletProfile {
    const profile = runtime.setExtensionProfile(
      receiveAddress,
      changeAddress,
      name.trim() || provider.name,
      network,
      provider,
    );
    const entry: SessionProfile = {
      id: crypto.randomUUID(),
      name: profile.walletLabel,
      kind: "extension",
      profile,
      provider,
    };
    entry.profile.profileId = entry.id;
    this.entries.push(entry);
    this.activeId = entry.id;
    this.rememberLiveSelection(entry);
    this.emit();
    return profile;
  }
  switchTo(id: string): ConnectedWalletProfile {
    const old = this.entries.find((e) => e.id === this.activeId);
    const current = runtime.getAddresses();
    if (
      old &&
      old.id === current.profileId &&
      old.profile.connectionType === current.connectionType &&
      old.profile.network === current.network
    )
      old.profile = current;
    const next = this.entries.find((e) => e.id === id);
    if (!next) throw new Error("Profile not found.");
    this.activeId = id;
    next.profile.localProfileId=next.kind === "local" ? id : undefined;
    const refreshed =
      next.kind === "sandbox" || next.profile.utxoSource === "sandbox"
        ? next.profile
        : {
            ...next.profile,
            utxos: [],
            balanceSats: 0n,
            utxoSource: "syncing",
          };
    const profile = runtime.activateSavedProfile(
      refreshed,
      next.wallet,
      next.manager,
      next.provider,
      next.wizardScan,
    );
    next.profile = profile;
    this.rememberLiveSelection(next);
    this.emit();
    return profile;
  }
  revealActiveSeed(): string {
    const current = this.getActiveProfile();
    if (current.securityAccount) consumeAuthorization(current.securityAccount, 'reveal',current.id);
    if (!current.mnemonic)
      throw new Error("This profile has no recovery phrase available.");
    return current.mnemonic;
  }
  getCurrentWallet(): ConnectedWalletProfile { return runtime.getAddresses(); }
  async revealAuthorizedSeed(): Promise<string> {
    const id = this.activeId;
    const account = this.getActiveProfile().securityAccount;
    if (account) await authorizeAccount(account, 'reveal',undefined,undefined,id);
    if (this.activeId !== id) throw new Error('Wallet changed during authorization. Try again.');
    return this.revealActiveSeed();
  }
  async switchLocalNetwork(network: WalletNetwork): Promise<ConnectedWalletProfile> {
    const entry = this.getActiveProfile();
    if (entry.kind !== 'local' || entry.sandbox || !entry.mnemonic) throw new Error('Select an unlocked live wallet to change its network.');
    if (entry.profile.network === network) return runtime.getAddresses();
    const wallet = new BchWalletService();
    const addresses = wallet.importLocalWallet(entry.mnemonic, network, entry.profile.accountIndex);
    const profile = runtime.setLocalProfile(addresses, false, wallet);
    profile.profileId = entry.id;
    profile.securityAccount = entry.securityAccount;
    profile.localProfileId = entry.id;
    profile.walletLabel = entry.name;
    entry.wallet?.lock();
    entry.wallet = wallet;
    entry.profile = profile;
    try {
      if (readEnvelopes().some(record => record.id === entry.id)) localStorage.setItem(`${NETWORK_KEY_PREFIX}${entry.id}`, network);
    } catch { /* The network can still be selected for this session. */ }
    this.rememberLiveSelection(entry);
    this.emit();
    return profile;
  }
  async protectActive(account: SecurityAccount, password: string, unlockKey: string): Promise<void> {
    const entry = this.getActiveProfile();
    if (entry.kind !== 'local') throw new Error('Password protection requires an unlocked local HD wallet.');
    const previous = entry.securityAccount;
    entry.securityAccount = account; entry.profile = { ...entry.profile, securityAccount: account };
    try { await this.rememberActive(password, unlockKey); }
    catch (error) { entry.securityAccount = previous; entry.profile = { ...entry.profile, securityAccount: previous }; throw error; }
    markWalletSessionUnlocked(entry.id,account);
    runtime.activateSavedProfile(entry.profile, entry.wallet, entry.manager, entry.provider); this.emit();
  }
  updateSecurityAccount(account: SecurityAccount): void {
    for (const entry of this.entries) if (entry.securityAccount?.id === account.id) { entry.securityAccount = account; entry.profile = { ...entry.profile, securityAccount: account }; }
    const current = this.getActiveProfile(); runtime.activateSavedProfile(current.profile, current.wallet, current.manager, current.provider); this.emit();
  }
  async rememberActive(password?: string, unlockKey?: string): Promise<void> {
    const entry = this.getActiveProfile();
    if (entry.kind === "sandbox")
      throw new Error("The sandbox profile does not need to be saved.");
    if (entry.kind === 'wizard') throw new Error('WizardConnect is saved separately as a pairing.');
    const record: StoredProfile = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind === "local" ? "local" : "watch",
      network: entry.profile.network,
      securityAccount: entry.securityAccount,
      ...(entry.kind === "local"
        ? { mnemonic: entry.mnemonic, sandbox: entry.sandbox, accountIndex: entry.profile.accountIndex }
        : { address: entry.profile.receiveAddress }),
    };
    const generation = this.generation;
    const profileVersion = this.profileVersions.get(record.id) ?? 0;
    const checkCurrent = () => {
      if (generation !== this.generation || profileVersion !== (this.profileVersions.get(record.id) ?? 0)) {
        throw new Error('Profile saving was cancelled.');
      }
    };
    await this.queueStorage(async () => {
      await this.writeEncryptedProfile(record, password, unlockKey, checkCurrent);
      entry.watchFallback = undefined;
      this.emit();
    });
  }

  private queueStorage<T>(job: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.then(job);
    this.storageQueue = result.then(() => {}, () => {});
    return result;
  }

  private async writeEncryptedProfile(record: StoredProfile, password: string | undefined, unlockKey: string | undefined, checkCurrent: () => void): Promise<void> {
    checkCurrent();
    if (password !== undefined && password.length < 8) throw new Error('Choose a password with at least 8 characters.');
    if (record.securityAccount && (!password || !unlockKey || !/^[a-f0-9]{64}$/i.test(unlockKey))) {
      throw new Error('Verify account security before saving this protected wallet.');
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyName = `${DEVICE_KEY_PREFIX}${record.id}`;
    const savedKey = password === undefined ? localStorage.getItem(keyName) : null;
    const newKey = password === undefined && !savedKey ? newDeviceKeyMaterial() : undefined;
    const key = password === undefined
      ? await importDeviceKey(savedKey ?? newKey ?? null)
      : await deriveKey(record.securityAccount ? `${password}\0${unlockKey}` : password, salt);
    const bytes = encode.encode(JSON.stringify(record));
    let ciphertext: ArrayBuffer;
    try { ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, bytes); }
    finally { bytes.fill(0); }

    checkCurrent();
    const envelope: Envelope = {
      id: record.id, securityAccount: record.securityAccount, mode: password === undefined ? 'device' : 'password',
      salt: Array.from(salt), iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)),
    };
    const saved = readEnvelopes().filter(entry => entry.id !== record.id);
    let wroteKey = false;
    try {
      if (password === undefined && localStorage.getItem(keyName) !== savedKey) throw new Error('The profile device key changed.');
      if (newKey) { localStorage.setItem(keyName, newKey); wroteKey = true; }
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...saved, envelope]));
    } catch (error) {
      if (wroteKey) localStorage.removeItem(keyName);
      throw error;
    }
    if (record.securityAccount) {
      try { localStorage.removeItem(keyName); } catch { /* The new ciphertext requires the account factor. */ }
    }
  }
  async unlockSaved(password: string, profileId: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    if (!profileId) throw new Error('Select the saved profile to unlock.');
    const selected = this.getLockedProfiles().find(profile => profile.id === profileId);
    if (!selected) throw new Error('This saved profile is unavailable or already unlocked.');
    if (!selected.device && !password) throw new Error('Enter your profile password.');
    return this.loadSaved(selected.device ? undefined : password, selected.device, profileId, signal);
  }
  async unlockDeviceProfiles(): Promise<number> {
    return this.loadSaved(undefined, true);
  }
  private async loadSaved(
    password: string | undefined,
    device: boolean,
    selectedProfileId?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    let count = 0;
    let failed = 0;
    const generation = this.generation;
    for (const encrypted of readEnvelopes().filter(row => !selectedProfileId || row.id === selectedProfileId)) {
      const profileVersion = this.profileVersions.get(encrypted.id)??0;
      if (this.entries.some((e) => e.id === encrypted.id)) continue;
      if ((encrypted.mode === "device") !== device) continue;
      try {
        let unlockPassword = password, unlockMaterial: string | undefined, verifiedAccount: SecurityAccount | undefined;
        if (encrypted.securityAccount) {
          const verified = await authorizeAccount(encrypted.securityAccount, 'unlock', password,undefined,encrypted.id);
          consumeAuthorization(encrypted.securityAccount, 'unlock',encrypted.id); unlockPassword = verified.password; unlockMaterial = verified.unlockKey; verifiedAccount = verified.account;
        }
        const key = device
          ? await importDeviceKey(localStorage.getItem(`${DEVICE_KEY_PREFIX}${encrypted.id}`))
          : await deriveKey(encrypted.securityAccount ? `${unlockPassword}\0${unlockMaterial}` : unlockPassword!, new Uint8Array(encrypted.salt));
        const record = await decryptProfile(encrypted, key);
        signal?.throwIfAborted();
        if (generation !== this.generation || profileVersion !== (this.profileVersions.get(encrypted.id)??0))
          throw new Error("Profile unlock cancelled");
        if (this.entries.some((e) => e.id === encrypted.id)) continue;
        if (
          record.id !== encrypted.id ||
          !["mainnet", "chipnet"].includes(record.network) ||
          !["local", "watch"].includes(record.kind)
        )
          throw new Error("Invalid profile");
        if (record.securityAccount?.id !== encrypted.securityAccount?.id) throw new Error("Account binding does not match encrypted profile.");
        if (verifiedAccount) record.securityAccount = verifiedAccount;
        if (record.kind === "local" && record.mnemonic) {
          const wallet = new BchWalletService();
          const addresses = wallet.importLocalWallet(
            record.mnemonic,
            record.sandbox ? record.network : savedNetwork(record.id, record.network),
            record.accountIndex,
          );
          const profile: ConnectedWalletProfile = {
            ...runtime.getAddresses(),
            ...addresses,
            ...accountDerivationPaths(addresses.accountIndex),
            profileId: record.id,
            securityAccount: record.securityAccount,
            localProfileId:record.id,
            connectionType: "BUILTIN_HD_XO",
            walletLabel: record.name || "Active Wallet",
            isConnected: true,
            utxos: [],
            balanceSats: 0n,
            utxoSource: record.sandbox ? "sandbox" : "unavailable",
          };
          this.entries.push({
            id: record.id,
            name: record.name,
            kind: "local",
            profile,
            wallet,
            sandbox: record.sandbox,
            securityAccount: record.securityAccount,
            mnemonic: record.mnemonic,
          });
          if(record.securityAccount)markWalletSessionUnlocked(record.id,record.securityAccount);
          count++;
        } else if (record.kind === "watch" && record.address) {
          const checked = validateAndConvertCashAddr(record.address);
          if (
            !checked.valid ||
            checked.network !== record.network ||
            !checked.standardAddress ||
            !checked.tokenAwareAddress
          )
            throw new Error("Invalid watch address");
          const profile: ConnectedWalletProfile = {
            ...runtime.getAddresses(),
            profileId: record.id,
            localProfileId:undefined,
            securityAccount:record.securityAccount,
            connectionType: "WATCH_ONLY",
            walletLabel: record.name,
            network: record.network,
            isConnected: true,
            receiveAddress: checked.standardAddress,
            receiveTokenAddress: checked.tokenAwareAddress,
            changeAddress: checked.standardAddress,
            changeTokenAddress: checked.tokenAwareAddress,
            balanceSats: 0n,
            utxos: [],
            utxoSource: "unavailable",
          };
          this.entries.push({
            id: record.id,
            name: record.name,
            kind: "watch",
            profile,
            securityAccount: record.securityAccount,
          });
          count++;
        }
      } catch {
        failed++;
      }
    }
    signal?.throwIfAborted();
    if (device && failed)
      throw new Error(
        "Some device-key profiles could not be unlocked. Restore their recovery phrases.",
      );
    if (!device && !count)
      throw new Error(
        "No locked profiles could be unlocked with that password.",
      );
    this.emit();
    return count;
  }
  removeActive(): ConnectedWalletProfile {
    return this.removeProfile(this.activeId);
  }
  removeProfile(id:string): ConnectedWalletProfile {
    const entry = this.entries.find(row=>row.id===id);
    const stored = readEnvelopes();
    if (id === 'sandbox') throw new Error('The practice account cannot be removed.');
    if(!entry&&!stored.some(row=>row.id===id))throw Error('Profile not found.');
    clearProfileAuthorization(id);
    this.profileVersions.set(id,(this.profileVersions.get(id)??0)+1);
    const saved = stored.filter(row => row.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    localStorage.removeItem(`${DEVICE_KEY_PREFIX}${id}`);
    localStorage.removeItem(`${NETWORK_KEY_PREFIX}${id}`);
    if (localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY) === id) localStorage.removeItem(ACTIVE_LIVE_PROFILE_KEY);
    entry?.wallet?.lock();
    this.entries = this.entries.filter(row => row.id !== id);
    if(this.activeId===id){this.activeId='sandbox';runtime.connectSandboxDemo(true);}
    const profile = runtime.getAddresses();
    this.emit();
    return profile;
  }
  logout(): ConnectedWalletProfile {
    clearAccountAuthorization();
    this.generation++;
    // A deliberate lock is different from closing or refreshing a tab.
    try { localStorage.removeItem(ACTIVE_LIVE_PROFILE_KEY); } catch { /* The current session still locks. */ }
    for (const entry of this.entries) entry.wallet?.lock();
    const profile = runtime.connectSandboxDemo();
    this.entries = [
      {
        id: "sandbox",
        name: "Paper Trading Account",
        kind: "sandbox",
        profile,
      },
    ];
    this.activeId = "sandbox";
    this.emit();
    return profile;
  }
  wipeAll(): ConnectedWalletProfile {
    clearAccountAuthorization();
    this.generation++;
    this.savedWizardProfiles = [];
    if (typeof indexedDB !== 'undefined') void clearWizardCredentials().catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_LIVE_PROFILE_KEY);
    const deviceKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DEVICE_KEY_PREFIX) || key?.startsWith(NETWORK_KEY_PREFIX)) deviceKeys.push(key);
    }
    for (const key of deviceKeys) localStorage.removeItem(key);
    for (const entry of this.entries) entry.wallet?.lock();
    const profile = runtime.connectSandboxDemo();
    this.entries = [
      { id: "sandbox", name: "Paper Trading Account", kind: "sandbox", profile },
    ];
    this.activeId = "sandbox";
    this.emit();
    return profile;
  }
}
export const profileManager = new ProfileManager();
