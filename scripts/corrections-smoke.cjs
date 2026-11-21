const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const { zipSync, strToU8 } = require('fflate');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const xlsx = Buffer.from(zipSync(Object.fromEntries(Object.entries({
  'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Payroll" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${[['Address','Amount','Currency'],[address,'25','pusd'],[address,'0.01','BCH']].map((cells,i)=>`<row r="${i+1}">${cells.map((cell,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
}).map(([name, text]) => [name, strToU8(text)]))));
const dappHtml = `<!doctype html><title>QA browser dApp</title><p>Real browser handshake fixture</p><script>
addEventListener('message', event => { if (event.data?.type !== 'CASHINGULARITY_WALLET_HELLO') return;
 const channel = new MessageChannel(); window.sessionPort = channel.port1;
 channel.port1.onmessage = message => { if (message.data?.type === 'CASHINGULARITY_CONNECTED') { window.connected = message.data; channel.port1.postMessage({id:1, method:'bch_getAddresses'}); } else if(message.data?.type === 'CASHINGULARITY_PING') channel.port1.postMessage({type:'CASHINGULARITY_PONG'}); else window.response = message.data; };
 channel.port1.start(); parent.postMessage({...event.data, type:'CASHINGULARITY_CONNECT'}, event.origin, [channel.port2]);
});</script>`;
(async () => {
  const { totp } = await import(pathToFileURL(path.resolve('packages/backend/dist/authService.js')).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const results = [];
  try { for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route('https://silent.qa.invalid/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Silent dApp fixture</title><p>No handshake available.</p>'}));
    await context.route('https://dapp.qa.invalid/**', route => route.fulfill({ contentType: 'text/html', body: dappHtml }));
    const page = await context.newPage(), errors = [], http = [], checks = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) { http.push(`${response.status()} ${response.url()}`); console.log('HTTP FAILURE',response.status(),response.url()); } });
    const popup = name => page.getByRole('dialog', { name, exact: true });
    const action = name => page.locator('.wallet-action-grid button').filter({ has: page.getByText(name, { exact: true }) });
    const close = name => page.getByRole('button', { name: `Close ${name}`, exact: true }).click();
    const check = async name => { await page.waitForTimeout(150); const layout = await page.evaluate(() => ({ viewport:innerWidth, scroll:document.documentElement.scrollWidth, sticky:getComputedStyle(document.querySelector('.blaze-banner')).position })); assert.equal(layout.scroll, layout.viewport, `${width} ${name}: overflow`); assert.equal(layout.sticky, 'sticky'); checks.push(name); console.log(`${width}: ${name}`); };
    const nav = async (name, url) => { if (width > 768) await page.locator('.primary-navigation').getByRole('link', { name, exact:true }).click(); else await page.locator('.mobile-bottom-nav').getByRole('button', { name, exact:true }).click(); await page.waitForURL(current => current.pathname === (name === 'Wallet' ? '/' : url)); };
    await page.goto('http://localhost:3000/wallet');
    await page.getByRole('heading', {name:'Welcome to your wallet'}).waitFor();
    assert.equal(await page.locator('.primary-navigation a').count(),3); assert.equal(await page.locator('.mobile-nav-item').count(),3); assert.equal(await page.locator('.header-connect').count(),0); assert.equal(await page.locator('.rabby-wallet-sidebar').count(),0); assert.equal(await page.locator('.wallet-portfolio-hero .wallet-connect').count(),1); assert.equal((await page.request.get('http://localhost:3000/api/news')).status(),404);
    assert.ok((await page.getByRole('heading', {name:'Welcome to your wallet'}).evaluate(node=>getComputedStyle(node).fontFamily)).includes('Orbitron'));
    await action('Send').click(); const send = popup('Send BCH');
    assert.deepEqual(await send.getByLabel('Send asset', {exact:true}).locator('option').allTextContents(), ['BCH']);
    assert.equal(await send.getByRole('button', {name:'Review & Send',exact:true}).isDisabled(), true);
    assert.match(await send.innerText(), /Wallet balance unavailable/);
    await check('native-assets-only-zero-balance'); await close('Send BCH');
    await page.locator('.blaze-banner').getByRole('button', {name:'Enter Paper Trading',exact:true}).click();
    await page.getByLabel('Virtual balance in BCH', {exact:true}).fill('123.45678901');
    await page.getByRole('button', {name:'Set Virtual Balance',exact:true}).click();
    await action('Send').click(); await send.getByLabel('Recipient address', {exact:true}).fill(address); await send.getByLabel('Send amount', {exact:true}).fill('0.01');
    await send.getByRole('button', {name:'Review Paper Transfer',exact:true}).click();
    await popup('Transaction confirmation').getByRole('button', {name:'Confirm Paper Preview',exact:true}).click();
    await popup('Transaction confirmation').getByText('Paper Preview Complete',{exact:true}).waitFor();
    await page.getByRole('button', {name:'Close confirmation',exact:true}).click(); await close('Send BCH');
    await check('custom-paper-balance-transfer');
    await page.getByLabel('Virtual balance in BCH',{exact:true}).fill('9999999999999999999999999999.12345678'); await page.getByRole('button',{name:'Set Virtual Balance',exact:true}).click();
    assert.equal(await page.locator('.wallet-portfolio-hero').evaluate(node=>node.getBoundingClientRect().right<=innerWidth),true); assert.equal(await page.locator('.wallet-assets-panel').evaluate(node=>node.getBoundingClientRect().right<=innerWidth),true); await check('large-virtual-balance-layout');
    await page.getByLabel('Virtual balance in BCH', {exact:true}).fill('0'); await page.getByRole('button', {name:'Set Virtual Balance',exact:true}).click();
    await action('Send').click(); assert.equal(await send.getByRole('button',{name:'Review Paper Transfer',exact:true}).isDisabled(),true); await close('Send BCH');
    await page.locator('.blaze-banner').getByRole('button', {name:'Exit Paper Trading',exact:true}).click();
    await action('Batch Pay').click(); const batch = popup('Batch Pay');
    assert.equal(await batch.locator('.payroll-row').count(),4);
    for(let n=4;n>1;n--) await batch.getByRole('button',{name:`Remove recipient ${n}`,exact:true}).click();
    assert.equal(await batch.locator('.payroll-row').count(),1);
    assert.equal(await batch.locator('.payroll-row-actions button').count(),1); await batch.getByLabel('Recipient 1 address',{exact:true}).fill(address); await batch.getByLabel('Recipient 1 amount',{exact:true}).fill('25'); await batch.getByLabel('Recipient 1 currency',{exact:true}).fill('pusd');
    assert.match(await batch.locator('.confirmed-currency').innerText(),/Confirmed: Parity USD/); assert.match(await batch.locator('textarea').inputValue(),/25 pusd/);
    await batch.getByRole('button',{name:'Clear All',exact:true}).click(); assert.equal(await batch.locator('.payroll-row').count(),0);
    await batch.getByRole('button',{name:'Add Row',exact:true}).click(); await batch.getByLabel('Recipient 1 currency',{exact:true}).fill('XYZ'); assert.match(await batch.locator('.confirmed-currency').innerText(),/needs confirmation/);
    await batch.locator('summary').click(); await batch.getByLabel('Raw Text / Bulk Edit',{exact:true}).fill(`${address} | 50 usdt\n${address} | 0.02 BCH`); assert.equal(await batch.locator('.payroll-row').count(),2);
    assert.equal(await batch.getByLabel('Recipient 1 currency',{exact:true}).inputValue(),'USDT');
    await batch.getByLabel('Recipient 2 amount',{exact:true}).fill('0.03'); assert.match(await batch.locator('textarea').inputValue(),/0.03 BCH/);
    await check('removable-typed-currency-two-way-sync');
    await batch.locator('.spreadsheet-dropzone').evaluate((node, encoded) => { const data=new DataTransfer(); const bytes=Uint8Array.from(atob(encoded), char=>char.charCodeAt(0)); data.items.add(new File([bytes],'payroll.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})); node.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data})); }, xlsx.toString('base64'));
    await batch.getByText('Imported 2 recipients from payroll.xlsx.',{exact:true}).waitFor(); assert.equal(await batch.getByLabel('Recipient 1 currency',{exact:true}).inputValue(),'pusd');
    await batch.getByLabel('Import spreadsheet',{exact:true}).setInputFiles({name:'payroll.csv',mimeType:'text/csv',buffer:Buffer.from(`Address,Amount,Currency,Label\n${address},"1,250.50",USD,"Team, A"\n${address},75,KZT,Team B`)});
    await batch.getByText('Imported 2 recipients from payroll.csv.',{exact:true}).waitFor(); assert.equal(await batch.getByLabel('Recipient 1 amount',{exact:true}).inputValue(),'1,250.50');
    await batch.getByLabel('Import spreadsheet',{exact:true}).setInputFiles({name:'payroll.tsv',mimeType:'text/tab-separated-values',buffer:Buffer.from(`Address\tAmount\tCurrency\n${address}\t75\tRUB`)});
    await batch.getByText('Imported 1 recipients from payroll.tsv.',{exact:true}).waitFor();
    await check('xlsx-drag-drop-csv-tsv'); await close('Batch Pay'); await action('Batch Pay').click(); assert.equal(await batch.getByLabel('Recipient 1 currency',{exact:true}).inputValue(),'RUB'); await close('Batch Pay');
    await nav('Settings','/settings'); assert.equal(await page.locator('.rabby-wallet-sidebar').count(),0); const main = page.locator('main'); assert.match(await main.locator('.connected-app-list').innerText(),/0 connected apps/); assert.equal(await main.getByText('Polymarket',{exact:true}).count(),0);
    await page.locator('.header-wallet-selector').getByRole('button',{name:'Switch wallet profile',exact:true}).click(); await page.locator('.profile-popover').getByRole('button',{name:/Add profile/}).click();
    await popup('Wallet connection').getByLabel('Profile name',{exact:true}).fill('First-test'); await page.keyboard.press('Escape'); await popup('Wallet connection').waitFor({state:'hidden'}); await page.locator('.header-wallet-selector').getByRole('button',{name:'Switch wallet profile',exact:true}).click(); await page.locator('.profile-popover').getByRole('button',{name:/Add profile/}).click(); await popup('Wallet connection').getByLabel('Profile name',{exact:true}).fill('First-test'); await popup('Wallet connection').getByRole('button',{name:'Generate 12-Word Recovery Phrase',exact:true}).click(); await page.getByLabel('I have saved my 12-word phrase',{exact:true}).check(); await page.getByRole('button',{name:'Confirm & Create Wallet',exact:true}).click(); await popup('Wallet connection').waitFor({state:'hidden'}); await nav('Wallet','/wallet'); assert.match(await page.locator('.wallet-home-profile').innerText(),/First-test/); await nav('Settings','/settings'); if(await page.locator('.wallet-toast').count()) assert.ok(await page.locator('.wallet-toast').evaluate(n=>n.getBoundingClientRect().top>=72));
    await main.getByRole('button',{name:'Connect dApp / Paste Pairing Code',exact:true}).click(); await popup('Connect dApp').getByLabel('dApp connection input',{exact:true}).fill('https://dapp.qa.invalid/'); await popup('Connect dApp').getByRole('button',{name:'Continue →',exact:true}).click();
    const approve = popup('Approve dApp connection').getByRole('button',{name:'Approve',exact:true}); await approve.waitFor(); await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Approve'&&!b.disabled)); await approve.click();
    await main.getByText('Active session',{exact:true}).waitFor();
    const frame = page.frames().find(frame=>frame.url().startsWith('https://dapp.qa.invalid/')); await frame.waitForFunction(()=>window.response?.result?.[0]?.startsWith('bitcoincash:'));
    await main.getByRole('button',{name:'Details',exact:true}).click(); assert.match(await popup('Application connection details').innerText(),/No transaction signing/); await close('Application connection details');
    await main.getByRole('button',{name:'Disconnect',exact:true}).click(); assert.match(await main.locator('.connected-app-list').innerText(),/0 connected apps/); await check('real-browser-handshake-disconnect');
    await main.getByRole('button',{name:'Connect dApp / Paste Pairing Code',exact:true}).click(); await popup('Connect dApp').getByLabel('dApp connection input',{exact:true}).fill('https://silent.qa.invalid/'); await popup('Connect dApp').getByRole('button',{name:'Continue →',exact:true}).click(); await popup('Application connection timed out').waitFor({timeout:15000}); assert.match(await popup('Application connection timed out').innerText(),/within 10 seconds/); await close('Application connection timed out'); assert.match(await main.locator('.connected-app-list').innerText(),/0 connected apps/); await check('dapp-handshake-timeout');
    // Exercise real persisted password/TOTP on desktop; mobile checks the same layout.
    if(width===1440 || width===390) {
      const password='QA-local-test-password-456', username=`qa-${Date.now()}`;
      await main.getByLabel('Security account name',{exact:true}).fill(username); await main.getByLabel('Security account password',{exact:true}).fill(password); await main.getByRole('button',{name:'Continue →',exact:true}).click(); await popup('Set up Authenticator').waitFor();
      assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('cashingularity.profiles.v1.device-key.'))),false);
      let auth=popup('Verify account security');
      await popup('Set up Authenticator').getByText('Manual setup key',{exact:true}).click(); const secret=await popup('Set up Authenticator').locator('details code').innerText(); assert.match(secret,/^[A-Z2-7]{32}$/); assert.ok(await popup('Set up Authenticator').locator('.qr-box svg').count());
      await popup('Set up Authenticator').getByLabel('Protection authenticator code',{exact:true}).fill(totp(secret,Date.now()-30000)); await popup('Set up Authenticator').getByRole('button',{name:'Verify & enable Authenticator',exact:true}).click(); await main.getByText(/Authenticator enabled/).waitFor();
      await main.getByRole('button',{name:'Reveal recovery phrase',exact:true}).click(); await auth.getByLabel('Account authorization password',{exact:true}).fill(password); await auth.getByRole('button',{name:'Continue →',exact:true}).click(); await auth.getByLabel('Account authorization code',{exact:true}).fill(totp(secret)); await auth.getByRole('button',{name:'Verify & continue',exact:true}).click(); await main.locator('.settings-seed').waitFor(); assert.equal(await main.locator('.settings-seed>div').count(),12); await main.getByRole('button',{name:'Hide recovery phrase',exact:true}).click();
      await check('database-password-rfc6238-enrollment-reveal');
      // Mock funding only in this browser. Never submit a signed transaction to a node.
      const category='ab'.repeat(32), seen=new Map(); let broadcastAttempts=0;
      const fundingRoute=async route=>{const addr=new URL(route.request().url()).searchParams.get('address'); if(!seen.has(addr)) seen.set(addr,seen.size+1);const id=seen.get(addr).toString(16).padStart(64,'0');await route.fulfill({json:{source:'qa-fixture',utxos:[{txid:id,vout:1,satoshis:'100000000'},{txid:id,vout:2,satoshis:'1000',token:{categoryId:category,amount:'1000'}}]}});};
      const metadataRoute=route=>route.fulfill({json:{categoryId:category,name:'QA held token',symbol:'QAT',decimals:2,isVerified:false}});
      const broadcastRoute=route=>{
        broadcastAttempts++;
        const {createHash}=require('node:crypto');const raw=Buffer.from(route.request().postDataJSON().rawTxHex,'hex');
        const txid=createHash('sha256').update(createHash('sha256').update(raw).digest()).digest().reverse().toString('hex');
        return route.fulfill({json:{txid}}); // Browser-only receipt; never reaches a real node.
      };
      await context.route('**/api/chain/utxos?**',fundingRoute); await context.route(`**/api/bcmr/${category}`,metadataRoute); await context.route('**/api/chain/broadcast',broadcastRoute);
      await nav('Wallet','/wallet'); await page.locator('.blaze-banner').getByRole('button',{name:'Enter Paper Trading',exact:true}).click(); await page.locator('.blaze-banner').getByRole('button',{name:'Exit Paper Trading',exact:true}).click();
      await action('Send').click(); await send.getByLabel('Send asset',{exact:true}).locator('option').filter({hasText:'QAT'}).waitFor({state:'attached'}); assert.deepEqual(await send.getByLabel('Send asset',{exact:true}).locator('option').allTextContents(),['BCH','QAT']);
      // A verified unlock lasts for this wallet session, including after the old 30-second limit.
      await page.evaluate(()=>{window.qaOriginalNow=Date.now;Date.now=()=>window.qaOriginalNow()+31000;});
      await send.getByLabel('Send amount',{exact:true}).fill('0.01'); await send.getByRole('button',{name:'Review & Send',exact:true}).click();
      await popup('Transaction confirmation').getByRole('button',{name:'Sign & Broadcast',exact:true}).click();
      await popup('Transaction confirmation').getByText('Transaction broadcast',{exact:true}).waitFor();
      assert.equal(await auth.count(),0);assert.equal(broadcastAttempts,1);
      await page.evaluate(()=>{Date.now=window.qaOriginalNow;delete window.qaOriginalNow;});
      await page.getByRole('button',{name:'Close confirmation',exact:true}).click();
      await send.getByLabel('Send asset',{exact:true}).selectOption(category); await send.getByLabel('Send amount',{exact:true}).fill('1.25'); await send.getByRole('button',{name:'Review & Send',exact:true}).click(); assert.match(await popup('Transaction confirmation').innerText(),/Transfer 1.25 QAT/); await page.getByRole('button',{name:'Close confirmation',exact:true}).click(); await close('Send BCH'); assert.equal(broadcastAttempts,1);
      await context.unroute('**/api/chain/utxos?**',fundingRoute); await context.unroute(`**/api/bcmr/${category}`,metadataRoute); await context.unroute('**/api/chain/broadcast',broadcastRoute); await nav('Settings','/settings');
      await check('held-token-assets-and-session-unlocked-local-signature');
      await main.getByRole('button',{name:'Log out & lock session',exact:true}).click(); await page.locator('.header-wallet-selector').getByRole('button',{name:'Switch wallet profile',exact:true}).click(); await page.getByPlaceholder('Profile password',{exact:true}).fill(password); await page.locator('.profile-popover').getByRole('button',{name:'Unlock',exact:true}).click();
      await auth.getByRole('button',{name:'Continue →',exact:true}).click(); await auth.getByLabel('Account authorization code',{exact:true}).fill(totp(secret,Date.now()+30000)); await auth.getByRole('button',{name:'Verify & continue',exact:true}).click(); await auth.waitFor({state:'hidden'}); await page.locator('.profile-popover').waitFor({state:'hidden'}); assert.match(await page.locator('.profile-switcher-trigger').innerText(),/First-test/); await check('totp-encrypted-profile-unlock');
      await page.reload(); await page.locator('.header-wallet-selector').getByRole('button',{name:'Switch wallet profile',exact:true}).click(); assert.equal(await page.getByPlaceholder('Profile password',{exact:true}).count(),1); assert.equal(await page.locator('.profile-option').count(),1); await check('protected-profile-remains-locked-on-reload'); await page.getByRole('button',{name:'Switch wallet profile',exact:true}).click();
    }
    await nav('Markets','/market'); await page.locator('.market-explorer-card').first().click(); await page.waitForURL('**/market/*');
    for(const [label,seconds] of [['1m',60],['5m',300],['1h',3600],['24h',86400],['Custom',300]]) {
      const button=page.getByRole('button',{name:label,exact:true}); await button.click(); await page.waitForFunction(seconds=>document.querySelector('.epoch-section')?.getAttribute('data-duration')===String(seconds),seconds); await page.waitForFunction(()=>Array.from(document.querySelectorAll('.epoch-pill')).length>0);
      const expiries=await page.locator('.epoch-result-pill').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.expiry))); for(let i=1;i<expiries.length;i++) { assert.ok(expiries[i-1]>expiries[i]); assert.equal((expiries[i-1]-expiries[i])%(seconds*1000),0); } assert.ok(expiries.length<=8);
      await page.getByRole('button',{name:'View all resolutions',exact:true}).click(); const history=popup('BCH/USD Resolution History'); await history.waitFor(); assert.doesNotMatch(await history.innerText(),/Upcoming|Pending close/); assert.doesNotMatch(await history.locator('.portfolio-note').first().innerText(),/in the last 7 days/); assert.equal(await history.locator('.resolution-action').count(),await history.locator('.resolution-row').count()); assert.ok((await history.locator('.epoch-direction').allTextContents()).every(text=>/^(UP|DOWN|FLAT) /.test(text))); await close('BCH/USD Resolution History');
    }
    await check('all-epoch-steps-resolved-only-history');
    await nav('Settings','/settings'); assert.equal(await page.getByRole('heading',{name:'Settings',exact:true}).evaluate(node=>node.getBoundingClientRect().top>=document.querySelector('.blaze-banner').getBoundingClientRect().bottom),true); await check('settings-heading-not-clipped');
    await nav('Wallet','/wallet'); await page.screenshot({path:`corrections-wallet-${width}.png`,fullPage:true}); await check('wallet-final');
    assert.deepEqual(errors,[],`${width}: console/page errors`); assert.deepEqual(http,[],`${width}: HTTP errors`); results.push({width,checks,consoleErrors:errors.length,httpErrors:http.length}); await context.close();
  }} finally { await browser.close(); }
  fs.writeFileSync('corrections-smoke-results.json',JSON.stringify(results,null,2)); console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
