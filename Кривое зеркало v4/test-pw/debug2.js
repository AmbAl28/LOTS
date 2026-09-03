const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
  const p = await (await b.newContext({ viewport:{width:1280,height:860} })).newPage();
  const logs = [];
  p.on('pageerror', e => logs.push('PE: ' + String(e.message).slice(0,300)));
  p.on('console', m => logs.push(m.type()+': '+m.text().slice(0,220)));
  await p.goto('http://localhost:8000/');
  await p.waitForTimeout(300);
  await p.click('#policyAccept', { timeout: 5000 }).catch(e => logs.push('click fail: '+String(e).split('\n')[0]));
  await p.waitForTimeout(1200);
  console.log('STATE1:', JSON.stringify(await p.evaluate(() => ({
    started: typeof S !== 'undefined' && S.started,
    renderer: typeof S !== 'undefined' && !!S.renderer,
    status: document.getElementById('statusLine').textContent.slice(0,150),
    perf: document.getElementById('perfLine').textContent.slice(0,80),
    ls: (() => { try { return localStorage.getItem('crooked-mirror-consent-v1'); } catch(e){ return 'LS-ERR '+e.message; } })(),
  })), null, 0));
  // источник
  await p.evaluate(async () => {
    const img = new Image(); img.src = 'test-media/face.png'; await img.decode();
    const c = document.createElement('canvas'); c.width=640; c.height=800;
    const g = c.getContext('2d'); g.drawImage(img,0,0,640,800);
    window.__c = c;
    const st = c.captureStream(24); window.__st = st;
    const v = document.getElementById('sourceVideo'); v.srcObject = st; await v.play();
  });
  await p.waitForTimeout(3500);
  console.log('STATE2:', JSON.stringify(await p.evaluate(() => ({
    ready: document.getElementById('sourceVideo').readyState,
    vw: document.getElementById('sourceVideo').videoWidth,
    cw: document.getElementById('glCanvas').width,
    tracker: typeof S !== 'undefined' && !!S.tracker,
    landmarker: typeof S !== 'undefined' && S.tracker && !!S.tracker.landmarker,
    tErr: typeof S !== 'undefined' && S.tracker && S.tracker.err,
    frames: typeof S !== 'undefined' && S.frame,
    faces: typeof S !== 'undefined' && S.faces && S.faces.length,
    status: document.getElementById('statusLine').textContent.slice(0,150),
    perf: document.getElementById('perfLine').textContent.slice(0,100),
  }))));
  console.log('LOGS:'); logs.slice(0,15).forEach(l => console.log('  '+l));
  await b.close();
})();
