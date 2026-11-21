import { subscribeAuthorization, isWalletSessionUnlocked } from './accountSecurity.js';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveP2sh32CashAddr } from '@cashingularity/shared';
import { BchWalletService } from './bchWalletService.js';
import { ACTIVE_LIVE_PROFILE_KEY, ProfileManager } from "./profileManager.js";
import { wizardWalletSingleton } from "./walletRuntime.js";
import { DappConnectionManager } from '@wizardconnect/dapp';

const mnemonic = "abandon ".repeat(11) + "about"; // Public zero-entropy BIP39 test vector.
const profileStorageKey = 'cashingularity.profiles.v1';

function testAddresses(network: 'mainnet' | 'chipnet') {
  const wallet = new BchWalletService();
  const addresses = wallet.importLocalWallet(mnemonic, network);
  wallet.lock();
  return addresses;
}
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(k) {
      return map.get(k) ?? null;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k) {
      map.delete(k);
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
  };
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("localStorage", makeStorage());
  wizardWalletSingleton.connectSandboxDemo();
});
afterEach(() => {
  wizardWalletSingleton.connectSandboxDemo();
  vi.unstubAllGlobals();
});
describe("encrypted wallet profiles", () => {
  it('separates same-name watch, signing and WizardConnect profiles even for the same address', () => {
    const profiles = new ProfileManager();
    const addresses = testAddresses('mainnet');
    profiles.addWatch(addresses.receiveAddress, 'mainnet', 'Selene');
    const watchId = profiles.getActiveId();
    profiles.addLocal(mnemonic, 'mainnet', false, 'Selene');
    const localId = profiles.getActiveId();
    const first = new DappConnectionManager('QA', undefined, { session: false });
    const second = new DappConnectionManager('QA', undefined, { session: false });
    const identity = {
      ...addresses, walletName: 'Selene', walletPublicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), secret: 'fixture',
    };
    const former = profiles.addWizard('wizard-1', identity, first);
    profiles.addWizard('wizard-2', identity, second);
    profiles.updateCurrent(former);
    expect(profiles.getActiveId()).toBe('wizard-2');
    expect(profiles.getWizardConnection(watchId)).toBeUndefined();
    expect(profiles.getWizardConnection(localId)).toBeUndefined();
    expect(profiles.getWizardConnection('wizard-2')).toBe(second);
    expect(profiles.suspendWizard(first)).toBeNull();
    expect(profiles.getActiveId()).toBe('wizard-2');
    expect(profiles.switchTo(watchId)).toMatchObject({ profileId: watchId, connectionType: 'WATCH_ONLY' });
    expect(profiles.switchTo(localId)).toMatchObject({ profileId: localId, connectionType: 'BUILTIN_HD_XO' });
    expect(profiles.switchTo('sandbox')).toMatchObject({ profileId: 'sandbox', connectionType: 'SANDBOX_DEMO' });
  });

  it('locks one wallet independently when both use the same security account', async () => {
    const profiles = new ProfileManager();
    const account = { id: 'one-account', username: 'wallet-owner', totpEnabled: true };
    profiles.addLocal(mnemonic, 'mainnet', false, 'First account path');
    const first = profiles.getActiveId();
    await profiles.protectActive(account, 'profile-password', 'ab'.repeat(32));
    profiles.addLocal(mnemonic, 'mainnet', false, 'Second account path', account, 1);
    const second = profiles.getActiveId();
    await profiles.protectActive(account, 'profile-password', 'ab'.repeat(32));
    profiles.lockProfile(first);
    expect(isWalletSessionUnlocked(first, account)).toBe(false);
    expect(isWalletSessionUnlocked(second, account)).toBe(true);
    expect(profiles.getActiveId()).toBe(second);
  });

  it('keeps one identity and backup across network switches, with explicit restoration', async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, 'mainnet', false, 'Primary');
    const id = profiles.getActiveId();
    await profiles.rememberActive();
    const encrypted = localStorage.getItem(profileStorageKey);
    const chipnet = await profiles.switchLocalNetwork('chipnet');
    expect(chipnet).toMatchObject({ localProfileId: id, walletLabel: 'Primary', network: 'chipnet', utxoSource: 'syncing' });
    expect(chipnet.receiveAddress).toMatch(/^bchtest:/);
    expect(chipnet.utxos).toEqual([]);
    expect(localStorage.getItem(profileStorageKey)).toBe(encrypted);
    profiles.lockProfile(id);
    expect(profiles.getActiveId()).toBe('sandbox');
    expect(profiles.list().some(profile => profile.id === id)).toBe(false);
    expect(profiles.getLockedProfiles().map(profile => profile.id)).toEqual([id]);
    await profiles.unlockSaved('', id);
    expect(profiles.getActiveId()).toBe('sandbox');
    expect(profiles.switchTo(id)).toMatchObject({ localProfileId: id, network: 'chipnet', walletLabel: 'Primary' });
  });

  it('keeps a saved profile locked when its explicit unlock is cancelled', async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, 'mainnet', false, 'Saved');
    const id = profiles.getActiveId();
    await profiles.rememberActive();
    profiles.lockProfile(id);
    const controller = new AbortController();
    const unlock = profiles.unlockSaved('', id, controller.signal);
    controller.abort();
    await expect(unlock).rejects.toThrow();
    expect(profiles.getLockedProfiles().map(profile => profile.id)).toEqual([id]);
    expect(profiles.getActiveId()).toBe('sandbox');
  });
  it('revokes an external signing profile and preserves only its watch-only address',()=>{
    const profiles=new ProfileManager(),address='bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
    profiles.addExtension(address,address,'mainnet','External',{name:'External',key:'bitcoinCash'});const id=profiles.getActiveId();
    expect(profiles.disconnectExternal(id).connectionType).toBe('WATCH_ONLY');expect(profiles.list().find(p=>p.id===id)?.kind).toBe('watch');
    profiles.switchTo('sandbox');expect(profiles.switchTo(id).connectionType).toBe('WATCH_ONLY');
  });
  it('locks and removes only the selected profile while preserving the active wallet and other backups',async()=>{
    const profiles=new ProfileManager();profiles.addLocal(mnemonic,'mainnet',false,'First');const first=profiles.getActiveId();await profiles.rememberActive();
    profiles.addLocal(mnemonic,'chipnet',false,'Second');const second=profiles.getActiveId();await profiles.rememberActive();
    const active=wizardWalletSingleton.getAddresses().receiveAddress;
    profiles.lockProfile(first);expect(profiles.getActiveId()).toBe(second);expect(wizardWalletSingleton.getAddresses().receiveAddress).toBe(active);
    expect(profiles.getLockedProfiles().map(p=>p.id)).toContain(first);expect(profiles.revealActiveSeed()).toBe(mnemonic);
    expect(await profiles.unlockSaved('',first)).toBe(1);profiles.removeProfile(first);
    expect(profiles.list().map(p=>p.id)).not.toContain(first);expect(profiles.getActiveId()).toBe(second);
    expect(JSON.parse(localStorage.getItem('cashingularity.profiles.v1')!).map((p:{id:string})=>p.id)).toEqual([second]);
  });
  it('prevents an in-flight unlock from resurrecting a removed saved profile',async()=>{
    const profiles=new ProfileManager();profiles.addLocal(mnemonic,'mainnet',false,'Saved');const id=profiles.getActiveId();await profiles.rememberActive('profile-password');profiles.lockProfile(id);
    const pending=profiles.unlockSaved('profile-password',id);profiles.removeProfile(id);
    await expect(pending).rejects.toThrow();expect(profiles.list().some(p=>p.id===id)).toBe(false);expect(profiles.lockedCount()).toBe(0);
  });
  it('does not discard a session-only key when locking, or cancel another profile save when removing a wallet',async()=>{
    const profiles=new ProfileManager();profiles.addLocal(mnemonic,'mainnet',false,'First');const first=profiles.getActiveId();
    expect(()=>profiles.lockProfile(first)).toThrow(/backup/);await profiles.rememberActive();
    profiles.addLocal(mnemonic,'chipnet',false,'Second');const second=profiles.getActiveId();const saving=profiles.rememberActive();profiles.removeProfile(first);
    await expect(saving).resolves.toBeUndefined();expect(profiles.list().find(p=>p.id===second)?.saved).toBe(true);
  });
  it('restores the selected live wallet after reload and preserves it while Paper Trading is active', async () => {
    const saved = new ProfileManager();
    saved.addLocal(mnemonic,'mainnet',false,'test-01'); const firstId=saved.getActiveId(); await saved.rememberActive();
    saved.addLocal(mnemonic,'chipnet',false,'test-02'); const secondId=saved.getActiveId(); await saved.rememberActive();
    saved.switchTo(firstId); expect(localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY)).toBe(firstId);
    saved.switchTo('sandbox'); expect(localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY)).toBe(firstId);
    expect(saved.activatePreferredLiveProfile()?.walletLabel).toBe('test-01'); expect(saved.getActiveId()).toBe(firstId);
    saved.switchTo(secondId); saved.switchTo('sandbox');
    const restored=new ProfileManager(); await restored.unlockDeviceProfiles();
    expect(restored.getActiveId()).toBe('sandbox'); expect(restored.activatePreferredLiveProfile()?.walletLabel).toBe('test-02');
    expect(restored.getActiveId()).toBe(secondId); expect(restored.list().filter(profile=>profile.active).map(profile=>profile.name)).toEqual(['test-02']);
    restored.wipeAll(); expect(localStorage.getItem(ACTIVE_LIVE_PROFILE_KEY)).toBeNull();
  });
  it('falls back to an unlocked live wallet without prompting for a locked preferred profile', async () => {
    const saved=new ProfileManager(); saved.addLocal(mnemonic,'mainnet',false,'Available'); const available=saved.getActiveId(); await saved.rememberActive();
    saved.addLocal(mnemonic,'chipnet',false,'Locked'); await saved.rememberActive('protected-password');
    const requested: string[]=[]; const stop=subscribeAuthorization(request=>{if(request){requested.push(request.account.id);request.reject(new Error('Unexpected prompt'));}});
    try { const restored=new ProfileManager(); await restored.unlockDeviceProfiles(); expect(restored.activatePreferredLiveProfile()?.walletLabel).toBe('Available'); expect(restored.getActiveId()).toBe(available); expect(requested).toEqual([]); expect(restored.getLockedProfiles()).toHaveLength(1); } finally { stop(); }
  });
  it("logs out of the signing session while preserving encrypted profiles", async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, "chipnet", false, "Saved wallet");
    const id = profiles.getActiveId();
    await profiles.rememberActive();
    const saved = localStorage.getItem("cashingularity.profiles.v1");
    const disconnected = profiles.logout();
    expect(disconnected.isConnected).toBe(false);
    expect(() => profiles.revealActiveSeed()).toThrow();
    expect(() => profiles.switchTo(id)).toThrow();
    expect(localStorage.getItem("cashingularity.profiles.v1")).toBe(saved);
    expect(await profiles.unlockDeviceProfiles()).toBe(1);
    profiles.switchTo(id);
    expect(profiles.revealActiveSeed()).toBe(mnemonic);
  });
  it("removes only the selected encrypted profile and its device key", async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, 'mainnet', false, 'Keep this wallet');
    await profiles.rememberActive();
    profiles.addLocal(mnemonic, 'chipnet', false, 'Remove this wallet');
    const removed = profiles.getActiveId();
    await profiles.rememberActive();
    profiles.removeActive();
    expect(profiles.list()).toHaveLength(2);
    expect(localStorage.getItem(`cashingularity.profiles.v1.device-key.${removed}`)).toBeNull();
    const restored = new ProfileManager();
    expect(await restored.unlockDeviceProfiles()).toBe(1);
    expect(restored.list().some(row => row.name === 'Keep this wallet')).toBe(true);
  });
  it("requires account authorization and the server encryption factor for protected profiles", async () => {
    const profiles = new ProfileManager(); profiles.addLocal(mnemonic, 'mainnet', false, 'Protected');
    const account = { id: 'security-account', username: 'auditor', totpEnabled: true }, factor = 'cd'.repeat(32);
    await profiles.protectActive(account, 'secure-password-123', factor);
    const protectedId=profiles.getActiveId();
    expect(profiles.getCurrentWallet().localProfileId).toBe(protectedId);
    expect(isWalletSessionUnlocked(protectedId,account)).toBe(true);
    const stored = localStorage.getItem('cashingularity.profiles.v1')!;
    expect(stored).not.toContain(mnemonic); expect(stored).not.toContain(factor);
    expect(() => profiles.revealActiveSeed()).toThrow(/authorization/);
    expect(localStorage.getItem(`cashingularity.profiles.v1.device-key.${profiles.getActiveId()}`)).toBeNull();
    const stopWrong = subscribeAuthorization(request => request?.resolve('secure-password-123', account, 'ef'.repeat(32)));
    const wrong = new ProfileManager(); await expect(wrong.unlockSaved('secure-password-123', wrong.getLockedProfiles()[0].id)).rejects.toThrow(); stopWrong();
    const stop = subscribeAuthorization(request => request?.resolve('secure-password-123', account, factor));
    const restored = new ProfileManager(); expect(await restored.unlockDeviceProfiles()).toBe(0); expect(await restored.unlockSaved('secure-password-123', restored.getLockedProfiles()[0].id)).toBe(1);
    expect(isWalletSessionUnlocked(protectedId,account)).toBe(true);
    restored.switchTo(restored.list().find(row => row.kind === 'local')!.id);
    expect(await restored.revealAuthorizedSeed()).toBe(mnemonic); expect(() => restored.revealActiveSeed()).toThrow(/authorization/); stop();
    restored.lockProfile(protectedId);expect(isWalletSessionUnlocked(protectedId,account)).toBe(false);
  });
  it('authorizes only the chosen encrypted profile even when two accounts are saved', async () => {
    const saved = new ProfileManager();
    const a = {id:'account-a',username:'alice',totpEnabled:true}, b = {id:'account-b',username:'bob',totpEnabled:true};
    saved.addLocal(mnemonic,'mainnet',false,'Alice wallet'); await saved.protectActive(a,'shared-password','ab'.repeat(32)); const aId = saved.getActiveId();
    saved.addLocal(mnemonic,'chipnet',false,'Bob wallet'); await saved.protectActive(b,'shared-password','cd'.repeat(32)); const bId = saved.getActiveId();
    const requested: string[] = []; const stop = subscribeAuthorization(request => { if (request) { requested.push(request.account.id); request.resolve('shared-password',request.account,request.account.id === b.id ? 'cd'.repeat(32) : 'ab'.repeat(32)); } });
    try {
      const restored = new ProfileManager(); expect(await restored.unlockSaved('shared-password',bId)).toBe(1);
      expect(requested).toEqual(['account-b']); expect(restored.getLockedProfiles().map(p => p.id)).toEqual([aId]);
      expect(restored.switchTo(bId).walletLabel).toBe('Bob wallet');
    } finally { stop(); }
  });
  it("switches active profiles without losing their session keys and can wipe them", () => {
    const profiles = new ProfileManager();
    const chipnet = profiles.addLocal(
      mnemonic,
      "chipnet",
      false,
      "Test wallet",
    );
    const id = profiles.getActiveId();
    expect(profiles.list()).toHaveLength(2);
    expect(profiles.revealActiveSeed()).toBe(mnemonic);
    expect(profiles.switchTo("sandbox").balanceSats).toBe(250000000n);
    expect(profiles.switchTo(id).receiveTokenAddress).toBe(
      chipnet.receiveTokenAddress,
    );
    expect(profiles.revealActiveSeed()).toBe(mnemonic);
    profiles.wipeAll();
    expect(profiles.list()).toHaveLength(1);
    expect(() => profiles.revealActiveSeed()).toThrow();
  });
  it("persists only encrypted profiles and requires the correct password after reload", async () => {
    const profiles = new ProfileManager();
    const original = profiles.addLocal(
      mnemonic,
      "mainnet",
      false,
      "Private label",
    );
    await profiles.rememberActive("test-password-123");
    const stored = localStorage.getItem("cashingularity.profiles.v1")!;
    expect(stored).not.toContain(mnemonic);
    expect(stored).not.toContain("Private label");
    expect(stored).not.toContain(original.receiveAddress);
    expect(stored).not.toContain("test-password-123");
    wizardWalletSingleton.connectSandboxDemo();
    const restored = new ProfileManager();
    expect(restored.lockedCount()).toBe(1);
    await expect(restored.unlockSaved("wrong-password", restored.getLockedProfiles()[0].id)).rejects.toThrow();
    expect(restored.lockedCount()).toBe(1);
    expect(await restored.unlockSaved("test-password-123", restored.getLockedProfiles()[0].id)).toBe(1);
    const id = restored.list().find((p) => p.name === "Private label")!.id;
    expect(restored.switchTo(id).receiveAddress).toBe(original.receiveAddress);
    expect(restored.revealActiveSeed()).toBe(mnemonic);
    restored.wipeAll();
    expect(localStorage.getItem("cashingularity.profiles.v1")).toBeNull();
  });
  it("restores multiple encrypted profiles and preserves sandbox mode", async () => {
    const profiles = new ProfileManager();
    const first = profiles.addLocal(mnemonic, "chipnet", false, "Chipnet");
    await profiles.rememberActive("same-password");
    const second = profiles.addLocal(
      `${"abandon ".repeat(23)}art`,
      "mainnet",
      true,
      "Sandbox key",
    );
    await profiles.rememberActive("same-password");
    expect(profiles.list()).toHaveLength(3);
    const firstId = profiles.list().find((p) => p.name === "Chipnet")!.id;
    expect(profiles.switchTo(firstId).receiveAddress).toBe(
      first.receiveAddress,
    );
    wizardWalletSingleton.connectSandboxDemo();
    const restored = new ProfileManager();
    expect(await restored.unlockSaved("same-password", firstId)).toBe(1);
    expect(restored.getLockedProfiles()).toHaveLength(1);
    expect(restored.list().filter(p => p.kind === 'local')).toHaveLength(1);
    expect(await restored.unlockSaved("same-password", restored.getLockedProfiles()[0].id)).toBe(1);
    const secondId = restored.list().find((p) => p.name === "Sandbox key")!.id;
    const switched = restored.switchTo(secondId);
    expect(switched.receiveAddress).toBe(second.receiveAddress);
    expect(switched.utxoSource).toBe("sandbox");
    restored.wipeAll();
  });
  it("restores device-key profiles without a password while preserving locked password profiles", async () => {
    const profiles = new ProfileManager();
    const device = profiles.addLocal(
      mnemonic,
      "chipnet",
      false,
      "Device wallet",
    );
    await profiles.rememberActive();
    profiles.addLocal(
      `${"abandon ".repeat(23)}art`,
      "mainnet",
      false,
      "Password wallet",
    );
    await profiles.rememberActive("another-password");
    const storage = localStorage.getItem("cashingularity.profiles.v1")!;
    expect(storage).not.toContain(mnemonic);
    expect(
      [...Array(localStorage.length)]
        .map((_, i) => localStorage.key(i))
        .some((k) => k?.startsWith("cashingularity.profiles.v1.device-key.")),
    ).toBe(true);
    wizardWalletSingleton.connectSandboxDemo();
    const restored = new ProfileManager();
    await Promise.all([
      restored.unlockDeviceProfiles(),
      restored.unlockDeviceProfiles(),
    ]);
    expect(
      restored.list().filter((p) => p.name === "Device wallet"),
    ).toHaveLength(1);
    expect(restored.lockedCount()).toBe(1);
    expect(
      restored.switchTo(
        restored.list().find((p) => p.name === "Device wallet")!.id,
      ).receiveAddress,
    ).toBe(device.receiveAddress);
    expect(restored.revealActiveSeed()).toBe(mnemonic);
    expect(await restored.unlockSaved("another-password", restored.getLockedProfiles()[0].id)).toBe(1);
    restored.wipeAll();
    expect(
      [...Array(localStorage.length)]
        .map((_, i) => localStorage.key(i))
        .some((k) => k?.startsWith("cashingularity.profiles.v1.device-key.")),
    ).toBe(false);
  });
  it("never substitutes a predictable key if device storage is unavailable", async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, "mainnet", false, "Local");
    const storage = makeStorage();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.stubGlobal("localStorage", storage);
    await expect(profiles.rememberActive()).rejects.toThrow(
      "Storage unavailable",
    );
  });
  it("does not recreate a device key after profiles are wiped during an asynchronous save", async () => {
    const profiles = new ProfileManager();
    profiles.addLocal(mnemonic, "chipnet", false, "Test");
    const pending = profiles.rememberActive();
    profiles.wipeAll();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(localStorage.length).toBe(0);
  });
});

describe('Watch-only signing upgrade', () => {
  it.each(['mainnet', 'chipnet'] as const)('matches the watched key on %s and preserves the original backup for session signing', async network => {
    const profiles = new ProfileManager();
    const address = testAddresses(network);
    profiles.addWatch(network === 'mainnet' ? address.receiveAddress : address.receiveTokenAddress, network, 'Treasury');
    const id = profiles.getActiveId();
    await profiles.rememberActive();
    const backup = localStorage.getItem(profileStorageKey);

    const upgraded = await profiles.upgradeWatchProfile(id, ` ${mnemonic.toUpperCase().replaceAll(' ', '\n')} `, { save: false });
    expect(upgraded).toMatchObject({ localProfileId: id, walletLabel: 'Treasury', receiveAddress: address.receiveAddress, network, connectionType: 'BUILTIN_HD_XO' });
    expect(profiles.list().filter(profile => profile.id === id)).toEqual([expect.objectContaining({ kind: 'local', sessionSigning: true, address: address.receiveTokenAddress, active: true })]);
    expect(profiles.revealActiveSeed()).toBe(mnemonic);
    expect(localStorage.getItem(profileStorageKey)).toBe(backup);

    expect(profiles.lockProfile(id)).toMatchObject({ connectionType: 'WATCH_ONLY', receiveTokenAddress: address.receiveTokenAddress });
    expect(profiles.getActiveId()).toBe(id);
    expect(() => profiles.revealActiveSeed()).toThrow(/no recovery phrase/);
    const restored = new ProfileManager();
    await restored.unlockDeviceProfiles();
    expect(restored.activatePreferredLiveProfile()?.connectionType).toBe('WATCH_ONLY');
    expect(restored.getActiveId()).toBe(id);
  });

  it('replaces only the selected encrypted backup and keeps its password', async () => {
    const profiles = new ProfileManager();
    const address = testAddresses('mainnet');
    profiles.addWatch(address.receiveAddress, 'mainnet', 'Protected treasury');
    const id = profiles.getActiveId();
    await profiles.rememberActive('original-password');
    const prior = localStorage.getItem(profileStorageKey);

    await expect(profiles.upgradeWatchProfile(id, mnemonic, { save: true, password: 'wrong-password' })).rejects.toThrow(/existing saved profile password/);
    expect(localStorage.getItem(profileStorageKey)).toBe(prior);
    expect(profiles.getCurrentWallet().connectionType).toBe('WATCH_ONLY');

    await profiles.upgradeWatchProfile(id, mnemonic, { save: true, password: 'original-password' });
    const saved = localStorage.getItem(profileStorageKey)!;
    expect(saved).not.toContain(mnemonic);
    expect(JSON.parse(saved)).toEqual([expect.objectContaining({ id, mode: 'password' })]);
    expect(localStorage.getItem(`${profileStorageKey}.device-key.${id}`)).toBeNull();
    const restored = new ProfileManager();
    expect(await restored.unlockDeviceProfiles()).toBe(0);
    expect(await restored.unlockSaved('original-password', id)).toBe(1);
    expect(restored.switchTo(id)).toMatchObject({ receiveAddress: address.receiveAddress, walletLabel: 'Protected treasury', connectionType: 'BUILTIN_HD_XO' });
    expect(restored.revealActiveSeed()).toBe(mnemonic);
  });

  it('rejects a mismatched phrase, a script address, and a duplicate signing wallet', async () => {
    const profiles = new ProfileManager();
    profiles.addWatch('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'mainnet', 'Other wallet');
    const other = profiles.getActiveId();
    await expect(profiles.upgradeWatchProfile(other, mnemonic, { save: false })).rejects.toThrow(/does not match/);
    expect(profiles.getActiveId()).toBe(other);

    profiles.addWatch(deriveP2sh32CashAddr('test-script').tokenAwareAddress, 'mainnet', 'Script wallet');
    await expect(profiles.upgradeWatchProfile(profiles.getActiveId(), mnemonic, { save: false })).rejects.toThrow(/supports its script/);

    const signer = profiles.addLocal(mnemonic, 'chipnet', false, 'Existing signer');
    expect(() => profiles.addWatch(signer.receiveAddress, 'mainnet', 'Wrong network')).toThrow(/network mismatch/);
    profiles.addWatch(signer.receiveTokenAddress, 'chipnet', 'Watched signer');
    await expect(profiles.upgradeWatchProfile(profiles.getActiveId(), mnemonic, { save: false })).rejects.toThrow(/signing wallet is already available/);
    expect(profiles.getCurrentWallet().connectionType).toBe('WATCH_ONLY');
  });

  it('keeps the watch profile and backup intact when saving is cancelled or fails', async () => {
    const profiles = new ProfileManager();
    profiles.addWatch(testAddresses('chipnet').receiveTokenAddress, 'chipnet', 'Treasury');
    const id = profiles.getActiveId();
    await profiles.rememberActive();
    const backup = localStorage.getItem(profileStorageKey);

    const controller = new AbortController();
    const upgrading = profiles.upgradeWatchProfile(id, mnemonic, { save: true, signal: controller.signal });
    controller.abort();
    await expect(upgrading).rejects.toThrow(/selection changed/);

    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === profileStorageKey) throw new Error('Storage unavailable');
      setItem(key, value);
    });
    await expect(profiles.upgradeWatchProfile(id, mnemonic, { save: true })).rejects.toThrow('Storage unavailable');
    expect(localStorage.getItem(profileStorageKey)).toBe(backup);
    expect(profiles.getActiveId()).toBe(id);
    expect(profiles.getCurrentWallet().connectionType).toBe('WATCH_ONLY');
  });
});
