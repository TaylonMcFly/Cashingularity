const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const Fastify = require('fastify');
const websocket = require('@fastify/websocket');
const WebSocket = require('ws');

const workspace = join(__dirname, '..');
const measurements = join(workspace, 'docs', 'rocket-race-online');
const path = '/ws/arcade/rocket-race';
const phaseMs = 12_000;
const kb = bytes => +(bytes / 1024).toFixed(2);
const mib = bytes => +(bytes / 1024 ** 2).toFixed(2);

async function player(origin, name) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { origin, perMessageDeflate: false });
  const counts = { up: 0, down: 0, snapshots: 0, firstTick: undefined, tick: 0 };
  const latest = {};
  socket.on('message', raw => {
    counts.down += raw.length;
    const packet = JSON.parse(raw.toString());
    latest[packet.t] = packet;
    if (packet.t === 's') {
      counts.snapshots++;
      counts.firstTick ??= packet.tick;
      counts.tick = packet.tick;
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  function send(packet) {
    const data = JSON.stringify(packet);
    counts.up += Buffer.byteLength(data);
    socket.send(data);
  }
  send({ t: 'hello', v: 1, name });
  await wait(() => latest.welcome);
  return { socket, counts, latest, send };
}

async function wait(condition, ms = 7_000) {
  const start = performance.now();
  while (!await condition()) {
    assert.ok(performance.now() - start < ms, 'Timed out during online load test');
    await delay(14);
  }
}

async function measure(origin, server, grids) {
  const before = await server('memory');
  const lobbyCount = 4 * grids;
  const racers = await Promise.all(Array.from({ length: lobbyCount }, (_, seat) => player(origin, `Load ${seat + 1}`)));
  for (let first = 0; first < racers.length; first += 4) {
    const group = racers.slice(first, first + 4);
    group[0].send({ t: 'create', size: 4, difficulty: 'hard', bots: false });
    await wait(() => group[0].latest.room?.room);
    const code = group[0].latest.room.room.code;
    for (const rider of group.slice(1)) rider.send({ t: 'join', code });
    await wait(() => group.every(rider => rider.latest.room?.room?.members.length === 4));
    for (const rider of group) rider.send({ t: 'ready', code, value: true });
  }
  await wait(() => racers.every(rider => rider.latest.room?.room?.phase === 'racing'));
  const inbound = racers.reduce((n, rider) => n + rider.counts.up, 0);
  const outbound = racers.reduce((n, rider) => n + rider.counts.down, 0);
  await server('begin');
  const begin = performance.now();
  let seq = 0;
  let next = begin;
  const interval = setInterval(() => {
    const now = performance.now();
    if (now < next) return;
    next = Math.max(next + 1_000 / 30, now);
    seq++;
    for (const [i, rider] of racers.entries()) {
      rider.send({ t: 'i', race: rider.latest.room.room.game.id, seq, keys: [((i * 7 + seq) % 40) - 20, 75 + i % 26, seq % 15 === 0 ? 1 : 0] });
    }
  }, 7);
  try { await delay(phaseMs); } finally { clearInterval(interval); }
  const elapsed = performance.now() - begin;
  const live = await server('sample');
  assert.equal(live.rooms, grids);
  const slices = racers.map(rider => rider.counts);
  assert.ok(slices.every(count => count.snapshots > 200 && count.tick > 680), 'Every real client must receive authoritative race updates');
  const bytesDown = slices.reduce((n, count) => n + count.down, 0) - outbound;
  const bytesUp = slices.reduce((n, count) => n + count.up, 0) - inbound;
  const rate = (bytes) => +(kb(bytes) * 1000 / elapsed).toFixed(2);
  for (const rider of racers) rider.send({ t: 'leave' });
  await wait(async () => (await server('count')).rooms === 0);
  for (const rider of racers) rider.socket.close();
  await wait(async () => {
    const remaining = await server('count');
    return remaining.connections === 0 && remaining.pilots === 0;
  });
  const after = await server('memory');
  return {
    rooms: grids, clients: lobbyCount, durationSeconds: +(elapsed / 1000).toFixed(2), controlHz: +(seq * 1000 / elapsed).toFixed(2),
    serverCpuPctOneCore: live.cpu, eventLoopP95Ms: live.p95, eventLoopMaxMs: live.max,
    downKiBpsPerClient: rate(bytesDown / lobbyCount), upKiBpsPerClient: rate(bytesUp / lobbyCount),
    snapshotsPerClient: [Math.min(...slices.map(count => count.snapshots)), Math.max(...slices.map(count => count.snapshots))],
    heapMiBBefore: mib(before.heapUsed), heapMiBLive: mib(live.memory.heapUsed),
    heapMiBAfterGc: mib(after.heapUsed), rssMiBLive: mib(live.memory.rss),
    remaining: await server('count'),
  };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cashingularity-online-load-'));
  const app = Fastify();
  try {
    await app.register(websocket, { options: { maxPayload: 32_768 } });
    const { registerOnlineRacing } = await import(pathToFileURL(join(workspace, 'packages/backend/dist/rocketRaceOnline.js')).href);
    const rooms = registerOnlineRacing(app, dataDir, { seed: () => 157, maxPeersPerIp: 64 });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const loop = monitorEventLoopDelay({ resolution: 5 });
    let baseline;
    let began;
    process.send({ origin, gcForced: !!global.gc });
    await new Promise(resolve => {
      process.once('disconnect', resolve);
      process.on('message', request => {
        let result;
        if (request === 'stop') { resolve(); return; }
        if (request === 'count') result = rooms.metrics();
        if (request === 'memory') { global.gc?.(); result = process.memoryUsage(); }
        if (request === 'begin') {
          loop.reset();
          loop.enable();
          baseline = process.cpuUsage();
          began = performance.now();
          result = true;
        }
        if (request === 'sample') {
          loop.disable();
          const cpu = process.cpuUsage(baseline);
          result = { memory: process.memoryUsage(), cpu: +((cpu.user + cpu.system) / 10 / (performance.now() - began)).toFixed(2),
            p95: +(loop.percentile(95) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2), rooms: rooms.metrics().rooms };
        }
        process.send({ result });
      });
    });
  } finally {
    await app.close();
    for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { force: true });
    rmdirSync(dataDir);
    process.disconnect();
  }
}

async function main() {
  const child = fork(__filename, ['--serve'], { windowsHide: true });
  const exited = once(child, 'exit');
  const reply = () => Promise.race([once(child, 'message').then(([message]) => message),
    exited.then(([code]) => { throw new Error(`Load server exited with status ${code}.`); })]);
  const { origin, gcForced } = await reply();
  function server(request) {
    const response = reply();
    child.send(request);
    return response.then(message => message.result);
  }
  try {
    const runs = [];
    for (const grids of [1, 8]) runs.push(await measure(origin, server, grids));
    const result = { node: process.version, gcForced, notes: 'Real loopback sockets. CPU and memory measured in the separate Arcade Fastify server process. Traffic is WebSocket JSON payload only.', runs };
    mkdirSync(measurements, { recursive: true });
    writeFileSync(join(measurements, 'load-metrics.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (child.connected) child.send('stop');
    await exited;
  }
}
(process.argv.includes('--serve') ? serve() : main()).catch(error => { console.error(error); process.exitCode = 1; });
