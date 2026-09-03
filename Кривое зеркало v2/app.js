"use strict";
/*
 * app.js — v2 «Кривого зеркала». Связка: источники видео, GL-рендер, лица, запись.
 *
 * Отличия от v1 (папка «Кривое зеркало» в LOTS):
 *  - эффекты считаются на GPU (WebGL2), а не попиксельным JS по ImageData;
 *  - четыре источника вместо одного: файл / URL (CORS) / экран / камера;
 *  - распознавание и трекинг лиц (MediaPipe FaceLandmarker, офлайн-бандл в vendor/);
 *  - режимы маски: эффект только на лице / кроме лица + отрисовка контуров;
 *  - экспорт: запись обработанного видео (MediaRecorder) и PNG-кадр;
 *  - исправлены баги v1: нет слушателя change у select, остановка по ended трека
 *    (а не video.onended), отсутствие willReadFrequently — здесь уже не актуально.
 */

const $ = (id) => document.getElementById(id);
const VENDOR = (document.baseURI || location.href).replace(/[^/]*$/, '') + 'vendor/';

const el = {
  video: $('sourceVideo'),
  glCanvas: $('glCanvas'),
  overlay: $('overlayCanvas'),
  octx: $('overlayCanvas').getContext('2d'),
  stage: $('stage'),
  startFile: $('startFile'), startUrl: $('startUrl'), startScreen: $('startScreen'),
  startCam: $('startCam'), stopBtn: $('stopBtn'), playBtn: $('playBtn'),
  fsBtn: $('fsBtn'), recBtn: $('recBtn'), snapBtn: $('snapBtn'),
  fileInput: $('fileInput'), urlInput: $('urlInput'), urlPanel: $('urlPanel'),
  effectSelect: $('effectSelect'), paramsPanel: $('paramsPanel'),
  faceToggle: $('faceToggle'), vizToggle: $('vizToggle'), monitorToggle: $('monitorToggle'),
  statusLine: $('statusLine'), perfLine: $('perfLine'),
  audioEl: $('audioMonitor'),
};

const S = {
  renderer: null,
  tracker: null,
  faceOn: false,
  faces: [],
  stream: null,
  objUrl: null,
  frame: 0,
  t0: performance.now(),
  fps: 0,
  rec: null,
  chunks: [],
  taintWarned: false,
  sourceName: 'нет',
  running: false,
};

/* ---------------- параметры эффектов (слайдеры) ---------------- */
const P = {
  effect: 1, maskMode: 0,
  ampX: 15, ampY: 15, waveLenX: 120, waveLenY: 120, speed: 1, strength: 0.6, block: 14,
  expand: 0.12, feather: 10,
};
function bindSlider(id, key, isFloat = true) {
  const inp = $(id), out = $(id + 'Val');
  const upd = () => {
    P[key] = isFloat ? parseFloat(inp.value) : parseInt(inp.value, 10);
    if (out) out.textContent = inp.value;
  };
  inp.addEventListener('input', upd);
  upd();
}
bindSlider('ampX', 'ampX'); bindSlider('ampY', 'ampY');
bindSlider('waveLenX', 'waveLenX'); bindSlider('waveLenY', 'waveLenY');
bindSlider('speed', 'speed'); bindSlider('strength', 'strength');
bindSlider('block', 'block'); bindSlider('expand', 'expand'); bindSlider('feather', 'feather');

/* ---------------- статус ---------------- */
let statusTimer = 0;
function setStatus(msg, kind = 'info') {
  el.statusLine.textContent = msg;
  el.statusLine.style.color = kind === 'err' ? '#ff7b7b' : kind === 'ok' ? '#7bffb0' : '#cfd6e4';
}

/* ---------------- источники ---------------- */
function stopCurrent() {
  if (S.rec) stopRecording();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  if (S.objUrl) { URL.revokeObjectURL(S.objUrl); S.objUrl = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.srcObject = null;
  el.video.load();
  el.audioEl.srcObject = null;
  if (S.tracker) S.tracker.reset();
  S.faces = [];
  S.taintWarned = false;
  S.sourceName = 'нет';
  setStatus('Источник выключен');
}

function attachStream(stream, name, muted) {
  S.stream = stream;
  el.video.srcObject = stream;
  el.video.muted = muted;
  if (!muted) el.video.muted = true; // звук — отдельным <audio> при включённом мониторе
  el.video.play().catch(e => setStatus('Браузер не дал autoplay: ' + e.name, 'err'));
  S.sourceName = name;
  const vt = stream.getVideoTracks()[0];
  if (vt) vt.addEventListener('ended', () => stopCurrent()); // корректная остановка шаринга (в v1 это был video.onended — ненадёжно)
  setStatus(`Источник: ${name}. Идёт обработка…`, 'ok');
}

el.startFile.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  stopCurrent();
  S.objUrl = URL.createObjectURL(f);
  el.video.src = S.objUrl;
  el.video.loop = true;
  el.video.muted = false;
  S.sourceName = 'файл: ' + f.name;
  await el.video.play().catch(e => setStatus('Нажмите ▶ (autoplay заблокирован): ' + e.name, 'err'));
  setStatus(`Источник: файл «${f.name}». Можно включать лица и эффекты.`, 'ok');
});

el.startUrl.addEventListener('click', () => {
  el.urlPanel.style.display = el.urlPanel.style.display === 'none' ? 'block' : 'none';
  el.urlInput.focus();
});
el.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openUrl(); });
$('urlGo').addEventListener('click', openUrl);
function openUrl() {
  const url = el.urlInput.value.trim();
  if (!url) return;
  stopCurrent();
  el.video.crossOrigin = 'anonymous';
  el.video.src = url;
  el.video.loop = true;
  el.video.muted = false;
  S.sourceName = 'URL';
  el.video.onerror = () => setStatus(
    'Не удалось загрузить URL. Причины: 404, отсутствие CORS-заголовков у сервера или это страница (не прямой файл). ' +
    'Для защищённого DRM контента (Кинопоиск/Netflix/…) такой путь в принципе невозможен — используйте захват экрана.', 'err');
  el.video.play().catch(() => {});
  setStatus('Открываю URL… (нужен прямой файл видео с CORS: allow-origin)');
}

el.startScreen.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setStatus('getDisplayMedia недоступен (нужен HTTPS или localhost, и это не sandbox-iframe)', 'err'); return;
  }
  try {
    stopCurrent();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } },
      audio: true,
      selfBrowserSurface: 'include',
    });
    attachStream(stream, 'экран', true);
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? 'Захват экрана отменён' : 'Ошибка захвата: ' + e.message, 'err');
  }
});

el.startCam.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('getUserMedia недоступен в этом окружении', 'err'); return;
  }
  try {
    stopCurrent();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    attachStream(stream, 'камера', true);
  } catch (e) {
    setStatus('Камера недоступна: ' + e.name, 'err');
  }
});

el.stopBtn.addEventListener('click', stopCurrent);
el.playBtn.addEventListener('click', () => {
  if (el.video.paused) el.video.play().catch(() => {}); else el.video.pause();
});

el.monitorToggle.addEventListener('change', () => {
  if (el.monitorToggle.checked && S.stream) {
    el.audioEl.srcObject = S.stream;
    el.audioEl.play().catch(() => {});
  } else {
    el.audioEl.pause();
    el.audioEl.srcObject = null;
  }
});

/* ---------------- лица ---------------- */
el.faceToggle.addEventListener('change', async () => {
  if (!el.faceToggle.checked) {
    S.faceOn = false;
    if (S.tracker) S.tracker.reset();
    S.faces = [];
    el.octx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    setStatus('Распознавание лиц выключено');
    return;
  }
  try {
    if (!S.tracker) S.tracker = new FaceTracker(VENDOR);
    setStatus('Загружаю модель лиц (MediaPipe FaceLandmarker)…');
    await S.tracker.load();
    S.faceOn = true;
    setStatus(`Детектор лиц готов (делегат: ${S.tracker.delegate}). Лица отслеживаются в реальном времени.`, 'ok');
  } catch (e) {
    setStatus('Не удалось загрузить детектор лиц: ' + (e.message || e) +
      ' (в sandbox-превью динамические import могут блокироваться — откройте страницу в обычной вкладке)', 'err');
    el.faceToggle.checked = false;
  }
});

/* ---------------- запись / снапшот ---------------- */
function pickMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRecording() {
  if (!S.renderer || !el.glCanvas.width) { setStatus('Нет видеопотока для записи', 'err'); return; }
  const cs = el.glCanvas.captureStream(30);
  if (S.stream) for (const t of S.stream.getAudioTracks()) cs.addTrack(t);
  const rec = new MediaRecorder(cs, pickMime() ? { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 } : undefined);
  S.chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(S.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `krivoe-zerkalo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus('Запись сохранена в .webm (обработанные кадры + звук источника)', 'ok');
  };
  rec.start(2000);
  S.rec = rec;
  el.recBtn.textContent = '⏹ Остановить запись';
  setStatus('Идёт запись обработанного видео…');
}
function stopRecording() {
  if (S.rec && S.rec.state !== 'inactive') S.rec.stop();
  S.rec = null;
  el.recBtn.textContent = '⏺ Запись webm';
}
el.recBtn.addEventListener('click', () => (S.rec ? stopRecording() : startRecording()));
el.snapBtn.addEventListener('click', () => {
  if (!S.renderer) return;
  const a = document.createElement('a');
  a.href = S.renderer.snapshotPNG();
  a.download = 'frame.png';
  a.click();
});

/* ---------------- полноэкранный режим ---------------- */
el.fsBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  el.fsBtn.textContent = document.fullscreenElement ? '✖ Свернуть' : '⛶ Во весь экран';
});

/* ---------------- главный цикл ---------------- */
function readUI() {
  P.effect = EFFECT_IDS[el.effectSelect.value] ?? 0;
  const mm = $('maskMode') ? $('maskMode').value : 'off';
  P.maskMode = S.faceOn ? (mm === 'inside' ? 1 : mm === 'outside' ? 2 : 0) : 0;
}
$('maskMode') && $('maskMode').addEventListener('change', () => {
  if (el.faceToggle.checked && $('maskMode').value !== 'off' && !S.faceOn) el.faceToggle.click();
});
el.effectSelect.addEventListener('change', () => {
  // в v1 этот обработчик отсутствовал — панель настроек не скрывалась/не показывалась
  const v = el.effectSelect.value;
  el.paramsPanel.style.display = (v === 'none' || v === 'invert' || v === 'grayscale' || v === 'mirror') ? 'none' : 'block';
  readUI();
});

// letterbox:.stage получает явные размеры под аспект видео (CSS-трюк с calc()/aspect-ratio
// через var() ломается textual substitution'ом — проверено headless-тестом)
function fitStage() {
  const d = S.vSize;
  if (!d || !d[1]) return;
  const war = innerWidth / Math.max(1, innerHeight);
  const ar = d[0] / d[1];
  let w, h;
  if (ar > war) { w = innerWidth; h = Math.round(w / ar); }
  else { h = innerHeight; w = Math.round(h * ar); }
  el.stage.style.width = w + 'px';
  el.stage.style.height = h + 'px';
}
window.addEventListener('resize', fitStage);

let lastT = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const v = el.video;
  const dt = now - lastT; lastT = now;
  if (dt > 0) S.fps = S.fps ? S.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
  if (!S.renderer || v.readyState < 2 || !v.videoWidth) return;

  readUI();
  S.frame++;

  const vw = v.videoWidth | 0, vh = v.videoHeight | 0;

  // синхронизация размеров GL-канваса и оверлея (у v1 это было только на onplay — размер больше не обновлялся)
  if (el.glCanvas.width !== vw || el.glCanvas.height !== vh) {
    el.overlay.width = vw; el.overlay.height = vh;
    S.vSize = [vw, vh];
    fitStage();
  }

  if (S.faceOn && S.tracker && S.tracker.landmarker && S.frame % 2 === 0) {
    S.faces = S.tracker.process(v, { maxW: 480 });
    S.tracker.buildMask(vw, vh, P.expand / 100, P.feather); // слайдер 0..60 -> 0.00..0.60
  }

  const mask = (S.faceOn && S.tracker && P.maskMode > 0) ? S.tracker.mask : null;
  S.renderer.draw(v, mask, {
    time: (now - S.t0) / 1000,
    ampX: P.ampX, ampY: P.ampY, waveLenX: P.waveLenX, waveLenY: P.waveLenY,
    speed: P.speed, strength: P.strength, block: P.block,
    effect: P.effect, maskMode: P.maskMode,
  });

  if (S.renderer.tainted && !S.taintWarned) {
    S.taintWarned = true;
    setStatus('Кадр недоступен для обработки: кросс-доменное видео без CORS или DRM-защита (захват DRM-вкладок показывает чёрный экран). ' +
      'Варианты: локальный файл, URL с CORS, либо экран без DRM-плеера.', 'err');
  }

  // оверлей контуров лиц
  const showViz = S.faceOn && el.vizToggle.checked;
  if (showViz) S.tracker.drawOverlay(el.octx, vw, vh);
  else if (el.overlay.width && (S.frame % 2 === 0)) el.octx.clearRect(0, 0, vw, vh);

  if (now - statusTimer > 500) {
    statusTimer = now;
    const f = S.faces.length;
    const det = S.faceOn && S.tracker ? ` · дет.: ${S.faces.length ? S.tracker.lastMs.toFixed(0) + 'ms' : '—'}` : '';
    el.perfLine.textContent = `${S.fps.toFixed(0)} fps${det} · лиц: ${f} · режим: ${el.effectSelect.selectedOptions[0].text}${P.maskMode ? ' + маска ' + $('maskMode').value : ''}`;
  }
}

/* ---------------- init ---------------- */
try {
  S.renderer = new GLRenderer(el.glCanvas);
  S.renderer.onTaint = () => {};
  setStatus('Готово. Выберите источник: файл, URL, экран или камеру.', 'ok');
} catch (e) {
  setStatus('Ошибка WebGL2: ' + e.message, 'err');
}
S.t0 = performance.now();
requestAnimationFrame(tick);
