const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs=[];
  page.on('console', m => logs.push(m.type()+': '+m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: '+e.message));
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'domcontentloaded' });
  if (await page.locator('#policyModal:not([hidden])').count()) await page.click('#policyAccept');
  await page.waitForTimeout(1000);
  await page.setInputFiles('#fileInput', path.join('/home/user/mirror-v2/test-media/recorded.webm'));
  await page.waitForTimeout(2500);
  const afterSource = await page.evaluate(() => ({effect: effectSelect.value, status: statusLine.textContent, perf: perfLine.textContent, size:[glCanvas.width, glCanvas.height]}));
  const effects=['cheeshire','bigmouth','fatface','cathole','bulleyes','pinhead','fishlips','caterpillar','wobbleface','rippleface','flipface','blacksketch','bignose','narrowface','longnose','waxdrop'];
  const results=[];
  for (const eff of effects) {
    await page.selectOption('#effectSelect', eff);
    await page.waitForTimeout(350);
    results.push(await page.evaluate((eff) => ({eff, effect: effectSelect.value, urlLen: glCanvas.toDataURL('image/png').length, status: statusLine.textContent, perf: perfLine.textContent}), eff));
  }
  await page.click('#resetBtn');
  const reset = await page.evaluate(() => ({effect: effectSelect.value, emoji: emojiSelect.value, random: presetRandom.checked, mask: maskMode.value, scale: emojiScale.value}));
  console.log(JSON.stringify({afterSource, reset, tested: results.length, sample: results.slice(0,4), logErrors: logs.filter(x=>/error|PAGEERROR|compile|link/i.test(x))}, null, 2));
  await browser.close();
})();
