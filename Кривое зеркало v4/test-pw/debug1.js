const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
  const p = await (await b.newContext({ viewport:{width:1280,height:860} })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PE: '+String(e.message).slice(0,200)));
  p.on('console', m => { if (m.type()==='error') errs.push('CE: '+m.text().slice(0,200)); });
  await p.goto('http://localhost:8000/');
  await p.waitForTimeout(400);
  console.log('alive check:', await p.evaluate(() => 1 + 1));
  console.log('errs after load:', JSON.stringify(errs));
  console.log('hidden computed:', await p.evaluate(() => {
    const m = document.getElementById('policyModal');
    return { hiddenAttr: m.hidden, display: getComputedStyle(m).display };
  }));
  console.log('hit test:', await p.evaluate(() => {
    const btn = document.getElementById('policyAccept');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return { rect: [r.x|0, r.y|0, r.width|0, r.height|0], topId: top && top.id, topTag: top && top.tagName };
  }));
  await p.evaluate(() => document.getElementById('policyAccept').click());
  await p.waitForTimeout(600);
  console.log('after js click:', await p.evaluate(() => ({
    hidden: document.getElementById('policyModal').hidden,
    status: document.getElementById('statusLine').textContent.slice(0,80),
    consent: localStorage.getItem('crooked-mirror-consent-v1'),
    started: S.started,
  })));
  await p.click('#uiToggle', { timeout: 3000 }).catch(e => console.log('uiToggle click FAIL:', String(e).split('\n')[0]));
  await b.close();
})();
