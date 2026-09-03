const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio'] });
  const p = await (await b.newContext({ viewport:{width:800,height:600} })).newPage();
  p.on('pageerror', e => console.log('PE:', String(e.message).slice(0,200)));
  await p.goto('http://localhost:8000/');
  await p.waitForTimeout(300);
  await p.evaluate(() => { if (!S.started) { grantConsent(); start(); } });
  // источник: чёрный кадр 640x800
  await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width=640; c.height=800;
    const g = c.getContext('2d'); g.fillStyle='#000'; g.fillRect(0,0,640,800);
    window.__c = c;
    const v = document.getElementById('sourceVideo');
    v.srcObject = c.captureStream(15); await v.play();
  });
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => {
    // 640x800 маркерный холст: верхняя половина красная, нижняя синяя, левый-верх зелёный квадрат
    const t = document.createElement('canvas'); t.width = 640; t.height = 800;
    const g = t.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0,0,640,400);      // canvas TOP = red
    g.fillStyle = '#0000ff'; g.fillRect(0,400,640,400);     // canvas BOTTOM = blue
    g.fillStyle = '#00ff00'; g.fillRect(0,0,160,160);        // canvas top-left = green
    // фиксированный rect на весь кадр, без клипа
    S.renderer.draw(document.getElementById('sourceVideo'), {
      time: 0, mode: 0, warp: 0, faceMode: 2, faceCanvas: t,
      rect: [0, 0, 640, 800], maskCanvas: null,
    });
    const gl = S.renderer.gl;
    const px = new Uint8Array(4);
    const rd = (x, y) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [...px.slice(0,3)]; };
    return {
      glBottomLeft: rd(40, 40),       // GL y мал = низ экрана
      glTopLeft: rd(40, 760),         // верх экрана
      glTopRight: rd(600, 760),
    };
  });
  // ожидаем: верх кадра = красный/зелёный, низ = синий (фото стоит как есть)
  // если перевёрнуто: верх = синий, низ = красный
  console.log(JSON.stringify(r));
  console.log(r.glTopLeft[2] > 150 && r.glBottomLeft[0] > 150 ? 'FLIPPED(верха-синий/низ-красный)' : r.glTopLeft[2] > 150 ? 'FLIPPED' : 'UPRIGHT');
  await b.close();
})();
