import { decodeHdPublicKey, hexToBin } from '@bitauth/libauth';
import {
  DEFAULT_RELAY_URLS, encodeKeyExchangeURI, generateKeyExchangeCredentials,
  isHdwalletv1Session, isWalletReadyMessage, RelayClient, RelayMsgAction, RelayStatus,
  type PathXpub, type ProtocolMessage, type RelayClientConfig, type RelayStatusCallback,
} from '@wizardconnect/core';
import { AbstractSimplePool } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';
import type { WizardCredentials } from './wizardCredentials.js';

// A relay can close between nostr-tools scheduling a write and running it.
// Scope the readyState check to these sockets, leaving other WebSockets alone.
class WizardRelaySocket extends WebSocket {
  override send(data: Parameters<WebSocket['send']>[0]) {
    if (this.readyState === WebSocket.OPEN) super.send(data);
  }
}

class WizardRelayPool extends AbstractSimplePool {
  accepting = false;
  requireLiveEvents = false;
  markLive?: () => void;
  private seen = new Set<string>();
  private closeSubscription?: () => Promise<void>;

  constructor() {
    super({ verifyEvent, websocketImplementation: WizardRelaySocket, enablePing: true, maxWaitForConnection: 3_000 });
    // Only subscriptions open relay sockets. A publish can use a surviving relay during a partial outage.
    this.allowConnectingToRelay = (url, [operation]) => this.accepting && (
      operation === 'read' || this.listConnectionStatus().get(url) === true
    );
  }

  override subscribeMany(...[urls, filter, handlers]: Parameters<AbstractSimplePool['subscribeMany']>) {
    let closing: Promise<void> | undefined;
    let live = false;
    const active = () => this.accepting && !closing;
    const activate = () => { if (active()) live = true; };
    this.markLive = activate;
    const subscription = super.subscribeMany(urls, filter, {
      ...handlers,
      onevent: event => {
        if (!active() || (this.requireLiveEvents && !live) || this.seen.has(event.id)) return;
        this.seen.add(event.id);
        if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
        handlers.onevent?.(event);
      },
      oneose: () => { if (active()) { activate(); handlers.oneose?.(); } },
      onclose: reasons => { if (active()) handlers.onclose?.(reasons); },
    });
    const close = () => closing ??= Promise.resolve(subscription.close());
    this.closeSubscription = close;
    return { close };
  }

  async closeConnection() {
    try {
      // RelayClient starts closing its subscription without awaiting it.
      // Wait for the subscribed relays to send CLOSE before closing sockets.
      await this.closeSubscription?.();
    } finally {
      this.markLive = undefined;
      this.closeSubscription = undefined;
      this.destroy();
    }
  }
}

function validReadyPaths(paths: PathXpub[]): boolean {
  if (!paths.length) return true;
  if (!paths.every(path => typeof decodeHdPublicKey(path.xpub) === 'object')) return false;
  const branch = (name: 'receive' | 'change') => {
    const matching = paths.filter(path => path.name === name);
    if (matching.length !== 1) return undefined;
    const decoded = decodeHdPublicKey(matching[0].xpub);
    return typeof decoded === 'object' && decoded.network === 'mainnet' ? matching[0].xpub : undefined;
  };
  const receive = branch('receive');
  const change = branch('change');
  return Boolean(receive && change && receive !== change);
}

/** Authenticate in RelayClient, then validate before the manager can log or apply session data. */
class WizardRelayClient extends RelayClient {
  constructor(config: RelayClientConfig, pool: WizardRelayPool, private onInvalidReady: () => void) {
    super(config, pool);
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const message = event === 'message' ? args[0] as ProtocolMessage : undefined;
    if (message?.action === RelayMsgAction.WalletReady && (
      !isWalletReadyMessage(message) || !message.supported_protocols.every(protocol => typeof protocol === 'string') ||
      !message.supported_protocols.includes('hdwalletv1') || !isHdwalletv1Session(message.session.hdwalletv1) ||
      !validReadyPaths(message.session.hdwalletv1.paths)
    )) {
      this.onInvalidReady();
      return false;
    }
    return super.emit(event, ...args);
  }
}

/** One relay client and one reconnect loop per pairing, including across tab visibility changes. */
export function createWizardRelay(onStatus: RelayStatusCallback, onInvalidReady: () => void, existing?: WizardCredentials) {
  const { privateKey, secret } = existing ?? generateKeyExchangeCredentials();
  const keyBytes = hexToBin(privateKey);
  const pool = new WizardRelayPool();
  const client = new WizardRelayClient({
    signerPrivateKey: keyBytes,
    pairedPublicKey: existing ? hexToBin(existing.walletPublicKey) : new Uint8Array(33),
    pairingSecret: secret,
    explicitRelayUrls: [...DEFAULT_RELAY_URLS],
    logNetworkActivity: false,
  }, pool, onInvalidReady);
  const pairing = encodeKeyExchangeURI(client.getPublicKeyHex(), secret);
  let phase: 'idle' | 'connecting' | 'connected' | 'retrying' | 'closed' = 'idle';
  let ready = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = Promise.resolve();
  let online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const events = new AbortController();
  const relayAvailable = () => [...pool.listConnectionStatus().values()].some(Boolean);

  const connected = () => {
    // Avoid launching a handshake wait for each reconnect before a peer is pinned.
    if (phase !== 'connecting' || !ready || !client.isKeyExchangeComplete()) return;
    phase = 'connected';
    onStatus({ client, status: RelayStatus.connected() });
  };
  const connect = () => {
    if (phase === 'closed' || !online) return;
    phase = 'connecting';
    ready = false;
    pool.accepting = true;
    pool.requireLiveEvents = client.isKeyExchangeComplete();
    if (pool.requireLiveEvents) {
      client.setLastProcessedTimestamp(Math.max(client.getLastProcessedTimestamp(), Math.floor(Date.now() / 1000)));
    }
    void client.connect().catch(reconnect);
  };
  const disconnect = () => client.disconnect().finally(() => pool.closeConnection());
  const clearRetry = () => { clearTimeout(timer); timer = undefined; };
  const retry = (immediate = false) => {
    if (phase !== 'retrying' || !online || (timer !== undefined && !immediate)) return;
    clearRetry();
    const wait = immediate ? 0 : Math.min(10_000, 1_000 * 2 ** Math.min(attempt++, 4));
    timer = setTimeout(() => { timer = undefined; if (phase === 'retrying') connect(); }, wait);
  };
  function reconnect(error?: unknown) {
    if (phase === 'idle' || phase === 'retrying' || phase === 'closed') return;
    phase = 'retrying';
    pool.accepting = false;
    closing = disconnect();
    onStatus({ client, status: RelayStatus.reconnecting(error instanceof Error ? error.message : null) });
    void closing.then(() => retry(), () => retry());
  }
  const wake = () => {
    if (phase === 'retrying') void closing.then(() => retry(true), () => retry(true));
    else if (phase === 'connected' && !relayAvailable()) reconnect();
  };

  client.on('connection', () => {
    if (phase !== 'connecting') return;
    ready = relayAvailable();
    if (ready) {
      attempt = 0;
      pool.markLive?.();
    }
    connected();
  });
  client.on('paired', connected);
  client.on('disconnect', reconnect);

  return {
    ...pairing,
    credentials: { privateKey, secret },
    start() {
      if (phase !== 'idle') return;
      onStatus({ client, status: RelayStatus.reconnecting(null) });
      if (typeof window !== 'undefined') {
        window.addEventListener('offline', () => { online = false; clearRetry(); reconnect(); }, { signal: events.signal });
        window.addEventListener('online', () => { online = true; attempt = 0; wake(); }, { signal: events.signal });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') wake();
        }, { signal: events.signal });
      }
      if (online) connect();
      else phase = 'retrying';
    },
    probeWallet() {
      if (phase !== 'connected') return;
      if (!relayAvailable()) { reconnect(); return; }
      // The wallet can sleep while the Nostr sockets remain healthy.
      onStatus({ client, status: RelayStatus.reconnecting('Waiting for wallet heartbeat.') });
      onStatus({ client, status: RelayStatus.connected() });
    },
    close() {
      if (phase === 'closed') return closing;
      const disconnecting = phase === 'retrying';
      phase = 'closed';
      events.abort();
      clearRetry();
      pool.accepting = false;
      client.removeAllListeners();
      if (!disconnecting) closing = disconnect();
      closing = closing.finally(() => keyBytes.fill(0)).then(() => {});
      return closing;
    },
  };
}
