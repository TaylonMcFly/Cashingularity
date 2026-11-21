const {waitForLocalOverviewPlot}=require('./local-overview-smoke-helper.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');

async function checkRollover(browser) {
 const origin = 'http://localhost:3000';
 const context = await browser.newContext();
 try {
  const page = await context.newPage();
  const data = await (await page.request.get(`${origin}/api/markets`)).json();
  const sample = data.markets.find(market => market.epochSeriesId === 'bchusd-5m' && market.status === 'OPEN' && !market.isFutureSlot);
  assert.ok(sample);
  const start = Date.now();
  const expiry = start + 45_000;
  const base = { ...sample, status: 'OPEN', isHistoricalSlot: false, isFutureSlot: false, isCurrentSlot: true };
  const active = { ...base, createdAtMs: expiry - 300_000, expiryTimestampMs: expiry, title: 'Current BCH/USD round' };
  const upcoming = { ...base, marketId: active.marketId + 5, title: 'Next BCH/USD round', createdAtMs: expiry, expiryTimestampMs: expiry + 300_000 };
  const report = { ...base, marketId: active.marketId + 6, status: 'RESOLVED', isHistoricalSlot: true, isCurrentSlot: false,
   expiryTimestampMs: active.createdAtMs, createdAtMs: active.createdAtMs - 300_000, resolutionPriceCents: active.strikePriceCents };
  let nextReady = false;
  await page.route(`${origin}/api/markets`, route => route.fulfill({ json: { ...data, markets: [active, report,
   nextReady ? upcoming : { ...upcoming, isFutureSlot: true, isCurrentSlot: false }] } }));
  const ratesUrl = `${origin}/api/rates?horizonSeconds=300`;
  const rates = await (await page.request.get(ratesUrl)).json();
  await page.route(ratesUrl, route => route.fulfill({ json: { ...rates, tick: {
   ...rates.tick, source: 'live', spotSource: 'binance', bchUsdPrice: active.strikePriceCents / 100, spotFetchedAtMs: start,
  } } }));
  await page.clock.install({ time: new Date(start) });
  await page.goto(`${origin}/market/bchusd-5m-flash`);
  await page.locator('.epoch-result-pill').getByText('FLAT', { exact: false }).first().click();
  const details = page.getByRole('region', { name: 'Selected epoch result' });
  await details.getByText('Reported close', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Enter Paper Trading', exact: true }).click();
  await page.getByRole('button', { name: /Review & Place Stake/ }).click();
  const confirmation = page.getByRole('dialog', { name: 'Transaction confirmation' });
  await confirmation.waitFor();
  await page.clock.fastForward(expiry - await page.evaluate(() => Date.now()) + 1500);
  await confirmation.waitFor({ state: 'hidden' });
  await page.getByText('Waiting for an open round in this market.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Review & Place Stake/ }).count(), 0);
  assert.equal(await details.isVisible(), true);
  nextReady = true;
  await page.clock.fastForward(5_000);
  await page.getByRole('heading', { name: 'Next BCH/USD round', exact: true }).waitFor();
  assert.equal(await details.isVisible(), true);
  assert.equal(await page.locator('.paper-position').count(), 0);
  console.log('Paper stake review closes at expiry and waits for a confirmed live round');
 } finally {
  await context.close();
 }
}

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];
 try{for(const width of [1440,390])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:1000}});
  await context.addInitScript(theme=>localStorage.setItem('cashingularity.theme.v1',theme),theme);
  const page=await context.newPage(),errors=[],http=[],scriptRequests=[],archiveRequests=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)http.push(`${r.status()} ${r.url()}`)});
  page.on('request', request => {
   if (request.resourceType() === 'script' && new URL(request.url()).origin !== 'http://localhost:3000') scriptRequests.push(request.url());
   if (new URL(request.url()).searchParams.get('extended') === 'true') archiveRequests.push(request.url());
  });
  const check=async name=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width} ${theme} overflow: ${name}`);checks.push(name);console.log(`${width} ${theme}: ${name}`)};
  const curve=async()=>{
   // Capture the bounds and pixels from the same render. A round can expire
   // and replace the chart between separate browser calls.
   await page.waitForFunction(theme => {
    const card = document.querySelector('.spot-target-card');
    const host = card?.querySelector('.spot-target-canvas');
    const canvas = host?.querySelector('canvas');
    if (!canvas?.width || !canvas.height || Number(host.dataset.pointCount) < 2) return false;
    const plot = host.getBoundingClientRect(), box = card.getBoundingClientRect();
    if (plot.left < box.left || plot.right > box.right || plot.width <= box.width * .95) return false;
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const accent = theme === 'dark' ? [242, 193, 78] : [154, 104, 10];
    let matching = 0;
    for (let i = 0; i < data.length; i += 4) {
     if (data[i + 3] > 200 && accent.every((channel, index) => Math.abs(data[i + index] - channel) < 12) && ++matching > 10) return true;
    }
    return false;
   }, theme);
   assert.equal(await page.locator('.spot-target-canvas a[href*="tradingview.com"]').count(),0);
  };
  await page.goto('http://localhost:3000/market/bchusd-5m-flash');await page.locator('.epoch-pill.active').filter({hasText:'Live'}).waitFor();await curve();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);
  assert.equal(await page.locator('.header-links').count(),0);assert.equal(await page.locator('.blaze-banner').getByText(/Pitch Deck|GitHub|Copy Donate Addr/).count(),0);
  const clipped=await page.locator('.blaze-banner').evaluate(header=>[...header.querySelectorAll('button,a,img')].filter(e=>e.getClientRects().length).some(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth}));assert.equal(clipped,false);
  if(width>768){assert.equal(await page.locator('.header-market-group .ticker').isVisible(),true);const alignment=await page.locator('.blaze-banner').evaluate(h=>{const a=h.querySelector('.header-account').getBoundingClientRect(),l=h.querySelector('.header-market-group').getBoundingClientRect();return{gap:a.left-l.right,right:innerWidth-a.right,padding:parseFloat(getComputedStyle(h).paddingRight)}});assert.ok(alignment.gap>0);assert.ok(Math.abs(alignment.right-alignment.padding)<1);}
  await check('compact-header-and-default-live-epoch');
  assert.equal(await page.locator('.local-symbol-overview').getByRole('heading',{name:'Bitcoin Cash / U.S. Dollar'}).count(),1);
  assert.deepEqual(await page.getByRole('group',{name:'Overview price range'}).getByRole('button').allTextContents(),['1D','1M','3M','1Y','5Y','All']);
  await waitForLocalOverviewPlot(page,theme);
  await check('local-overview-theme-and-no-external-widget');
  const frames = page.getByRole('group', { name: 'Market timeframe', exact: true });
  const plot = page.locator('.spot-target-canvas');
  assert.equal(await page.locator('.spot-target-header .spot-timeframes').count(), 1);
  assert.equal(await page.locator('.market-detail-heading').getByRole('button').count(), 0);
  assert.deepEqual(await frames.getByRole('button').allTextContents(), ['1m', '5m', '1h', '24h', 'Custom']);
  await check('timeframes-are-in-the-spot-chart-header');
  for(const [tf,seconds]of[['1m',60],['5m',300],['1h',3600],['24h',86400]]){
   await frames.getByRole('button',{name:tf,exact:true}).click();await page.waitForFunction(seconds=>document.querySelector('.epoch-section')?.dataset.duration===String(seconds),seconds);
   await page.locator('.epoch-pill.active').filter({hasText:'Live'}).waitFor();await curve();await check(`${tf}-switch-selects-live-with-curve`);
   const bestLive = page.locator('.epoch-live[aria-current="time"]');
   const results = page.locator('.epoch-result-pill');
   const detail = page.getByRole('region',{name:'Selected epoch result',exact:true});
   const currentExpiry = await bestLive.getAttribute('data-expiry');
   const title = await page.locator('.market-detail-heading h1').innerText();
   const route = page.url();
   await results.first().waitFor();
   assert.ok((await results.count()) <= 8);
   const reference = page.getByLabel('Stake amount in BCH',{exact:true});
   await reference.fill('0.0031');
   await results.first().click();
   assert.match(await detail.innerText(),/Target[\s\S]*Reported close[\s\S]*(UP|DOWN|FLAT)/);
   assert.equal(page.url(), route);
   assert.equal(await reference.inputValue(),'0.0031');
   await curve();
   if (await bestLive.getAttribute('data-expiry') === currentExpiry) assert.equal(await page.locator('.market-detail-heading h1').innerText(), title);
   assert.equal(await page.locator('.spot-target-card').getByText('Current Spot Price',{exact:true}).count(),1);
   assert.equal(await page.locator('.outcome-ticket').getByRole('button',{name:/Review & Place Stake/}).isEnabled(),true);
   await check(`${tf}-reported-result-leaves-live-chart-and-ticket-intact`);
  }
  assert.deepEqual(archiveRequests,[], 'Large archives load on demand');
  const historicalExpiry = Number(await page.locator('.epoch-result-pill').first().getAttribute('data-expiry'));
  const pastUrl = `http://localhost:3000/market/bchusd-24h-${historicalExpiry / 1000}`;
  await page.goto(pastUrl);
  const detail = page.getByRole('region',{name:'Selected epoch result',exact:true});
  await detail.getByText('Reported close',{exact:true}).waitFor();
  await page.locator('.epoch-pill.active').filter({hasText:'Live'}).waitFor();await curve();assert.equal(page.url(),pastUrl);await check('historical-deep-link-opens-result-alongside-live-round');
  await page.getByRole('button',{name:'View all resolutions',exact:true}).click();
  const history=page.getByRole('dialog',{name:'BCH/USD Resolution History',exact:true});
  await history.locator('.resolution-row').first().waitFor();
  assert.doesNotMatch(await history.innerText(), /Upcoming|Pending close/);
  assert.ok((await history.locator('.epoch-direction').allTextContents()).every(text=>/^(UP|DOWN|FLAT) /.test(text)));
  await history.locator('.resolution-row').last().click();
  assert.equal(page.url(),pastUrl);
  await detail.getByText('Reported close',{exact:true}).waitFor();await curve();await check('archive-inspection-keeps-live-round');
  await frames.getByRole('button',{name:'5m',exact:true}).click();await page.locator('.epoch-pill.active').filter({hasText:'Live'}).waitFor();await curve();await page.evaluate(()=>window.scrollTo(0,0));
  const path=page.url();await page.goBack();assert.equal(page.url(),pastUrl);await detail.getByText('Reported close',{exact:true}).waitFor();await page.goForward();await page.locator('.epoch-pill.active').filter({hasText:'Live'}).waitFor();assert.equal(page.url(),path);await check('timeframe-and-bookmark-back-forward-navigation');
  await curve();await waitForLocalOverviewPlot(page,theme);

  const expiry = Number(await page.locator('.epoch-pill.active').getAttribute('data-expiry'));
  await frames.getByRole('button', { name: 'Custom', exact: true }).click();
  const presets = page.getByRole('group', { name: 'Chart window presets', exact: true });
  assert.deepEqual(await presets.getByRole('button').allTextContents(), ['30s', '2m', '10m', '15m', '30m']);
  const selectHorizon = async (label, seconds) => {
   await presets.getByRole('button', { name: label, exact: true }).click();
   assert.equal(await plot.getAttribute('data-window-seconds'), String(seconds));
   await curve();
  };
  await selectHorizon('30s', 30);
  await page.waitForFunction(() => {
   const { firstDisplayTime, lastDisplayTime } = document.querySelector('.spot-target-canvas').dataset;
   const span = Number(lastDisplayTime) - Number(firstDisplayTime);
   return span >= 28 && span <= 30;
  });
  await selectHorizon('30m', 1800);
  await page.waitForFunction(() => {
   const { firstDisplayTime, lastDisplayTime } = document.querySelector('.spot-target-canvas').dataset;
   return Number(lastDisplayTime) - Number(firstDisplayTime) >= 1798;
  });
  const amount = page.getByLabel('Chart window', { exact: true });
  const unit = page.getByLabel('Chart window unit', { exact: true });
  await amount.fill('1.5');
  assert.equal(await unit.inputValue(), 'minutes');
  assert.equal(await plot.getAttribute('data-window-seconds'), '90');
  await unit.selectOption('seconds');
  assert.equal(await amount.getAttribute('aria-invalid'), 'true');
  assert.equal(await plot.getAttribute('data-window-seconds'), '90');
  await amount.fill('45');
  assert.equal(await amount.getAttribute('aria-invalid'), 'false');
  assert.equal(await plot.getAttribute('data-window-seconds'), '45');
  await curve();
  assert.equal(page.url(), path);
  assert.equal(await page.locator('.epoch-section').getAttribute('data-duration'), '300');
  if (expiry > Date.now()) assert.equal(Number(await page.locator('.epoch-pill.active').getAttribute('data-expiry')), expiry);
  await check('custom-presets-and-typed-duration-fit-the-chart-with-five-minute-expiry');

  const ticket = page.locator('.outcome-ticket');
  const pool = ticket.getByRole('group', { name: 'Model odds', exact: true });
  assert.match(await pool.innerText(), /BELOW\s+\d+(\.\d+)?%[\s\S]*ABOVE\s+\d+(\.\d+)?%/);
  const outcomes = ticket.getByRole('group', { name: 'Market outcomes', exact: true });
  await outcomes.getByRole('button', { name: /^BELOW/ }).click();
  assert.equal(await outcomes.getByRole('button', { name: /^BELOW/ }).getAttribute('aria-pressed'), 'true');
  const returns = ticket.getByRole('region', { name: 'Return preview', exact: true });
  const principal = returns.locator('.stake-return-principal');
  const share = returns.locator('.stake-pool-share strong');
  const shareBefore = await share.innerText();
  const barBefore = await principal.evaluate(node => node.style.width);
  await ticket.getByRole('button', { name: '0.005 BCH', exact: true }).click();
  assert.match(await returns.innerText(), /Your stake\s+0\.005 BCH/);
  assert.notEqual(await share.innerText(), shareBefore);
  assert.notEqual(await principal.evaluate(node => node.style.width), barBefore);
  const slider = ticket.getByRole('slider', { name: 'Stake amount slider', exact: true });
  await slider.focus();
  await page.keyboard.press('End');
  assert.match(await returns.innerText(), /Your stake\s+0\.02 BCH/);
  assert.match(await returns.innerText(), /Net profit\s+[+-]?\d/);
  await check('pool-balance-and-return-bar-respond-to-outcome-preset-and-slider');
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({path:`local-overview-${theme}-${width}.png`,fullPage:true});

  // Test both sides of the strike and stale observations in the browser only.
  const ratesUrl = 'http://localhost:3000/api/rates?horizonSeconds=300';
  const ratesResponse = await page.request.get(ratesUrl);
  assert.equal(ratesResponse.ok(), true);
  const rates = await ratesResponse.json();
  const strike = Number((await page.locator('.spot-price-stats strong').first().innerText()).slice(1));
  let testSpot = strike + 1.4;
  let age = 0;
  await page.route(ratesUrl, route => route.fulfill({ json: {
   ...rates, tick: { ...rates.tick, bchUsdPrice: testSpot, source: 'live', spotSource: 'binance', spotFetchedAtMs: Date.now() - age }
  } }));
  const spread = page.locator('.spot-delta');
  await spread.filter({ hasText: /Winning ABOVE.*\+\$1\.40/i }).waitFor();
  assert.equal(await spread.getAttribute('data-outcome'), 'above');
  const positiveTint = await spread.evaluate(node => getComputedStyle(node).backgroundColor);
  testSpot = strike - .85;
  await spread.filter({ hasText: /Winning BELOW.*−\$0\.85/i }).waitFor();
  assert.equal(await spread.getAttribute('data-outcome'), 'below');
  await page.waitForFunction(tint => getComputedStyle(document.querySelector('.spot-delta')).backgroundColor !== tint, positiveTint);
  age = 90_000;
  await spread.waitFor({ state: 'hidden' });
  await page.unroute(ratesUrl);
  await check('spread-tints-follow-live-outcomes-and-disappear-for-stale-data');

  await page.waitForFunction(() => document.querySelector('.spot-delta')?.textContent.includes('Winning'));
  assert.deepEqual(scriptRequests,[],`${width} ${theme}: external script loads`);
  assert.deepEqual(errors,[],`${width} ${theme}: console/page errors`);assert.deepEqual(http,[],`${width} ${theme}: HTTP failures`);results.push({width,theme,checks,consoleErrors:errors.length,httpErrors:http.length,externalScripts:scriptRequests.length});await context.close();
 } await checkRollover(browser); }finally{await browser.close()}
 fs.writeFileSync('market-overview-smoke-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
