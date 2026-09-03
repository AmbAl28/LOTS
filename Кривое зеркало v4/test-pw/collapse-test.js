const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
  const p = await (await b.newContext({viewport:{width:1280,height:860}})).newPage();
  await p.goto('http://localhost:8000/');
  await p.evaluate(() => { if (!S.started) document.getElementById("policyAccept").click(); });
  await p.waitForTimeout(400);
  await p.evaluate(async () => {
    const img = new Image(); img.src = 'test-media/face.png'; await img.decode();
    const c = document.createElement('canvas'); c.width=640; c.height=800; const g=c.getContext('2d');
    let t=0; (function loop(){ t+=1/24; g.fillStyle='#c9ccd2'; g.fillRect(0,0,640,800);
      const dx=Math.sin(t*1.1)*50; g.save(); g.translate(320+dx,400); g.scale(1+Math.sin(t*.7)*.05,1+Math.sin(t*.7)*.05); g.drawImage(img,-320,-400); g.restore();
      requestAnimationFrame(loop); })();
    const v = document.getElementById('sourceVideo'); v.srcObject = c.captureStream(24); await v.play();
  });
  await p.selectOption('#effectSelect', 'cheeshire');
  await p.waitForFunction(() => /лиц: [1-9]/.test(document.getElementById('perfLine').textContent), null, { timeout: 30000 });
  await p.click('#uiToggle');
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => ({
    uiGone: getComputedStyle(document.getElementById('ui')).display === 'none',
    panelGone: getComputedStyle(document.getElementById('paramsPanel')).display === 'none',
    statusGone: getComputedStyle(document.getElementById('status')).display === 'none',
    toggleVisible: getComputedStyle(document.getElementById('uiToggle')).display !== 'none',
  }));
  await p.screenshot({ path: '/home/user/mirror-v2/test-media/shot-collapsed.png' });
  console.log(JSON.stringify(r));
  await b.close();
})();
