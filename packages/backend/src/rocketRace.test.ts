import Fastify from 'fastify';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COUNTDOWN_TICKS, createRace, makeRaceEntry, RACE_VERSION, recordInput, stepRace, ticksToMs,
  type InputRun, type RaceConfig,
} from '@cashingularity/shared/rocket-race';
import { registerRocketRace } from './rocketRace.js';

const endpoint = '/api/arcade/rocket-race';

describe('authoritative Rocket Race leaderboard', () => {
  let app: ReturnType<typeof Fastify>;
  let directory: string;
  let now: number;
  const body = { nickname: 'Nova Pilot', difficulty: 'normal', rockets: 3 };
  const start = async () => {
    const reply = await app.inject({ method: 'POST', url: `${endpoint}/challenges`, payload: body });
    expect(reply.statusCode).toBe(201);
    return reply.json() as { id: string; config: RaceConfig; version: number; expiresAt: number };
  };
  const submit = (payload: object) => app.inject({ method: 'POST', url: `${endpoint}/results`, payload });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rocket-race-test-'));
    now = 100_000;
    app = Fastify();
    registerRocketRace(app, directory, () => now);
  });

  afterEach(async () => {
    await app.close();
    rmSync(join(directory, 'rocket-race.json'), { force: true });
    rmdirSync(directory);
  });

  it('replays inputs, computes its own metrics, deduplicates retries and persists across startup', async () => {
    const challenge = await start();
    const race = createRace(challenge.config);
    const inputs: InputRun[] = [];
    while (!race.result) {
      const input = { steer: 0, throttle: 91, boost: race.tick % 30 === 0 };
      recordInput(inputs, input);
      stepRace(race, input);
    }
    const proof = { challengeId: challenge.id, version: challenge.version, inputs };
    expect((await submit(proof)).statusCode).toBe(400);
    now += ticksToMs(race.tick + COUNTDOWN_TICKS) + 3;
    expect((await submit({ ...proof, points: 999_999 })).statusCode).toBe(400);
    const first = await submit(proof);
    expect(first.statusCode).toBe(201);
    const entry = makeRaceEntry(challenge.id, body.nickname, challenge.config, race.result, now);
    expect(first.json()).toEqual({ entry });
    expect((await submit(proof)).json()).toEqual({ entry });

    await app.close();
    app = Fastify();
    registerRocketRace(app, directory, () => now);
    const board = await app.inject(`${endpoint}/leaderboard?difficulty=normal&rockets=3&sort=dodges`);
    expect(board.json()).toMatchObject({
      count: 1, rankings: [{ nickname: body.nickname, races: 1, points: entry.points }], recent: [entry],
    });
    expect((await app.inject(`${endpoint}/leaderboard?difficulty=easy`)).json().count).toBe(0);
    expect((await app.inject(`${endpoint}/leaderboard?rockets=5`)).statusCode).toBe(400);
  });

  it('rejects malformed names, versions, controls, oversized logs, expired challenges and incomplete finishes', async () => {
    for (const nickname of ['<b>evil</b>', 'aa\u200bbb', 'A', 'A'.repeat(40)]) {
      expect((await app.inject({ method: 'POST', url: `${endpoint}/challenges`, payload: { ...body, nickname } })).statusCode).toBe(400);
    }
    const challenge = await start();
    now += 60_000;
    const proof = { challengeId: challenge.id, version: RACE_VERSION, inputs: [[1, 0, 0, 0]] };
    expect((await submit({ ...proof, version: 999 })).statusCode).toBe(400);
    expect((await submit({ ...proof, inputs: [[-1, 0, 0, 0]] })).statusCode).toBe(400);
    expect((await submit({ ...proof, inputs: [[90, 0, 0, 1]] })).statusCode).toBe(400);
    expect((await submit({ ...proof, inputs: 'x'.repeat(160_001) })).statusCode).toBe(413);
    expect((await submit(proof)).statusCode).toBe(422);
    expect((await submit(proof)).statusCode).toBe(410);
    const expired = await start();
    now = expired.expiresAt;
    expect((await submit({ ...proof, challengeId: expired.id })).statusCode).toBe(410);
    expect((await app.inject(`${endpoint}/leaderboard`)).json().rankings).toEqual([]);
  });

  it('bounds write requests and old invitations for one client', async () => {
    const original = await start();
    for (let index = 0; index < 8; index++) await start();
    expect((await submit({ challengeId: original.id, version: RACE_VERSION, inputs: [[1, 0, 0, 0]] })).statusCode).toBe(410);
    for (let index = 0; index < 14; index++) await start();
    expect((await app.inject({ method: 'POST', url: `${endpoint}/challenges`, payload: body })).statusCode).toBe(429);
    now += 60_001;
    await start();
  });
});
