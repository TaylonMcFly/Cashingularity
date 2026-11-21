const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const {waitForLocalOverviewPlot}=require('./local-overview-smoke-helper.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];
 try{for(const width of [1440,390])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:1000}});
  await context.addInitScript(theme=>localStorage.setItem('cashingularity.theme.v1',theme),theme);
  // No funds or broadcasting: these routes are browser fixtures only.
  await context.route('**/api/chain/utxos?**',route=>route.fulfill({json:{source:'qa-fixture',utxos:[]}}));
  let broadcasts=0;await context.route('**/api/**broadcast',route=>{broadcasts++;return route.abort()});
  const page=await context.newPage(),errors=[],http=[],externalScripts=[],tradingViewRequests=[],authRequests=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  page.on('response',r=>{if(r.status()>=400)http.push(`${r.status()} ${r.url()}`)});
  page.on('request',r=>{
   if(/(^|\.)tradingview\.com$/.test(new URL(r.url()).hostname))tradingViewRequests.push(r.url());
   if(r.resourceType()==='script'&&r.frame()===page.mainFrame()&&new URL(r.url()).origin!=='http://localhost:3000')externalScripts.push(r.url());
   if(/\/api\/auth\/(register|login)/.test(r.url()))authRequests.push(r.url());
  });
  const check=async name=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflow`);checks.push(name);console.log(`${width} ${theme}: ${name}`)};
  const wallet=()=>page.getByRole('dialog',{name:'Wallet connection',exact:true});
  const confirmation=()=>page.getByRole('dialog',{name:'Transaction confirmation',exact:true});
  const stake=()=>page.locator('.outcome-ticket').getByRole('button',{name:'Review & Place Stake',exact:true});
  await page.goto('http://localhost:3000/market/bchusd-5m-flash');await waitForLocalOverviewPlot(page,theme);
  for(const [label,limit]of[['1M',31],['3M',91],['1Y',200],['5Y',200],['All',200],['1D',25]]){
   const response=page.waitForResponse(r=>r.url().includes(`/api/markets/candles?interval=${label==='1D'?'1h':'1d'}&limit=${limit}`));
   await page.getByRole('group',{name:'Overview price range'}).getByRole('button',{name:label,exact:true}).click();await response;await waitForLocalOverviewPlot(page,theme);
  }
  await check('all-local-overview-ranges-painted-without-tradingview-requests');
  await stake().click();await wallet().waitFor();assert.equal(await page.getByText('Already have an account',{exact:true}).count(),0);await check('disconnected-stake-opens-wallet-selection-only');
  await wallet().getByRole('button',{name:'Create',exact:true}).click();await wallet().getByLabel('Profile name',{exact:true}).fill('QA local wallet');await wallet().getByRole('button',{name:'Generate 12-Word Recovery Phrase',exact:true}).click();await wallet().getByLabel('I have saved my 12-word phrase',{exact:true}).check();await wallet().getByRole('button',{name:'Confirm & Create Wallet',exact:true}).click();await wallet().waitFor({state:'hidden'});
  await stake().click();await confirmation().waitFor();assert.match(await confirmation().innerText(),/Insufficient On-Chain Balance/);assert.equal(authRequests.length,0);assert.equal(await page.getByRole('dialog',{name:'Verify account security',exact:true}).count(),0);await page.getByRole('button',{name:'Close confirmation',exact:true}).click();await check('active-wallet-reviews-with-funding-feedback-and-no-account-registration');
  await page.locator('.blaze-banner').getByRole('button',{name:'Enter Paper Trading',exact:true}).click();await stake().click();await confirmation().getByRole('button',{name:'Confirm Paper Preview',exact:true}).waitFor();assert.equal(authRequests.length,0);await page.getByRole('button',{name:'Close confirmation',exact:true}).click();await check('paper-stake-reviews-without-account');
  await page.locator('.blaze-banner').getByRole('button',{name:'Exit Paper Trading',exact:true}).click();
  if(width>768)await page.locator('.primary-navigation').getByRole('link',{name:'Settings',exact:true}).click();else await page.locator('.mobile-bottom-nav').getByRole('button',{name:'Settings',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.settings-page .security-form button.btn-primary')?.disabled===false,{},{timeout:30000});
  const frame=page.frames().find(f=>new URL(f.url()||'about:blank').pathname==='/verification-frame.html');assert.ok(frame);assert.equal(new URL(frame.url()).origin,'http://127.0.0.1:3001');
  const isolation=await frame.evaluate(()=>{let dom=false,storage=false;try{void parent.document.body;dom=true}catch{}try{void parent.localStorage.length;storage=true}catch{}return {dom,storage}});assert.deepEqual(isolation,{dom:false,storage:false});
  assert.equal(await page.locator('iframe[title="Isolated bot verification"]').getAttribute('sandbox'),'allow-scripts allow-same-origin');assert.equal(await page.evaluate(()=>typeof window.turnstile),'undefined');
  const frameResponse=await page.request.get(frame.url());assert.match(frameResponse.headers()['content-security-policy'],/frame-ancestors http:\/\/localhost:3000/);assert.match(frameResponse.headers()['content-security-policy'],/connect-src https:\/\/challenges.cloudflare.com/);
  await page.screenshot({path:`isolated-security-${theme}-${width}.png`,fullPage:false});await check('real-turnstile-token-from-separated-origin-with-wallet-dom-and-storage-inaccessible');
  assert.deepEqual(externalScripts,[]);assert.deepEqual(tradingViewRequests,[]);assert.deepEqual(errors,[]);assert.deepEqual(http,[]);assert.equal(broadcasts,0);
  results.push({width,theme,checks,externalWalletScripts:externalScripts.length,tradingViewRequests:tradingViewRequests.length,consoleErrors:errors.length,httpErrors:http.length});await context.close();
 }}finally{await browser.close()}
 fs.writeFileSync('local-chart-session-smoke-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
