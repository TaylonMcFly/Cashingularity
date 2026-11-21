const assert = require('node:assert/strict');
const { mockWalletChain } = require('./wallet-chain-fixture.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');

const origin = 'http://localhost:3000';
const seriesPath = '/market/bchusd-5m-flash';
const epochMs = 300_000;

function fixtureRound(marketId, start, title) {
  const expiry = start + epochMs;
  return {
    marketId, title, description: 'Five-minute regression fixture',
    slug: `bchusd-5m-${expiry / 1000}`, epochSeriesId: 'bchusd-5m', epochKey: `5m:${expiry}`,
    assetPair: 'BCH/USD', timeframe: '5m', durationSeconds: 300, strikePriceCents: 20_000,
    createdAtMs: start, slotStartMs: start, expiryTimestampMs: expiry, status: 'OPEN',
    feeBps: '100', totalPoolSats: '1000000', categoryId: 'aa'.repeat(32),
    buckets: [
      { bucketId: 0, label: 'BELOW $200', poolSats: '450000', outcomeRule: 'BELOW', upperBoundCents: 20_000 },
      { bucketId: 1, label: 'ABOVE $200', poolSats: '550000', outcomeRule: 'ABOVE', lowerBoundCents: 20_000 },
    ],
  };
}

async function installMarketFixtures(page) {
  const start = Math.floor(Date.now() / epochMs) * epochMs;
  const expiry = start + epochMs;
  const first = fixtureRound(5731, start, 'First 5m round');
  const next = fixtureRound(5732, expiry, 'Next 5m round');
  const time = () => page.evaluate(() => Date.now());
  let spot = 200;
  let paperBuys = [];
  const published = [];
  await page.clock.install({ time: new Date(start + 35_000) });
  await page.route(/\/api\/markets(?:\?.*)?$/, async route => {
    const now = await time();
    const firstLive = now < expiry;
    await route.fulfill({ json: { markets: [
      firstLive ? { ...first, isCurrentSlot: true } : { ...first, status: 'RESOLVED', isHistoricalSlot: true, resolutionPriceCents: 20_100 },
      { ...next, isCurrentSlot: !firstLive, isFutureSlot: firstLive },
    ], paperBuys } });
  });
  await page.route(/\/api\/rates(?:\?.*)?$/, async route => {
    const now = await time();
    await route.fulfill({ json: { tick: { bchUsdPrice: spot, spotSource: 'binance', spotFetchedAtMs: now } } });
  });
  await page.route(/\/api\/markets\/\d+\/paper-flow$/, async route => {
    const buy = route.request().postDataJSON();
    published.push(buy);
    const marketId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    paperBuys.push({ id: buy.id, marketId, bucketId: buy.bucketId, sats: buy.sats, timestampMs: await time() });
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/markets/candles?**', async route => {
    const url = new URL(route.request().url());
    const interval = url.searchParams.get('interval');
    const step = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 }[interval] ?? 60;
    const end = Number(url.searchParams.get('endTimeMs') || await time());
    const last = Math.floor(end / 1000 / step) * step;
    const candles = Array.from({ length: 52 }, (_, i) => {
      const close = 200 + Math.sin(i / 3) * 0.16;
      return { time: last - (51 - i) * step, open: close, high: close + 0.03, low: close - 0.04, close, volume: 3 };
    });
    await route.fulfill({ json: { source: 'binance', candles, fetchedAtMs: await time() } });
  });
  return {
    expiry, time, published,
    setSpot: price => { spot = price; },
    setFlow: async (bucketId, sats) => {
      paperBuys = [{ id: `order-${bucketId}`, marketId: first.marketId, bucketId, sats, timestampMs: await time() }];
    },
    tick: () => page.clock.fastForward(5050),
  };
}

async function checkTrading(browser, width, theme, addresses) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  try {
    await context.addInitScript(value => localStorage.setItem('cashingularity.theme.v1', value), theme);
    await mockWalletChain(context);
    const page = await context.newPage();
    const errors = [];
    const externalScripts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on('request', request => {
      if (request.resourceType() === 'script' && new URL(request.url()).origin !== origin) externalScripts.push(request.url());
      if (request.method() === 'POST' && new URL(request.url()).pathname.includes('/broadcast')) errors.push('Unexpected broadcast request');
    });
    const fixture = await installMarketFixtures(page);
    const checkLayout = async () => {
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    };
    await page.goto(`${origin}${seriesPath}`);
    const ticket = page.getByRole('complementary', { name: 'Select Outcome Position' });
    const active = page.getByRole('region', { name: 'Active Positions', exact: true });
    const positions = active.locator('.active-position');
    const history = page.locator('details[aria-label="Paper position history"]');
    const tab = name => ticket.getByRole('button', { name, exact: true });
    const enterPaper = () => page.getByRole('button', { name: 'Enter Paper Trading', exact: true }).click();
    const exitPaper = () => page.getByRole('button', { name: 'Exit Paper Trading', exact: true }).click();
    const above = ticket.locator('[data-outcome="above"].outcome-card');
    const below = ticket.locator('[data-outcome="below"].outcome-card');
    const aboveOdds = async () => parseFloat(await above.locator('.outcome-card-odds strong').innerText());
    const awaitOdds = (min, max) => page.waitForFunction(([low, high]) => {
      const odds = parseFloat(document.querySelector('.outcome-card[data-outcome="above"] .outcome-card-odds strong')?.textContent);
      return odds >= low && odds <= high;
    }, [min, max]);
    const preset = ticket.getByRole('button', { name: '0.001 BCH', exact: true });
    const win = () => preset.locator('span').innerText();
    await awaitOdds(49, 51);
    const openingOdds = await aboveOdds();
    const initialWin = await win();
    assert.match(initialWin, /^Win [\d.]+ BCH$/);
    fixture.setSpot(197);
    await fixture.tick();
    await awaitOdds(4, 15);
    assert.notEqual(await win(), initialWin);
    const weakWin = await win();
    await below.click();
    assert.notEqual(await win(), weakWin);
    await above.click();
    fixture.setSpot(200);
    await fixture.setFlow(1, '300000');
    await fixture.tick();
    await page.getByText('+0.003 BCH · ABOVE', { exact: true }).waitFor();
    assert.ok(await aboveOdds() > openingOdds + 5);
    await checkLayout();

    await enterPaper();
    const buy = async (side, stake) => {
      await tab('Buy').click();
      await (side === 'above' ? above : below).click();
      await ticket.getByLabel('Stake amount in BCH').fill(stake);
      await ticket.getByRole('button', { name: /Review & Place Stake/ }).click();
      const drawer = page.getByRole('dialog', { name: 'Transaction confirmation' });
      await drawer.getByText('Win payout', { exact: true }).waitFor();
      const reported = page.waitForResponse(response => response.url().endsWith('/paper-flow'));
      await drawer.getByRole('button', { name: 'Confirm Paper Preview' }).click();
      assert.equal((await reported).status(), 204);
      await drawer.waitFor({ state: 'hidden' });
    };
    await buy('above', '0.001');
    fixture.setSpot(200.45);
    await fixture.tick();
    await awaitOdds(75, 96);
    await buy('above', '0.005');
    await buy('below', '0.004');
    assert.equal(await positions.count(), 3);
    const walletNav = width > 768
      ? page.locator('.primary-navigation').getByRole('link', { name: 'Wallet', exact: true })
      : page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Wallet', exact: true });
    await walletNav.click();
    const walletPositions = page.getByRole('region', { name: 'Market positions', exact: true });
    assert.equal(await walletPositions.locator('li').count(), 3);
    await checkLayout();
    await page.goBack();
    await positions.first().waitFor();
    assert.equal(fixture.published.length, 3);
    assert.deepEqual(Object.keys(fixture.published[0]).sort(), ['bucketId', 'expiryMs', 'id', 'sats']);
    const aboveRows = positions.filter({ hasText: 'ABOVE $200' });
    assert.equal(await aboveRows.count(), 2);
    const entries = await aboveRows.locator('dd').filter({ hasText: /×/ }).allTextContents();
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0], entries[1]);
    assert.equal(await history.count(), 0);
    const sellFirst = aboveRows.filter({ hasText: '0.005 BCH' });
    await sellFirst.getByRole('button', { name: 'Sell / Cash Out' }).click();
    assert.equal(await tab('Sell').getAttribute('aria-pressed'), 'true');
    await tab('25%').click();
    assert.equal(await ticket.getByLabel('Stake to cash out (BCH)', { exact: true }).inputValue(), '0.00125');
    await tab('50%').click();
    assert.equal(await ticket.getByLabel('Stake to cash out (BCH)', { exact: true }).inputValue(), '0.0025');
    const review = page.getByRole('dialog', { name: 'Confirm Paper Cash Out' });
    await tab('Review Cash Out').click();
    const credit = review.locator('dd').nth(3);
    const held = await credit.innerText();
    fixture.setSpot(199.7);
    await fixture.tick();
    assert.equal(await credit.innerText(), held);
    await review.getByRole('button', { name: 'Confirm Cash Out' }).click();
    assert.equal(await positions.count(), 3);
    assert.match(await active.innerText(), /0\.0025 BCH/);
    assert.equal(await active.getByText('Cashed out', { exact: true }).count(), 0);
    assert.equal(await history.getAttribute('open'), null);
    await tab('Max (100%)').click();
    assert.equal(await ticket.getByLabel('Stake to cash out (BCH)', { exact: true }).inputValue(), '0.0025');
    await tab('Sell all positions').click();
    assert.match(await review.innerText(), /Positions\s+3/);
    await review.getByRole('button', { name: 'Confirm Cash Out' }).click();
    await ticket.getByText('No open positions in this round.').waitFor();
    assert.equal(await positions.count(), 0);
    assert.equal(await ticket.getByLabel('Stake to cash out (BCH)').count(), 0);
    await history.locator('summary').click();
    assert.equal(await history.getByText('Cashed out', { exact: true }).count(), 4);
    await checkLayout();

    const selector = page.getByRole('button', { name: 'Switch wallet profile' });
    const profileSummary = page.getByRole('dialog', { name: 'Profile menu' }).locator('.header-profile-summary');
    const walletDialog = page.getByRole('dialog', { name: 'Wallet connection' });
    const addWallet = async (name, address) => {
      await selector.click();
      await profileSummary.click();
      await page.getByRole('button', { name: 'Connected wallets', exact: true }).click();
      await walletDialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await walletDialog.getByLabel('Watch-only address', { exact: true }).fill(address);
      await walletDialog.getByLabel('Profile name', { exact: true }).fill(name);
      await walletDialog.getByRole('button', { name: 'Add watch-only profile' }).click();
      await walletDialog.waitFor({ state: 'hidden' });
    };
    await exitPaper();
    await addWallet('Profile A', addresses[0]);
    await enterPaper();
    await buy('above', '0.003');
    assert.equal(await positions.count(), 1);
    assert.equal(await history.count(), 0);
    await exitPaper();
    assert.equal(await positions.count(), 0);
    await addWallet('Profile B', addresses[1]);
    await enterPaper();
    await tab('Sell').click();
    await ticket.getByText('No open positions in this round.').waitFor();
    assert.equal(await positions.count(), 0);
    await selector.click();
    await profileSummary.click();
    await page.locator('.profile-option').filter({ hasText: 'Profile A' }).click();
    await enterPaper();
    await positions.first().waitFor();
    assert.equal(await positions.count(), 1);
    await positions.first().getByRole('button', { name: 'Sell / Cash Out' }).click();
    await tab('Review Cash Out').click();
    await review.waitFor();
    await page.clock.fastForward(fixture.expiry - await fixture.time() + 6200);
    await page.getByRole('heading', { name: 'Next 5m round', exact: true }).waitFor();
    await review.waitFor({ state: 'hidden' });
    assert.equal(await positions.count(), 0);
    await tab('Sell').click();
    await ticket.getByText('No open positions in this round.').waitFor();
    assert.equal(await ticket.getByLabel('Stake to cash out (BCH)').count(), 0);
    await checkLayout();
    assert.deepEqual(errors, []);
    assert.deepEqual(externalScripts, []);
    console.log(`${width}px ${theme}: odds, Win cards, multi-entry, partial/full sales, wallet isolation, rollover; no page, console, HTTP, or overflow errors`);
  } finally {
    await context.close();
  }
}

(async () => {
  const { CashAddressType, encodeCashAddress } = await import('@bitauth/libauth');
  const addresses = [1, 2].map(value => encodeCashAddress({
    prefix: 'bitcoincash', type: CashAddressType.p2pkh, payload: Uint8Array.from({ length: 20 }, () => value),
  }).address);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) await checkTrading(browser, width, theme, addresses);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
