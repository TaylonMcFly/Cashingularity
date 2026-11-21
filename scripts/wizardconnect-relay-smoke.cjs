const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const { mockWalletChain } = require('./wallet-chain-fixture.cjs');
const origin = process.env.CASHINGULARITY_QA_ORIGIN || 'http://localhost:3000';

async function relayFixture(urls) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const browserSockets = new Set();
  const subscribers = new Map();
  const archive = [];
  let record = false;
  let replayed = 0;
  server.on('connection', (socket, request) => {
    if (request.headers.origin) browserSockets.add(socket);
    const filters = new Map();
    subscribers.set(socket, { path: request.url, filters });
    socket.on('close', () => { subscribers.delete(socket); browserSockets.delete(socket); });
    socket.on('message', buffer => {
      const [action, id, filter] = JSON.parse(buffer.toString());
      if (action === 'REQ') {
        filters.set(id, filter['#p']);
        if (request.headers.origin) for (const { path, event } of archive) {
          if (path === request.url && event.tags.some(([tag, value]) => tag === 'p' && filter['#p'].includes(value))) {
            socket.send(JSON.stringify(['EVENT', id, event]));
            replayed++;
          }
        }
        socket.send(JSON.stringify(['EOSE', id]));
      } else if (action === 'CLOSE') filters.delete(id);
      else if (action === 'EVENT') {
        const event = id;
        if (record && !request.headers.origin) archive.push({ path: request.url, event });
        socket.send(JSON.stringify(['OK', event.id, true, '']));
        for (const [other, sub] of subscribers) {
          if (sub.path !== request.url || other.readyState !== other.OPEN) continue;
          for (const [subId, pubkeys] of sub.filters) {
            if (event.tags.some(([tag, value]) => tag === 'p' && pubkeys.includes(value))) {
              other.send(JSON.stringify(['EVENT', subId, event]));
            }
          }
        }
      }
    });
  });
  return {
    redirects: Object.fromEntries(urls.map((url, index) => [new URL(url).origin, `ws://127.0.0.1:${server.address().port}${index ? `/${index}` : ''}`])),
    drop: () => { for (const socket of browserSockets) socket.terminate(); },
    capture: enabled => { record = enabled; if (enabled) archive.length = 0; },
    get replayed() { return replayed; },
    close: () => { for (const socket of server.clients) socket.terminate(); server.close(); },
  };
}

// Use native browser sockets and the encrypted WizardConnect protocol. UTXOs and broadcast are fixtures.
async function checkWizardConnect() {
  const api = await import('@bitauth/libauth');
  const wire = await import('@wizardconnect/core');
  const now = () => Math.floor(Date.now() / 1000);
  const root = api.deriveHdPrivateNodeFromBip39Mnemonic(`${'abandon '.repeat(11)}about`);
  const first = 'QA Wizard Wallet A';
  const second = 'QA Wizard Wallet B';
  // The wallet chooses the numeric paths. The dapp must use the shared branch name and xpub.
  const nodes = [[3, 8], [0, 1]].map((branches, account) => branches.map(branch => api.deriveHdPath(root, `m/44'/145'/${account}'/${branch}`)));
  const extra = api.deriveHdPath(root, "m/44'/145'/0'/7");
  root.privateKey.fill(0);
  const address = (node, index) => api.encodeCashAddress({
    prefix: 'bitcoincash', type: 'p2pkh', payload: api.hash160(api.deriveHdPublicNodeChild(api.deriveHdPublicNode(node), index).publicKey),
  }).address;
  const fundingAddress = address(nodes[0][1], 9);
  const excludedAddress = address(extra, 0);
  const lockingBytecode = api.cashAddressToLockingBytecode(fundingAddress).bytecode;
  const funding = { valueSatoshis: 150000n, lockingBytecode };
  const outpoint = '42'.repeat(32);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const relay = await relayFixture(wire.DEFAULT_RELAY_URLS);
  const peers = [];
  let paid = '';
  const requests = [];
  let broadcastCount = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(redirects => {
      const NativeSocket = WebSocket;
      const stats = window.wizardSocketStats = { opened: 0, active: {}, peak: {}, closedWrites: [] };
      const listeners = new Map();
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      const watched = (target, type) => (target === window && ['online', 'offline'].includes(type)) ||
        (target === document && type === 'visibilitychange');
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (listener && watched(this, type) && !options?.signal?.aborted) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
          options?.signal?.addEventListener('abort', () => set.delete(listener), { once: true });
        }
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (watched(this, type)) listeners.get(type)?.delete(listener);
        return remove.call(this, type, listener, options);
      };
      window.wizardLifecycle = () => {
        window.gc?.();
        return { listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
          sockets: Object.values(stats.active).reduce((sum, count) => sum + count, 0),
          heapKiB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1024) };
      };
      window.WebSocket = class extends NativeSocket {
        constructor(url, protocols) {
          const origin = new URL(url, location.href).origin;
          super(redirects[origin] ?? url, protocols);
          if (!redirects[origin]) return;
          this.relayOrigin = origin;
          stats.opened++;
          stats.active[origin] = (stats.active[origin] ?? 0) + 1;
          stats.peak[origin] = Math.max(stats.peak[origin] ?? 0, stats.active[origin]);
          this.addEventListener('close', () => stats.active[origin]--, { once: true });
        }
        send(data) {
          if (this.relayOrigin && this.readyState >= NativeSocket.CLOSING) stats.closedWrites.push(this.relayOrigin);
          return super.send(data);
        }
      };
    }, relay.redirects);
    const changed = await mockWalletChain(context, watched => watched === fundingAddress ? {
      history: [{ txid: outpoint, height: 99 }, ...(paid ? [{ txid: paid, height: 0 }] : [])],
      utxos: paid ? [] : [{ txid: outpoint, vout: 0, satoshis: '150000', height: 99 }],
    } : watched === excludedAddress ? {
      history: [{ txid: '41'.repeat(32), height: 99 }],
      utxos: [{ txid: '41'.repeat(32), vout: 0, satoshis: '900000', height: 99 }],
    } : { history: [], utxos: [] });
    await context.route(/\/api\/(?:chain\/|wallet\/)?broadcast$/, async route => {
      broadcastCount++;
      const { rawTxHex, network } = route.request().postDataJSON();
      assert.equal(network, 'mainnet');
      const bytes = api.hexToBin(rawTxHex);
      assert.equal(api.createVirtualMachineBCH().verify({ transaction: api.decodeTransaction(bytes), sourceOutputs: [funding] }), true);
      paid = api.hashTransaction(bytes);
      await route.fulfill({ json: { txid: paid } });
      changed();
    });

    const page = await context.newPage();
    const pageErrors = [];
    const closedSocketErrors = [];
    const sensitiveMarker = 'fixture-value-must-stay-out-of-console';
    const sensitiveLogs = [];
    const captureLogs = page => page.on('console', async message => {
      const args = await Promise.all(message.args().map(arg => arg.jsonValue().catch(() => undefined)));
      if (message.text().includes(sensitiveMarker) || JSON.stringify(args).includes(sensitiveMarker)) sensitiveLogs.push(message.type());
    });
    captureLogs(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (/WebSocket is already in CLOSING or CLOSED/.test(message.text())) closedSocketErrors.push(message.text()); });
    await page.goto(origin);
    const modal = page.getByRole('dialog', { name: 'Wallet connection', exact: true });
    const list = modal.getByRole('list', { name: 'Wallet profiles', exact: true });
    const row = label => list.getByRole('button', { name: new RegExp(`^${label}`) });
    const closeModal = () => modal.getByRole('button', { name: 'Close', exact: true }).click();
    const openManager = async (current = page) => {
      await current.getByRole('button', { name: 'Switch wallet profile', exact: true }).click();
      await current.locator('.header-profile-summary').click();
      await current.getByRole('button', { name: 'Connected wallets', exact: true }).click();
    };
    const pair = async (label, account, staged) => {
      await modal.getByRole('img', { name: 'WizardConnect pairing QR code' }).waitFor();
      await modal.getByText('Show pairing link', { exact: true }).click();
      const uri = (await modal.locator('code.uri-text').first().innerText()).trim();
      assert.match(uri, /^wiz:\/\//i);
      assert.equal(await modal.getByLabel('Recovery phrase', { exact: true }).count(), 0);
      const { publicKey, secret } = wire.decodeKeyExchangeURI(uri);
      const relayUrls = Object.values(relay.redirects);
      const { hostname, port } = new URL(relayUrls[0]);
      const localUri = wire.encodeKeyExchangeURI(publicKey, secret, { hostname, port: Number(port), protocol: 'ws' }).uri;
      const paths = nodes[account].map((node, i) => ({ name: i ? 'change' : 'receive', xpub: api.encodeHdPublicKey({ network: 'mainnet', node: api.deriveHdPublicNode(node) }).hdPublicKey }));
      if (!account) paths.push({ name: 'alternate-receive', xpub: api.encodeHdPublicKey({ network: 'mainnet', node: api.deriveHdPublicNode(extra) }).hdPublicKey });
      const key = Uint8Array.from(randomBytes(32));
      let clientInstance;
      let approved = !staged;
      let answerHello = true;
      const ready = (client, discovered) => client.relay({
        action: wire.RelayMsgAction.WalletReady, wallet_name: label, wallet_icon: '',
        dapp_discovered: discovered, supported_protocols: ['hdwalletv1'], session: { hdwalletv1: { paths: approved ? paths : [] } },
        public_key: api.binToHex(wallet.walletPublicKey), secret: wallet.secret, time: now(),
      });
      const wallet = wire.initiateWalletRelay(({ client, status }) => {
        if (status.status !== 'connected') return;
        if (clientInstance !== client) {
          clientInstance = client;
          client.on('message', message => {
            if (message.action === wire.RelayMsgAction.DappReady && !message.wallet_discovered && answerHello) void ready(client, true);
            if (message.action === wire.RelayMsgAction.SignTransactionRequest) requests.push({ client, message, label });
            if (message.action === wire.RelayMsgAction.Ping) void client.relay({ action: wire.RelayMsgAction.Pong, time: now() });
          });
        }
        void ready(client, false);
      }, { uri: localUri, walletPrivateKey: key, explicitRelayUrls: relayUrls });
      peers.push({
        wallet, key,
        answerHello: enabled => { answerHello = enabled; },
        ready: enabled => { approved = enabled; return ready(clientInstance, true); },
        pong: () => clientInstance.relay({ action: wire.RelayMsgAction.Pong, time: now() }),
        invalidReady: async () => {
          await clientInstance.relay({
            action: wire.RelayMsgAction.WalletReady, wallet_name: label, public_key: api.binToHex(wallet.walletPublicKey),
            secret: wallet.secret, time: now(), dapp_discovered: true, supported_protocols: ['hdwalletv1'],
            session: { hdwalletv1: { paths: sensitiveMarker } },
          });
          await clientInstance.relay({
            action: wire.RelayMsgAction.WalletReady, wallet_name: label, wallet_icon: '', public_key: api.binToHex(wallet.walletPublicKey),
            secret: wallet.secret, time: now(), dapp_discovered: true, supported_protocols: ['hdwalletv1'],
            session: { hdwalletv1: { paths: [{ name: sensitiveMarker, xpub: sensitiveMarker }] } },
          });
        },
      });
      if (staged) {
        await modal.getByText('Wallet found. Approve the connection on your phone.', { exact: true }).waitFor({ timeout: 40000 });
        assert.equal(await page.locator('.wallet-home-network').getAttribute('data-wallet-status'), 'disconnected');
        approved = true;
        await ready(clientInstance, true);
      }
      await row(label).waitFor({ timeout: 40000 });
      assert.match(await row(label).innerText(), /WizardConnect · Connected/);
    };

    await page.getByRole('button', { name: 'Connect external wallet', exact: true }).click();
    await pair(first, 0, true);
    await page.waitForFunction(() => document.querySelector('.wallet-hero-bch')?.textContent.trim() === '0.0015 BCH');
    await peers[0].invalidReady();
    await page.waitForTimeout(300);
    const invalidatedOnMalformed = await page.locator('.wallet-home-network').getAttribute('data-wallet-status') === 'offline';
    await peers[0].ready(true);
    await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor();
    await page.evaluate(async () => {
      for (const state of ['hidden', 'visible', 'hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      delete document.visibilityState;
    });
    const initialSockets = await page.evaluate(() => window.wizardSocketStats);
    assert.equal(initialSockets.opened, wire.DEFAULT_RELAY_URLS.length);
    assert.deepEqual(initialSockets.closedWrites, []);
    const beforeReconnect = await page.evaluate(() => window.wizardLifecycle());
    for (let i = 0; i < 4; i++) {
      relay.drop();
      await page.locator('.wallet-home-network[data-wallet-status="offline"]').waitFor({ timeout: 12000 });
      // The controlled peer sends a fresh approval after the new relay subscriptions.
      const target = wire.DEFAULT_RELAY_URLS.length * (i + 2);
      await page.waitForFunction(expected => window.wizardSocketStats.opened === expected &&
        Object.values(window.wizardSocketStats.active).every(count => count === 1), target);
      await page.waitForTimeout(330);
      await peers[0].ready(true);
      await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 30000 });
    }
    const afterReconnect = await page.evaluate(() => window.wizardLifecycle());
    assert.equal(afterReconnect.listeners, beforeReconnect.listeners);
    assert.equal(afterReconnect.sockets, beforeReconnect.sockets);
    console.log(JSON.stringify({ relayReconnects: 4, beforeReconnect, afterReconnect }));
    const recoveredSockets = await page.evaluate(() => window.wizardSocketStats);
    assert.equal(recoveredSockets.opened, wire.DEFAULT_RELAY_URLS.length * 5);
    assert.ok(Object.values(recoveredSockets.peak).every(count => count === 1));
    assert.deepEqual(recoveredSockets.closedWrites, []);
    console.log('Staged approval found change index 9. Relay restart restored signing readiness.');

    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('offline')); });
    await page.locator('.wallet-home-network[data-wallet-status="offline"]').waitFor();
    await page.waitForFunction(() => Object.values(window.wizardSocketStats.active).every(count => count === 0));
    assert.equal(await page.evaluate(() => window.wizardSocketStats.opened), recoveredSockets.opened);
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online')); });
    await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 30000 });
    assert.equal(await page.evaluate(() => window.wizardSocketStats.opened), recoveredSockets.opened + wire.DEFAULT_RELAY_URLS.length);

    await modal.getByRole('button', { name: 'Connect', exact: true }).click();
    await pair(second, 1, false);
    await peers[0].ready(false);
    await row(first).getByText('WizardConnect · Waiting for wallet').waitFor();
    assert.equal(await row(first).count(), 1);
    await row(first).click();
    await modal.getByRole('button', { name: 'Activate', exact: true }).click();
    await closeModal();
    await page.waitForFunction(() => document.querySelector('.wallet-hero-bch')?.textContent.trim() === '0.0015 BCH');
    await peers[0].pong();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.wallet-home-network').getAttribute('data-wallet-status'), 'offline');
    await peers[0].ready(true);
    await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Send/ }).click();
    const send = page.getByRole('dialog', { name: 'Send BCH', exact: true });
    await send.getByLabel('Recipient address').fill(address(nodes[0][0], 20));
    await send.getByLabel('Send amount').fill('0.0001');
    await send.getByRole('button', { name: 'Review & Send' }).click();
    const review = page.getByRole('dialog', { name: 'Transaction confirmation' });
    assert.equal(requests.length, 0);
    assert.equal(broadcastCount, 0);
    await review.getByRole('button', { name: 'Sign & Broadcast' }).click();
    for (let i = 0; !requests.length && i < 150; i++) {
      if (await review.getByRole('alert').count()) throw new Error(await review.getByRole('alert').innerText());
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(requests.length, 1, 'Expected one signing request');
    assert.equal(requests[0].label, first);
    assert.equal(broadcastCount, 0);
    const { client, message } = requests[0];
    assert.deepEqual(message.inputPaths, [[0, 'change', 9]]);
    assert.equal(message.transaction.broadcast, false);
    assert.equal(wire.toBigInt(message.transaction.sourceOutputs[0].valueSatoshis), funding.valueSatoshis);
    assert.deepEqual(wire.toUint8Array(message.transaction.sourceOutputs[0].lockingBytecode), funding.lockingBytecode);
    const tx = api.decodeTransaction(api.hexToBin(message.transaction.transaction));
    assert.equal(typeof tx, 'object');
    const key = api.deriveHdPrivateNodeChild(nodes[0][1], 9).privateKey;
    const serialization = api.generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs: [funding], transaction: tx },
      { coveredBytecode: lockingBytecode, signingSerializationType: Uint8Array.of(0x61) });
    const signature = api.secp256k1.signMessageHashSchnorr(key, api.sha256.hash(api.sha256.hash(serialization)));
    const pubkey = api.secp256k1.derivePublicKeyCompressed(key);
    key.fill(0);
    tx.inputs[0].unlockingBytecode = Uint8Array.from([65, ...signature, 0x61, 33, ...pubkey]);
    const signedTransaction = api.binToHex(api.encodeTransaction(tx));
    const respond = (sequence) => client.relay({ action: wire.RelayMsgAction.SignTransactionResponse, sequence, signedTransaction, time: now() });
    relay.drop();
    await review.getByRole('alert').getByText(/disconnected during signing/).waitFor({ timeout: 12000 });
    assert.ok(await review.getByRole('button', { name: 'Sign & Broadcast' }).isDisabled());
    await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 30000 });
    await respond(message.sequence);
    assert.equal(broadcastCount, 0);
    assert.equal(requests.length, 1);
    await review.getByRole('button', { name: 'Sign & Broadcast' }).click();
    for (let i = 0; requests.length === 1 && i < 150; i++) await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, 2, 'Only the second explicit approval should request another signature');
    assert.equal(requests[1].label, first);
    assert.equal(requests[1].message.transaction.broadcast, false);
    assert.equal(requests[1].message.transaction.transaction, message.transaction.transaction);
    assert.equal(broadcastCount, 0);
    assert.notEqual(requests[1].message.sequence, message.sequence);
    await respond(message.sequence);
    await peers[1].wallet.client.relay({
      action: wire.RelayMsgAction.SignTransactionResponse, sequence: requests[1].message.sequence, signedTransaction, time: now(),
    });
    await page.waitForTimeout(300);
    assert.equal(broadcastCount, 0, 'Old and wrong-peer replies cannot satisfy the active request');
    await respond(requests[1].message.sequence);
    await review.getByText('Transaction broadcast', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(broadcastCount, 1);
    assert.deepEqual(await page.evaluate(() => window.wizardSocketStats.closedWrites), []);
    console.log('Only the selected peer received the signing request. CashVM verified the intercepted payment.');

    peers[0].answerHello(false);
    relay.capture(true);
    await peers[0].ready(true);
    relay.capture(false);
    await page.reload();
    await page.locator('.wallet-home-network[data-wallet-status="offline"]').waitFor({ timeout: 15000 });
    await peers[0].pong();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.wallet-home-network').getAttribute('data-wallet-status'), 'offline');
    assert.ok(relay.replayed > 0, 'The relay actually delivered a retained approval on reload');
    await peers[0].ready(true);
    await page.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 15000 });
    peers[0].answerHello(true);
    await openManager();
    assert.match(await row(first).innerText(), /WizardConnect · Connected/);
    assert.match(await row(second).innerText(), /Reconnect to sign/);
    await row(second).click();
    await modal.getByRole('button', { name: 'Forget pairing', exact: true }).click();
    await row(second).waitFor({ state: 'hidden' });
    assert.match(await row(first).innerText(), /WizardConnect · Connected/);
    await closeModal();

    const other = await context.newPage();
    captureLogs(other);
    other.on('pageerror', error => pageErrors.push(error.message));
    await other.goto(origin);
    await other.waitForFunction(() => document.querySelector('.wallet-home-network')?.getAttribute('data-wallet-status') === 'disconnected');
    await other.waitForTimeout(600);
    assert.equal(await other.evaluate(() => window.wizardSocketStats.opened), 0, 'A second tab must wait for the saved pairing owner');
    await page.close();
    await other.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 15000 });
    assert.equal(await other.evaluate(() => window.wizardSocketStats.opened), wire.DEFAULT_RELAY_URLS.length);
    await other.getByRole('button', { name: 'Switch wallet profile', exact: true }).click();
    await other.getByRole('dialog', { name: 'Profile menu' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await other.getByRole('button', { name: 'Log out & lock session', exact: true }).click();
    await other.goto(origin);
    await openManager(other);
    const manager = other.getByRole('dialog', { name: 'Wallet connection', exact: true });
    const saved = manager.getByRole('list', { name: 'Wallet profiles', exact: true }).getByRole('button', { name: new RegExp('^' + first) });
    await saved.getByText('WizardConnect · Reconnect to sign').waitFor();
    assert.equal(await other.evaluate(() => window.wizardSocketStats.opened), 0, 'A deliberately locked session must remain locked on reload');
    await saved.click();
    await manager.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await other.locator('.wallet-home-network[data-wallet-status="signing"]').waitFor({ timeout: 15000 });
    await peers[0].wallet.client.relay({ action: wire.RelayMsgAction.Disconnect, reason: wire.DisconnectReason.UserDisconnect, time: now() });
    // A delayed same-peer handshake still in the relay after explicit revocation cannot keep the session.
    await peers[0].ready(true);
    const revoked = await other.locator('.wallet-home-network[data-wallet-status="disconnected"]').waitFor({ timeout: 12000 })
      .then(() => true, () => false);
    assert.deepEqual({ invalidatedOnMalformed, sensitiveLogs, revoked }, { invalidatedOnMalformed: true, sensitiveLogs: [], revoked: true });
    await other.reload();
    await other.locator('.wallet-home-network[data-wallet-status="disconnected"]').waitFor();
    assert.equal(await other.evaluate(() => window.wizardSocketStats.opened), 0);
    await other.close();

    const expired = await context.newPage();
    captureLogs(expired);
    expired.on('pageerror', error => pageErrors.push(error.message));
    await expired.clock.install();
    await expired.goto(origin);
    await expired.getByRole('button', { name: 'Connect external wallet', exact: true }).click();
    await expired.getByRole('img', { name: 'WizardConnect pairing QR code' }).waitFor();
    await expired.clock.fastForward(181_000);
    await expired.getByText('No wallet handshake received. Open WizardConnect on your phone and retry.').waitFor();
    await expired.waitForFunction(() => window.wizardLifecycle().sockets === 0);
    await expired.close();

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(closedSocketErrors, []);
    console.log('Saved profile resumed after reload and moved between tabs without duplicate sockets. Empty approvals, offline transitions, logout and revocation kept signing disabled.');
  } finally {
    for (const { wallet, key } of peers) {
      wallet.cleanup();
      key.fill(0);
    }
    nodes.flat().forEach(node => node.privateKey.fill(0));
    extra.privateKey.fill(0);
    await browser.close();
    relay.close();
  }
}

checkWizardConnect().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
