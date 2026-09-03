"use strict";
/* e2e Crooked Mirror v3 (headless Chromium):
 * - политика: показать/принять
 * - источник: canvas.captureStream с анимированным лицом (детектор реально грузится из vendor/)
 * - пресет cheeshire (warp по маске), эмодзи-слой, фото-замена, клип по контуру, рандомы
 * - пиксельные проверки через gl.readPixels + свёртка интерфейса
 */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = '/home/user/mirror-v2/test-media';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const consoleErrs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => consoleErrs.push('PAGEERROR: ' + String(e).slice(0, 300)));
  const R = {};

  try {
    await page.goto('http://localhost:8000/', { waitUntil: 'load' });
    await page.waitForTimeout(250);

    // --- политика ---
    R.policyVisible = await page.isVisible('#policyModal');
    await page.click('#policyAccept');
    R.policyHidden = await page.evaluate(() => document.getElementById('policyModal').hidden === true);
    R.consentStored = await page.evaluate(() => localStorage.getItem('crooked-mirror-consent-v1') === '1');

    // --- источник ---
    await page.evaluate(async () => {
      const img = new Image();
      img.src = 'test-media/face.png';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 640; c.height = 800;
      const g = c.getContext('2d');
      let t = 0;
      window.__anim = true;
      (function loop() {
        if (window.__anim) {
          t += 1 / 24;
          g.fillStyle = '#c9ccd2'; g.fillRect(0, 0, 640, 800);
          const dx = Math.sin(t * 1.1) * 60, sc = 1 + Math.sin(t * 0.7) * 0.06, rot = Math.sin(t * 0.9) * 0.06;
          g.save(); g.translate(320 + dx, 400); g.rotate(rot); g.scale(sc, sc);
          g.drawImage(img, -320, -400); g.restore();
        }
        requestAnimationFrame(loop);
      })();
      const stream = c.captureStream(24);
      const v = document.getElementById('sourceVideo');
      v.srcObject = stream;
      await v.play();
    });

    // --- лица ---
    await page.waitForFunction(() => /лиц: [1-9]/.test(document.getElementById('perfLine').textContent), null, { timeout: 40000 });
    R.faces = await page.evaluate(() => document.getElementById('perfLine').textContent.trim());
    R.delegate = await page.evaluate(() => S.tracker && S.tracker.delegate);
    R.feats = await page.evaluate(() => {
      const f = S.largest; if (!f) return null;
      const ok = (p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);
      return {
        id: f.id, hull: f.hull.length,
        eyes: ok(f.feat.eyeL) && ok(f.feat.eyeR), mouth: ok(f.feat.mouthL) && ok(f.feat.mouthR),
        cheeks: ok(f.feat.cheekL) && ok(f.feat.cheekR), nose: ok(f.feat.nose),
        ew: +f.feat.eyeDist.toFixed(1), mw: +f.feat.mouthW.toFixed(1),
        score: FaceTracker.score(f),
      };
    });
    R.rectFor = await page.evaluate(() => {
      const v = document.getElementById('sourceVideo');
      const w = v.videoWidth, h = v.videoHeight;
      const emoji = S.tracker.rectFor(S.largest, w, h, 'emoji', { scale: 1 });
      const photo = S.tracker.rectFor(S.largest, w, h, 'photo', { aspect: 1.25 });
      const chk = (r) => r && r.rect.every(isFinite) && r.clip.length >= 6 &&
        r.rect[2] > 4 && r.rect[3] > 4 && r.rect[1] >= -h && r.rect[1] <= h * 2 &&
        r.clip.every(isFinite) && r.clip.length % 2 === 0;
      return { emoji: !!chk(emoji), photo: !!chk(photo), e: emoji && emoji.rect.map(x => +x.toFixed(1)) };
    });

    // --- пресет cheeshire ---
    await page.selectOption('#effectSelect', 'cheeshire');
    await page.waitForTimeout(500);
    R.frameParams = await page.evaluate(() => {
      const v = document.getElementById('sourceVideo');
      return buildFrameParams(performance.now(), v.videoWidth, v.videoHeight);
    });
    R.fpOK = R.frameParams.mode === 1 && R.frameParams.warp === 2 && Math.abs(R.frameParams.strength) === 1
      && Array.isArray(R.frameParams.extra) && R.frameParams.extra[3] === 1 && isFinite(R.frameParams.radius);
    await page.screenshot({ path: `${OUT}/shot-cheeshire.png` });

    // --- эмодзи ---
    await page.selectOption('#effectSelect', 'none');
    await page.selectOption('#emojiSelect', '😂');
    await page.waitForTimeout(500);
    R.emojiActive = await page.evaluate(() => {
      const v = document.getElementById('sourceVideo');
      const p = buildFrameParams(performance.now(), v.videoWidth, v.videoHeight);
      return p.faceMode === 1 && !!p.faceCanvas && p.faceCanvas.width === 384 && p.rect && !!p.clips;
    });
    R.emojiCanvasNonEmpty = await page.evaluate(() => {
      const c = emojiCanvas('😂');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let a = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 32) a++;
      return a > 2000;
    });
    await page.screenshot({ path: `${OUT}/shot-emoji.png` });

    // --- рандом эмодзи: дёргаем ракурс -> ожидаем смену ---
    await page.selectOption('#effectSelect', 'cheeshire');
    await page.check('#emojiRandom');
    const e0 = await page.evaluate(() => document.getElementById('emojiSelect').value);
    await page.evaluate(() => { window.__anim = true; }); // анимация снова ходит — score меняется
    const flipped = await page.waitForFunction((prev) => {
      const cur = document.getElementById('emojiSelect').value;
      return cur !== prev;
    }, e0, { timeout: 12000 }).then(() => true).catch(() => false);
    R.emojiRandomFlip = flipped;
    await page.uncheck('#emojiRandom');

    // --- фото-замена (clip-полигон обязан обрезать картинку до лица) ---
    await page.setInputFiles('#faceImage', `${OUT}/face.png`);
    await page.waitForFunction(() => S.photoCanvas, null, { timeout: 5000 });
    await page.selectOption('#emojiSelect', '');
    await page.waitForTimeout(500);
    R.photoActive = await page.evaluate(() => {
      const v = document.getElementById('sourceVideo');
      const p = buildFrameParams(performance.now(), v.videoWidth, v.videoHeight);
      return p.faceMode === 2 && p.rect && p.clips.length >= 6;
    });
    await page.screenshot({ path: `${OUT}/shot-photo-clip.png` });

    // --- пиксельная проверка: инверсия с гейтом маски и без ---
    R.frameCheck = await page.evaluate(() => {
      window.__anim = false;
      const v = document.getElementById('sourceVideo');
      const r = S.renderer;
      const c = r.canvas, gl = r.gl;
      const px = new Uint8Array(4);
      const rd = (x, y) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [...px.slice(0, 3)]; };
      const base = { time: 0, mode: 0, warp: 0, maskCanvas: S.tracker ? S.tracker.mask : null };
      r.draw(v, { ...base, maskMode: 0 });
      const center0 = rd(c.width >> 1, (c.height >> 1) + 120), corner0 = rd(12, 12);
      r.draw(v, { ...base, colorOp: 1, maskMode: 1 });   // инверсия только на лице
      const center1 = rd(c.width >> 1, (c.height >> 1) + 120), corner1 = rd(12, 12);
      r.draw(v, { ...base, colorOp: 1, maskMode: 0 });   // инверсия всего кадра
      const corner2 = rd(12, 12);
      const ch_ = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      return {
        maskWorks: ch_(center0, center1) > 60 && ch_(corner0, corner1) <= 10 && ch_(corner0, corner2) > 60,
        dCenter: ch_(center0, center1), dCornerMasked: ch_(corner0, corner1), dCornerFull: ch_(corner0, corner2),
      };
    });

    // --- пиксельная проверка фото-клипа: под лицом НЕ должно быть фото (угол кадра) ---
    R.photoClip = await page.evaluate(() => {
      const v = document.getElementById('sourceVideo');
      const r = S.renderer;
      const gl = r.gl, c = r.canvas;
      const px = new Uint8Array(4);
      const rd = (x, y) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [...px.slice(0, 3)]; };
      // кадр с фото на лице (cheeshire + photo, faceMode=2)
      const p = buildFrameParams(performance.now(), c.width, c.height);
      r.draw(v, { ...p, maskCanvas: S.tracker.mask, time: 0 });
      const cornerWithPhoto = rd(12, 12);
      r.draw(v, { time: 0, mode: 0, warp: 0, faceMode: 0, maskCanvas: S.tracker.mask });
      const cornerPlain = rd(12, 12);
      const ch_ = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      return { cornerDiff: ch_(cornerWithPhoto, cornerPlain) <= 10 };
    });

    // --- UI collapse ---
    await page.click('#uiToggle');
    R.uiHiddenAfterToggle = await page.evaluate(() => document.body.classList.contains('ui-hidden'));
    R.titleHidden = await page.evaluate(() => getComputedStyle(document.querySelector('#ui .title')).display === 'none');
    R.toggleVisible = await page.isVisible('#uiToggle');
    await page.keyboard.press('KeyH');
    R.uiShownAfterH = await page.evaluate(() => !document.body.classList.contains('ui-hidden'));

    // --- запись webm ---
    try {
      const dl = page.waitForEvent('download', { timeout: 15000 });
      await page.click('#recBtn');
      await page.waitForTimeout(2500);
      await page.click('#recBtn');
      const d = await dl;
      await d.saveAs(`${OUT}/recorded.webm`);
      R.recording = fs.statSync(`${OUT}/recorded.webm`).size + ' bytes';
    } catch (e) { R.recording = 'FAIL: ' + String(e).slice(0, 160); }

    R.fps = await page.evaluate(() => Math.round(S.fps));
    R.label = await page.evaluate(() => document.getElementById('effectSelect').selectedOptions[0].text);
  } catch (e) {
    R.error = String(e).slice(0, 400);
  } finally {
    R.consoleErrors = consoleErrs.slice(0, 10);
    console.log(JSON.stringify(R, null, 2));
    await browser.close();
  }
})();
