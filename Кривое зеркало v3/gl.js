"use strict";
/*
 * gl.js — WebGL2-рендерер Crooked Mirror (v3, «лицоцентричный»).
 *
 * Один проход фрагментного шейдера:
 *   uMode=0  — ручные эффекты на весь кадр, гейт по маске лиц (uMaskMode: везде/на лице/кроме);
 *   uMode=1  — лицевые пресеты: warp с центром на анатомической точке лица, сила blend = маска;
 *   uFaceMode=1/2 — слой поверх лица: эмодзи (альфа+тёмное «ничто» под ним) или фото-замена;
 *   uClip    — полигон контура лица в uv-координатах слоя, чтобы эмодзи/фото не вылезало за лицо.
 * Warp-формы: 1 wave, 2 bulge (s<0 = pinch), 6 pixelate, 7 twist, 8 ripple, 9 drag; плюс uExtra —
 * второй bulge («лицо+уши», «глазницы», «щёки») без второго прохода.
 */

const WARP_LIB = `
vec2 warpPx(vec2 px) {
  vec2 sp = px;
  float osc = (uAnimate == 1) ? (0.6 + 0.4 * sin(uTime * uSpeed * 1.6)) : 1.0;
  vec2 c = (uMode == 1) ? uCenter : (uRes * 0.5);
  float rad = (uMode == 1) ? uRadius : (min(uRes.x, uRes.y) * 0.9);

  if (uWarp == 1) {                    // волна
    float t  = uTime * max(uSpeed, 0.001);
    float kx = 6.2831853 / max(uWave.z, 1.0);
    float ky = 6.2831853 / max(uWave.w, 1.0);
    sp.x += uWave.x * sin(px.y * ky + t);
    sp.y += uWave.y * sin(px.x * kx + t);
  } else if (uWarp == 2) {             // bulge / pinch
    float s = clamp(uStrength, -1.2, 1.05) * osc;
    vec2 d = px - c;
    float r = length(d);
    if (r < rad) {
      float f = 1.0 - s * (1.0 - cos(r / rad * 1.5707963));
      sp = c + d * f;
    }
  } else if (uWarp == 6) {             // пикселизация
    float b = max(uBlock, 1.0);
    sp = (floor(px / b) + 0.5) * b;
  } else if (uWarp == 7) {             // твист вокруг центра
    vec2 d = px - c;
    float r = length(d);
    float a = 3.14159265 * uStrength * (1.0 - min(r / max(rad, 1.0), 1.0)) * (osc * 1.6 - 0.6);
    float ca = cos(a), sa = sin(a);
    sp = c + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
  } else if (uWarp == 8) {             // рябь
    vec2 d = px - c;
    float rl = max(length(d), 1.0);
    float nd = rl / max(rad, 1.0);
    float off = uStrength * rad * 0.10 * sin(nd * 12.0 - uTime * max(uSpeed, 0.001) * 2.0);
    sp = px + d / rl * off;
  } else if (uWarp == 9) {             // drag (тянет вниз/вверх по профилю от центра)
    float k = clamp(1.0 - length(px - c) / max(rad, 1.0), 0.0, 1.0);
    sp.y += uStrength * rad * 0.30 * k * k * osc;
  }

  if (uExtra.w > 0.0) {                // второй bulge: x,y,radius,strength
    vec2 d2 = sp - uExtra.xy;
    float r2 = length(d2);
    if (r2 < uExtra.z) {
      float f2 = 1.0 - uExtra.w * (1.0 - cos(r2 / uExtra.z * 1.5707963));
      sp = uExtra.xy + d2 * f2;
    }
  }
  return sp;
}`;

const COMMON = `
bool edgeX(vec2 p, vec2 a, vec2 b) {
  return ((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x);
}
bool inPoly(vec2 p) {
  if (uClipOn == 0) return true;
  bool ins = false;
  for (int i = 0; i < MAXCLIP; i++) {
    if (i >= uClipN) break;
    vec2 A = uClip[i];
    vec2 B = (i + 1 >= uClipN) ? uClip[0] : uClip[i + 1];
    if (edgeX(p, A, B)) ins = !ins;
  }
  return ins;
}`;

const VS_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_SRC = `#version 300 es
#define MAXCLIP 28
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform sampler2D uFace;
uniform vec2  uRes;
uniform float uTime;
uniform vec4  uWave;       // ampX, ampY, lenX, lenY (px)
uniform float uSpeed;
uniform float uStrength;
uniform float uBlock;
uniform int   uMode;       // 0 ручные, 1 лицевой blend
uniform int   uWarp;       // форма warp
uniform int   uMirror;
uniform int   uColorOp;    // 0 нет 1 инверсия 2 ч/б 3 скетч
uniform int   uAnimate;
uniform int   uMaskMode;   // для uMode=0: 0 везде 1 на лице 2 кроме лица
uniform vec2  uCenter;     // GL-пиксели (y снизу)
uniform float uRadius;
uniform vec4  uExtra;
uniform int   uFaceMode;   // 0 выкл, 1 эмодзи, 2 фото
uniform vec4  uRect;       // слой: [ax, ay, bx, by] GL-пиксели (ax,ay — левый нижний угол)
uniform int   uClipOn;
uniform int   uClipN;
uniform vec2  uClip[MAXCLIP];
out vec4 fragColor;
${COMMON}
${WARP_LIB}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 base = texture(uVideo, uv).rgb;
  float m = texture(uMask, uv).r;

  if (uMode == 0 && uWarp == 0 && uMirror == 0 && (uColorOp == 1 || uColorOp == 2)) {
    // цвет-онли ручные (инверсия/чб)
    vec3 eff = uColorOp == 1 ? vec3(1.0) - base : vec3(luma(base));
    float amt = uMaskMode == 1 ? m : (uMaskMode == 2 ? 1.0 - m : 1.0);
    fragColor = vec4(mix(base, eff, amt), 1.0);
    return;
  }

  vec2 sp = warpPx(uv * uRes);
  if (uMirror == 1) sp.x = uRes.x - sp.x;
  sp = clamp(sp, vec2(0.5), max(uRes - 0.5, vec2(0.5)));
  vec3 eff = texture(uVideo, sp / uRes).rgb;

  if (uColorOp == 1) eff = vec3(1.0) - eff;
  else if (uColorOp == 2) eff = vec3(luma(eff));
  else if (uColorOp == 3) {
    vec2 tx = 1.6 / uRes;                       // скетч: sobel по яркости + лёгкая «бумага»
    float e = abs(luma(texture(uVideo, uv + vec2(-tx.x, -tx.y)).rgb) + 2.0 * luma(texture(uVideo, uv + vec2(0.0, -tx.y)).rgb) + luma(texture(uVideo, uv + vec2(tx.x, -tx.y)).rgb)
                - luma(texture(uVideo, uv + vec2(-tx.x, tx.y)).rgb) - 2.0 * luma(texture(uVideo, uv + vec2(0.0, tx.y)).rgb) - luma(texture(uVideo, uv + vec2(tx.x, tx.y)).rgb))
              + abs(luma(texture(uVideo, uv + vec2(-tx.x, -tx.y)).rgb) + 2.0 * luma(texture(uVideo, uv + vec2(-tx.x, 0.0)).rgb) + luma(texture(uVideo, uv + vec2(-tx.x, tx.y)).rgb)
                - luma(texture(uVideo, uv + vec2(tx.x, -tx.y)).rgb) - 2.0 * luma(texture(uVideo, uv + vec2(tx.x, 0.0)).rgb) - luma(texture(uVideo, uv + vec2(tx.x, tx.y)).rgb));
    eff = mix(vec3(0.96, 0.95, 0.92), vec3(0.06), smoothstep(0.04, 0.28, e));
  }

  float amt = (uMode == 1) ? m : (uMaskMode == 1 ? m : (uMaskMode == 2 ? 1.0 - m : 1.0));
  vec3 col = mix(base, eff, clamp(amt, 0.0, 1.0));

  if (uFaceMode > 0) {
    vec2 q = (uv * uRes - uRect.xy) / uRect.zw;   // uRect в пикселях GL-пространства
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0 && inPoly(q)) {
      vec4 e = texture(uFace, q);
      if (uFaceMode == 1) {                      // эмодзи: под ним — тёмная пиксельная «пустота»
        vec3 dark = texture(uVideo, (floor(uv * uRes / 16.0) + 0.5) * 16.0 / uRes).rgb * vec3(0.16);
        col = mix(col, dark, clamp(m * 1.5, 0.0, 1.0));
        col = mix(col, e.rgb, e.a);
      } else {                                   // фото: полная замена внутри контура;
        // текущий warp прогоняем и по фото (шутки применяются к подставленному лицу)
        vec2 p = q * uRect.zw + uRect.xy;
        vec2 wpx = warpPx(p);
        vec2 q2 = (wpx - uRect.xy) / uRect.zw;
        vec3 pc = (q2.x < -0.02 || q2.x > 1.02 || q2.y < -0.02 || q2.y > 1.02)
          ? vec3(0.02) : texture(uFace, clamp(q2, vec2(0.004), vec2(0.996))).rgb;
        col = mix(col, pc, clamp(m * 1.5 + 0.85, 0.0, 1.0));
      }
    }
  }
  fragColor = vec4(col, 1.0);
}`;

class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 недоступен в этом браузере');
    this.gl = gl;
    this.tainted = false;

    this.program = this._program(VS_SRC, FS_SRC);
    gl.useProgram(this.program);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of ['uVideo', 'uMask', 'uFace', 'uRes', 'uTime', 'uWave', 'uSpeed', 'uStrength', 'uBlock',
      'uMode', 'uWarp', 'uMirror', 'uColorOp', 'uAnimate', 'uMaskMode', 'uCenter', 'uRadius', 'uExtra',
      'uFaceMode', 'uRect', 'uClipOn', 'uClipN']) this.u[n] = gl.getUniformLocation(this.program, n);
    this.u.uClip = gl.getUniformLocation(this.program, 'uClip[0]');
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uMask, 1);
    gl.uniform1i(this.u.uFace, 2);

    this.texVideo = this._tex(0, [0, 0, 0, 255]);
    this.texMask = this._tex(1, [255, 255, 255, 255]);
    this.texFace = this._tex(2, [0, 0, 0, 0]);
    this.clipBuf = new Float32Array(56);
    this.srcSize = [0, 0];
    this.maskSize = null;
    this.faceSize = null;
  }

  _tex(unit, fill) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(fill));
    return t;
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error((type === gl.VERTEX_SHADER ? 'VS' : 'FS') + ' compile: ' + log);
    }
    return s;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /**
   * Единый проход. p: {time, mode, warp, strength, speed, block, mirror, colorOp, animate,
   *   maskMode, ampX, ampY, waveLenX, waveLenY, center:[x,y], radius, extra:[x,y,r,s],
   *   faceMode, rect:[ax,ay,bx,by], clips:[qx,qy,...], maskCanvas, faceCanvas}
   */
  draw(video, p) {
    const gl = this.gl;
    const w = video.videoWidth | 0, h = video.videoHeight | 0;
    if (w < 2 || h < 2) return;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.srcSize = [w, h];
      this.maskSize = null;   // размер кадра сменился — маску и слой перелить принудительно
      this.faceSize = null;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.tainted = false;
    } catch (e) {
      if (!this.tainted) { this.tainted = true; this.onTaint && this.onTaint(e); }
      return;
    }

    const mc = p.maskCanvas || null;
    if (mc) {
      const key = mc.width + 'x' + mc.height;
      if (this.maskSize !== key) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texMask);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc);
        this.maskSize = key;
      } else {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texMask);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc);
        this.maskSize = key;
      }
    }
    if (p.faceCanvas && p.faceMode > 0) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texFace);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.faceCanvas);
      this.faceSize = p.faceCanvas.width + 'x' + p.faceCanvas.height;
    }

    gl.uniform2f(this.u.uRes, w, h);
    gl.uniform1f(this.u.uTime, p.time || 0);
    gl.uniform4f(this.u.uWave, p.ampX || 0, p.ampY || 0, p.waveLenX || 120, p.waveLenY || 120);
    gl.uniform1f(this.u.uSpeed, p.speed == null ? 1 : p.speed);
    gl.uniform1f(this.u.uStrength, p.strength || 0);
    gl.uniform1f(this.u.uBlock, p.block || 14);
    gl.uniform1i(this.u.uMode, p.mode || 0);
    gl.uniform1i(this.u.uWarp, p.warp || 0);
    gl.uniform1i(this.u.uMirror, p.mirror ? 1 : 0);
    gl.uniform1i(this.u.uColorOp, p.colorOp || 0);
    gl.uniform1i(this.u.uAnimate, p.animate ? 1 : 0);
    gl.uniform1i(this.u.uMaskMode, p.maskMode || 0);
    const ctr = p.center || [w / 2, h / 2];
    gl.uniform2f(this.u.uCenter, ctr[0], ctr[1]);
    gl.uniform1f(this.u.uRadius, p.radius || Math.min(w, h) * 0.4);
    const ex = p.extra || [0, 0, 0, 0];
    gl.uniform4f(this.u.uExtra, ex[0], ex[1], ex[2], ex[3]);
    gl.uniform1i(this.u.uFaceMode, p.faceMode || 0);
    gl.uniform4f(this.u.uRect, p.rect ? p.rect[0] : 0, p.rect ? p.rect[1] : 0,
      p.rect ? p.rect[2] : w, p.rect ? p.rect[3] : h);

    const clips = (p.clips && p.clips.length >= 6) ? p.clips : null;
    if (clips) {
      const n = Math.min(28, clips.length >> 1);
      for (let i = 0; i < n * 2; i++) this.clipBuf[i] = clips[i];
      gl.uniform2fv(this.u.uClip, this.clipBuf.subarray(0, n * 2));
      gl.uniform1i(this.u.uClipN, n);
      gl.uniform1i(this.u.uClipOn, 1);
    } else {
      gl.uniform1i(this.u.uClipOn, 0);
      gl.uniform1i(this.u.uClipN, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  snapshotPNG() { return this.canvas.toDataURL('image/png'); }
}
