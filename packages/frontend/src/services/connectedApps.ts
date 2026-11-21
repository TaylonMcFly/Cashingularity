export interface AppConnection {
  id: string; name: string; domain: string; address: string; startedAtMs: number;
  status: 'ACTIVE'; network: string; permissions: string[]; signingScope: string;
}
export interface BrowserPairing {
  id: string; url: string; origin: string; challenge: string; scope: string; address: string;
  status: 'WAITING' | 'REQUESTED' | 'ACTIVE'; source?: Window; port?: MessagePort;
}
export class BrowserAppSessions {
  private pairs = new Map<string, BrowserPairing>();
  private listeners = new Set<() => void>();
  private currentScope = '';
  private timers = new Map<string, number>();
  constructor(private host: Window) {
    host.addEventListener('message', this.receive);
    try { const keys: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith('cashingularity.apps.v1:')) keys.push(key); } for (const key of keys) localStorage.removeItem(key); } catch {}
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
  setScope(scope: string) { if (this.currentScope && this.currentScope !== scope) for (const pair of [...this.pairs.values()]) this.disconnect(pair.id); this.currentScope = scope; }
  list(scope: string): AppConnection[] {
    return [...this.pairs.values()].filter(pair => pair.scope === scope && pair.status === 'ACTIVE').map(pair => ({ id: pair.id, name: new URL(pair.url).hostname, domain: pair.origin, address: pair.address, startedAtMs: this.started.get(pair.id)!, status: 'ACTIVE', network: scope.startsWith('chipnet:') ? 'Bitcoin Cash Chipnet' : 'Bitcoin Cash Mainnet', permissions: ['Read the approved BCH address'], signingScope: 'Address access only. No transaction signing or token approvals.' }));
  }
  private started = new Map<string, number>();
  frames(): BrowserPairing[] { return [...this.pairs.values()]; }
  begin(uri: string, scope: string, address: string): string {
    if (!address || scope !== this.currentScope) throw new Error('Connect an unlocked live wallet first.');
    let url: URL; try { url = new URL(uri.trim()); } catch { throw new Error('Enter the HTTPS URL of a compatible browser dApp.'); }
    const local = url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.origin === this.host.location.origin || url.username || url.password) throw new Error('Use an HTTPS dApp on a separate origin (or another localhost port). WalletConnect URI records are not accepted as sessions.');
    if (this.pairs.size >= 10 || this.frames().some(pair => pair.status !== 'ACTIVE')) throw new Error('Finish or cancel the pending connection first.');
    const id = crypto.randomUUID();
    this.pairs.set(id, { id, url: url.href, origin: url.origin, challenge: crypto.randomUUID(), scope, address, status: 'WAITING' }); this.emit(); return id;
  }
  attachFrame(id: string, source: Window) {
    const pair = this.pairs.get(id); if (pair?.status === 'ACTIVE') { this.disconnect(id); return; } if (!pair || pair.status !== 'WAITING') return;
    pair.source = source;
    source.postMessage({ type: 'CASHINGULARITY_WALLET_HELLO', version: 1, requestId: id, challenge: pair.challenge }, pair.origin);
  }
  private receive = (event: MessageEvent) => {
    if (!event.data || event.data.type !== 'CASHINGULARITY_CONNECT' || event.data.version !== 1) return;
    const pair = this.pairs.get(event.data.requestId);
    if (!pair || pair.status !== 'WAITING' || pair.scope !== this.currentScope || event.origin !== pair.origin || event.source !== pair.source || event.data.challenge !== pair.challenge || !event.ports[0]) return;
    pair.port = event.ports[0]; pair.status = 'REQUESTED'; this.emit();
  };
  approve(id: string) {
    const pair = this.pairs.get(id);
    if (!pair || pair.status !== 'REQUESTED' || !pair.port || pair.scope !== this.currentScope) throw new Error('No verified dApp handshake is awaiting approval.');
    pair.status = 'ACTIVE'; this.started.set(id, Date.now());
    let lastSeen = Date.now();
    pair.port.onmessageerror = () => this.disconnect(id);
    pair.port.onmessage = event => {
      if (!this.pairs.has(id) || pair.status !== 'ACTIVE' || pair.scope !== this.currentScope) return;
      lastSeen = Date.now();
      const request = event.data;
      if (request?.type === 'CASHINGULARITY_PONG') return;
      if (request?.method === 'bch_getAddresses') pair.port!.postMessage({ id: request.id, result: [pair.address] });
      else if (request?.method === 'disconnect') this.disconnect(id);
      else pair.port!.postMessage({ id: request?.id, error: { code: 4200, message: 'Only approved address access is supported. Signing is not authorized.' } });
    };
    this.timers.set(id, this.host.setInterval(() => { if (Date.now() - lastSeen > 45000) this.disconnect(id); else pair.port?.postMessage({ type: 'CASHINGULARITY_PING' }); }, 15000));
    pair.port.start(); pair.port.postMessage({ type: 'CASHINGULARITY_CONNECTED', sessionId: id, accounts: [pair.address], permissions: ['bch_getAddresses'] }); this.emit();
  }
  disconnect(id: string) {
    const pair = this.pairs.get(id); if (!pair) return;
    try { pair.port?.postMessage({ type: 'CASHINGULARITY_DISCONNECTED' }); pair.port?.close(); } catch {}
    this.host.clearInterval(this.timers.get(id)); this.timers.delete(id);
    this.pairs.delete(id); this.started.delete(id); this.emit();
  }
  dispose() { for (const id of [...this.pairs.keys()]) this.disconnect(id); this.host.removeEventListener('message', this.receive); }
}
let singleton: BrowserAppSessions | null = null;
export function appSessions(): BrowserAppSessions { return singleton ??= new BrowserAppSessions(window); }
