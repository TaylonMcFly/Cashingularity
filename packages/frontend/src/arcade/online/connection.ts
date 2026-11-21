import {
  INPUT_INTERVAL_MS, MAX_RACE_TICKS, normalizeNickname, ONLINE_VERSION, ONLINE_WS_PATH, RECONNECT_MS,
  type ClientPacket, type LobbySummary, type OnlineSnapshot, type RoomView, type ServerPacket,
} from '@cashingularity/shared/rocket-race';

export const PILOT_KEY = 'cashingularity.arcade.onlinePilot.v1';
const ROOM_KEY = 'cashingularity.arcade.onlineRoom.v1';
const LEAVE_KEY = 'cashingularity.arcade.onlineLeave.v1';
type LobbyAction = Extract<ClientPacket, { t: 'quick' | 'join' | 'create' }> | { t: 'browse' };
export interface OnlineView {
  status: 'idle' | 'connecting' | 'online' | 'reconnecting';
  pilot?: { id: string; name: string };
  room: RoomView | null;
  rooms: LobbySummary[];
  error: string;
  rtt?: number;
  graceMs: number;
}
export const initialOnlineView: OnlineView = { status: 'idle', room: null, rooms: [], error: '', graceMs: RECONNECT_MS };

export function socketUrl(configured: string | undefined, location: Pick<Location, 'href' | 'protocol'>) {
  const endpoint = new URL(configured?.trim() || ONLINE_WS_PATH, location.href);
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if ((endpoint.protocol !== 'wss:' && endpoint.protocol !== 'ws:') ||
      (location.protocol === 'https:' && endpoint.protocol !== 'wss:') ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid online racing endpoint.');
  return endpoint.href;
}

function restore(key: string) {
  try { return sessionStorage.getItem(key) ?? undefined; } catch { return undefined; }
}
function remember(key: string, value?: string) {
  try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Session can stay in memory. */ }
}

function snapshotValid(message: OnlineSnapshot, room: RoomView) {
  return message.race === room.game?.id && Number.isInteger(message.tick) && message.tick >= 0 && message.tick <= MAX_RACE_TICKS &&
    Array.isArray(message.own) && message.own.length === 3 && message.own.every(n => Number.isSafeInteger(n) && n >= 0) &&
    Array.isArray(message.ships) && message.ships.length === room.size &&
    message.ships.every(ship => Array.isArray(ship) && ship.length === 14 && ship.every(Number.isSafeInteger)) &&
    Array.isArray(message.order) && message.order.length === room.size &&
    message.order.every((id, i) => Number.isInteger(id) && id >= 0 && id < room.size && message.order.indexOf(id) === i);
}

export class OnlineConnection {
  private view = initialOnlineView;
  private socket?: WebSocket;
  private active = false;
  private token = restore(PILOT_KEY);
  private roomCode = this.token && restore(ROOM_KEY);
  private name: string | undefined;
  private action?: LobbyAction;
  private leaving = !!this.roomCode && restore(LEAVE_KEY) === '1';
  private leaveSent?: WebSocket;
  private retryAt?: number;
  private handshake?: number;
  private heartbeat?: number;
  private tries = 0;
  private pingId = 0;
  private pingAt = 0;
  private pongAt = 0;
  private sequence = 0;
  private lastSentAt = -Infinity;
  private lastSteer = 0;
  private lastThrottle = 0;
  private serial?: string;
  private sample?: OnlineSnapshot;
  private listeners = new Set<(sample: OnlineSnapshot) => void>();

  constructor(private readonly changed: (view: OnlineView) => void) {}

  start() {
    this.active = true;
    window.addEventListener('online', this.wake);
    window.addEventListener('offline', this.offline);
    window.addEventListener('pagehide', this.suspendPage);
    window.addEventListener('pageshow', this.wake);
    document.addEventListener('visibilitychange', this.visibility);
    if (this.token) this.connect();
  }

  stop() {
    this.active = false;
    this.idle();
    this.disposeSocket();
    window.removeEventListener('online', this.wake);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('pagehide', this.suspendPage);
    window.removeEventListener('pageshow', this.wake);
    document.removeEventListener('visibilitychange', this.visibility);
    this.listeners.clear();
  }

  run(action: LobbyAction, nickname: string) {
    if (this.view.status === 'online') return this.send(action);
    const name = normalizeNickname(nickname);
    if (!name && !this.token) { this.update({ error: 'Use a nickname of 2–20 letters, numbers, spaces, dashes, or underscores.' }); return false; }
    this.name = name ?? undefined;
    this.action = action;
    if (navigator.onLine === false) {
      this.update({ status: 'reconnecting', error: 'Network unavailable. The room request will retry when you reconnect.' });
      return true;
    }
    this.update({ error: '' });
    this.wake();
    return true;
  }

  useNewPilot() {
    this.send({ t: 'leave' });
    this.disposeSocket();
    this.token = this.name = this.serial = this.roomCode = undefined;
    this.action = undefined;
    this.leaving = false;
    remember(PILOT_KEY);
    remember(ROOM_KEY);
    remember(LEAVE_KEY);
    this.sample = undefined;
    this.update(initialOnlineView);
  }

  act(packet: ClientPacket) {
    if (this.view.status !== 'online' || !this.send(packet)) return false;
    this.update({ error: '' });
    return true;
  }

  leave() {
    this.leaving = true;
    remember(LEAVE_KEY, '1');
    if (this.act({ t: 'leave' })) { this.leaveSent = this.socket; return; }
    this.update({ room: null, error: 'The server will receive your leave request after reconnecting.' });
  }

  watch(listener: (sample: OnlineSnapshot) => void) {
    this.listeners.add(listener);
    if (this.sample) listener(this.sample);
    return () => { this.listeners.delete(listener); };
  }

  sendControls(steer: number, throttle: number, boost: boolean, now: number): number | null {
    if (!this.sample || this.view.status !== 'online' || this.view.room?.phase !== 'racing' ||
        now - this.lastSentAt < INPUT_INTERVAL_MS - 0.2 || (this.socket?.bufferedAmount ?? Infinity) > 4_096 ||
        (!boost && this.lastSteer === steer && this.lastThrottle === throttle && now - this.lastSentAt < 180)) return null;
    const next = this.sequence + 1;
    if (!this.send({ t: 'i', race: this.sample.race, seq: next, keys: [steer, throttle, boost ? 1 : 0] })) return null;
    this.sequence = next;
    this.lastSteer = steer;
    this.lastThrottle = throttle;
    this.lastSentAt = now;
    return next;
  }

  idle() {
    if (this.view.room?.phase === 'racing') this.send({ t: 'idle' });
    this.lastSteer = this.lastThrottle = 0;
    this.lastSentAt = -Infinity;
  }

  private update(patch: Partial<OnlineView>) {
    this.view = { ...this.view, ...patch };
    if (this.active) this.changed(this.view);
  }

  private send(packet: ClientPacket) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(packet));
    return true;
  }

  private wake = () => {
    clearTimeout(this.retryAt);
    if (this.view.status === 'online') this.ping();
    else this.connect();
  };

  private offline = () => {
    if (!this.token && !this.name) return;
    this.disposeSocket();
    this.update({ status: 'reconnecting', rtt: undefined, error: 'Network unavailable. Waiting to reconnect.' });
  };

  private suspendPage = () => {
    this.idle();
    this.disposeSocket();
    if (this.token) this.update({ status: 'reconnecting', rtt: undefined });
  };

  private visibility = () => {
    if (document.hidden) this.idle();
    else {
      this.pongAt = performance.now();
      this.wake();
    }
  };

  private connect() {
    if (!this.active || this.socket || document.hidden || navigator.onLine === false || (!this.token && !this.name)) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(import.meta.env.VITE_ARCADE_WS_URL, window.location));
    } catch {
      this.update({ status: 'idle', error: 'The online racing endpoint is unavailable.' });
      return;
    }
    this.socket = socket;
    this.update({ status: this.tries || this.view.pilot ? 'reconnecting' : 'connecting', rtt: undefined });
    this.handshake = window.setTimeout(() => socket.close(4000, 'Handshake timed out'), 8_000);
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.send(this.token ? { t: 'hello', v: ONLINE_VERSION, token: this.token } : { t: 'hello', v: ONLINE_VERSION, name: this.name! });
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 24_000) return;
      let packet: ServerPacket;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet && typeof packet === 'object') this.receive(packet);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      const previous = this.view.error;
      this.disposeSocket();
      if (!this.token && !this.name) { this.update({ status: 'idle', rtt: undefined }); return; }
      this.update({ status: 'reconnecting', rtt: undefined, error: previous || 'Connection interrupted. Reconnecting…' });
      if (++this.tries >= 4 && !this.view.pilot) this.update({ error: previous || 'Online service is unreachable. Retrying…' });
      this.schedule();
    });
  }

  private schedule() {
    if (!this.active || document.hidden || navigator.onLine === false) return;
    const delay = Math.min(3_000, 350 * 1.6 ** Math.min(8, this.tries));
    this.retryAt = window.setTimeout(() => this.connect(), delay + Math.random() * 250);
  }

  private disposeSocket() {
    clearTimeout(this.retryAt);
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    this.leaveSent = undefined;
    this.sample = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  private ping() {
    this.pingAt = performance.now();
    this.send({ t: 'ping', id: ++this.pingId });
  }

  private receive(packet: ServerPacket) {
    switch (packet.t) {
      case 'welcome':
        clearTimeout(this.handshake);
        this.token = packet.token;
        remember(PILOT_KEY, packet.token);
        this.tries = 0;
        this.pongAt = performance.now();
        this.update({ status: 'online', pilot: { id: packet.id, name: packet.name }, graceMs: packet.graceMs, error: '' });
        clearInterval(this.heartbeat);
        this.heartbeat = window.setInterval(() => {
          if (document.hidden) return;
          if (performance.now() - this.pongAt > 13_000) this.socket?.close(4000, 'Heartbeat timed out');
          else this.ping();
        }, 2_500);
        this.ping();
        break;
      case 'room': {
        const next = packet.room;
        if (this.leaving && next) {
          if (this.leaveSent !== this.socket && this.send({ t: 'leave' })) this.leaveSent = this.socket;
          return;
        }
        const lostRoom = this.roomCode && !next && !this.leaving && !this.action;
        const left = this.leaving && !next;
        this.leaving = false;
        remember(LEAVE_KEY);
        this.roomCode = next?.code;
        remember(ROOM_KEY, this.roomCode);
        if (next?.game?.id !== this.serial) {
          this.serial = next?.game?.id;
          this.sequence = 0;
          this.sample = undefined;
          this.lastSentAt = -Infinity;
        }
        this.update({ room: next, ...(lostRoom && { error: 'Your previous room is no longer available. Join a new race to continue.' }),
          ...(left && { error: '' }) });
        if (this.action) {
          const action = this.action;
          this.action = undefined;
          if (!next || action.t === 'browse') this.send(action);
        }
        break;
      }
      case 'rooms': this.update({ rooms: packet.rooms }); break;
      case 'pong':
        if (packet.id !== this.pingId) return;
        this.pongAt = performance.now();
        this.update({ rtt: Math.round(this.pongAt - this.pingAt) });
        break;
      case 'error':
        if (packet.code === 'expired') {
          this.token = this.name = undefined;
          this.action = undefined;
          this.roomCode = undefined;
          remember(PILOT_KEY);
          remember(ROOM_KEY);
          remember(LEAVE_KEY);
          this.update({ ...initialOnlineView, error: packet.message });
        } else this.update({ error: packet.message });
        break;
      case 's':
        if (!this.view.room || !snapshotValid(packet, this.view.room) || (this.sample && packet.tick <= this.sample.tick)) return;
        this.sequence = this.sample ? Math.max(this.sequence, packet.own[0]) : packet.own[0];
        this.sample = packet;
        for (const listener of this.listeners) listener(packet);
    }
  }
}
