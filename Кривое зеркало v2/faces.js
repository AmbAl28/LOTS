"use strict";
/*
 * faces.js — распознавание лиц, трекинг и построение маски (v2 «Кривого зеркала»).
 *
 * Модель: Google MediaPipe FaceLandmarker (478 точек лица, 68-точечный аналог — too slow для realtime).
 * Работает целиком в браузере (WASM, при доступном GPU-делегате — WebGL2), офлайн: все файлы в vendor/.
 *
 * Пайплайн:
 *  1) кадр уменьшается до <=maxW px (детектору хватает 192–512 px) -> detectForVideo()
 *  2) находки сопоставляются со стабильными треками (по расстоянию центров) — так id лица не прыгают;
 *  3) точки сглаживаются EMA (иначе маска дрожит между кадрами детекции);
 *  4) по точкам строится выпуклая оболочка -> полигон маски на low-res canvas + feather-блюр -> GL-текстура.
 */

function convexHull(points) {
  // Andrew monotone chain; points: [[x,y],...] -> CCW hull
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

class FaceTracker {
  constructor(vendorBase) {
    this.vendorBase = vendorBase;
    this.landmarker = null;
    this.delegate = '';
    this.err = null;

    this.work = document.createElement('canvas');      // даунскейл для детекции
    this.wctx = this.work.getContext('2d');
    this.mask = document.createElement('canvas');      // маска low-res, текстурируется в GL
    this.mctx = this.mask.getContext('2d');

    this.tracks = [];
    this.nextId = 1;
    this.ts = 0;          // monotonic timestamp for detectForVideo
    this.lastMs = 0;      // время последней детекции
    this.faces = [];      // { id, hull (в пикселях видео), bbox } — для оверлея/экспорта
  }

  async load() {
    if (this.landmarker) return true;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const mod = await import(this.vendorBase + 'vision_bundle.mjs');
      const { FilesetResolver, FaceLandmarker } = mod;
      const fileset = await FilesetResolver.forVisionTasks(this.vendorBase + 'wasm');
      const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.vendorBase + 'face_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numFaces: 4,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      });
      try {
        this.landmarker = await make('GPU');
        this.delegate = 'GPU';
      } catch (e) {
        this.landmarker = await make('CPU');
        this.delegate = 'CPU';
      }
      return true;
    })().catch(e => { this.err = String(e && e.message || e); throw e; });
    return this._loading;
  }

  reset() {
    this.tracks = [];
    this.faces = [];
    this._clearMask();
  }

  _clearMask() {
    const g = this.mctx, c = g.canvas;
    if (!c.width) return;
    g.save(); g.filter = 'none';
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.restore();
  }

  /**
   * Один проход детекции + трекинга. Синхронный (WASM-вызов быстрый на low-res).
   * @returns {Array} треки с hull в пиксельных координатах видео
   */
  process(video, opts) {
    const vw = video.videoWidth | 0, vh = video.videoHeight | 0;
    if (!this.landmarker || vw < 2 || vh < 2) { this.faces = []; return this.faces; }

    const scale = Math.min(1, (opts.maxW || 480) / vw);
    const dw = Math.max(2, Math.round(vw * scale)), dh = Math.max(2, Math.round(vh * scale));
    if (this.work.width !== dw || this.work.height !== dh) { this.work.width = dw; this.work.height = dh; }
    this.wctx.drawImage(video, 0, 0, dw, dh);

    this.ts = Math.max(this.ts + 1, Math.round(performance.now()));
    let res;
    const t0 = performance.now();
    try { res = this.landmarker.detectForVideo(this.work, this.ts); }
    catch (e) { this.err = String(e && e.message || e); return this.faces; }
    this.lastMs = performance.now() - t0;

    // нормализованные точки -> пиксели видео
    const dets = [];
    const lms = res.faceLandmarks || [];
    for (let fi = 0; fi < lms.length; fi++) {
      const lm = lms[fi], n = lm.length;
      const pts = new Float32Array(n * 2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = lm[i].x * vw, y = lm[i].y * vh;
        pts[2 * i] = x; pts[2 * i + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      dets.push({ pts, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
    }

    // --- сопоставление с треками (жадный nearest-by-center) ---
    const usedTrack = new Array(this.tracks.length).fill(false);
    const detMatched = new Array(dets.length).fill(-1);
    for (let d = 0; d < dets.length; d++) {
      let best = -1, bd = Infinity;
      for (let t = 0; t < this.tracks.length; t++) {
        if (usedTrack[t]) continue;
        const tr = this.tracks[t];
        const tol = 0.75 * Math.max(24, (tr.bw + tr.bh) / 2);
        const dist = Math.hypot(dets[d].cx - tr.cx, dets[d].cy - tr.cy);
        if (dist < tol && dist < bd) { bd = dist; best = t; }
      }
      if (best >= 0) { usedTrack[best] = true; detMatched[d] = best; }
    }

    const K = 0.45; // EMA: 0 = не обновлять, 1 = без сглаживания
    for (let d = 0; d < dets.length; d++) {
      const det = dets[d], ti = detMatched[d];
      if (ti < 0) {
        this.tracks.push({ id: this.nextId++, pts: det.pts.slice(), cx: det.cx, cy: det.cy, bw: det.w, bh: det.h, misses: 0 });
      } else {
        const tr = this.tracks[ti];
        tr.misses = 0;
        const n = Math.min(tr.pts.length, det.pts.length);
        for (let i = 0; i < n; i++) tr.pts[i] += K * (det.pts[i] - tr.pts[i]);
        tr.cx += K * (det.cx - tr.cx); tr.cy += K * (det.cy - tr.cy);
        tr.bw += K * (det.w - tr.bw);  tr.bh += K * (det.h - tr.bh);
      }
    }
    for (let t = this.tracks.length - 1; t >= 0; t--) {
      if (!usedTrack[t]) {
        this.tracks[t].misses++;
        if (this.tracks[t].misses > 6) this.tracks.splice(t, 1);
      }
    }

    // --- hull для каждой трека ---
    this.faces = this.tracks.map(tr => {
      const pts = [];
      for (let i = 0; i < tr.pts.length; i += 1) pts.push([tr.pts[2 * i], tr.pts[2 * i + 1]]);
      tr.hull = convexHull(pts);
      return { id: tr.id, hull: tr.hull, cx: tr.cx, cy: tr.cy, bw: tr.bw, bh: tr.bh };
    });
    return this.faces;
  }

  /**
   * Перерисовать low-res маску по текущим трекам.
   * @param vw,vh размер видео (для пересчёта координат)
   * @param expand  насколько раздуть контур (0.05–0.5)
   * @param feather радиус блюра в px маски (мягкий край)
   */
  buildMask(vw, vh, expand, feather) {
    const mw = Math.max(4, (vw / 4) | 0), mh = Math.max(4, (vh / 4) | 0);
    if (this.mask.width !== mw || this.mask.height !== mh) { this.mask.width = mw; this.mask.height = mh; }
    const g = this.mctx, s = mw / vw;
    g.save();
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, mw, mh);
    g.filter = `blur(${Math.max(0, feather | 0)}px)`;
    g.fillStyle = '#fff';
    for (const f of this.faces) {
      if (!f.hull || f.hull.length < 3) continue;
      const cx = f.cx, cy = f.cy, ex = 1 + (expand || 0);
      g.beginPath();
      for (let i = 0; i < f.hull.length; i++) {
        let x = f.hull[i][0], y = f.hull[i][1];
        x = cx + (x - cx) * ex;
        y = cy + (y - cy) * ex;          // контур лица
        (i ? g.lineTo : g.moveTo).call(g, x * s, y * s);
      }
      g.closePath();
      g.fill();
      g.fill(); // двойная заливка: центр маски уверенно = 1.0 даже с блюром
    }
    g.restore();
  }

  /** Отрисовка контуров/подписей поверх канваса (в координатах видео). */
  drawOverlay(g2, vw, vh) {
    g2.clearRect(0, 0, vw, vh);
    if (!this.faces.length) return;
    const lw = Math.max(2, vw / 480);
    g2.lineWidth = lw;
    g2.strokeStyle = '#00ffc6';
    g2.fillStyle = '#00ffc6';
    g2.font = `${Math.max(14, vw / 48)}px system-ui, sans-serif`;
    for (const f of this.faces) {
      if (!f.hull || f.hull.length < 3) continue;
      g2.beginPath();
      g2.moveTo(f.hull[0][0], f.hull[0][1]);
      for (let i = 1; i < f.hull.length; i++) g2.lineTo(f.hull[i][0], f.hull[i][1]);
      g2.closePath();
      g2.setLineDash([6 * lw / 2, 4 * lw / 2]);
      g2.stroke();
      g2.setLineDash([]);
      g2.fillText('лицо #' + f.id, f.cx - f.bw / 2, Math.max(0, f.cy - f.bh / 2 - lw * 3));
    }
  }
}
