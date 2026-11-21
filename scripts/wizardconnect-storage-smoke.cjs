const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { transform } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');

// Native IndexedDB with two browser tabs. All credentials are inert fixture values.
(async () => {
  const source = await readFile(resolve(__dirname, '../packages/frontend/src/services/wizardCredentials.ts'), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context = await browser.newContext();
    const origin = 'http://127.0.0.1:48882';
    await context.route(origin + '/**', route => route.request().url().endsWith('.js')
      ? route.fulfill({ contentType: 'text/javascript', body: code })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([first.goto(origin), second.goto(origin)]);
    const id = 'test-pairing';
    await first.evaluate(async id => {
      const credentials = {
        walletPublicKey: '13'.repeat(32), privateKey: '12'.repeat(32), secret: 'fixture-secret',
        walletName: 'Fixture Wallet', receiveAddress: 'fixture-receive', changeAddress: 'fixture-change',
      };
      const storage = await import('/credentials.js');
      await storage.saveWizardCredentials(id, credentials);
      const saved = await storage.loadWizardCredentials(id);
      if (saved.secret !== credentials.secret || localStorage.length !== 0) throw Error('Unexpected credential storage');
      const row = await new Promise((done, reject) => {
        const db = indexedDB.open('cashingularity.wizard-relay.v1', 1);
        db.onerror = () => reject(db.error);
        db.onsuccess = () => {
          const request = db.result.transaction('pairings').objectStore('pairings').get(id);
          request.onsuccess = () => { done(request.result); db.result.close(); };
        };
      });
      if (row.key.extractable || row.key.algorithm.name !== 'AES-GCM' || 'privateKey' in row || 'secret' in row ||
          !(row.data instanceof ArrayBuffer) || new TextDecoder().decode(row.data).includes(credentials.secret)) throw Error('Expected encrypted pairing');
    }, id);
    await second.evaluate(async id => {
      const storage = await import('/credentials.js');
      const credentials = await storage.loadWizardCredentials(id);
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = async (...args) => {
        await new Promise(resolve => { window.completeEncryption = resolve; });
        return encrypt(...args);
      };
      window.pendingSave = storage.saveWizardCredentials(id, { ...credentials, receiveXpub: 'fixture-new-xpub' }, true)
        .then(() => 'saved', () => 'rejected');
    }, id);
    await second.waitForFunction(() => window.completeEncryption);
    await first.evaluate(async id => (await import('/credentials.js')).forgetWizardCredentials(id), id);
    const save = await second.evaluate(async () => { window.completeEncryption(); return window.pendingSave; });
    assert.deepEqual({
      save,
      profiles: await first.evaluate(async () => (await import('/credentials.js')).listWizardProfiles()),
    }, { save: 'rejected', profiles: [] });
    console.log('Native IndexedDB kept the pairing encrypted and rejected a save completed after a second tab revoked it.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
