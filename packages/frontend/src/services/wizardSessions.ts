import { decodeHdPublicKey, deriveHdPublicNodeChild } from '@bitauth/libauth';
import { DisconnectReason, isHdwalletv1Session, isWalletReadyMessage, RelayMsgAction, type PathXpub, type WalletReadyMessage } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { addressFromPubkey } from './bchWalletService.js';
import type { WalletScan } from './walletChainSync.js';
import { profileManager } from './profileManager.js';
import { loadWizardCredentials, type WizardCredentials } from './wizardCredentials.js';
import { createWizardRelay } from './wizardRelay.js';
import { wizardWalletSingleton, type ConnectedWalletProfile } from './walletRuntime.js';

interface WizardSession {
  release: (revoke: boolean, forgotten?: Promise<void>) => void;
  closing?: Promise<void>;
}
const sessions = new Map<string, WizardSession>();
const revocations = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  ? new BroadcastChannel('cashingularity.wizard-revocations.v1') : undefined;
revocations?.addEventListener('message', event => {
  if (typeof event.data !== 'string') return;
  sessions.get(event.data)?.release(false);
  void profileManager.refreshWizardProfiles().catch(() => {});
});

function mainnetAccount(paths: PathXpub[]) {
  const branch = (name: 'receive' | 'change') => {
    const candidates = paths.filter(path => path.name === name);
    const xpub = candidates[0]?.xpub;
    const decoded = xpub && decodeHdPublicKey(xpub);
    if (candidates.length !== 1 || !decoded || typeof decoded === 'string' || decoded.network !== 'mainnet') {
      throw new Error('The wallet must share valid Mainnet receive and change xpubs.');
    }
    const derive = (index: number) => addressFromPubkey(deriveHdPublicNodeChild(decoded.node, index).publicKey, 'mainnet');
    return { xpub, derive, address: derive(0) };
  };
  const receive = branch('receive');
  const change = branch('change');
  if (receive.address === change.address) throw new Error('The wallet supplied the same receive and change path.');
  const scan: WalletScan = { network: 'mainnet', derive: (scope, index) => (scope === 'receive' ? receive : change).derive(index) };
  return {
    addresses: { receiveAddress: receive.address, changeAddress: change.address, receiveXpub: receive.xpub, changeXpub: change.xpub },
    scan,
  };
}

function savedScan(identity: WizardCredentials): WalletScan {
  if (identity.receiveXpub && identity.changeXpub) {
    const account = mainnetAccount([{ name: 'receive', xpub: identity.receiveXpub }, { name: 'change', xpub: identity.changeXpub }]);
    if (account.addresses.receiveAddress !== identity.receiveAddress || account.addresses.changeAddress !== identity.changeAddress) {
      throw new Error('Saved wallet paths do not match the approved account.');
    }
    return account.scan;
  }
  // Older pairings can display their known public addresses while waiting for xpubs.
  return { network: 'mainnet', addresses: [
    { address: identity.receiveAddress, scope: 'receive', index: 0 },
    { address: identity.changeAddress, scope: 'change', index: 0 },
  ] };
}

async function forgetPairing(id: string) {
  await profileManager.forgetWizardProfile(id);
  revocations?.postMessage(id);
}

interface PairingOptions {
  profileId?: string;
  shouldActivate?: () => boolean;
  onPairingCode: (uri: string, qrUri: string) => void;
  onStatus: (message: string) => void;
  onApproved: (profile: ConnectedWalletProfile) => void;
  onRestored?: (profile: ConnectedWalletProfile) => void;
  onEnded: (profile: ConnectedWalletProfile) => void;
  onPersistenceError: () => void;
}

/** Cancel a new invitation on dismissal. Previously approved pairings remain available offline. */
export function startWizardPairing(options: PairingOptions): () => void {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (options.profileId && (!locks || !revocations)) {
    options.onStatus('This browser cannot safely reopen saved WizardConnect pairings. Update your browser or scan a new pairing code.');
    return () => {};
  }
  const id = options.profileId ?? crypto.randomUUID();
  const previous = sessions.get(id);
  if (previous && !previous.closing) {
    options.onStatus(profileManager.getWizardConnection(id)
      ? 'This wallet already has a connection in this tab.'
      : 'Waiting for this saved pairing. Close any other Cashingularity tab using it to resume here.');
    return () => {};
  }
  const manager = new DappConnectionManager('Cashingularity', undefined, { session: false });
  const controller = new AbortController();
  let finish: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let ui: PairingOptions | undefined = options;
  let relay: ReturnType<typeof createWizardRelay> | undefined;
  let identity: WizardCredentials | undefined;
  let running = true;
  let registered = false;
  let approvalReported = false;
  let hasApprovedPaths = false;
  let relayOnline = false;
  let verifiedThisCycle = false;
  let saving = false;
  let latestReady: WalletReadyMessage | undefined;

  const teardown = async (revoke: boolean) => {
    await previous?.closing;
    if (revoke && relayOnline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          manager.sendDisconnect('Connection removed from Cashingularity.'),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); }),
        ]);
      } catch { /* The wallet may already be offline. */ }
      finally { clearTimeout(timer); }
    }
    void manager.destroy();
    manager.removeAllListeners();
    await relay?.close().catch(() => {});
  };
  const release = (revoke: boolean, forgotten?: Promise<void>) => {
    if (!running) return;
    running = false;
    controller.abort();
    clearTimeout(deadline);
    const suspend = () => {
      const next = profileManager.suspendWizard(manager);
      if (next) options.onEnded(next);
    };
    if (!forgotten) suspend();
    else profileManager.setWizardReady(manager, false);
    session.closing = Promise.allSettled([teardown(revoke), forgotten]).then(() => {
      if (forgotten) suspend();
      if (sessions.get(id) === session) sessions.delete(id);
      finish();
    });
  };
  const fail = (message: string, forgotten?: Promise<void>) => {
    ui?.onStatus(message);
    ui?.onPairingCode('', '');
    release(false, forgotten);
  };
  const deadline = options.profileId ? undefined : setTimeout(() => fail(
    manager.isWalletDiscovered() ? 'Wallet approval timed out. Approve a new attempt on your phone.' : 'No wallet handshake received. Open WizardConnect on your phone and retry.',
  ), 180_000);
  const session: WizardSession = { release };
  sessions.set(id, session);

  const markReady = () => {
    if (!registered || !hasApprovedPaths || !relayOnline || !verifiedThisCycle || saving) return;
    profileManager.setWizardReady(manager, true);
    const active = wizardWalletSingleton.getAddresses();
    if (!approvalReported && active.profileId === id) {
      approvalReported = true;
      ui?.onApproved(active);
    }
  };
  const persist = (credentials: WizardCredentials, replace = false) => {
    saving = true;
    let storageFailed = false;
    void profileManager.rememberWizardProfile(id, credentials, replace).catch(() => { storageFailed = true; }).then(() => {
      saving = false;
      if (running) {
        if (replace && storageFailed) {
          fail('The saved pairing could not be verified. Open Wallet connection to reconnect.');
          return;
        }
        markReady();
        if (storageFailed) ui?.onPersistenceError();
      }
    });
  };
  const requireApproval = () => {
    hasApprovedPaths = false;
    verifiedThisCycle = false;
    profileManager.setWizardReady(manager, false);
  };
  manager.on('walletready', msg => {
    // The SDK may finish a handshake after a more recent one or a disconnect.
    if (!running || !relay || msg !== latestReady) return;
    try {
      const peer = msg.public_key.toLowerCase();
      if (!/^[a-f\d]{64}$/.test(peer) || manager.protocol !== 'hdwalletv1' || (identity && identity.walletPublicKey !== peer)) {
        throw new Error('The transport identity does not match a supported WizardConnect wallet.');
      }
      const data = msg.session.hdwalletv1;
      if (!isHdwalletv1Session(data)) throw new Error('The wallet did not share a supported BCH account.');
      if (!data.paths.length) {
        // Selene introduces itself before the human approval that releases its account xpubs.
        requireApproval();
        ui?.onStatus('Wallet found. Approve the connection on your phone.');
        return;
      }
      const { addresses: account, scan } = mainnetAccount(data.paths);
      if (identity && (
        identity.receiveAddress !== account.receiveAddress || identity.changeAddress !== account.changeAddress ||
        (identity.receiveXpub && identity.receiveXpub !== account.receiveXpub) ||
        (identity.changeXpub && identity.changeXpub !== account.changeXpub)
      )) {
        throw new Error('The wallet shared a different BCH account. Reopen the original account or pair the new one separately.');
      }
      hasApprovedPaths = true;
      verifiedThisCycle = true;
      if (!registered) {
        const walletName = msg.wallet_name?.trim().slice(0, 100) || 'WizardConnect wallet';
        identity = { ...account, walletName, walletPublicKey: peer, privateKey: relay.credentials.privateKey, secret: relay.credentials.secret };
        profileManager.addWizard(id, identity, manager, scan);
        registered = true;
        clearTimeout(deadline);
        persist(identity);
      } else if (identity && (!identity.receiveXpub || !identity.changeXpub)) {
        identity = { ...identity, ...account };
        profileManager.updateWizardScan(manager, scan);
        persist(identity, true);
      }
      markReady();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
  manager.on('messagereceived', msg => {
    if (!running) return;
    if (isWalletReadyMessage(msg)) {
      latestReady = msg;
      const data = msg.session.hdwalletv1;
      // An empty or changed account takes effect before the SDK's asynchronous reply.
      const matches = msg.supported_protocols.includes('hdwalletv1') && isHdwalletv1Session(data) &&
        (['receive', 'change'] as const).every(branch => {
          const paths = data.paths.filter(path => path.name === branch);
          return paths.length === 1 && paths[0].xpub === identity?.[branch === 'receive' ? 'receiveXpub' : 'changeXpub'];
        });
      if (!matches) requireApproval();
    } else if (msg.action === RelayMsgAction.Disconnect) {
      latestReady = undefined;
      requireApproval();
      if ('reason' in msg && msg.reason === DisconnectReason.UserDisconnect) {
        // The SDK allows a grace window. An explicit revocation is terminal for this identity.
        fail('The wallet revoked this connection. Pair again to reconnect.', registered || identity ? forgetPairing(id) : undefined);
      }
    } else if (msg.action === RelayMsgAction.Pong && relayOnline && hasApprovedPaths) {
      // Keepalives only resume a previously approved account in this browser session.
      verifiedThisCycle = true;
      markReady();
    }
  });
  manager.on('reconnecting', () => {
    // The manager also emits this when the peer stops answering pings.
    if (running && relayOnline) relay?.probeWallet();
  });
  manager.on('disconnect', reason => {
    if (!running) return;
    const forgotten = reason === DisconnectReason.UserDisconnect && (registered || identity) ? forgetPairing(id) : undefined;
    fail('The external wallet disconnected.', forgotten);
  });

  const connect = async () => {
    try {
      await previous?.closing;
      if (!running) return;
      if (options.profileId) {
        identity = await loadWizardCredentials(id);
        if (!running) return;
        if (options.shouldActivate && !options.shouldActivate()) { release(false); return; }
        if (!identity) throw new Error('Saved pairing unavailable. Start a new QR pairing.');
        const next = profileManager.addWizard(id, identity, manager, savedScan(identity));
        registered = true;
        if (next === wizardWalletSingleton.getAddresses()) ui?.onRestored?.(next);
      }
      relay = createWizardRelay(({ client, status }) => {
        if (!running) return;
        relayOnline = status.status === 'connected';
        if (!relayOnline) {
          latestReady = undefined;
          verifiedThisCycle = false;
          profileManager.setWizardReady(manager, false);
        }
        manager.updateConnection(client, status);
        if (relayOnline && verifiedThisCycle) markReady();
      }, () => {
        if (!running) return;
        latestReady = undefined;
        requireApproval();
        ui?.onStatus('The wallet sent unsupported account data. Reopen WizardConnect in your wallet.');
      }, identity);
      relay.start();
      if (!options.profileId) ui?.onPairingCode(relay.uri, relay.qrUri);
      await finished;
    } catch (error) {
      if (running) fail(error instanceof Error ? error.message : String(error));
    }
  };
  // One instance can use a restored relay identity, even across separate tabs.
  if (locks) {
    void locks.request('cashingularity.wizard:' + id, { signal: controller.signal }, connect)
      .catch(error => { if (running) fail(error instanceof Error ? error.message : String(error)); });
  } else void connect();

  return () => {
    ui = undefined;
    if (!registered) release(false);
  };
}

export function pauseWizardSessions(): void {
  for (const session of sessions.values()) session.release(false);
}

export async function disconnectWizardProfile(id: string): Promise<ConnectedWalletProfile> {
  const session = sessions.get(id);
  const forgotten = forgetPairing(id);
  session?.release(true, forgotten);
  await forgotten;
  await session?.closing;
  return wizardWalletSingleton.getAddresses();
}
