const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const workspace = resolve(__dirname, '..');
const evidence = join(workspace, 'docs', 'rocket-race');
const apiPath = '/api/arcade/rocket-race';
const scoreKey = 'cashingularity.rocketRace.scores.v1';
const portableChrome = process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let origin;

// Count real frames that drew the running track. The probe lives only in the test browser.
function installProbe() {
  const schedule = window.requestAnimationFrame.bind(window);
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  const text = CanvasRenderingContext2D.prototype.fillText;
  const listeners = new Map();
  for (const [target, names] of [[window, ['keyup', 'blur']], [document, ['visibilitychange']]]) {
    const register = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    names.forEach(name => listeners.set(name, new Set()));
    target.addEventListener = (name, fn, options) => {
      if (names.includes(name)) listeners.get(name).add(fn);
      register(name, fn, options);
    };
    target.removeEventListener = (name, fn, options) => {
      if (names.includes(name)) listeners.get(name).delete(fn);
      remove(name, fn, options);
    };
  }
  const canvasKinds = new WeakMap();
  const isGame = canvas => {
    if (!canvasKinds.has(canvas)) canvasKinds.set(canvas, canvas.parentElement?.classList.contains('race-field'));
    return canvasKinds.get(canvas);
  };
  const probe = window.__rocketProbe = {
    count: 0, playerX: null, capture: false, frames: [],
    listeners: () => Object.fromEntries([...listeners].map(([type, callbacks]) => [type, callbacks.size])),
  };
  let drawingFrame = false;
  let drewGame = false;
  window.requestAnimationFrame = callback => schedule(timestamp => {
    drawingFrame = true;
    drewGame = false;
    const start = performance.now();
    try { callback(timestamp); } finally {
      if (drewGame) {
        probe.count++;
        if (probe.capture && probe.frames.length < 4_096) probe.frames.push([timestamp, performance.now() - start]);
      }
      drawingFrame = false;
    }
  });
  CanvasRenderingContext2D.prototype.fillRect = function (...args) {
    if (drawingFrame && !drewGame && isGame(this.canvas)) drewGame = true;
    return fill.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.fillText = function (message, ...args) {
    if (message === 'YOU' && isGame(this.canvas)) probe.playerX = args[0];
    return text.call(this, message, ...args);
  };
}

async function open(browser, width, theme, touch = width <= 768, low = false) {
  const context = await browser.newContext({
    viewport: { width, height: width === 375 ? 667 : width === 390 ? 812 : width === 768 ? 1_024 : 940 },
    deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch, colorScheme: theme,
  });
  await context.addInitScript(installProbe);
  if (low) await context.addInitScript(() => localStorage.setItem('cashingularity.rocketRace.preferences.v1', JSON.stringify({ lowQuality: true })));
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) problems.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return { context, page, problems };
}

async function bounds(page, selectors) {
  const layout = await page.evaluate(selectors => ({
    view: innerWidth, width: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll(selectors)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(node => String(node.className)),
  }), selectors);
  assert.equal(layout.width, layout.view, 'horizontal document overflow');
  assert.deepEqual(layout.clipped, [], 'out-of-bounds Arcade controls');
}

const game = page => page.locator('.race-game');
const tick = page => page.locator('[data-race-tick]').getAttribute('data-race-tick').then(Number);
const untilRacing = page => page.locator('.race-game[data-phase="racing"]').waitFor({ timeout: 12_000 });
const order = page => page.getByRole('list', { name: 'Live race order' });
const back = page => page.getByRole('link', { name: 'Back to Arcade', exact: true }).click();
const waiting = page => page.waitForFunction(() => Number(document.querySelector('[data-race-tick]')?.dataset.raceTick) > 10);

async function startRace(page, { nickname, difficulty, rockets, seed, ranked } = {}) {
  if (nickname) await page.getByLabel('Pilot nickname').fill(nickname);
  if (difficulty) await page.getByRole('button', { name: new RegExp(`^${difficulty}`) }).click();
  if (rockets) await page.getByRole('button', { name: String(rockets), exact: true }).click();
  if (seed !== undefined) await page.getByLabel(/Course seed/).fill(String(seed));
  if (ranked) await page.getByRole('button', { name: 'Ranked', exact: true }).click();
  await page.getByRole('button', { name: 'Start race', exact: true }).click();
  await game(page).waitFor();
}

async function checkLayout(browser, width, theme) {
  const { page, context, problems } = await open(browser, width, theme);
  try {
    await page.goto(origin + '/');
    const tab = width <= 768
      ? page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Arcade', exact: true })
      : page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Arcade', exact: true });
    await tab.click();
    await page.getByRole('heading', { name: 'Rocket Race', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await bounds(page, '.arcade-hero, .arcade-header nav a, .arcade-home-links a');
    if (width === 1280 && theme === 'dark') await page.screenshot({ path: join(evidence, 'arcade-dark.png'), animations: 'disabled' });
    const nav = page.getByRole('navigation', { name: 'Arcade navigation' });
    await nav.getByRole('link', { name: 'Settings', exact: true }).click();
    const nick = page.getByLabel('Pilot nickname');
    await nick.fill('Pilot Cycle');
    await nick.press('ArrowLeft');
    assert.equal(await nick.inputValue(), 'Pilot Cycle');
    await page.getByRole('button', { name: 'Save nickname' }).click();
    await page.getByLabel('Movement keys').selectOption('arrows');
    if (width <= 768) await page.getByLabel('Boost hand').selectOption('left');
    if (width === 768 && theme === 'light') await page.getByLabel('Steering method').selectOption('drag');
    if (theme === 'light') await page.getByLabel('Show the BCH market widget on desktop').uncheck();
    await bounds(page, '.arcade-settings section, .arcade-settings input, .arcade-settings select');
    await nav.getByRole('link', { name: 'How to Play', exact: true }).click();
    await page.getByRole('heading', { name: 'How to play', exact: true }).waitFor();
    await nav.getByRole('link', { name: 'Single Player', exact: true }).click();
    await page.getByRole('heading', { name: 'Starting grid' }).waitFor();
    assert.equal(await page.getByLabel('Pilot nickname').inputValue(), 'Pilot Cycle');
    const widget = page.locator('.race-market-widget');
    if (theme === 'light') assert.equal(await widget.count(), 0);
    else if (width > 768) {
      await page.getByLabel('BCH market information').click();
      assert.equal(await widget.getAttribute('open'), '');
      await page.getByLabel('BCH market information').click();
      assert.equal(await widget.getAttribute('open'), null);
    } else assert.equal(await widget.isVisible(), false);
    await bounds(page, '.race-setup, .race-setup button, .race-setup input, .race-title');
    const idleListeners = await page.evaluate(() => window.__rocketProbe.listeners());
    await startRace(page, { seed: 157, rockets: 3 });
    await untilRacing(page);
    assert.equal(await order(page).getByRole('listitem').count(), 3);
    if (width <= 768) {
      assert.equal(await game(page).getAttribute('data-touch'), 'true');
      assert.equal(await game(page).getAttribute('data-handed'), 'left');
      const deck = page.locator('.race-steering-deck');
      const boost = await page.locator('.race-boost-deck').boundingBox();
      assert.ok(boost.x < (await deck.boundingBox()).x);
      const height = await page.evaluate(() => innerHeight);
      assert.ok(boost.y + boost.height <= height, 'mobile controls fit above the fold');
      if (width === 768 && theme === 'light') {
        assert.equal(await page.getByText('Drag on the track', { exact: true }).isVisible(), true);
        const cdp = await context.newCDPSession(page);
        const field = await page.locator('.race-field').boundingBox();
        const base = { x: field.x + field.width / 2, y: field.y + field.height / 2, id: 1 };
        const initial = await page.evaluate(() => window.__rocketProbe.playerX);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [base] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...base, x: base.x + 50 }] });
        await page.waitForTimeout(170);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.ok(await page.evaluate(() => window.__rocketProbe.playerX) > initial);
      } else await page.getByRole('group', { name: 'Touch joystick' }).waitFor();
    } else {
      assert.equal(await page.getByRole('group', { name: 'Touch joystick' }).count(), 0);
      const positions = await order(page).boundingBox();
      assert.ok(positions.y + positions.height <= await page.evaluate(() => innerHeight), 'desktop standings fit above the fold');
      // Scope hotkeys to the game. A steer and throttle key can be held together.
      const initial = await page.evaluate(() => window.__rocketProbe.playerX);
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(210);
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('ArrowUp');
      assert.ok(await page.evaluate(() => window.__rocketProbe.playerX) > initial);
    }
    await page.locator('.race-field').focus();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Race paused' }).waitFor();
    const pausedTick = await tick(page);
    const oldFrames = await page.evaluate(() => window.__rocketProbe.count);
    await page.waitForTimeout(180);
    assert.equal(await tick(page), pausedTick);
    assert.equal(await page.evaluate(() => window.__rocketProbe.count), oldFrames);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    if (width === 390) {
      const previousWidth = await page.locator('.race-field canvas').evaluate(canvas => canvas.width);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(width => document.querySelector('.race-field canvas')?.width !== width, previousWidth);
      assert.ok(await tick(page) >= pausedTick);
      const canvas = await page.locator('.race-field').boundingBox();
      assert.ok(canvas.y + canvas.height <= 390);
    }
    await bounds(page, '.race-board,.race-hud,.race-toolbar button,.race-joystick,.race-boost-button,.race-live-order li');
    await back(page);
    await page.getByRole('heading', { name: 'Arcade', exact: true }).waitFor();
    const framesAfter = await page.evaluate(() => window.__rocketProbe.count);
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => window.__rocketProbe.count), framesAfter);
    assert.deepEqual(await page.evaluate(() => window.__rocketProbe.listeners()), idleListeners);
    await page.goBack();
    await page.getByRole('heading', { name: 'Starting grid' }).waitFor();
    assert.equal(await game(page).count(), 0);
    assert.deepEqual(problems, []);
    console.log(`${width}px ${theme} · navigation, settings, ${width <= 768 ? 'touch' : 'keyboard'}, pause, bounds and cleanup passed`);
  } finally {
    await context.close();
  }
}

function percent(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)];
}

async function beginMeasuring(page) {
  await page.evaluate(() => { window.__rocketProbe.frames = []; window.__rocketProbe.capture = true; });
}

async function frameReport(page) {
  const samples = await page.evaluate(() => {
    window.__rocketProbe.capture = false;
    return window.__rocketProbe.frames.splice(0);
  });
  assert.ok(samples.length > 45, 'a live renderer produced frames');
  const intervals = samples.slice(1).map((frame, index) => frame[0] - samples[index][0]);
  assert.ok(intervals.every(ms => ms > 0), 'exactly one game loop per animation frame');
  const rounded = value => Number(value.toFixed(2));
  return {
    samples: samples.length,
    fps: rounded(1_000 * intervals.length / (samples.at(-1)[0] - samples[0][0])),
    medianFrameMs: rounded(percent(intervals, 0.50)), p95FrameMs: rounded(percent(intervals, 0.95)),
    worstFrameMs: rounded(Math.max(...intervals)), p95WorkMs: rounded(percent(samples.map(sample => sample[1]), 0.95)),
  };
}

async function mobileFinish(browser) {
  const { context, page, problems } = await open(browser, 390, 'dark');
  try {
    const arcadeCalls = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith(apiPath)) arcadeCalls.push(request.method()); });
    await page.goto(origin + '/arcade/rocket-race');
    await startRace(page, { nickname: 'Comet QA', difficulty: 'Easy', rockets: 2, seed: 157 });
    await untilRacing(page);
    const cdp = await context.newCDPSession(page);
    const pad = page.getByRole('group', { name: 'Touch joystick' });
    const box = await pad.boundingBox();
    const thrust = { x: box.x + box.width / 2, y: box.y + box.height * 0.08, id: 1 };
    const scroll = await page.evaluate(() => window.scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [thrust] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...thrust, x: thrust.x + 7 }] });
    await page.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [thrust] });
    assert.equal(await page.evaluate(() => window.scrollY), scroll, 'touch steering cannot scroll the page');
    await beginMeasuring(page);
    const boost = page.locator('.race-boost-button');
    await page.waitForFunction(() => document.querySelector('.race-boost-button')?.dataset.ready === 'true', null, { timeout: 20_000 });
    const metrics = await frameReport(page);
    const charge = await boost.boundingBox();
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [thrust, { x: charge.x + charge.width / 2, y: charge.y + charge.height / 2, id: 2 }],
    });
    await page.waitForFunction(() => document.querySelector('.race-boost-button')?.dataset.boosting === 'true');
    await page.screenshot({ path: join(evidence, 'rocket-race-mobile.png'), animations: 'disabled' });
    // Keep both physical contacts held until finish. Only the joystick controls thrust.
    await page.getByRole('region', { name: 'Race results' }).waitFor({ timeout: 65_000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByRole('heading', { name: 'You win!', exact: true }).waitFor();
    await page.getByText('Personal best', { exact: true }).waitFor();
    const scores = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), scoreKey);
    assert.equal(scores.length, 1);
    assert.ok(scores[0].finishMs > 0 && scores[0].boostsEarned > 0 && scores[0].dodges >= 5);
    assert.deepEqual(arcadeCalls, [], 'a local race makes no Arcade API requests');
    await page.getByRole('link', { name: 'Leaderboard', exact: true }).click();
    await page.reload();
    await page.getByRole('rowheader', { name: /Comet QA/ }).waitFor();
    await page.getByLabel('Difficulty').selectOption('hard');
    await page.getByText('No results for these filters yet.').waitFor();
    assert.deepEqual(problems, []);
    console.log('Mobile full race · real touch boost during thrust, finish, personal best and reload passed');
    return { ...metrics, finishMs: scores[0].finishMs, dodges: scores[0].dodges, points: scores[0].points };
  } finally {
    await context.close();
  }
}

async function rankedFinish(browser) {
  const { context, page, problems } = await open(browser, 1280, 'light');
  try {
    await page.goto(origin + '/arcade/rocket-race');
    await startRace(page, { nickname: 'Venture QA', difficulty: 'Easy', rockets: 4, ranked: true });
    await untilRacing(page);
    await page.keyboard.down('KeyW');
    await waiting(page);
    await beginMeasuring(page);
    await page.waitForTimeout(5_100);
    const metrics = await frameReport(page);
    await page.screenshot({ path: join(evidence, 'rocket-race-desktop.png'), animations: 'disabled' });
    await page.getByText('Server-verified shared score', { exact: true }).waitFor({ timeout: 65_000 });
    await page.keyboard.up('KeyW');
    await bounds(page, '.race-results, .race-results-table, .race-setup-actions');
    await page.screenshot({ path: join(evidence, 'rocket-race-results.png'), animations: 'disabled' });
    const records = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), scoreKey);
    const server = await page.request.get(origin + apiPath + '/leaderboard?difficulty=easy&rockets=4');
    assert.ok(server.ok());
    const board = await server.json();
    const result = board.recent.find(row => row.id === records[0].id);
    assert.equal(result.points, records[0].points);
    assert.equal(result.elapsedMs, records[0].elapsedMs);
    await page.getByRole('link', { name: 'Leaderboard', exact: true }).click();
    await page.getByRole('button', { name: 'Shared', exact: true }).click();
    await page.getByRole('rowheader', { name: /Venture QA/ }).waitFor();
    assert.deepEqual(problems, []);
    console.log('Desktop ranked finish · server replay accepted and appeared in shared history');
    return { ...metrics, verifiedElapsedMs: result.elapsedMs, place: result.place, points: result.points };
  } finally {
    await context.close();
  }
}

async function lifecycle(browser) {
  const { context, page, problems } = await open(browser, 390, 'light', true, true);
  try {
    await page.goto(origin + '/arcade/rocket-race');
    await startRace(page, { seed: 157 });
    await untilRacing(page);
    assert.equal(await page.locator('.race-field canvas').evaluate(canvas => canvas.width), await page.locator('.race-field canvas').evaluate(canvas => canvas.clientWidth));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await beginMeasuring(page);
    await page.waitForTimeout(5_000);
    const metrics = await frameReport(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('heading', { name: 'Race paused' }).waitFor();
    const hiddenTick = await tick(page);
    const hiddenFrames = await page.evaluate(() => window.__rocketProbe.count);
    await page.waitForTimeout(550);
    assert.equal(await tick(page), hiddenTick);
    assert.equal(await page.evaluate(() => window.__rocketProbe.count), hiddenFrames);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(tick => Number(document.querySelector('[data-race-tick]')?.dataset.raceTick) > tick, hiddenTick);
    await page.getByRole('button', { name: /^Restart/ }).click();
    await page.locator('.race-game[data-phase="countdown"]').waitFor();
    assert.equal(await tick(page), 0);
    await back(page);
    await page.getByRole('heading', { name: 'Arcade', exact: true }).waitFor();
    await cdp.send('Performance.enable');
    async function snapshot() {
      await cdp.send('HeapProfiler.collectGarbage');
      const values = await cdp.send('Performance.getMetrics');
      const dom = await cdp.send('Memory.getDOMCounters');
      return {
        heapKiB: Math.round(values.metrics.find(metric => metric.name === 'JSHeapUsedSize').value / 1024),
        nodes: dom.nodes, jsListeners: dom.jsEventListeners,
        listenerCounts: await page.evaluate(() => window.__rocketProbe.listeners()),
      };
    }

    async function cycle() {
      for (let iteration = 0; iteration < 8; iteration++) {
        await page.getByRole('link', { name: 'Play Rocket Race', exact: true }).click();
        await startRace(page, { seed: 157 });
        await page.waitForTimeout(60);
        await back(page);
        await page.getByRole('heading', { name: 'Arcade', exact: true }).waitFor();
      }
    }
    const before = await snapshot();
    await cycle();
    const afterEight = await snapshot();
    await cycle();
    const after = await snapshot();
    assert.deepEqual(after.listenerCounts, before.listenerCounts);
    assert.ok(after.heapKiB - before.heapKiB < 2_048, 'short repeated use must not grow the live heap by 2 MiB');
    assert.deepEqual(problems, []);
    console.log('Visibility pause, canvas downscaling, same-seed restart and sixteen cleanup cycles passed');
    return { ...metrics, cpuThrottle: 4, before, afterEight, after };
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(evidence, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), 'cashingularity-rocket-smoke-'));
  const { buildBackendServer } = await import(pathToFileURL(join(workspace, 'packages/backend/dist/index.js')).href);
  const { app } = await buildBackendServer({ dataDir: temp });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.method !== 'GET' && !request.url.startsWith(apiPath + '/')) {
      void reply.code(403).send({ error: 'Only Arcade writes are allowed by this smoke server.' });
    } else done();
  });
  let browser;
  try {
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({
      headless: true, executablePath: process.env.CHROME_PATH || (portableChrome && existsSync(portableChrome) ? portableChrome : undefined),
    });
    const report = { browser: browser.version(), viewportChecks: [] };
    if (!process.argv.includes('--races')) {
      for (const width of [375, 390, 768, 1280, 1920]) {
        for (const theme of ['light', 'dark']) {
          await checkLayout(browser, width, theme);
          report.viewportChecks.push({ width, theme });
        }
      }
    }
    if (!process.argv.includes('--layout')) {
      report.mobileStandard = await mobileFinish(browser);
      report.desktopStandard = await rankedFinish(browser);
      report.mobileLow = await lifecycle(browser);
    }
    writeFileSync(join(evidence, 'browser-metrics.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await app.close();
    for (const name of readdirSync(temp)) rmSync(join(temp, name), { force: true });
    rmdirSync(temp);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
