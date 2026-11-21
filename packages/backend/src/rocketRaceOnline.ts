import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isDifficulty, isGridSize, ONLINE_BOARD_PATH, ONLINE_WS_PATH, RECONNECT_MS } from '@cashingularity/shared/rocket-race';
import { OnlinePilotIdentity } from './onlinePilotIdentity.js';
import { OnlineRooms, type RoomOptions } from './onlineRooms.js';
import { OnlineScoreboard } from './onlineScoreboard.js';

function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function normalizedIp(address: string) {
  return address.replace(/^::ffff:/, '');
}

export function registerOnlineRacing(app: FastifyInstance, dataDir: string, options?: Partial<RoomOptions> & { manual?: boolean }) {
  const configured = process.env.ARCADE_WS_PATH;
  const path = configured && /^\/ws\/arcade\/[a-z0-9-]+$/.test(configured) ? configured : ONLINE_WS_PATH;
  const origins = (process.env.ARCADE_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  const proxies = new Set((process.env.ARCADE_TRUST_PROXY_IPS ?? '').split(',').map(value => normalizedIp(value.trim())).filter(value => isIP(value)));
  const allowed = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (!origin) return false;
    if (origins.length) return origins.includes(origin);
    return origin === `https://${request.headers.host}` || origin === `http://${request.headers.host}`;
  };
  const ip = (request: FastifyRequest) => {
    const peer = normalizedIp(request.raw.socket.remoteAddress ?? request.ip);
    const forwarded = request.headers['x-forwarded-for'];
    return proxies.has(peer) && typeof forwarded === 'string' && isIP(normalizedIp(forwarded.trim()))
      ? normalizedIp(forwarded.trim()) : peer;
  };

  let board: OnlineScoreboard;
  let rooms: OnlineRooms;
  try {
    const identity = new OnlinePilotIdentity(dataDir);
    board = new OnlineScoreboard(dataDir);
    rooms = new OnlineRooms(identity, board, {
      now: () => performance.now(), seed: () => randomInt(0x1_0000_0000),
      graceMs: bounded(process.env.ARCADE_RECONNECT_MS, RECONNECT_MS, 5_000, 120_000),
      maxPeers: bounded(process.env.ARCADE_MAX_CONNECTIONS, 256, 4, 2_048),
      maxPeersPerIp: bounded(process.env.ARCADE_MAX_PER_IP, 16, 2, 256),
      maxRooms: bounded(process.env.ARCADE_MAX_ROOMS, 64, 1, 256),
      ...options,
    });
  } catch {
    // A damaged optional Arcade store must never block the wallet's startup.
    app.log.warn('Arcade online storage could not be opened.');
    app.get(ONLINE_BOARD_PATH, (_request, reply) => reply.code(503).send({ error: 'Online racing is temporarily unavailable.' }));
    app.get(path, { websocket: true }, socket => socket.close(1013, 'Online racing is temporarily unavailable.'));
    return undefined;
  }

  app.get(path, { websocket: true, preValidation: (request, reply, done) => {
    if (!allowed(request)) void reply.code(403).send({ error: 'Online racing origin is not allowed.' });
    else done();
  } }, (socket, request) => rooms.accept(socket, ip(request)));

  app.get(ONLINE_BOARD_PATH, (request, reply) => {
    const { difficulty, size } = request.query as Record<string, unknown>;
    const count = typeof size === 'string' && /^[234]$/.test(size) ? Number(size) : undefined;
    if ((difficulty !== undefined && !isDifficulty(difficulty)) || (size !== undefined && !isGridSize(count))) {
      return reply.code(400).send({ error: 'Invalid multiplayer ranking filters.' });
    }
    return reply.header('Cache-Control', 'no-store').send(board.view(
      isDifficulty(difficulty) ? difficulty : undefined, isGridSize(count) ? count : undefined,
    ));
  });

  const timer = options?.manual ? undefined : setInterval(() => rooms.advance(), 8);
  timer?.unref();
  app.addHook('preClose', (_done) => {
    clearInterval(timer);
    rooms.close();
    _done();
  });
  return rooms;
}
