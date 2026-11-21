const {waitForLocalOverviewPlot}=require('./local-overview-smoke-helper.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/taylo/AppData/Local/Temp/cashingularity-ui-check/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],http=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)http.push(`${r.status()} ${r.url()}`)});
  const popup=name=>page.getByRole('dialog',{name,exact:true});
  const action=name=>page.locator('.wallet-action-grid button').filter({has:page.getByText(name,{exact:true})});
  const close=name=>page.getByRole('button',{name:`Close ${name}`,exact:true}).click();
  const nav=async name=>{if(width>768)await page.locator('.primary-navigation').getByRole('link',{name,exact:true}).click();else await page.locator('.mobile-bottom-nav').getByRole('button',{name,exact:true}).click()};
  const check=async name=>{const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(layout.scroll,layout.width,`${width}: ${name} overflow`);checks.push(name);console.log(`${width}: ${name}`)};
  const palette=theme=>theme==='dark'?'rgb(28, 32, 40)':'rgb(255, 255, 255)';
  const assertSurface=async(locator,theme)=>{ await locator.evaluate((n,expected)=>new Promise(resolve=>{const check=()=>{if(getComputedStyle(n).backgroundColor===expected)resolve();else requestAnimationFrame(check)};check()}),palette(theme)); };
  const charts=async theme=>{
   // Inspect rendered canvas pixels, including after in-place theme changes.
   await page.waitForFunction(theme=>['.spot-target-canvas'].every(selector=>{
    const parent=document.querySelector(selector),canvas=parent?.querySelector('canvas');if(!canvas||parent.dataset.chartTheme!==theme)return false;
    const ctx=canvas.getContext('2d'),expected=theme==='dark'?'28,32,40,255':'255,255,255,255';let matched=0,total=0;
    for(let y=5;y<canvas.height;y+=17)for(let x=5;x<canvas.width;x+=17){total++;if([...ctx.getImageData(x,y,1,1).data].join(',')===expected)matched++;}return total>0&&matched/total>.25;
   }),theme);
   await waitForLocalOverviewPlot(page,theme);
  };
  const placement=async layout=>{
   await page.evaluate(()=>window.scrollTo(0,0));
   const geometry=await page.evaluate(()=>{const a=document.querySelector('.market-charts-card').getBoundingClientRect(),b=document.querySelector('.outcome-ticket').getBoundingClientRect();return{charts:a.toJSON(),ticket:b.toJSON(),position:getComputedStyle(document.querySelector('.outcome-ticket')).position}});
   if(width<=1000||layout==='below'){assert.ok(geometry.ticket.top>=geometry.charts.bottom);assert.equal(geometry.position,'static');}else{assert.ok(Math.abs(geometry.charts.top-geometry.ticket.top)<2);assert.equal(geometry.position,'sticky');if(layout==='right')assert.ok(geometry.ticket.left>=geometry.charts.right);else assert.ok(geometry.charts.left>=geometry.ticket.right);}
  };
  await page.goto('http://localhost:3000/market');await page.locator('.market-explorer-card').first().click();await page.locator('.spot-target-canvas canvas').first().waitFor();const url=page.url();
  await charts('light');await placement('right');assert.equal(await page.locator('.rabby-wallet-sidebar').count(),0);assert.equal(await page.getByLabel('Contract Engine',{exact:true}).count(),0);await check('default-right-ticket-and-light-charts');
  for(const [layout,label]of[['below','Below Charts (Full Width)'],['left','Dock Left'],['right','Dock Right (Sidebar)']]){
   await page.getByRole('button',{name:'More options',exact:true}).click();const menu=popup('Outcome position options');assert.equal(await menu.getByLabel('Contract Engine',{exact:true}).locator('option').count(),3);
   await menu.getByRole('button',{name:label,exact:true}).click();await menu.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>localStorage.getItem('cashingularity.outcomePanelLayout.v1')),layout);await placement(layout);await charts('light');await check(`${layout}-ticket-layout`);
  }
  await page.getByRole('button',{name:'More options',exact:true}).click();await popup('Outcome position options').getByRole('button',{name:'Dock Left',exact:true}).click();await page.reload();await page.locator('.spot-target-canvas canvas').first().waitFor();await placement('left');await check('layout-restored-after-reload');
  await page.getByRole('button',{name:'More options',exact:true}).click();await popup('Outcome position options').getByText('Developer Contract Inspector',{exact:true}).click();await popup('Outcome position options').getByLabel('Contract Engine',{exact:true}).selectOption('SOLIDCASH_SCASH');await page.keyboard.press('Escape');assert.equal(await popup('Outcome position options').count(),0);assert.equal(await page.getByRole('button',{name:'More options',exact:true}).evaluate(n=>n===document.activeElement),true);
  await page.getByRole('button',{name:'More options',exact:true}).click();await popup('Outcome position options').getByRole('button',{name:'Dock Right (Sidebar)',exact:true}).click();
  for(const theme of ['dark','light','dark']){
   await page.locator('.blaze-banner').getByRole('button',{name:`Switch to ${theme} mode`,exact:true}).click();await charts(theme);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);await assertSurface(page.locator('.outcome-ticket'),theme);await assertSurface(page.locator('.spot-target-card'),theme);await check(`${theme}-live-charts-and-ticket-palette`);
  }
  await page.getByRole('button',{name:'More options',exact:true}).click();await assertSurface(popup('Outcome position options'),'dark');await check('dark-layout-engine-popover');await page.keyboard.press('Escape');
  await page.evaluate(()=>window.scrollTo(0,500));assert.equal(await page.locator('.blaze-banner').evaluate(n=>Math.round(n.getBoundingClientRect().top)),0);if(width>1000)assert.ok(Math.abs((await page.locator('.outcome-ticket').boundingBox()).y-88)<2);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`market-dark-${width}.png`,fullPage:false});await page.reload();await charts('dark');await placement('right');await check('dark-persistence-and-pinned-header');
  for(const theme of ['dark','light']){
   if(theme==='light'){await page.locator('.blaze-banner').getByRole('button',{name:'Switch to light mode',exact:true}).click();}
   await nav('Wallet');await page.getByRole('heading',{name:'Welcome to your wallet'}).waitFor();assert.ok((await page.locator('.wallet-portfolio-hero').evaluate(n=>getComputedStyle(n).backgroundImage)).includes(palette(theme)));await check(`${theme}-wallet`);
   for(const name of ['Send','Batch Pay','Receive']){
    await action(name).click();const title=name==='Send'?'Send BCH':name==='Receive'?'Receive BCH':name;await assertSurface(popup(title),theme);
    if(name==='Batch Pay'){
     const batch=popup(title);assert.equal(await batch.getByRole('heading',{name:'Batch Pay',exact:true}).count(),1);await batch.getByRole('button',{name:/Review & Send Batch/}).click();assert.match(await batch.locator('.batch-review-error').innerText(),/Add at least one recipient/);await batch.getByRole('button',{name:'? Format Guide',exact:true}).click();await assertSurface(batch.getByRole('region',{name:'Spreadsheet file format guide',exact:true}),theme);assert.equal(await batch.locator('.format-guide-example tbody tr').count(),2);await page.screenshot({path:`batch-${theme}-${width}.png`,fullPage:false});await page.keyboard.press('Escape');
    }
    await check(`${theme}-${name.toLowerCase()}-popup`);await close(title);
   }
   await nav('Settings');await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();const choice=page.getByRole('group',{name:'Theme',exact:true}).getByRole('button',{name:theme==='dark'?'Dark':'Light',exact:true});assert.equal(await choice.getAttribute('aria-pressed'),'true');await assertSurface(page.locator('.settings-appearance'),theme);await check(`${theme}-settings`);
   if(theme==='dark'){await page.getByRole('group',{name:'Theme',exact:true}).getByRole('button',{name:'Light',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');await page.getByRole('group',{name:'Theme',exact:true}).getByRole('button',{name:'Dark',exact:true}).click();}
   await page.screenshot({path:`settings-${theme}-${width}.png`,fullPage:false});await nav('Markets');
  }
  await page.goto(url);await charts('light');assert.deepEqual(errors,[],`${width}: console/page errors`);assert.deepEqual(http,[],`${width}: HTTP failures`);results.push({width,checks,consoleErrors:errors.length,httpErrors:http.length});await context.close();
 }}finally{await browser.close();}
 fs.writeFileSync('appearance-layout-smoke-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
