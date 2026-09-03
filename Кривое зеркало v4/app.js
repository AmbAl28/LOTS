"use strict";
/*
 * app.js — Crooked Mirror v4: «кривое зеркало» для лиц.
 * Готовые смешные пресеты (без слайдеров) + эмодзи/фото вместо лица + рандом по ракурсу.
 * Эффекты: WebGL2 (gl.js); лица: MediaPipe FaceLandmarker (faces.js), всё офлайн из vendor/.
 * Приватность: никаких сетевых запросов кроме локального бандла; consent-модалка при входе.
 */

const $ = (id) => document.getElementById(id);
const VENDOR = (document.baseURI || location.href).replace(/[^/]*$/, '') + 'vendor/';

const el = {
  video: $('sourceVideo'),
  glCanvas: $('glCanvas'),
  overlay: $('overlayCanvas'),
  octx: $('overlayCanvas').getContext('2d'),
  stage: $('stage'),
  startFile: $('startFile'), startScreen: $('startScreen'), startCam: $('startCam'),
  stopBtn: $('stopBtn'), playBtn: $('playBtn'),
  fsBtn: $('fsBtn'), recBtn: $('recBtn'), snapBtn: $('snapBtn'),
  aboutBtn: $('aboutBtn'), uiToggle: $('uiToggle'),
  fileInput: $('fileInput'),
  effectSelect: $('effectSelect'), maskMode: $('maskMode'),
  emojiSelect: $('emojiSelect'), emojiRandom: $('emojiRandom'),
  faceImage: $('faceImage'), resetBtn: $('resetBtn'), emojiFit: $('emojiFit'),
  policyModal: $('policyModal'), aboutModal: $('aboutModal'),
  statusLine: $('statusLine'), perfLine: $('perfLine'),
};

let pendingStart = false;
/* ---------------- consent (простая политика) ---------------- */
const CONSENT_KEY = 'cr…t-v1';
let consentOk = false;
function consentNeeded() {
  if (consentOk) return false;
  try { return localStorage.getItem(CONSENT_KEY) !== '1'; } catch (e) { return true; }
}
function grantConsent() {
  consentOk = true;
  try { localStorage.setItem(CONSENT_KEY, '1'); } catch (e) { /* storage недоступен — работаем в памяти */ }
}
if (consentNeeded()) {
  el.policyModal.hidden = false;
  $('policyAccept').addEventListener('click', () => {
    grantConsent();
    el.policyModal.hidden = true;
    start();
  });
  $('policyDecline').addEventListener('click', () => {
    document.body.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#cfd6e4;font-family:system-ui;text-align:center;padding:24px">' +
      'Без согласия на обработку изображения в этой вкладке приложение не работает — оно ничего не умеет без доступа к лицам.<br>Можно перезагрузить и передумать.</div>';
  });
} else {
  pendingStart = true;
}

/* ---------------- состояние ---------------- */
const S = {
  renderer: null,
  tracker: null,
  faces: [],
  largest: null,
  emojiCache: new Map(),
  photoCanvas: null,
  photoName: '',
  stream: null,
  objUrl: null,
  sourceKind: 'none',
  frame: 0,
  t0: performance.now(),
  fps: 0,
  rec: null,
  chunks: [],
  presetKey: 'none',
  presetRandomT: 0,
  emojiLastScore: null,
  emojiLastFlip: 0,
  emojiLastT: 0,
  started: false,
};

/* ---------------- каталог эффектов ---------------- */
// mode0 — ручные: гейт maskMode; centers — кадр. mode1 — лицевые: blend по маске, центры по фичам.
const MANUAL = {
  none:        {},
  wave:        { warp: 1, ampX: 16, ampY: 16, waveLenX: 130, waveLenY: 130, speed: 1, animate: 1 },
  bulge:       { warp: 2, strength: 0.55, speed: 1, animate: 1 },
  twist:       { warp: 7, strength: 0.5, speed: 1, animate: 1 },
  ripple:      { warp: 8, strength: 1.0, speed: 1.2, animate: 1 },
  pixelate:    { warp: 6, block: 14 },
  mirror:      { mirror: 1 },
  invert:      { colorOp: 1 },
  grayscale:   { colorOp: 2 },
};
// r — множитель радиуса; rf — база радиуса: mw — ширина рта, ew — межзрачковое, fh/fw — лицо
const PRESETS = {
  // v4: пресеты больше не являются «круглыми лупами поверх лица».
  // Для рта/глаз/щёк используются анатомические центры и специальные локальные варпы.
  cheeshire:     { warp: 10, c: 'mouthC', rf: 'mw', r: 1.55, strength: 0.92, colorOp: 6 },
  bigmouth:      { warp: 10, c: 'mouthC', rf: 'mw', r: 1.85, strength: 1.15 },
  minihead:      { warp: 2,  c: 'faceC',  rf: 'fw', r: 0.86, strength: -0.62 },
  fatface:       { warp: 12, c: 'cheekL', rf: 'ew', r: 0.72, strength: 0.55, ex: { c: 'cheekR', rf: 'ew', r: 0.72, strength: 0.55 } },
  cathole:       { warp: 0,  c: 'eyeL',   rf: 'ew', r: 0.31, strength: 1.0,  ex: { c: 'eyeR', rf: 'ew', r: 0.31, strength: 1.0 }, colorOp: 4 },
  bulleyes:      { warp: 11, c: 'eyeL',   rf: 'ew', r: 1.0,  strength: 0.95, ex: { c: 'eyeR', rf: 'ew', r: 1.0,  strength: 0.95 }, colorOp: 8 },
  bloathead:     { warp: 2,  c: 'faceC',  rf: 'fh', r: 0.95, strength: 0.85 },
  pinhead:       { warp: 13, c: 'faceC',  rf: 'fh', r: 1.03, strength: -0.82, ex: { c: 'nose', rf: 'ew', r: 0.42, strength: 0.45 } },
  cathole_warp:  { warp: 7,  c: 'nose',   rf: 'fh', r: 0.92, strength: 0.92, speed: 0.55, animate: 1 },
  fishlips:      { warp: 10, c: 'mouthC', rf: 'mw', r: 1.25, strength: 0.75, colorOp: 7 },
  melty:         { warp: 9,  c: 'nose',   rf: 'fh', r: 1.1,  strength: 0.75, speed: 0.38, animate: 1 },
  spooky:        { warp: 9,  c: 'nose',   rf: 'fh', r: 1.25, strength: -1.1 },
  caterpillar:   { warp: 15, c: 'faceC',  rf: 'fh', r: 1.05, strength: 0.65, ampX: 18, ampY: 5, waveLenX: 190, waveLenY: 155, speed: 0.25, animate: 1 },
  twirlface:     { warp: 7,  c: 'nose',   rf: 'fh', r: 1.05, strength: -0.72, speed: 0.40, animate: 1 },
  wobbleface:    { warp: 1,  c: 'faceC',  rf: 'fh', r: 1.05, strength: 0.4, ampX: 9, ampY: 8, waveLenX: 150, waveLenY: 170, speed: 0.28, animate: 1 },
  bubbleface:    { warp: 14, c: 'nose',   rf: 'fh', r: 1.0,  strength: 0.35 },
  rippleface:    { warp: 8,  c: 'nose',   rf: 'fh', r: 1.0,  strength: 0.65, speed: 0.32, animate: 1 },
  flipface:      { mirror: 2, c: 'faceC', rf: 'fw', r: 1.0 },
  sketchface:    { colorOp: 3 },
  blacksketch:   { colorOp: 5 },
  negativeface:  { colorOp: 1 },
  pixelmask:     { warp: 6, block: 20 },

  // Новые статичные «кривые зеркала»: эффект включился и держится, без мельтешения.
  bignose:       { warp: 2,  c: 'nose',   rf: 'ew', r: 0.62, strength: 0.88 },
  narrowface:    { warp: 16, c: 'faceC',  rf: 'fh', r: 1.05, strength: 0.70 },
  tinyeyes:      { warp: 11, c: 'eyeL',   rf: 'ew', r: 1.0,  strength: -0.75, ex: { c: 'eyeR', rf: 'ew', r: 1.0, strength: -0.75 } },
  longnose:      { warp: 17, c: 'nose',   rf: 'ew', r: 1.0,  strength: 0.82 },
  sleepywave:    { warp: 15, c: 'faceC',  rf: 'fh', r: 1.05, strength: 0.7, ampX: 14, ampY: 7, waveLenX: 260, waveLenY: 210 },
  waxdrop:       { warp: 18, c: 'faceC',  rf: 'fh', r: 1.05, strength: 0.78 },
};

const EMOJI_NAMES = {
  '\u{1F602}': 'ржёт', '\u{1F60D}': 'влюблён', '\u{1F92A}': 'чокнутый', '\u{1F621}': 'злой',
  '\u{1F631}': 'крик', '\u{1F976}': 'замёрз', '\u{1F634}': 'сон', '\u{1F480}': 'череп',
  '\u{1F921}': 'клоун', '\u{1F383}': 'тыква', '\u{1F47D}': 'пришелец', '\u{1F92F}': 'взрыв мозга',
  '\u{1F973}': 'вечеринка', '\u{1F60E}': 'крутой', '\u{1F914}': 'думающий', '\u{1F607}': 'ангел',
  '\u{1FAE0}': 'тает', '\u{1F438}': 'квакушка', '\u{1F435}': 'обезьяна', '\u{1F31A}': 'луна',
  '\u{1F525}': 'огонь', '\u{1F4A9}': 'сюрприз', '\u{1F984}': 'единорог', '\u{1F354}': 'бургер',
  '\u{1F440}': 'глазищи', '\u{1F916}': 'бот', '\u{1F3A9}': 'шляпа', '\u{1FAE3}': 'стыд',
};
const EMOJIS = Object.keys(EMOJI_NAMES);

(function buildEmojiSelect() {
  const sel = el.emojiSelect;
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '— выкл —';
  sel.appendChild(o0);
  for (const e of EMOJIS) {
    const o = document.createElement('option');
    o.value = e; o.textContent = e + ' ' + EMOJI_NAMES[e];
    sel.appendChild(o);
  }
})();

/* ---------------- параметры UI ---------------- */
const DEFAULTS = { maskMode: 0, expand: 0.12, feather: 12, emojiScale: 1, randInterval: 1.6, wobble: true, viz: false, emojiFit: 'rotate' };
const P = { ...DEFAULTS };
function bindSlider(id, key, div = 1) {
  const inp = $(id), out = $(id + 'Val');
  const upd = () => {
    P[key] = parseFloat(inp.value) / div;
    if (out) out.textContent = (div === 1 ? inp.value : (inp.value / 100).toFixed(2));
  };
  if (inp) { inp.addEventListener('input', upd); upd(); }
}
bindSlider('expand', 'expand', 100);   // слайдер 0..60 -> 0.00..0.60 (множитель раздувания hull)
bindSlider('feather', 'feather');
bindSlider('emojiScale', 'emojiScale', 100);
bindSlider('randInterval', 'randInterval');

// maskMode: только для ручных эффектов (лицевые пресеты всегда blend по маске)
const MASK_MODES = { all: 0, inside: 1, outside: 2 };
function syncMaskMode() { P.maskMode = MASK_MODES[el.maskMode.value] | 0; }
el.maskMode.addEventListener('change', syncMaskMode);
syncMaskMode();

const wob = $('emojiWobble');
if (wob) { P.wobble = wob.checked; wob.addEventListener('change', () => { P.wobble = wob.checked; }); }
if (el.emojiFit) { P.emojiFit = el.emojiFit.value; el.emojiFit.addEventListener('change', () => { P.emojiFit = el.emojiFit.value; }); }
el.emojiRandom.addEventListener('change', () => {
  if (el.emojiRandom.checked) {
    if (!el.emojiSelect.value) flipEmoji();           // включили рандом без эмодзи — дать случайный
    S.emojiLastScore = null; S.emojiLastT = 0;        // обнулить детектор ракурса
  }
});

/* ---------------- статус ---------------- */
function setStatus(msg, kind = 'info') {
  if (!el.statusLine) return;
  el.statusLine.textContent = msg;
  el.statusLine.className = kind;
}

/* ---------------- лица ---------------- */
async function ensureFaces() {
  if (S.tracker && S.tracker.landmarker) return true;
  if (!S.tracker) S.tracker = new FaceTracker(VENDOR);
  try {
    await S.tracker.load();
    setStatus(`Детектор лиц готов (делегат: ${S.tracker.delegate}).`, 'ok');
    return true;
  } catch (e) {
    setStatus('Не удалось загрузить детектор лиц: ' + (e.message || e) + ' — эффекты на весь кадр всё равно работают.', 'err');
    return false;
  }
}

/* ---------------- слои: эмодзи / фото ---------------- */
function emojiCanvas(ch) {
  if (S.emojiCache.has(ch)) return S.emojiCache.get(ch);
  const t = 384;
  const c = document.createElement('canvas');
  c.width = t; c.height = t;
  const g = c.getContext('2d');
  const font = (sz) => `${sz}px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Twemoji Mozilla",system-ui,sans-serif`;
  g.clearRect(0, 0, t, t);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let fs = t * 1.02;
  g.font = font(fs);
  const w = g.measureText(ch).width || fs;
  const k = Math.min(1, (t * 1.08) / Math.max(w, fs * 0.92));
  if (k < 1) { fs *= k; g.font = font(fs); }
  g.fillText(ch, t / 2, t / 2 + t * 0.02);
  S.emojiCache.set(ch, c);
  return c;
}

el.faceImage.addEventListener('change', () => {
  const f = el.faceImage.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    const cap = 768;
    const sc = Math.min(1, cap / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.max(4, Math.round(img.naturalWidth * sc));
    c.height = Math.max(4, Math.round(img.naturalHeight * sc));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    S.photoCanvas = c;
    S.photoName = f.name;
    el.emojiSelect.value = '';            // фото приоритетнее, пока эмодзи не выбран
    setStatus(`Фото «${f.name}» готово — выберите в эффектах пресет (или «оригинал»), лицо заменится.`, 'ok');
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { setStatus('Не удалось прочитать картинку.', 'err'); URL.revokeObjectURL(url); };
  img.src = url;
});

function setSliderValue(id, value) {
  const inp = $(id);
  if (!inp) return;
  inp.value = String(value);
  inp.dispatchEvent(new Event('input'));
}
function resetEffects(opts = {}) {
  el.effectSelect.value = 'none';
  S.presetKey = 'none';
  const pr = $('presetRandom'); if (pr) pr.checked = false;
  el.maskMode.value = 'all'; syncMaskMode();
  setSliderValue('expand', 12);
  setSliderValue('feather', 12);
  setSliderValue('emojiScale', 100);
  setSliderValue('randInterval', 1.6);
  el.emojiSelect.value = '';
  el.emojiRandom.checked = false;
  if (wob) { wob.checked = true; P.wobble = true; }
  if (el.emojiFit) { el.emojiFit.value = 'rotate'; P.emojiFit = 'rotate'; }
  if (!opts.keepPhoto) {
    S.photoCanvas = null; S.photoName = '';
    if (el.faceImage) el.faceImage.value = '';
  }
  S.emojiLastScore = null; S.emojiLastFlip = 0; S.emojiLastT = 0;
  setStatus('Сброшено: оригинал без эффектов, без эмодзи/фото, настройки стандартные.', 'ok');
}
if (el.resetBtn) el.resetBtn.addEventListener('click', () => resetEffects());

/* ---------------- источники ---------------- */
function stopCurrent() {
  if (S.rec) stopRecording();
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  if (S.objUrl) { URL.revokeObjectURL(S.objUrl); S.objUrl = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.srcObject = null;
  el.video.load();
  if (S.tracker) S.tracker.reset();
  S.faces = []; S.largest = null;
  el.octx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  S.sourceKind = 'none';
}

el.startFile.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  stopCurrent();
  resetEffects();
  S.objUrl = URL.createObjectURL(f);
  el.video.src = S.objUrl;
  el.video.loop = true;
  el.video.muted = false;
  S.sourceKind = 'file';
  await el.video.play().catch(e => setStatus('Нажмите ▶ (браузер ждёт жеста): ' + e.name, 'err'));
  await ensureFaces();
  setStatus(`Файл «${f.name}» — готово. По умолчанию включён оригинал без эффекта.`, 'ok');
});

el.startScreen.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setStatus('Захват экрана недоступен (нужен HTTPS/localhost, вне sandbox-iframe).', 'err'); return;
  }
  try {
    stopCurrent();
    resetEffects();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } },
      audio: true,
      selfBrowserSurface: 'include',
    });
    S.stream = stream;
    S.sourceKind = 'screen';
    el.video.srcObject = stream;
    el.video.muted = true;   // звук остаётся у самой вкладки; при записи дорожка подмешивается
    await el.video.play().catch(() => {});
    const vt = stream.getVideoTracks()[0];
    if (vt) vt.addEventListener('ended', stopCurrent);
    await ensureFaces();
    setStatus('Экран транслируется. По умолчанию включён оригинал без эффекта.', 'ok');
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? 'Захват экрана отменён' : 'Ошибка захвата: ' + e.message, 'err');
  }
});

el.startCam.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Камера недоступна в этом окружении.', 'err'); return;
  }
  try {
    stopCurrent();
    resetEffects();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    S.stream = stream;
    S.sourceKind = 'cam';
    el.video.srcObject = stream;
    el.video.muted = true;
    await el.video.play().catch(() => {});
    const vt = stream.getVideoTracks()[0];
    if (vt) vt.addEventListener('ended', stopCurrent);
    await ensureFaces();
    setStatus('Камера включена. По умолчанию включён оригинал без эффекта.', 'ok');
  } catch (e) {
    setStatus('Камера недоступна: ' + e.name, 'err');
  }
});

el.stopBtn.addEventListener('click', () => { stopCurrent(); setStatus('Источник выключен'); });
el.playBtn.addEventListener('click', () => {
  if (el.video.paused) el.video.play().catch(() => {}); else el.video.pause();
});

/* ---------------- интерфейс: collapse, модалки, фуллскрин ---------------- */
function setCollapsed(on) {
  document.body.classList.toggle('ui-hidden', on);
  el.uiToggle.textContent = on ? '🪞' : '✕';
  el.uiToggle.title = on ? 'Показать интерфейс (H)' : 'Свернуть интерфейс (H)';
}
el.uiToggle.addEventListener('click', () => setCollapsed(!document.body.classList.contains('ui-hidden')));
window.addEventListener('keydown', (e) => {
  if ((e.key === 'h' || e.key === 'H' || e.key === 'р' || e.key === 'Р') && !e.ctrlKey && !e.metaKey && !e.altKey)
    setCollapsed(!document.body.classList.contains('ui-hidden'));
});
el.aboutBtn.addEventListener('click', () => { el.aboutModal.hidden = false; });
$('aboutClose').addEventListener('click', () => { el.aboutModal.hidden = true; });
el.aboutModal.addEventListener('click', (e) => { if (e.target === el.aboutModal) el.aboutModal.hidden = true; });
el.fsBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  el.fsBtn.textContent = document.fullscreenElement ? '✖' : '⛶';
});

/* ---------------- выбор эффекта / рандом ---------------- */
function currentEffectKey() { return $('presetRandom').checked ? S.presetKey : el.effectSelect.value; }
el.effectSelect.addEventListener('change', () => {
  S.presetKey = el.effectSelect.value in PRESETS ? el.effectSelect.value : S.presetKey;
  if ($('presetRandom').checked) $('presetRandom').checked = false; // ручная смена отменяет рандом
});
$('presetRandom').addEventListener('change', () => {
  if ($('presetRandom').checked) { S.presetRandomT = performance.now() + P.randInterval * 1000; flipPreset(true); }
});
function flipPreset(force) {
  const keys = Object.keys(PRESETS);
  let k = keys[(Math.random() * keys.length) | 0];
  if (!force) { let guard = 0; while (k === S.presetKey && guard++ < 8) k = keys[(Math.random() * keys.length) | 0]; }
  S.presetKey = k;
  el.effectSelect.value = k;
}
function flipEmoji() {
  if (!EMOJIS.length) return;
  let e = el.emojiSelect.value;
  const others = EMOJIS.filter((x) => x !== e);
  e = others[(Math.random() * others.length) | 0];
  el.emojiSelect.value = e;
  el.emojiSelect.dispatchEvent(new Event('change'));
}
el.emojiSelect.addEventListener('change', () => {
  if (el.emojiSelect.value) {
    setStatus('Эмодзи «' + el.emojiSelect.value + '» поверх лиц. Снимите галку 🎲, если надоело меняться.', 'ok');
  } else if (S.photoCanvas) {
    setStatus('Обратно включена фото-замена: «' + S.photoName + '»', 'ok');
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
  if (S.sourceKind === 'file' && el.video.captureStream) {
    try { for (const t of el.video.captureStream().getAudioTracks()) cs.addTrack(t); } catch (e) { /* аудио опционально */ }
  }
  const rec = new MediaRecorder(cs, pickMime() ? { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 } : undefined);
  S.chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(S.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crooked-mirror-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus('Запись сохранена (.webm). Не забывайте предупреждать зрителей, что это шутка 🙂', 'ok');
  };
  rec.start(2000);
  S.rec = rec;
  el.recBtn.textContent = '⏹ Стоп запись';
  setStatus('Идёт запись обработанного видео…');
}
function stopRecording() {
  if (S.rec && S.rec.state !== 'inactive') S.rec.stop();
  S.rec = null;
  el.recBtn.textContent = '⏺ webm';
}
el.recBtn.addEventListener('click', () => (S.rec ? stopRecording() : startRecording()));
el.snapBtn.addEventListener('click', () => {
  if (!S.renderer) return;
  const a = document.createElement('a');
  a.href = S.renderer.snapshotPNG();
  a.download = 'crooked-mirror-frame.png';
  a.click();
});

/* ---------------- резолвинг эффекта в параметры шейдера ---------------- */
function featSize(feat, f, rf) {
  if (rf === 'mw') return feat.mouthW;
  if (rf === 'ew') return feat.eyeDist;
  if (rf === 'fh') return Math.max(f.bh, 24);
  if (rf === 'fw') return Math.max(f.bw, 24);
  return Math.max(f.bw, f.bh, 24);
}

function buildFrameParams(now, w, h) {
  const p = { time: (now - S.t0) / 1000, maskMode: P.maskMode };
  const key = currentEffectKey();
  const manual = MANUAL[key] !== undefined;
  const e = manual ? MANUAL[key] : (S.largest ? (PRESETS[key] || {}) : {});  // лицевой пресет без лица = passthrough
  const faceCapable = !manual && !!S.largest && S.faces.length > 0;

  p.warp = e.warp || 0;
  p.speed = e.speed == null ? 1 : e.speed;
  p.animate = e.animate ? 1 : 0;
  p.mirror = e.mirror || 0;
  p.colorOp = e.colorOp || 0;
  p.block = e.block || 14;
  p.ampX = e.ampX || 16;
  p.ampY = e.ampY || 16;
  p.waveLenX = e.waveLenX || 130;
  p.waveLenY = e.waveLenY || 130;
  p.strength = e.strength || 0;

  if (faceCapable) {
    p.mode = 1;
    const f = S.largest, feat = f.feat;
    const c = feat[e.c] || feat.faceC;
    p.center = [c[0], h - c[1]];                 // GL y-снизу
    p.radius = (e.r || 1) * featSize(feat, f, e.rf);
    if (e.ex) {
      const cx2 = feat[e.ex.c] || c;
      p.extra = [cx2[0], h - cx2[1], (e.ex.r || 1) * featSize(feat, f, e.ex.rf), e.ex.strength || 0.9];
    }
  } else {
    p.mode = 0;
    p.center = [w / 2, h / 2];
    p.radius = Math.min(w, h) * 0.9;
  }

  // слой эмодзи/фото
  const emojiCh = el.emojiSelect.value;
  if (emojiCh) {
    p.faceMode = 1;
    p.faceCanvas = emojiCanvas(emojiCh);
  } else if (S.photoCanvas) {
    p.faceMode = 2;
    p.faceCanvas = S.photoCanvas;
  } else {
    p.faceMode = 0;
  }
  if (p.faceMode && !(S.largest && S.tracker && S.tracker.landmarker)) p.faceMode = 0; // нет лиц — нет и слоя
  if (p.faceMode && S.largest && S.tracker) {
    const mode = p.faceMode === 1 ? 'emoji' : 'photo';
    const opt = { scale: P.emojiScale, fit: P.emojiFit };
    if (p.faceMode === 2) opt.aspect = S.photoCanvas.width / S.photoCanvas.height;
    if (p.faceMode === 1 && P.wobble) {
      opt.wobAmp = 0.05;
      opt.wobPhase = p.time * 6.5 + S.largest.id * 1.7;
    }
    const rr = S.tracker.rectFor(S.largest, w, h, mode, opt);
    if (rr) { p.rect = rr.rect; p.layerRot = (p.faceMode === 1 && P.emojiFit === 'rotate') ? (S.largest.feat.roll || 0) : 0; p.clips = (p.faceMode === 2) ? rr.clip : null; }
  }
  return p;
}

/* ---------------- рандом эмодзи по ракурсу ---------------- */
function maybeFlipEmoji(f, now) {
  if (!el.emojiRandom.checked || !el.emojiSelect.value || !f) { S.emojiLastScore = null; return; }
  const sc = FaceTracker.score(f);
  const sinceFlip = now - S.emojiLastFlip;
  const idle = now - S.emojiLastT > P.randInterval * 1000;
  if ((S.emojiLastScore !== null && sc !== S.emojiLastScore && sinceFlip > 350) || (idle && sinceFlip > 350)) {
    S.emojiLastScore = sc;
    S.emojiLastFlip = now;
    S.emojiLastT = now;
    flipEmoji();
  } else {
    if (S.emojiLastScore !== null) S.emojiLastScore = sc;
    S.emojiLastT = S.emojiLastT || now;
  }
}

/* ---------------- главный цикл ---------------- */
function fitStage() {
  const d = S.renderer && S.renderer.srcSize;
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

let lastStatus = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const v = el.video;
  if (!S.renderer || v.readyState < 2 || !v.videoWidth) return;

  const dt = now - (S.lastNow || now);
  S.lastNow = now;
  if (dt > 0) S.fps = S.fps ? S.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

  const w = v.videoWidth | 0, h = v.videoHeight | 0;
  if (el.glCanvas.width !== w || el.glCanvas.height !== h) {
    el.overlay.width = w; el.overlay.height = h;
    fitStage();
  }

  if (S.tracker && S.tracker.landmarker && S.frame % 2 === 0) {
    S.faces = S.tracker.process(v, { maxW: 480 });
    S.largest = S.faces.reduce((a, b) => (!a || b.bw * b.bh > a.bw * a.bh ? b : a), null);
    S.tracker.buildMask(w, h, P.expand, P.feather);
    if ($('presetRandom').checked && now > S.presetRandomT) {
      flipPreset(false);
      S.presetRandomT = now + P.randInterval * 1000;
    }
    maybeFlipEmoji(S.largest, now);
  }
  S.frame++;

  const p = buildFrameParams(now, w, h);
  p.maskCanvas = (S.tracker && S.tracker.landmarker) ? S.tracker.mask : null;
  S.renderer.draw(v, p);

  const showViz = $('vizToggle') && $('vizToggle').checked && S.tracker;
  if (showViz) S.tracker.drawOverlay(el.octx, w, h);
  else if (S.frame % 4 === 0) el.octx.clearRect(0, 0, w, h);

  if (S.renderer.tainted) setStatus('Кадр недоступен для чтения (DRM/безопасность источника) — попробуйте файл или камеру.', 'err');

  if (now - lastStatus > 400) {
    lastStatus = now;
    const f = S.faces.length;
    const opt = $('presetRandom') && $('presetRandom').checked ? ' 🎲' : '';
    const layer = el.emojiSelect.value ? ' ' + el.emojiSelect.value : (S.photoCanvas ? ' 🖼' + (S.photoName.length > 12 ? S.photoName.slice(0, 10) + '…' : S.photoName) : '');
    el.perfLine.textContent = `${S.fps.toFixed(0)} fps · лиц: ${f}${opt}${layer}`;
  }
}

/* ---------------- init ---------------- */
function start() {
  if (S.started) return;
  S.started = true;
  try {
    S.renderer = new GLRenderer(el.glCanvas);
    setStatus('Готово: включите 🎥 камеру, 🖥 экран или 📁 файл — и выбирайте эффект.', 'ok');
  } catch (e) {
    setStatus('Ошибка WebGL2: ' + e.message, 'err');
    return;
  }
  S.t0 = performance.now();
  requestAnimationFrame(tick);
  ensureFaces();  // автозагрузка модели лиц; при ошибке останутся ручные эффекты на весь кадр
}

/* запуск после объявления всех констант (consent-обработчик ниже сам зовёт start()) */
if (pendingStart) start();
