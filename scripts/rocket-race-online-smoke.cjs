const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const workspace = resolve(__dirname, '..');
const evidence = join(workspace, 'docs', 'rocket-race-online');
const arcadeUrl = '/arcade/rocket-race/online';
const boardPath = '/api/arcade/rocket-race/online/leaderboard';
const portableChrome = process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let origin;

function frameProbe() {
  const original = requestAnimationFrame.bind(window);
  window.onlineFrames = { rows: [], enabled: false };
  window.requestAnimationFrame = callback => original(timestamp => {
    const recording = window.onlineFrames.enabled && document.querySelector('.online-race[data-phase="racing"] canvas');
    const start = performance.now();
    callback(timestamp);
    if (recording && window.onlineFrames.rows.length < 4_000) window.onlineFrames.rows.push([timestamp, performance.now() - start]);
  });
}

async function participant(browser, name, width, theme, touch = width < 769, impairment = false) {
  const height = width === 375 ? 667 : width === 390 ? 812 : width === 768 ? 1_024 : 950;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch,
    deviceScaleFactor: touch ? 2 : 1, colorScheme: theme });
  await context.addInitScript(frameProbe);
  const info = { context, name, problems: [], wire: { inputs: 0, propelled: 0, snapshots: 0, lost: 0, transports: 0, last: null } };
  await context.routeWebSocket('**/ws/arcade/rocket-race', route => {
    info.wire.transports++;
    const backend = route.connectToServer();
    info.dropConnection = async () => {
      const close = { code: 4002, reason: 'Temporary transport loss' };
      await backend.close(close);
      await route.close(close);
    };
    route.onMessage(bytes => {
      const packet = JSON.parse(bytes);
      if (packet.t === 'i') {
        info.wire.inputs++;
        if (packet.keys[1] > 50) info.wire.propelled++;
      }
      if (impairment) setTimeout(() => backend.send(bytes), 35 + (info.wire.inputs % 3) * 6);
      else backend.send(bytes);
    });
    backend.onMessage(bytes => {
      const packet = JSON.parse(bytes);
      if (packet.t === 's') {
        info.wire.snapshots++;
        if (!info.wire.last || packet.race !== info.wire.last.race || packet.tick > info.wire.last.tick) info.wire.last = packet;
        if (impairment) {
          if (info.wire.snapshots % 7 === 0) { info.wire.lost++; return; }
          setTimeout(() => route.send(bytes), 40 + (info.wire.snapshots % 7) * 12);
          return;
        }
      }
      route.send(bytes);
    });
  });
  const page = info.page = await context.newPage();
  page.on('pageerror', error => info.problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') info.problems.push(message.text()); });
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) info.problems.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.setDefaultTimeout(12_000);
  await page.goto(origin + arcadeUrl);
  await page.getByLabel('Pilot nickname').fill(name);
  return info;
}

const lobby = player => player.page.getByRole('region', { name: 'Race lobby' });
const track = player => player.page.getByRole('img', { name: 'Scrolling space race with rockets and asteroids' });
const results = player => player.page.getByRole('region', { name: 'Online race results' });
const green = player => player.page.locator('.online-link-status[data-status="online"]');
const button = (player, name) => player.page.getByRole('button', { name, exact: true });
const codeFor = player => lobby(player).locator('[data-room-code]').innerText();
const raceId = player => player.page.locator('.online-race').getAttribute('data-race-id');
const waitTick = (player, after) => player.page.waitForFunction(tick => Number(document.querySelector('[data-race-tick]')?.dataset.raceTick) > tick, after);

async function bounds(page, selectors) {
  const sizes = await page.evaluate(selectors => ({
    viewport: innerWidth, page: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll(selectors)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(node => String(node.className)),
  }), selectors);
  assert.equal(sizes.page, sizes.viewport, 'Horizontal document overflow');
  assert.deepEqual(sizes.clipped, [], 'Control clipping');
}

async function match(players) {
  for (const player of players) {
    await player.page.getByLabel('Grid size').selectOption(String(players.length));
    await button(player, 'Quick Match').click();
    await lobby(player).waitFor();
  }
  const code = await codeFor(players[0]);
  for (const player of players) {
    await player.page.getByRole('list', { name: 'Room participants' }).getByText(players.at(-1).name, { exact: true }).waitFor();
    assert.equal(await codeFor(player), code);
  }
  return code;
}

async function start(players) {
  await Promise.all(players.map(player => button(player, 'Ready').click()));
  await Promise.all(players.map(player => player.page.getByText('Launch in', { exact: true }).waitFor()));
  const ids = await Promise.all(players.map(raceId));
  assert.equal(new Set(ids).size, 1);
  const seeds = await Promise.all(players.map(player => player.page.locator('[data-course-seed]').innerText()));
  assert.deepEqual(seeds, Array(players.length).fill('157'));
  await Promise.all(players.map(player => waitTick(player, 0)));
  return ids[0];
}

async function timing(player) {
  return player.page.evaluate(() => {
    const rows = window.onlineFrames.rows;
    window.onlineFrames.enabled = false;
    const quantile = (values, q) => +values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)].toFixed(2);
    const deltas = rows.slice(1).map((row, i) => row[0] - rows[i][0]);
    return {
      frames: rows.length, fps: +(deltas.length * 1_000 / (rows.at(-1)[0] - rows[0][0])).toFixed(1),
      p95FrameIntervalMs: quantile(deltas, .95), p95FrameCallbackMs: quantile(rows.map(row => row[1]), .95),
    };
  });
}

async function readResults(player) {
  await results(player).waitFor({ timeout: 72_000 });
  return results(player).locator('tbody tr').evaluateAll(rows => rows.map(row => ({
    place: Number(row.dataset.place), seat: Number(row.dataset.seat),
    name: row.querySelector('th').textContent.replace(/^\d+/, ''), finishMs: Number(row.dataset.finish) || null,
    dodges: Number(row.querySelector('[data-label="Dodges"]').textContent),
    hits: Number(row.querySelector('[data-label="Hits"]').textContent),
    boosts: Number(row.querySelector('[data-label="Boosts"]').textContent),
  })));
}

async function useJoystick(player, cdp, withBoost = false) {
  const joystick = await player.page.getByRole('group', { name: 'Touch joystick' }).boundingBox();
  const boost = await player.page.getByRole('button', { name: /^Boost ·/ }).boundingBox();
  assert.ok(joystick && boost);
  const steering = { id: 1, x: joystick.x + joystick.width / 2, y: joystick.y + joystick.height * .16 };
  const ignition = { id: 2, x: boost.x + boost.width / 2, y: boost.y + boost.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: withBoost ? [steering, ignition] : [steering] });
}

async function fullGrid(browser, size) {
  const names = size === 2 ? ['Rook Desktop', 'Nova Touch'] : ['Atlas One', 'Lyra Two', 'Vega Three', 'Orion Four'];
  const players = [];
  let extra;
  try {
    for (const [i, name] of names.entries()) {
      players.push(await participant(browser, name, size === 2 ? i ? 390 : 1440 : [1280, 1920, 1280, 1440][i],
        i % 2 ? 'dark' : 'light', size === 2 && i === 1, size === 2 && i === 1));
    }
    const code = await match(players);
    const id = await start(players);
    console.log(`${size} simultaneous browser clients racing, room ${code}, round ${id}`);
    const mobile = size === 2 ? players[1] : undefined;
    const desktops = size === 2 ? players.slice(0, 1) : players;
    for (const player of desktops) {
      await player.page.locator('.race-field').focus();
      await player.page.keyboard.down('w');
    }
    if (size === 4) {
      await players[0].page.keyboard.down('a');
      await players[3].page.keyboard.down('d');
      await delay(275);
      await players[0].page.keyboard.up('a');
      await players[3].page.keyboard.up('d');
    }
    if (mobile) {
      let mobileCdp = await mobile.context.newCDPSession(mobile.page);
      await useJoystick(mobile, mobileCdp);
      await delay(625);
      assert.ok(mobile.wire.propelled > 0);
      const before = mobile.wire.last.tick;
      await mobileCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await mobile.page.setViewportSize({ width: 812, height: 390 });
      await bounds(mobile.page, '.online-header-actions, .race-board, .race-joystick, .race-boost-button');
      await mobile.page.waitForFunction(() => matchMedia('(orientation: landscape)').matches);
      await waitTick(mobile, before);
      await mobile.page.screenshot({ path: join(evidence, 'mobile-race.png') });
      await mobile.page.setViewportSize({ width: 390, height: 812 });

      await mobile.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const hidden = await mobile.page.locator('[data-race-tick]').getAttribute('data-race-tick');
      await waitTick(players[0], Number(hidden) + 35);
      assert.equal(await mobile.page.locator('[data-race-tick]').getAttribute('data-race-tick'), hidden);
      await mobile.page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitTick(mobile, Number(hidden) + 35);
      // Reload the actual browser tab with its saved session and transport closed.
      const tickAtReload = mobile.wire.last.tick;
      await mobile.page.reload({ waitUntil: 'domcontentloaded' });
      await green(mobile).waitFor();
      await track(mobile).waitFor();
      assert.equal(await raceId(mobile), id);
      await waitTick(mobile, tickAtReload);
      assert.equal(mobile.wire.transports, 2);
      const beforeDrop = mobile.wire.last.tick;
      await mobile.dropConnection();
      await mobile.page.getByRole('heading', { name: 'Reconnecting', exact: true }).waitFor();
      await green(mobile).waitFor();
      assert.equal(await raceId(mobile), id);
      await waitTick(mobile, beforeDrop);
      assert.equal(mobile.wire.transports, 3);
      mobileCdp = await mobile.context.newCDPSession(mobile.page);
      await mobileCdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await useJoystick(mobile, mobileCdp);
      // Wait for an earned charge, then start a second simultaneous touch on Boost.
      extra = (async () => {
        await mobile.page.locator('.race-boost-button[data-ready="true"]').waitFor({ timeout: 33_000 });
        await mobileCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await useJoystick(mobile, mobileCdp, true);
        await mobile.page.locator('.race-boost-button[data-boosting="true"]').waitFor({ timeout: 6_000 });
        assert.ok(mobile.wire.last.ships[1][10] > 0, 'The server must confirm the simultaneous touch boost');
        await track(players[0]).waitFor();
        return true;
      })();
      extra.catch(() => {});
    }

    await Promise.all(players.map(p => p.page.evaluate(() => { window.onlineFrames.enabled = true; })));
    await delay(4_100);
    const frames = await Promise.all(players.map(timing));
    assert.ok(frames.every(row => row.frames > 100 && row.fps > 25), 'Playable render cadence during concurrent live racing');
    await bounds(players[0].page, '.online-page, .race-board, .race-live-order');
    if (size === 4) await players[0].page.screenshot({ path: join(evidence, 'four-player-race.png') });
    const scorecards = await Promise.all(players.map(readResults));
    if (extra) assert.equal(await extra, true);
    const rows = scorecards[0];
    assert.equal(rows.length, size);
    for (const other of scorecards) assert.deepEqual(other, rows);
    assert.deepEqual(rows.map(row => row.place), names.map((_, i) => i + 1));
    assert.equal(new Set(rows.map(row => row.name)).size, size);
    assert.ok(rows[0].finishMs > 25_000 && rows[0].finishMs < 60_000);
    assert.ok(rows.filter(row => row.finishMs !== null).every((row, i, finished) => !i || row.finishMs >= finished[i - 1].finishMs));
    assert.ok(players.every(p => p.wire.propelled > 5), 'All human clients must contribute driving inputs');
    const board = await (await fetch(`${origin}${boardPath}?size=${size}`)).json();
    assert.equal(board.count, 1);
    assert.equal(board.recent[0].id, id);
    assert.equal(board.recent[0].pilots[board.recent[0].result.winnerId].name, rows[0].name);
    assert.deepEqual(board.recent[0].result.standings.map(row => row.finishMs), rows.map(row => row.finishMs));
    if (size === 4) await players[0].page.screenshot({ path: join(evidence, 'four-player-results.png') });
    if (size === 2) {
      await Promise.all(players.map(player => button(player, 'Vote for rematch').click()));
      await Promise.all(players.map(player => player.page.getByText('Launch in', { exact: true }).waitFor()));
      const next = await Promise.all(players.map(raceId));
      assert.notEqual(next[0], id);
      assert.equal(next[1], next[0]);
      // Leaving the rematch resets each session without an extra stream.
      await Promise.all(players.map(player => button(player, 'Leave Room').click()));
      await Promise.all(players.map(player => button(player, 'Quick Match').waitFor()));
    }
    for (const player of players) assert.deepEqual(player.problems, []);
    return { id, room: code, seed: 157, ranking: rows, frames, rematch: size === 2, suspendedAndReconnected: size === 2,
      simultaneousTouchBoost: size === 2, ...(size === 2 && { mobileCpuThrottle: 4, reconnectedAfterTransportLoss: true }),
      wire: players.map(({ name, wire }) => ({
        name, sentInputs: wire.inputs, thrustInputs: wire.propelled, receivedSnapshots: wire.snapshots,
        droppedSnapshots: wire.lost, transports: wire.transports,
      })) };
  } finally {
    await Promise.all(players.map(player => player.context.close()));
  }
}

async function layout(browser) {
  const widths = [375, 390, 768, 1280, 1920];
  const checks = [];
  for (const width of widths) {
    for (const theme of ['light', 'dark']) {
      const pilot = await participant(browser, 'Layout Pilot', width, theme);
      try {
        await bounds(pilot.page, '.race-titlebar, .online-home, .online-setup, .online-browser, .online-identity input, .online-home .btn');
        if (width === 1280 && theme === 'dark') await pilot.page.screenshot({ path: join(evidence, 'online-lobbies.png') });
        assert.deepEqual(pilot.problems, []);
        checks.push({ width, theme });
      } finally { await pilot.context.close(); }
    }
  }
  return checks;
}

async function browseAndJoin(browser) {
  const pilots = await Promise.all([
    participant(browser, 'Invite Host', 1280, 'dark'), participant(browser, 'Invite Guest', 390, 'light'),
  ]);
  const [host, guest] = pilots;
  try {
    await button(guest, 'Browse Rooms').click();
    await green(guest).waitFor();
    await host.page.getByLabel('Grid size').selectOption('3');
    await button(host, 'Quick Match').click();
    const code = await codeFor(host);
    await button(guest, `Join ${code}`).click();
    assert.equal(await codeFor(guest), code);
    await Promise.all(pilots.map(p => button(p, 'Leave Room').click()));
    await Promise.all(pilots.map(p => button(p, 'Create Room').waitFor()));
    await host.page.getByLabel('Fill spare private seats with AI').check();
    await button(host, 'Create Room').click();
    const invite = await codeFor(host);
    await guest.page.getByLabel('Invite code').fill(invite.toLowerCase());
    await button(guest, 'Join Room').click();
    assert.equal(await codeFor(guest), invite);
    await button(host, 'Ready').click();
    await button(host, 'Unready').click();
    await button(host, 'Ready').waitFor();
    await host.page.getByText('Open seat · AI if empty', { exact: true }).waitFor();
    await host.page.screenshot({ path: join(evidence, 'private-lobby.png') });
    for (const player of pilots) assert.deepEqual(player.problems, []);
  } finally { await Promise.all(pilots.map(pilot => pilot.context.close())); }
}

async function main() {
  mkdirSync(evidence, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'cashingularity-rocket-online-smoke-'));
  const { buildBackendServer } = await import(pathToFileURL(join(workspace, 'packages/backend/dist/index.js')).href);
  const { app } = await buildBackendServer({ dataDir, onlineRacing: { seed: () => 157 } });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method !== 'GET') void reply.code(403).send({ error: 'Only Arcade WebSocket session writes are allowed.' });
    else done();
  });
  let browser;
  try {
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.CHROME_PATH || (portableChrome && existsSync(portableChrome) ? portableChrome : undefined) });
    const report = { browser: browser.version(), testedAt: new Date().toISOString() };
    if (!process.argv.includes('--races')) {
      report.viewportChecks = await layout(browser);
      await browseAndJoin(browser);
      report.publicBrowserAndPrivateInvite = true;
      console.log('Ten light/dark browser layouts, public room browser and private invite lobby passed');
    }
    if (!process.argv.includes('--layout')) {
      report.twoPlayer = await fullGrid(browser, 2);
      console.log('Two-player race finished, both clients agreed, rematch started');
      report.fourPlayer = await fullGrid(browser, 4);
      console.log('Four-player race finished and all clients matched the persisted official ranking');
      const rankings = await participant(browser, 'Ranking Check', 390, 'dark');
      try {
        await rankings.page.getByRole('link', { name: 'Back to Arcade' }).click();
        await rankings.page.getByRole('navigation', { name: 'Arcade navigation' }).getByRole('link', { name: 'Leaderboard' }).click();
        await button(rankings, 'Online Multiplayer').click();
        await rankings.page.locator('.online-board').getByRole('table').waitFor();
        await rankings.page.getByLabel('Grid size').selectOption('4');
        await rankings.page.waitForFunction(() => document.querySelectorAll('.online-board tbody tr').length === 4);
        await bounds(rankings.page, '.online-board, .race-results-table');
        assert.deepEqual(rankings.problems, []);
      } finally { await rankings.context.close(); }
    }
    writeFileSync(join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await app.close();
    for (const name of readdirSync(dataDir)) rmSync(join(dataDir, name), { force: true });
    rmdirSync(dataDir);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
