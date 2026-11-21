import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  buildLeaderboard, COUNTDOWN_TICKS, isDifficulty, isGridSize, makeRaceEntry, normalizeNickname,
  RACE_ID_PATTERN, RACE_VERSION, RANK_SORTS, readRaceEntries, replayRace, SHARED_HISTORY_LIMIT,
  ticksToMs, validateReplay, type RaceConfig, type RaceEntry, type RaceFilters,
} from '@cashingularity/shared/rocket-race';

const PATH = '/api/arcade/rocket-race';
const CHALLENGE_TTL = 30 * 60_000;
const MAX_CHALLENGES = 256;
const MAX_CHALLENGES_PER_IP = 8;
const MUTATION_WINDOW = 60_000;
const MUTATIONS_PER_WINDOW = 24;
const MAX_RATE_BUCKETS = 2_048;

interface Challenge {
  config: RaceConfig;
  nickname: string;
  issuedAt: number;
  ip: string;
}

class SharedRaceBoard {
  private history: RaceEntry[];
  private readonly file: string;
  private readonly views = new Map<string, ReturnType<typeof buildLeaderboard>>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'rocket-race.json');
    this.history = [];
    if (existsSync(this.file)) {
      try {
        this.history = readRaceEntries(JSON.parse(readFileSync(this.file, 'utf8')), SHARED_HISTORY_LIMIT);
      } catch {
        // An unreadable scoreboard cannot affect the wallet or its service startup.
      }
    }
  }

  find(id: string) {
    return this.history.find(entry => entry.id === id);
  }

  save(entry: RaceEntry) {
    const history = [entry, ...this.history.slice(0, SHARED_HISTORY_LIMIT - 1)];
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(history), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.history = history;
    this.views.clear();
  }

  leaderboard(filters: RaceFilters) {
    const key = JSON.stringify(filters);
    let view = this.views.get(key);
    if (!view) {
      view = buildLeaderboard(this.history, filters);
      this.views.set(key, view);
    }
    return { ...view, capacity: SHARED_HISTORY_LIMIT };
  }
}

function allowedFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function registerRocketRace(app: FastifyInstance, dataDir: string, clock = Date.now) {
  const board = new SharedRaceBoard(dataDir);
  const challenges = new Map<string, Challenge>();
  const rateBuckets = new Map<string, { since: number; count: number }>();

  function canPost(ip: string, now: number) {
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.since >= MUTATION_WINDOW) {
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        for (const [key, current] of rateBuckets) {
          if (now - current.since >= MUTATION_WINDOW) rateBuckets.delete(key);
        }
        if (rateBuckets.size >= MAX_RATE_BUCKETS) return false;
      }
      bucket = { since: now, count: 0 };
      rateBuckets.set(ip, bucket);
    }
    return ++bucket.count <= MUTATIONS_PER_WINDOW;
  }

  app.post(`${PATH}/challenges`, { bodyLimit: 1_024 }, (request, reply) => {
    const now = clock();
    if (!canPost(request.ip, now)) return reply.code(429).send({ error: 'Too many ranked race requests. Try again shortly.' });
    const body = request.body;
    if (!allowedFields(body, ['nickname', 'difficulty', 'rockets']) || !isDifficulty(body.difficulty) || !isGridSize(body.rockets)) {
      return reply.code(400).send({ error: 'Choose a valid difficulty and grid size.' });
    }
    const nickname = normalizeNickname(body.nickname);
    if (!nickname) return reply.code(400).send({ error: 'Use a nickname with 2–20 letters, numbers, spaces, dashes, or underscores.' });

    const owned: string[] = [];
    for (const [id, challenge] of challenges) {
      if (now - challenge.issuedAt >= CHALLENGE_TTL) challenges.delete(id);
      else if (challenge.ip === request.ip) owned.push(id);
    }
    if (owned.length >= MAX_CHALLENGES_PER_IP) challenges.delete(owned[0]);
    if (challenges.size >= MAX_CHALLENGES) return reply.code(503).send({ error: 'Ranked racing is busy. Local racing is available.' });

    const id = randomUUID();
    const config: RaceConfig = { seed: randomInt(0x1_0000_0000), difficulty: body.difficulty, rockets: body.rockets };
    challenges.set(id, { config, nickname, issuedAt: now, ip: request.ip });
    return reply.code(201).send({ id, config, version: RACE_VERSION, expiresAt: now + CHALLENGE_TTL });
  });

  app.post(`${PATH}/results`, { bodyLimit: 160_000 }, (request, reply) => {
    const now = clock();
    if (!canPost(request.ip, now)) return reply.code(429).send({ error: 'Too many result requests. Try again shortly.' });
    const body = request.body;
    if (!allowedFields(body, ['challengeId', 'version', 'inputs']) || body.version !== RACE_VERSION ||
        typeof body.challengeId !== 'string' || !RACE_ID_PATTERN.test(body.challengeId)) {
      return reply.code(400).send({ error: 'Invalid race replay.' });
    }
    const saved = board.find(body.challengeId);
    if (saved) return { entry: saved }; // Retrying a lost acknowledgement earns no extra points.
    const challenge = challenges.get(body.challengeId);
    if (!challenge || now - challenge.issuedAt >= CHALLENGE_TTL) {
      challenges.delete(body.challengeId);
      return reply.code(410).send({ error: 'Ranked invitation expired. The local result is still available.' });
    }
    const replay = validateReplay(body.inputs);
    if (!replay) return reply.code(400).send({ error: 'Invalid race controls or duration.' });
    if (now - challenge.issuedAt + 300 < ticksToMs(COUNTDOWN_TICKS + replay.ticks)) {
      return reply.code(400).send({ error: 'The race ended too soon to verify.' });
    }

    challenges.delete(body.challengeId);
    const result = replayRace(challenge.config, replay.runs);
    if (!result || result.winnerId === null) {
      return reply.code(422).send({ error: 'The replay did not reach the race finish.' });
    }
    const entry = makeRaceEntry(body.challengeId, challenge.nickname, challenge.config, result, now);
    board.save(entry);
    return reply.code(201).send({ entry });
  });

  app.get(`${PATH}/leaderboard`, (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const { difficulty, rockets, sort = 'points' } = query;
    const grid = typeof rockets === 'string' && /^[234]$/.test(rockets) ? Number(rockets) : undefined;
    const order = RANK_SORTS.find(value => value === sort);
    if (!order || (difficulty !== undefined && !isDifficulty(difficulty)) || (rockets !== undefined && !isGridSize(grid))) {
      return reply.code(400).send({ error: 'Invalid leaderboard filters.' });
    }
    reply.header('Cache-Control', 'no-store');
    return board.leaderboard({ difficulty, rockets: isGridSize(grid) ? grid : undefined, sort: order });
  });
}
