const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required','--mute-audio'] });
  const p = await (await b.newContext()).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e.message).slice(0,150)));
  await p.goto('http://localhost:8000/');
  await p.evaluate(() => { document.getElementById('policyModal').hidden = true; });
  await p.click('#aboutBtn');
  await p.waitForTimeout(200);
  const r = await p.evaluate(() => ({
    aboutShown: !document.getElementById('aboutModal').hidden,
    tg: (document.querySelector('#aboutModal a[href*="t.me"]')||{}).href,
    yt: (document.querySelector('#aboutModal a[href*="youtube"]')||{}).href,
    title: document.querySelector('#ui .title em')?.textContent.trim(),
    titleHides: !!document.querySelector('#ui .title.ui-hide'),
  }));
  await p.screenshot({ path: '/home/user/mirror-v2/test-media/shot-about.png' });
  await p.click('#aboutClose');
  const closed = await p.evaluate(() => document.getElementById('aboutModal').hidden === true);
  await p.click('#uiToggle');
  const collapsed = await p.evaluate(() => document.body.classList.contains('ui-hidden') && getComputedStyle(document.getElementById('ui')).display);
  await p.screenshot({ path: '/home/user/mirror-v2/test-media/shot-collapsed.png' });
  console.log(JSON.stringify({ ...r, closed, collapsedWhenHidden: collapsed === 'none', errs }));
  await b.close();
})();
