const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs=[];
  page.on('console', m => logs.push(m.type()+': '+m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: '+e.message));
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'domcontentloaded' });
  const policyVisible = await page.locator('#policyModal:not([hidden])').count();
  if (policyVisible) await page.click('#policyAccept');
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    title: document.title,
    selected: document.querySelector('#effectSelect')?.value,
    hasReset: !!document.querySelector('#resetBtn'),
    hasEmojiFit: !!document.querySelector('#emojiFit'),
    started: !!window.GLRenderer,
    status: document.querySelector('#statusLine')?.textContent,
  }));
  console.log(JSON.stringify({info, logs}, null, 2));
  await browser.close();
})();
