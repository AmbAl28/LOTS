"use strict";
/*
 * faces.js — MediaPipe FaceLandmarker (478 точек) + трекинг + геометрические фичи лица.
 * Офлайн: модель и wasm лежат в vendor/ (см. README).
 *
 * Что добавлено против v2 для «лицевых» эффектов Crooked Mirror:
 *  - per-face фичи: зрачки, кончик носа, углы рта, центр рта, ширины, roll, yaw-proxy —
 *    на них навешиваются центры warp-деформаций (улыбка на рту, глазницы на зрачках…);
 *  - rectFor(): квадрат для эмодзи / rect с пропорциями фото + клип-полигон контура лица
 *    в uv-координатах слоя;
 *  - score(): дискретный «ракурс+композиция» сигнал для рандома эмодзи.
 * Точки EMA-сглаживаются, id треков стабильны.
 */

function convexHull(points) {
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

// индексы канонического FaceMesh (478)
const IDX = { noseTip: 1, irisL: 468, irisR: 473, mouthL: 61, mouthR: 291, lipTop: 14, lipBottom: 13 };

class FaceTracker {
  constructor(vendorBase) {
    this.vendorBase = vendorBase;
    this.landmarker = null;
    this.delegate = '';
    this.err = null;

    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d');
    this.mask = document.createElement('canvas');
    this.mctx = this.mask.getContext('2d');

    this.tracks = [];
    this.nextId = 1;
    this.ts = 0;
    this.lastMs = 0;
    this.faces = [];
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
        minTrackingConfidence: 0.4,
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

  reset() { this.tracks = []; this.faces = []; this._clearMask(); }

  _clearMask() {
    const g = this.mctx, c = g.canvas;
    if (!c || !c.width) return;
    g.save(); g.filter = 'none';
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.restore();
  }

  /** Один проход: downscale -> detectForVideo -> трекинг -> фичи -> hull. */
  process(video, opts = {}) {
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
      dets.push({ pts, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, bw: x1 - x0, bh: y1 - y0 });
    }

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

    const K = 0.45;
    for (let d = 0; d < dets.length; d++) {
      const det = dets[d], ti = detMatched[d];
      if (ti < 0) {
        this.tracks.push({ id: this.nextId++, pts: det.pts.slice(), cx: det.cx, cy: det.cy, bw: det.bw, bh: det.bh, misses: 0 });
      } else {
        const tr = this.tracks[ti];
        tr.misses = 0;
        const n = Math.min(tr.pts.length, det.pts.length);
        for (let i = 0; i < n; i++) tr.pts[i] += K * (det.pts[i] - tr.pts[i]);
        tr.cx += K * (det.cx - tr.cx); tr.cy += K * (det.cy - tr.cy);
        tr.bw += K * (det.bw - tr.bw); tr.bh += K * (det.bh - tr.bh);
      }
    }
    for (let t = this.tracks.length - 1; t >= 0; t--) {
      if (!usedTrack[t]) {
        this.tracks[t].misses++;
        if (this.tracks[t].misses > 6) this.tracks.splice(t, 1);
      }
    }

    this.faces = this.tracks.map(tr => {
      const P = tr.pts;
      const g = (i) => [P[2 * i] || 0, P[2 * i + 1] || 0];
      const feat = {
        nose: g(IDX.noseTip),
        eyeL: g(IDX.irisL), eyeR: g(IDX.irisR),
        mouthL: g(IDX.mouthL), mouthR: g(IDX.mouthR),
        lipTop: g(IDX.lipTop), lipBottom: g(IDX.lipBottom),
      };
      const [elx, ely] = feat.eyeL, [erx, ery] = feat.eyeR, [ntx, nty] = feat.nose;
      const [mlX, mlY] = feat.mouthL, [mrX, mrY] = feat.mouthR;
      feat.eyeC = [(elx + erx) / 2, (ely + ery) / 2];
      feat.eyeDist = Math.hypot(erx - elx, ery - ely) || 1;
      feat.mouthC = [(mlX + mrX) / 2, (mlY + mrY) / 2];
      feat.mouthW = Math.hypot(mrX - mlX, mrY - mlY) || 1;
      feat.roll = Math.atan2(ery - ely, erx - elx);
      const eyeSpan = Math.max(Math.abs(erx - elx), 1e-3);
      feat.yawRel = Math.max(-1, Math.min(1, (ntx - feat.eyeC[0]) / (eyeSpan * 0.55)));
      // щёки — наружу-вниз от носа к углам рта
      feat.cheekL = [ntx + (mlX - ntx) * 1.18, nty + (mlY - nty) * 1.05];
      feat.cheekR = [ntx + (mrX - ntx) * 1.18, nty + (mrY - nty) * 1.05];
      feat.faceC = [tr.cx, tr.cy];

      const pts = [];
      for (let i = 0; i < P.length; i += 2) pts.push([P[i], P[i + 1]]);
      tr.hull = convexHull(pts);
      return { id: tr.id, pts: P, hull: tr.hull, cx: tr.cx, cy: tr.cy, bw: tr.bw, bh: tr.bh, feat };
    });
    return this.faces;
  }

  /** Дискретный сигнал «ракурс/композиция» — меняется при повороте головы, крене, масштабе. */
  static score(f) {
    if (!f || !f.feat) return 0;
    const yawB = Math.round(f.feat.yawRel * 4);
    const rollB = Math.round(f.feat.roll / (Math.PI / 10));
    const areaB = Math.round(Math.log2(Math.max(4, f.bw * f.bh)) * 1.5);
    return yawB * 1000 + rollB * 40 + areaB;
  }

  /**
   * Прямоугольник слоя (эмодзи/фото) и клип-полигон контура.
   * mode 'emoji': квадрат; 'photo': rect с пропорциями картинки (вписать в bbox лица).
   * Возвращает rect в GL-пикселях (y снизу) и clip в uv слоя (0..1).
   */
  rectFor(f, vw, vh, mode, opt = {}) {
    if (!f || !f.hull || f.hull.length < 3) return null;
    const m = 0.12 * Math.max(f.bw, f.bh);
    let x0 = f.cx - f.bw / 2 - m, x1 = f.cx + f.bw / 2 + m;
    let y0 = f.cy - f.bh / 2 - m * 1.35, y1 = f.cy + f.bh / 2 + m * 0.35;
    if (mode === 'emoji') {
      const side = Math.max(x1 - x0, y1 - y0) * (opt.scale || 1.0);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 - (y1 - y0) * 0.03;
      x0 = cx - side / 2; x1 = cx + side / 2;
      y0 = cy - side / 2; y1 = cy + side / 2;
    } else if (opt.aspect) {
      const w0 = x1 - x0, h0 = y1 - y0;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (w0 / h0 > opt.aspect) { const nw = h0 * opt.aspect; x0 = cx - nw / 2; x1 = cx + nw / 2; }
      else { const nh = w0 / opt.aspect; y0 = cy - nh / 2; y1 = cy + nh / 2; }
    }
    const sw = x1 - x0, sh = y1 - y0;
    if (sw < 4 || sh < 4) return null;
    const clip = [];
    const N = f.hull.length, step = Math.max(1, Math.ceil(N / 26));
    for (let i = 0; i < N; i += step) {
      const hx = f.hull[i][0], hy = f.hull[i][1];
      clip.push((hx - x0) / sw, (y1 - hy) / sh);
    }
    if (clip.length < 6) return null;
    return { rect: [x0, vh - y1, sw, sh], clip };
  }

  /** Полнокадровый rect (для фото «лицо-в-лицо» без подгонки аспекта не используется). */
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
        y = cy + (y - cy) * ex;
        (i ? g.lineTo : g.moveTo).call(g, x * s, y * s);
      }
      g.closePath();
      g.fill();
      g.fill();
    }
    g.restore();
  }

  /** Контур(ы) поверх канваса для отладки/UX. */
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
      g2.setLineDash([3 * lw, 2 * lw]);
      g2.stroke();
      g2.setLineDash([]);
      g2.fillText('лицо #' + f.id, f.cx - f.bw / 2, Math.max(0, f.cy - f.bh / 2 - lw * 3));
    }
  }
}
