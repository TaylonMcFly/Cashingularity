const assert = require('node:assert/strict');
const { mockWalletChain } = require('./wallet-chain-fixture.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');

const origin = 'http://localhost:3000';
const phrase = `${'abandon '.repeat(11)}about`; // Public BIP39 vector. This browser never broadcasts to a network.
const recipient = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const outpoint = 'ab'.repeat(32);
const dapp = 'https://wallet-activity.qa.invalid';
const dappHtml = `<!doctype html><title>QA address access</title><script>
addEventListener('message', event => {
  if (event.data?.type !== 'CASHINGULARITY_WALLET_HELLO') return;
  const channel = new MessageChannel();
  window.testPort = channel.port1;
  channel.port1.onmessage = message => {
    if (message.data?.type === 'CASHINGULARITY_PING') channel.port1.postMessage({ type: 'CASHINGULARITY_PONG' });
  };
  parent.postMessage({ ...event.data, type: 'CASHINGULARITY_CONNECT' }, event.origin, [channel.port2]);
});
</script>`;

async function verifySendGates(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  try {
    await context.addInitScript(() => localStorage.setItem('cashingularity.theme.v1', 'dark'));
    await context.routeWebSocket('wss://**', socket => {
      socket.onMessage(raw => {
        const [action, id] = JSON.parse(raw.toString());
        if (action === 'REQ') socket.send(JSON.stringify(['EOSE', id]));
      });
    });
    await mockWalletChain(context, watched => watched === recipient ? {
      history: [{ txid: outpoint, height: 80 }],
      utxos: [{ txid: outpoint, vout: 0, satoshis: '200000', height: 80 }],
    } : { history: [], utxos: [] });
    let broadcasts = 0;
    await context.route(/\/api\/(?:chain\/|wallet\/)?broadcast$/, route => { broadcasts++; return route.abort(); });
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Send/ }).click();
    const send = page.getByRole('dialog', { name: 'Send BCH', exact: true });
    const review = send.getByRole('button', { name: 'Review & Send' });
    const confirmation = page.getByRole('dialog', { name: 'Transaction confirmation' });
    await send.getByLabel('Recipient address').fill(recipient);
    await send.getByLabel('Send amount').fill('0.0001');
    await send.getByText('Connect or unlock a signing wallet before sending BCH.', { exact: true }).waitFor();
    assert.ok(await review.isDisabled());
    assert.equal(await review.evaluate(button => getComputedStyle(button).cursor), 'not-allowed');
    await send.getByLabel('Send amount').press('Enter');
    assert.equal(await confirmation.count(), 0);

    await send.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    const wallet = page.getByRole('dialog', { name: 'Wallet connection', exact: true });
    await wallet.getByLabel('Watch-only address', { exact: true }).fill(recipient);
    await wallet.getByLabel('Profile name', { exact: true }).fill('QA funded watch-only wallet');
    await wallet.getByRole('button', { name: 'Add watch-only profile', exact: true }).click();
    await wallet.waitFor({ state: 'hidden' });
    await send.getByText('Available: 0.002 BCH', { exact: true }).waitFor();
    await send.getByText('This profile is watch-only. Enable signing or select a signing wallet.', { exact: true }).waitFor();
    assert.ok(await review.isDisabled());
    await send.getByLabel('Send amount').press('Enter');
    assert.equal(await confirmation.count(), 0);
    await send.getByRole('button', { name: 'Enable signing', exact: true }).click();
    await wallet.getByLabel('Recovery phrase', { exact: true }).waitFor();
    assert.equal(broadcasts, 0);
    console.log('Send at 390px in dark mode: disconnected and funded watch-only profiles show a reason and cannot open a signing review.');
  } finally {
    await context.close();
  }
}

async function verifyActivity(browser) {
  const { CashAddressType, deriveHdPath, deriveHdPrivateNodeFromBip39Mnemonic, encodeCashAddress, hash160, secp256k1, hashTransaction, hexToBin, decodeTransaction } = await import('@bitauth/libauth');
  const root = deriveHdPrivateNodeFromBip39Mnemonic(phrase);
  const derived = deriveHdPath(root, "m/44'/145'/0'/0/0");
  const address = encodeCashAddress({
    prefix: 'bitcoincash', type: CashAddressType.p2pkh, payload: hash160(secp256k1.derivePublicKeyCompressed(derived.privateKey)),
  }).address;
  derived.privateKey.fill(0);
  root.privateKey.fill(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const errors = [];
    const postBodiesWithSeed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on('request', request => { if (request.postData()?.includes(phrase)) postBodiesWithSeed.push(request.url()); });
    let sentTxid;
    let confirmed = false;
    let broadcastCount = 0;
    const changed = await mockWalletChain(context, watched => {
      if (watched !== address) return { history: [], utxos: [] };
      return {
        history: [{ txid: outpoint, height: 80 }, ...(sentTxid ? [{ txid: sentTxid, height: confirmed ? 100 : 0, ...(confirmed ? { timestampMs: Date.now() } : {}) }] : [])],
        utxos: sentTxid ? [] : [{ txid: outpoint, vout: 0, satoshis: '200000', height: 80 }],
      };
    });
    await context.route(/\/api\/(?:chain\/|wallet\/)?broadcast$/, async route => {
      broadcastCount++;
      const { rawTxHex, network } = route.request().postDataJSON();
      assert.equal(network, 'mainnet');
      const bytes = hexToBin(rawTxHex);
      const transaction = decodeTransaction(bytes);
      assert.equal(typeof transaction, 'object');
      assert.equal(transaction.inputs.length, 1);
      assert.ok(transaction.inputs[0].unlockingBytecode.length > 0);
      assert.equal(transaction.outputs[0].valueSatoshis, 10_000n);
      sentTxid = hashTransaction(bytes);
      await route.fulfill({ json: { txid: sentTxid } });
    });
    await context.route(`${dapp}/**`, route => route.fulfill({ contentType: 'text/html', body: dappHtml }));
    const now = Date.now();
    const expiry = now + 120_000;
    let resolved = false;
    const round = {
      marketId: 3510, title: 'Notification test BCH/USD round', description: 'Disposable test fixture',
      slug: 'notification-test-market', assetPair: 'BCH/USD', timeframe: '5m',
      strikePriceCents: 20_000, feeBps: '100', totalPoolSats: '1000000', durationSeconds: 300, expiryTimestampMs: expiry,
      createdAtMs: expiry - 300_000, status: 'OPEN', categoryId: 'ee'.repeat(32),
      buckets: [
        { bucketId: 0, label: 'BELOW', outcomeRule: 'BELOW', upperBoundCents: 20_000, poolSats: '450000' },
        { bucketId: 1, label: 'ABOVE', outcomeRule: 'ABOVE', lowerBoundCents: 20_000, poolSats: '550000' },
      ],
    };
    const unrelated = { ...round, marketId: 3511, slug: 'unrelated-notification-test', title: 'Unrelated BCH/USD round' };
    await page.clock.install({ time: new Date(now) });
    await page.route('**/api/markets', route => route.fulfill({ json: {
      markets: [round, unrelated].map(market => resolved ? { ...market, status: 'RESOLVED', resolvedOutcome: 1, resolutionPriceCents: 20_010 } : market),
    } }));
    await page.route(/\/api\/rates(?:\?.*)?$/, async route => route.fulfill({ json: {
      tick: { bchUsdPrice: 200.1, spotSource: 'binance', spotFetchedAtMs: await page.evaluate(() => Date.now()) },
    } }));
    // Candle requests use the simulated clock, so keep them inside the market fixture as well.
    await page.route('**/api/markets/candles?**', route => route.fulfill({ json: { source: 'binance', candles: [] } }));
    await page.route(`**/api/markets/${round.marketId}/paper-flow`, route => route.fulfill({ status: 204 }));
    const popup = name => page.getByRole('dialog', { name, exact: true });
    const bell = () => page.getByRole('button', { name: /^Notifications/ });
    const notices = popup('Notifications');
    const wallet = popup('Wallet connection');
    const profileTrigger = page.getByRole('button', { name: 'Switch wallet profile' });
    const menu = popup('Profile menu');
    const openProfiles = async () => {
      await profileTrigger.click();
      await menu.locator('.header-profile-summary').click();
    };
    const useProfile = async name => {
      await openProfiles();
      await menu.locator('.profile-option').filter({ hasText: name }).click();
      assert.match(await profileTrigger.innerText(), new RegExp(name));
    };
    const openSettings = async () => {
      await profileTrigger.click();
      await menu.getByRole('button', { name: 'Settings', exact: true }).click();
    };
    const assertEmptyNotices = async () => {
      await bell().click();
      await notices.getByText('No notifications yet.', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
    };
    const enterPaper = () => page.getByRole('button', { name: 'Enter Paper Trading' }).click();
    const exitPaper = () => page.getByRole('button', { name: 'Exit Paper Trading' }).click();
    await page.goto(origin);
    await assertEmptyNotices();

    await page.getByRole('button', { name: 'Existing Profile', exact: true }).click();
    await wallet.getByRole('button', { name: 'Import', exact: true }).click();
    await wallet.getByLabel('Recovery phrase', { exact: true }).fill(phrase);
    await wallet.getByRole('button', { name: 'Import wallet', exact: true }).click();
    await wallet.waitFor({ state: 'hidden' });
    await page.getByRole('region', { name: 'BCH portfolio balance' }).getByText('0.002 BCH', { exact: true }).waitFor();
    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Send/ }).click();
    const send = popup('Send BCH');
    const reviewButton = send.getByRole('button', { name: 'Review & Send' });
    await reviewButton.click();
    await send.getByRole('alert').getByText('Enter a recipient address.').waitFor();
    await send.getByLabel('Recipient address').fill('bitcoincash:invalid');
    await reviewButton.click();
    await send.getByRole('alert').getByText('Enter a valid BCH Mainnet recipient address.').waitFor();
    await send.getByLabel('Recipient address').fill(recipient);
    await reviewButton.click();
    await send.getByRole('alert').getByText('Enter an amount to send.').waitFor();
    await send.getByLabel('Send amount').fill('0.00000545');
    await reviewButton.click();
    await send.getByRole('alert').getByText('Enter at least 546 sats.').waitFor();
    await send.getByLabel('Send amount').fill('0.002');
    await reviewButton.click();
    await send.getByRole('alert').getByText(/Insufficient.*network fees/).waitFor();
    await send.getByLabel('Send amount').fill('0.0001');
    await reviewButton.click();
    const review = popup('Transaction confirmation');
    assert.equal(broadcastCount, 0);
    await review.getByRole('button', { name: 'Sign & Broadcast' }).click();
    await review.getByText('Transaction broadcast', { exact: true }).waitFor();
    await review.getByRole('button', { name: 'Close confirmation' }).click();
    await send.getByRole('button', { name: 'Close Send BCH' }).click();
    assert.equal(broadcastCount, 1);
    await bell().click();
    await notices.getByText('Signature requested', { exact: true }).waitFor();
    await notices.getByText('Transaction broadcast', { exact: true }).waitFor();
    assert.equal(await notices.getByText('Transaction confirmed', { exact: true }).count(), 0);
    await notices.getByRole('button', { name: 'Mark all as read' }).click();
    assert.equal(await bell().getAttribute('aria-label'), 'Notifications');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.wallet-history-item').getByText('Pending', { exact: true }).count(), 1);
    assert.doesNotMatch(await page.locator('.wallet-history-item').filter({ hasText: 'Pending' }).innerText(), /Unavailable/);

    // A separate watch-only profile sees the same public history, while notices belong to the signer.
    await openProfiles();
    await menu.getByRole('button', { name: 'Connected wallets', exact: true }).click();
    await wallet.getByRole('button', { name: 'Connect', exact: true }).click();
    await wallet.getByLabel('Watch-only address', { exact: true }).fill(address);
    await wallet.getByLabel('Profile name', { exact: true }).fill('QA activity watcher');
    await wallet.getByRole('button', { name: 'Add watch-only profile', exact: true }).click();
    await wallet.waitFor({ state: 'hidden' });
    await assertEmptyNotices();
    confirmed = true;
    changed();
    const confirmation = page.locator('.wallet-history-item').filter({ has: page.getByRole('link', { name: new RegExp(sentTxid.slice(0, 9)) }) });
    await confirmation.getByText('Confirmed', { exact: true }).waitFor();
    await assertEmptyNotices();

    await useProfile('Mainnet HD Wallet');
    await bell().click();
    await notices.getByText('Transaction confirmed', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await enterPaper();
    assert.equal(await page.locator('.wallet-history-item').count(), 0);
    await assertEmptyNotices();
    await exitPaper();
    await confirmation.getByText('Confirmed', { exact: true }).waitFor();

    await openSettings();
    await page.getByRole('button', { name: 'Connect dApp / Paste Pairing Code', exact: true }).click();
    const pair = popup('Connect dApp');
    await pair.getByLabel('dApp connection input').fill(dapp);
    await pair.getByRole('button', { name: 'Continue →' }).click();
    await popup('Approve dApp connection').getByRole('button', { name: 'Approve', exact: true }).click();
    await page.locator('.settings-page').getByText('Active session', { exact: true }).waitFor();
    await bell().click();
    await notices.getByText('Application connected', { exact: true }).waitFor();
    await page.keyboard.press('Escape');

    await useProfile('QA activity watcher');
    await page.locator('.settings-page .connected-app-list').getByText('0 connected apps', { exact: true }).waitFor();
    await assertEmptyNotices();
    await useProfile('Mainnet HD Wallet');
    await enterPaper();
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Markets' }).click();
    await page.getByRole('button', { name: `Open ${round.title}`, exact: true }).click();
    await page.getByRole('button', { name: 'Review & Place Stake', exact: true }).click();
    await review.getByRole('button', { name: 'Confirm Paper Preview', exact: true }).click();
    await page.locator('.active-position').first().waitFor();
    await useProfile('QA activity watcher');
    await enterPaper();
    resolved = true;
    const browserNow = await page.evaluate(() => Date.now());
    const marketRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/markets' && response.ok());
    await page.clock.fastForward(Math.max(0, expiry - browserNow) + 5500);
    await marketRefresh;
    await assertEmptyNotices();

    await useProfile('Mainnet HD Wallet');
    await bell().click();
    assert.equal(await notices.getByText('Market resolved', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await enterPaper();
    await bell().click();
    await notices.getByText('Market resolved', { exact: true }).waitFor();
    assert.equal(await notices.getByText('Market resolved', { exact: true }).count(), 1);
    assert.equal(await notices.getByText('Transaction confirmed', { exact: true }).count(), 0);
    assert.deepEqual(postBodiesWithSeed, []);
    assert.deepEqual(errors, []);
    console.log('Activity: VM-signed fixture transfer, confirmations, and dApp approvals are isolated by profile. Only the participating Paper Trading profile received the round resolution.');
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    await verifySendGates(browser);
    await verifyActivity(browser);
  }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
