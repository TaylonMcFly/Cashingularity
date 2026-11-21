const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const address='bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const activeKey='cashingularity.activeLiveProfileId.v1';
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const results=[];
  try {for(const width of [1440,390]) {
    const context=await browser.newContext({viewport:{width,height:1000}}), page=await context.newPage();
    const errors=[],http=[],checks=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('response',r=>{if(r.status()>=400){http.push(`${r.status()} ${r.url()}`);console.log('HTTP FAILURE',r.status(),r.url());}});
    const popup=name=>page.getByRole('dialog',{name,exact:true});
    const action=name=>page.locator('.wallet-action-grid button').filter({has:page.getByText(name,{exact:true})});
    const close=name=>page.getByRole('button',{name:`Close ${name}`,exact:true}).click();
    const trigger=()=>page.locator('.header-wallet-selector').getByRole('button',{name:'Switch wallet profile',exact:true});
    const selected=()=>page.evaluate(key=>localStorage.getItem(key),activeKey);
    const check=async name=>{const rect=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.equal(rect.width,rect.viewport,`${width} ${name} overflow`);checks.push(name);console.log(`${width}: ${name}`);};
    const waitName=async name=>{await page.waitForFunction(name=>document.querySelector('.header-wallet-selector .profile-switcher-trigger')?.textContent.includes(name),name);};
    const choose=async name=>{await trigger().click();await page.locator('.profile-popover .profile-option').filter({hasText:name}).click();await page.locator('.profile-popover').waitFor({state:'hidden'});await waitName(name);};
    const assertChecked=async name=>{await trigger().click();const options=page.locator('.profile-popover .profile-option[aria-pressed="true"]');assert.equal(await options.count(),1);assert.match(await options.innerText(),new RegExp(name));await trigger().click();};
    const create=async (name,count)=>{await trigger().click();await page.locator('.profile-popover').getByRole('button',{name:/Add profile/}).click();const wallet=popup('Wallet connection');await wallet.getByLabel('Profile name',{exact:true}).fill(name);await wallet.getByRole('button',{name:'Generate 12-Word Recovery Phrase',exact:true}).click();await wallet.getByLabel('I have saved my 12-word phrase',{exact:true}).check();await wallet.getByRole('button',{name:'Confirm & Create Wallet',exact:true}).click();await wallet.waitFor({state:'hidden'});await waitName(name);await page.waitForFunction(count=>JSON.parse(localStorage.getItem('cashingularity.profiles.v1')||'[]').length===count,count);return selected();};
    if(width>768){await page.goto('http://localhost:3000/market');const gap=await page.locator('.wallet-card').evaluate(card=>{const heading=card.querySelector('.wallet-card-heading').getBoundingClientRect(),connect=card.querySelector('.wallet-connect').getBoundingClientRect(),label=card.querySelector('.wallet-label').getBoundingClientRect();return{before:connect.top-heading.bottom,after:label.top-connect.bottom};});assert.ok(gap.before>=14);assert.ok(gap.after>=8);}
    await page.goto('http://localhost:3000/wallet');await page.getByRole('heading',{name:'Welcome to your wallet'}).waitFor();
    await trigger().click();assert.equal(await page.locator('.profile-option[aria-pressed="true"]').count(),0);await trigger().click();await check('unconnected-wallet-spacing-and-selection');
    await action('Send').click();assert.equal(await popup('Send BCH').getByRole('heading',{name:'Send BCH',exact:true}).count(),1);await close('Send BCH');
    await action('Batch Pay').click();const batch=popup('Batch Pay');assert.equal(await batch.getByRole('heading',{name:'Batch Pay',exact:true}).count(),1);
    const review=()=>batch.getByRole('button',{name:/Review & Send Batch/});
    await review().click();assert.equal(await batch.locator('.batch-review-error p').innerText(),'Add at least one recipient (via + Add Row, spreadsheet upload, or Raw Text) before reviewing.');
    const file=batch.getByLabel('Import spreadsheet',{exact:true});assert.equal(await file.evaluate(node=>getComputedStyle(node).clipPath),'inset(50%)');assert.ok((await file.boundingBox()).width<=1);
    const guideButton=batch.getByRole('button',{name:'? Format Guide',exact:true});await guideButton.click();const guide=batch.getByRole('region',{name:'Spreadsheet file format guide',exact:true});await guide.waitFor();assert.equal(await guide.locator('tbody tr').count(),2);assert.deepEqual(await guide.locator('th').allTextContents(),['Address','Amount','Currency','Label']);assert.ok(await guide.evaluate(node=>node.getBoundingClientRect().left>=0&&node.getBoundingClientRect().right<=innerWidth));await check('one-heading-hidden-file-input-format-guide');await page.screenshot({path:`batch-format-guide-${width}.png`,fullPage:false});await page.keyboard.press('Escape');await guide.waitFor({state:'hidden'});assert.equal(await batch.isVisible(),true);
    await batch.getByRole('button',{name:'Clear All',exact:true}).click();await review().click();assert.match(await batch.locator('.batch-review-error').innerText(),/Add at least one recipient/);
    await batch.getByRole('button',{name:'Add Row',exact:true}).click();await batch.getByLabel('Recipient 1 address',{exact:true}).fill('bitcoincash:invalid');await review().click();assert.match(await batch.locator('.batch-review-error').innerText(),/Fix the highlighted recipient row errors before reviewing/);assert.equal(await batch.locator('.payroll-row.invalid').count(),1);
    await batch.getByLabel('Recipient 1 address',{exact:true}).fill(address);await batch.getByLabel('Recipient 1 amount',{exact:true}).fill('0.01');await batch.getByLabel('Recipient 1 currency',{exact:true}).fill('USD or BCH');await review().click();assert.match(await batch.locator('.batch-review-error').innerText(),/Fix the highlighted/);
    await batch.getByLabel('Recipient 1 currency',{exact:true}).fill('BCH');await review().click();assert.match(await batch.locator('.batch-review-error').innerText(),/Connect or select a wallet before reviewing an on-chain batch transfer/);await check('explicit-empty-invalid-and-disconnected-batch-errors');
    await batch.getByRole('button',{name:'Connect or select wallet',exact:true}).click();await popup('Wallet connection').waitFor();await page.keyboard.press('Escape');await popup('Wallet connection').waitFor({state:'hidden'});assert.equal(await batch.isVisible(),true);assert.equal(await batch.getByLabel('Recipient 1 amount',{exact:true}).inputValue(),'0.01');await close('Batch Pay');
    const first=await create('test-01',1), second=await create('test-02',2);assert.notEqual(first,second);await assertChecked('test-02');assert.match(await page.locator('.wallet-home-profile').innerText(),/test-02/);
    await choose('test-01');assert.equal(await selected(),first);await assertChecked('test-01');
    await page.locator('.blaze-banner').getByRole('button',{name:'Enter Paper Trading',exact:true}).click();await waitName('Paper Trading Account');assert.equal(await selected(),first);await assertChecked('Paper Trading Account');
    await page.locator('.blaze-banner').getByRole('button',{name:'Exit Paper Trading',exact:true}).click();await waitName('test-01');assert.equal(await selected(),first);await assertChecked('test-01');await check('live-profile-name-checkmark-and-mode-round-trip');
    await page.reload();await waitName('test-01');assert.equal(await selected(),first);await assertChecked('test-01');
    await choose('test-02');assert.equal(await selected(),second);await page.reload();await waitName('test-02');assert.equal(await selected(),second);await assertChecked('test-02');assert.match(await page.locator('.wallet-home-profile').innerText(),/test-02/);
    await page.locator('.blaze-banner').getByRole('button',{name:'Enter Paper Trading',exact:true}).click();await waitName('Paper Trading Account');await choose('test-01');assert.equal(await selected(),first);assert.equal(await page.locator('.blaze-banner').getByRole('button',{name:'Enter Paper Trading',exact:true}).count(),1);await assertChecked('test-01');await check('preferred-live-profile-restored-after-reloads-and-paper-selection');
    assert.deepEqual(errors,[],`${width} console/page errors`);assert.deepEqual(http,[],`${width} HTTP failures`);results.push({width,checks,consoleErrors:errors.length,httpErrors:http.length});await context.close();
  }}finally{await browser.close();}
  fs.writeFileSync('profile-batch-ux-smoke-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
