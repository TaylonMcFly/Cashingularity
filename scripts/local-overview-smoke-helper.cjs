const assert = require('node:assert/strict');

/** Inspect the bundled chart's real canvas rather than an external frame. */
async function waitForLocalOverviewPlot(page, theme) {
  const plot = page.locator('.symbol-overview-plot');
  await plot.waitFor();
  await plot.scrollIntoViewIfNeeded();
  await page.waitForFunction(theme => {
    const host = document.querySelector('.symbol-overview-plot');
    if (host?.dataset.chartTheme !== theme || Number(host.dataset.pointCount) < 2) return false;
    return [...host.querySelectorAll('canvas')].some(canvas => {
      if (canvas.width < 150 || canvas.height < 90) return false;
      const ctx = canvas.getContext('2d'); if (!ctx) return false;
      const accent = theme === 'dark' ? [242, 193, 78] : [154, 104, 10];
      let matching = 0;
      for (let y=1;y<canvas.height;y+=3) for (let x=1;x<canvas.width;x+=3) {
        const pixel = ctx.getImageData(x,y,1,1).data;
        if (pixel[3] > 200 && accent.every((channel, index) => Math.abs(pixel[index] - channel) < 12)) matching++;
      }
      return matching > 15;
    });
  }, theme, {timeout:30000});
  assert.equal(await page.locator('.local-symbol-overview iframe, .local-symbol-overview script, script[src*="tradingview.com"]').count(),0);
  assert.equal(await page.locator('.symbol-overview-plot a[href*="tradingview.com"]').count(),0);
}
module.exports = { waitForLocalOverviewPlot };
