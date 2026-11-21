const assert = require('node:assert/strict');
const { mockWalletChain } = require('./wallet-chain-fixture.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');

const origin = 'http://localhost:3000';
const phrase = `${'abandon '.repeat(11)}about`; // Public BIP39 test vector only.
const backupKey = 'cashingularity.profiles.v1';
const selectionKey = 'cashingularity.activeLiveProfileId.v1';
const watchName = 'QA watch wallet';
const observerName = 'QA second wallet';

async function testAddress() {
  const { CashAddressType, deriveHdPath, deriveHdPrivateNodeFromBip39Mnemonic, encodeCashAddress, hash160, secp256k1 } = await import('@bitauth/libauth');
  const root = deriveHdPrivateNodeFromBip39Mnemonic(phrase);
  const key = deriveHdPath(root, "m/44'/145'/0'/0/0");
  const payload = hash160(secp256k1.derivePublicKeyCompressed(key.privateKey));
  const address = encodeCashAddress({ prefix: 'bitcoincash', type: CashAddressType.p2pkhWithTokens, payload }).address;
  key.privateKey.fill(0);
  root.privateKey.fill(0);
  return address;
}

async function checkWalletHome(browser, width, theme, address) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    await context.addInitScript(theme => {
      if (window !== window.top) return;
      if (!localStorage.getItem('cashingularity.theme.v1')) localStorage.setItem('cashingularity.theme.v1', theme);
    }, theme);
    // The disposable wallet is always unfunded and the smoke test never broadcasts.
    const historyRequests = new Set();
    await mockWalletChain(context, address => {
      historyRequests.add(address);
      return { history: [], utxos: [] };
    });
    const page = await context.newPage();
    const errors = [];
    const requestsWithPhrase = [];
    const externalScripts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on('request', request => {
      if (request.postData()?.includes(phrase)) requestsWithPhrase.push(request.method());
      if (request.resourceType() === 'script' && new URL(request.url()).origin !== origin && request.frame() === page.mainFrame()) externalScripts.push(request.url());
    });
    const go = path => page.goto(`${origin}${path}`);
    const nav = width > 768 ? page.locator('.primary-navigation') : page.locator('.mobile-bottom-nav');
    const navRole = width > 768 ? 'link' : 'button';
    const popup = name => page.getByRole('dialog', { name, exact: true });
    const walletDialog = popup('Wallet connection');
    const batch = popup('Batch Pay');
    const send = popup('Send BCH');
    const portfolio = page.getByRole('region', { name: 'BCH portfolio balance' });
    const walletName = page.locator('.wallet-home-profile');
    const watchRow = walletDialog.getByRole('list', { name: 'Wallet profiles', exact: true }).getByRole('button', { name: new RegExp(`^${watchName}`) });
    const profileTrigger = page.getByRole('button', { name: 'Switch wallet profile', exact: true });
    const profileMenu = popup('Profile menu');
    const profileSummary = profileMenu.locator('.header-profile-summary');
    const profileList = profileMenu.getByRole('group', { name: 'Wallet profiles' });
    const menuRow = name => profileList.getByRole('button', { name });
    const openProfiles = async () => {
      await profileTrigger.click();
      await profileSummary.click();
    };
    const assertMainMenu = async name => {
      const buttons = profileMenu.getByRole('button');
      assert.deepEqual((await buttons.allTextContents()).slice(0, -1), ['Wallet', 'Settings', 'Appearance']);
      assert.equal(await buttons.last().locator('strong').innerText(), name);
      assert.equal(await profileTrigger.locator('strong').innerText(), name);
      assert.equal(await profileTrigger.getAttribute('aria-description'), `${name} · ${await profileSummary.locator('small').innerText()}`);
      assert.equal(await profileList.count(), 0);
    };
    const selectNav = async name => {
      if (width > 768 && name === 'Settings') {
        await profileTrigger.click();
        await profileMenu.getByRole('button', { name, exact: true }).click();
      } else await nav.getByRole(navRole, { name, exact: true }).click();
    };
    const activeId = () => page.evaluate(key => localStorage.getItem(key), selectionKey);
    const storedBackup = () => page.evaluate(key => localStorage.getItem(key), backupKey);
    const checkLayout = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    const close = name => popup(name).getByRole('button', { name: `Close ${name}`, exact: true }).click();
    const openManage = async () => {
      await openProfiles();
      await profileMenu.getByRole('button', { name: 'Connected wallets', exact: true }).click();
      await watchRow.waitFor();
    };
    const restore = async () => {
      assert.match(await profileTrigger.innerText(), /Select profile/);
      await profileTrigger.click();
      await assertMainMenu('Select profile');
      await profileSummary.click();
      await profileMenu.getByRole('button', { name: /Saved wallet.*Locked/ }).click();
      const unlock = walletDialog.getByRole('button', { name: 'Unlock & activate', exact: true });
      await unlock.waitFor();
      assert.equal(await unlock.evaluate(button => document.activeElement === button), true);
      assert.equal(await profileMenu.count(), 0);
      assert.equal(await watchRow.count(), 0);
      assert.match(await profileTrigger.innerText(), /Select profile/);
      await unlock.click();
      await watchRow.waitFor();
      await walletDialog.getByRole('button', { name: 'Close', exact: true }).click();
    };
    const waitCapability = async status => {
      await page.locator(`.wallet-home-network[data-wallet-status="${status}"]`).waitFor();
      assert.equal(await walletName.innerText(), watchName);
      await page.locator(`.header-mode [data-wallet-status="${status === 'watch' ? 'watch-only' : 'connected'}"]`).waitFor();
    };
    const checkPopupBoundary = async () => assert.ok(await profileMenu.evaluate(panel => {
      const { top, right, bottom, left } = panel.getBoundingClientRect();
      const headerBottom = document.querySelector('.blaze-banner').getBoundingClientRect().bottom;
      const bottomNav = document.querySelector('.mobile-bottom-nav').getBoundingClientRect();
      return top >= headerBottom && left >= 0 && right <= innerWidth && bottom <= (bottomNav.height ? bottomNav.top : innerHeight);
    }));
    const checkHeaderControls = async () => assert.ok(await page.locator('.header-account').evaluate(account => {
      const controls = [...account.querySelectorAll('button, a')].map(element => element.getBoundingClientRect());
      return controls.every((rect, i) => rect.left >= (controls[i - 1]?.right ?? 0) && rect.right <= innerWidth);
    }));
    const desktopSpan = async (selector = '.center-workspace') => {
      if (width === 1920) assert.equal((await page.locator(selector).boundingBox()).width, 1440);
    };

    await go('/');
    await page.getByRole('heading', { name: 'Welcome to your wallet' }).waitFor();
    assert.deepEqual(await nav.getByRole(navRole).allTextContents(), width > 768
      ? ['Wallet', 'Markets', 'Arcade'] : ['Wallet', 'Markets', 'Arcade', 'Settings']);
    const header = page.locator('.blaze-banner');
    assert.equal(await header.getByRole('link', { name: 'Settings', exact: true }).count(), 0);
    const source = header.getByRole('link', { name: 'Source code on GitHub' });
    assert.equal(await source.isVisible(), true);
    assert.equal(await source.getAttribute('href'), 'https://github.com/TaylonMcFly/Cashingularity');
    if (width <= 768) assert.ok((await source.boundingBox()).width >= 44);
    assert.equal(await header.locator('.mode-indicator').getAttribute('title'), 'BCH Mainnet · No wallet selected');
    assert.equal(await header.getByText('Live On-Chain', { exact: true }).count(), 0);
    assert.equal(await nav.getByRole(navRole, { name: 'Wallet' }).getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.rabby-wallet-sidebar').count(), 0);
    for (const name of ['Create Profile', 'Existing Profile', 'Explore Sandbox'])
      assert.equal(await portfolio.getByRole('button', { name, exact: true }).isVisible(), true);
    if (width >= 1040) {
      assert.ok(await page.locator('.wallet-columns').evaluate(columns => {
        const main = columns.querySelector('.wallet-main-column').getBoundingClientRect();
        const side = columns.querySelector('.wallet-side-column').getBoundingClientRect();
        const share = main.width / (main.width + side.width);
        return side.left > main.right && share >= .65 && share <= .70;
      }));
    }
    await desktopSpan();
    assert.equal((await (await page.request.get(`${origin}/app.webmanifest`)).json()).start_url, '/');
    await checkLayout();
    await checkHeaderControls();
    if (width === 375) assert.ok(await profileTrigger.locator('strong').evaluate(async label => {
      await document.fonts.ready;
      return label.scrollWidth <= label.clientWidth;
    }));
    await profileTrigger.focus();
    await page.keyboard.press('Enter');
    await checkLayout();
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Wallet');
    const menuId = await profileMenu.getAttribute('id');
    await assertMainMenu('Select profile');
    assert.match(await profileMenu.getByRole('button').last().innerText(), /Select profile\s+No active wallet/);
    assert.equal(await profileMenu.getByRole('button', { name: 'Switch Profile', exact: true }).count(), 0);
    const shortViewport = width === 375;
    if (shortViewport) await page.setViewportSize({ width: 320, height: 226 });
    await page.keyboard.press('End');
    assert.equal(await profileSummary.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Enter');
    await profileMenu.getByRole('heading', { name: 'Switch Profile', exact: true }).waitFor();
    assert.equal(await profileMenu.getAttribute('id'), menuId);
    assert.equal(await profileMenu.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
    for (const name of ['Create Profile', 'Import Profile', /Explore Sandbox/]) {
      assert.equal(await menuRow(name).isVisible(), true);
    }
    await checkPopupBoundary();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Back to profile menu');
    await page.keyboard.press('Enter');
    assert.equal(await profileSummary.evaluate(element => document.activeElement === element && element.getBoundingClientRect().bottom <= element.closest('[role="dialog"]').getBoundingClientRect().bottom), true);
    await page.keyboard.press('Enter');
    await profileList.waitFor();
    await page.keyboard.press('Escape');
    if (shortViewport) {
      await checkHeaderControls();
      await openProfiles();
      await checkPopupBoundary();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 900 });
    }
    await profileTrigger.focus();
    await page.keyboard.press('Enter');
    await assertMainMenu('Select profile');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await checkLayout();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Back to profile menu');
    const appearance = profileMenu.getByRole('group', { name: 'Theme' });
    await appearance.getByRole('button', { name: 'System', exact: true }).click();
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
    }
    await appearance.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
    await profileMenu.getByRole('button', { name: 'Back to profile menu' }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Appearance');
    await page.keyboard.press('Escape');
    assert.equal(await profileTrigger.evaluate(button => document.activeElement === button), true);

    await openProfiles();
    await menuRow('Create Profile').click();
    await walletDialog.getByRole('button', { name: 'Generate 12-Word Recovery Phrase', exact: true }).waitFor();
    assert.equal(await profileMenu.count(), 0);
    await walletDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await openProfiles();
    await menuRow('Import Profile').click();
    await walletDialog.getByLabel('Recovery phrase', { exact: true }).waitFor();
    assert.equal(await profileMenu.count(), 0);
    await walletDialog.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: /^Notifications/ }).click();
    await popup('Notifications').waitFor();
    await page.mouse.click(4, 180);
    await popup('Notifications').waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: 'Open live 5m' }).click();
    assert.equal(new URL(page.url()).pathname, '/market/bchusd-5m-flash');
    await page.locator('.epoch-live[aria-current="time"]').waitFor();
    await desktopSpan();
    await checkLayout();
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, '/');
    await page.getByRole('button', { name: 'Explore markets', exact: true }).click();
    await desktopSpan('.workspace-layout');
    const filters = page.getByRole('group', { name: 'Filter markets' });
    assert.deepEqual(await filters.getByRole('button').allTextContents(), ['All', '1m', '5m', '1h', '24h']);
    const labels = { '1m': /BCH\/USD 1m\b/, '5m': /BCH\/USD (5m\b|5-Minute)/, '1h': /BCH\/USD (1h\b|1-Hour)/, '24h': /BCH\/USD (24h\b|24-Hour)/ };
    for (const [frame, label] of Object.entries(labels)) {
      const filter = filters.getByRole('button', { name: frame, exact: true });
      await filter.click();
      assert.ok((await filter.evaluate(element => {
        const luminance = color => color.match(/\d+/g).slice(0, 3).map(value => +value / 255)
          .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        const style = getComputedStyle(element);
        const [dark, light] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
        return (light + 0.05) / (dark + 0.05);
      })) >= 4.5);
      const markets = page.locator('.market-explorer-card');
      await markets.first().waitFor();
      assert.ok((await markets.allTextContents()).every(text => label.test(text)));
    }
    await checkLayout();
    await selectNav('Settings');
    const settingsHeading = page.getByRole('heading', { name: 'Settings', exact: true });
    assert.ok(await settingsHeading.evaluate(element => element.getBoundingClientRect().top >= document.querySelector('.blaze-banner').getBoundingClientRect().bottom));
    if (width > 768) assert.ok((await page.locator('.settings-page').boundingBox()).width <= 1080);
    await checkLayout();

    await go('/wallet');
    await portfolio.waitFor();
    await go('/batch');
    await batch.waitFor();
    await page.goBack();
    await batch.waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).pathname, '/wallet');
    await page.goForward();
    await batch.waitFor();
    await close('Batch Pay');
    await selectNav('Wallet');
    assert.equal(new URL(page.url()).pathname, '/');

    await portfolio.getByRole('button', { name: 'Existing Profile' }).click();
    await walletDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await walletDialog.locator('.wallet-network-select select').selectOption('mainnet');
    await walletDialog.getByLabel('Watch-only address', { exact: true }).fill(address);
    await walletDialog.getByLabel('Profile name', { exact: true }).fill(watchName);
    await walletDialog.getByLabel('Remember this profile in this browser', { exact: true }).check();
    await walletDialog.getByRole('button', { name: 'Add watch-only profile' }).click();
    await walletDialog.waitFor({ state: 'hidden' });
    await waitCapability('watch');
    const id = await activeId();
    await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) || '[]').some(row => row.id === id), { key: backupKey, id });
    const savedWatch = await storedBackup();

    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Send/ }).click();
    await send.getByLabel('Recipient address').fill(address);
    await send.getByLabel('Send amount').fill('0.0001');
    await send.getByRole('status').filter({ hasText: /watch-only/i }).waitFor();
    assert.equal(await send.getByRole('button', { name: 'Review & Send', exact: true }).isEnabled(), false);
    await send.getByRole('button', { name: 'Enable signing', exact: true }).click();
    const recovery = walletDialog.getByLabel('Recovery phrase', { exact: true });
    const submit = walletDialog.getByRole('button', { name: 'Enable signing', exact: true });
    const remember = walletDialog.getByRole('checkbox', { name: /^Save signing wallet/ });
    assert.equal(await recovery.getAttribute('type'), 'password');
    assert.equal(await remember.isChecked(), false);
    await recovery.fill(`${'abandon '.repeat(23)}art`);
    await submit.click();
    assert.match(await walletDialog.getByRole('alert').innerText(), /does not match/);
    assert.equal(await storedBackup(), savedWatch);
    await recovery.fill(phrase);
    await submit.click();
    await walletDialog.waitFor({ state: 'hidden' });
    assert.equal(await activeId(), id);
    assert.equal(await storedBackup(), savedWatch);
    assert.equal(await send.getByLabel('Send amount').inputValue(), '0.0001');
    assert.equal(await send.getByLabel('Recipient address').inputValue(), address);
    assert.equal(await send.getByRole('button', { name: 'Enable signing', exact: true }).count(), 0);
    await close('Send BCH');
    await waitCapability('signing');
    assert.ok(historyRequests.size >= 2, 'Upgrading the signing wallet syncs receive and change activity');

    await selectNav('Settings');
    await page.getByRole('button', { name: 'Reveal recovery phrase', exact: true }).click();
    await page.locator('.settings-seed').waitFor();
    await openManage();
    assert.match(await watchRow.innerText(), /Session signing/);
    await walletDialog.getByRole('region', { name: `${watchName} profile actions` }).getByRole('button', { name: 'Lock', exact: true }).click();
    assert.match(await watchRow.innerText(), /Watch-only/);
    assert.equal(await page.locator('.settings-seed').count(), 0);
    await walletDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await selectNav('Wallet');
    await waitCapability('watch');
    await page.reload();
    await restore();
    await waitCapability('watch');
    assert.equal(await activeId(), id);

    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Batch Pay/ }).click();
    await batch.getByLabel('Recipient 1 address').fill(address);
    await batch.getByLabel('Recipient 1 amount').fill('0.01');
    await batch.getByLabel('Recipient 1 currency').fill('BCH');
    await batch.getByRole('button', { name: 'Enable signing', exact: true }).click();
    await recovery.fill(phrase);
    await remember.check();
    await submit.click();
    await walletDialog.waitFor({ state: 'hidden' });
    assert.equal(await batch.getByLabel('Recipient 1 amount').inputValue(), '0.01');
    assert.equal(await batch.getByRole('button', { name: 'Enable signing', exact: true }).count(), 0);
    const savedSigning = await storedBackup();
    assert.notEqual(savedSigning, savedWatch);
    assert.ok(!savedSigning.includes(phrase));
    assert.deepEqual(JSON.parse(savedSigning).map(row => row.id), [id]);
    await checkLayout();
    await close('Batch Pay');
    await page.reload();
    await restore();
    await waitCapability('signing');
    assert.equal(await activeId(), id);
    await page.locator('.wallet-action-grid').getByRole('button', { name: /^Receive/ }).click();
    assert.equal(await popup('Receive BCH').locator('code').innerText(), address);
    await close('Receive BCH');
    await selectNav('Settings');
    await page.getByRole('button', { name: 'Chipnet', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.settings-networks button.selected')?.textContent === 'Chipnet');
    assert.equal(await activeId(), id);
    assert.deepEqual(JSON.parse(await storedBackup()).map(profile => profile.id), [id]);
    await selectNav('Wallet');
    await waitCapability('signing');
    assert.match(await page.locator('.wallet-home-network').innerText(), /Chipnet/);
    await selectNav('Settings');
    await page.getByRole('button', { name: 'Enable Sandbox', exact: true }).click();
    await selectNav('Wallet');
    await page.locator('.wallet-home-network[data-wallet-status="paper"]').waitFor();
    assert.equal(await page.locator('.wallet-history-item').count(), 0);
    await selectNav('Settings');
    await page.getByRole('button', { name: 'Exit Sandbox', exact: true }).click();
    await selectNav('Wallet');
    await waitCapability('signing');
    assert.match(await page.locator('.wallet-home-network').innerText(), /Chipnet/);

    await openManage();
    await walletDialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await walletDialog.locator('.wallet-network-select select').selectOption('mainnet');
    await walletDialog.getByLabel('Watch-only address', { exact: true }).fill(address);
    await walletDialog.getByLabel('Profile name', { exact: true }).fill(observerName);
    await walletDialog.getByLabel('Remember this profile in this browser', { exact: true }).uncheck();
    await walletDialog.getByRole('button', { name: 'Add watch-only profile', exact: true }).click();
    await walletDialog.waitFor({ state: 'hidden' });
    const observerId = await activeId();
    assert.ok(observerId && observerId !== id);

    await profileTrigger.click();
    await assertMainMenu(observerName);
    await profileSummary.click();
    assert.equal(await menuRow(/^QA second wallet/).getAttribute('aria-pressed'), 'true');
    await menuRow(/^QA watch wallet/).click();
    await waitCapability('signing');
    assert.equal(await activeId(), id);
    await profileTrigger.click();
    await assertMainMenu(watchName);
    await profileSummary.click();
    assert.equal(await menuRow(/^QA watch wallet/).getAttribute('aria-pressed'), 'true');
    await menuRow(/^QA second wallet/).click();
    assert.equal(await activeId(), observerId);
    assert.equal(await walletName.innerText(), observerName);
    assert.equal(await page.locator('.wallet-home-network').getAttribute('data-wallet-status'), 'watch');

    await openProfiles();
    await menuRow(/Explore Sandbox/).click();
    await page.locator('.wallet-home-network[data-wallet-status="paper"]').waitFor();
    await profileTrigger.click();
    await assertMainMenu('Paper Trading Account');
    await profileSummary.click();
    assert.equal(await menuRow(/^Paper Trading Account/).getAttribute('aria-pressed'), 'true');
    await menuRow(/^QA watch wallet/).click();
    await waitCapability('signing');
    assert.equal(await activeId(), id);
    await checkLayout();
    assert.deepEqual(requestsWithPhrase, []);
    assert.deepEqual(externalScripts, []);
    assert.deepEqual(errors, []);
    console.log(`${width}px ${theme}: main menu order, nested selector, locked wallet restore, wallet switching, and responsive layout passed`);
  } finally {
    await context.close();
  }
}

(async () => {
  const address = await testAddress();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const width of [375, 768, 1280, 1920]) for (const theme of ['light', 'dark']) await checkWalletHome(browser, width, theme, address);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
