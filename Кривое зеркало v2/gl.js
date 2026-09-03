"use strict";
/*
 * gl.js — WebGL2-рендерер для v2 «Кривого зеркала».
 * Все эффекты исполняются на GPU во фрагментном шейдере за один проход:
 * видеопоток -> текстура -> warp UV по маске искажений (лицевая маска — вторая текстура).
 * Это в десятки/сотни раз быстрее попиксельной обработки ImageData на CPU.
 */

const EFFECT_IDS = { none: 0, wave: 1, bulge: 2, invert: 3, grayscale: 4, mirror: 5, pixelate: 6, twist: 7, ripple: 8 };

const VS_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_SRC = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform vec2  uRes;       // размер кадра в пикселях
uniform float uTime;      // секунды
uniform vec4  uWave;      // ampX, ampY, waveLenX, waveLenY
uniform float uSpeed;
uniform float uStrength;  // сила для bulge / twist / ripple
uniform float uBlock;     // размер блока для pixelate
uniform int   uEffect;    // см. EFFECT_IDS
uniform int   uMaskMode;  // 0 = эффект на весь кадр, 1 = только на лице, 2 = кроме лица
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 px = uv * uRes;
  vec2 sp = px; // координата сэмпла (обратно)

  if (uEffect == 1) {                    // волна: горизонталь зависит от y и наоборот — как в v1, но с билинейной выборкой
    float t  = uTime * uSpeed;
    float kx = 6.2831853 / max(uWave.z, 1.0);
    float ky = 6.2831853 / max(uWave.w, 1.0);
    sp.x += uWave.x * sin(px.y * ky + t);
    sp.y += uWave.y * sin(px.x * kx + t);
  } else if (uEffect == 2) {             // выпуклость с анимацией силы
    vec2 c = uRes * 0.5;
    float rad = min(c.x, c.y) * 0.85;
    vec2 d = px - c;
    float r = length(d);
    float s = clamp(uStrength, 0.0, 1.0) * (0.5 + 0.5 * sin(uTime * max(uSpeed, 0.001)));
    if (r < rad) {
      float f = 1.0 - s * (1.0 - cos(r / rad * 1.5707963));
      sp = c + d * f;
    }
  } else if (uEffect == 6) {             // пикселизация: снап к центру блока (без усреднения — на GPU это бесплатно)
    float b = max(uBlock, 1.0);
    sp = (floor(px / b) + 0.5) * b;
  } else if (uEffect == 7) {             // твист: угол зависит от радиуса
    vec2 c = uRes * 0.5;
    float maxR = min(c.x, c.y);
    vec2 d = px - c;
    float r = length(d);
    float a = 6.2831853 * uStrength * (1.0 - min(r / maxR, 1.0)) * sin(uTime * max(uSpeed, 0.001));
    float ca = cos(a), sa = sin(a);
    sp = c + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
  } else if (uEffect == 8) {             // рябь: бегущие круги от центра
    vec2 c = uRes * 0.5;
    vec2 d = px - c;
    float r = max(length(d), 1.0);
    float off = 12.0 * uStrength * sin(r * 0.04 - uTime * max(uSpeed, 0.001) * 2.0);
    sp = px + d / r * off;
  }

  if (uEffect == 5) sp.x = uRes.x - sp.x; // зеркало

  sp = clamp(sp, vec2(0.5), max(uRes - 0.5, vec2(0.5)));

  vec3 base = texture(uVideo, uv).rgb;
  vec3 eff  = texture(uVideo, sp / uRes).rgb;  // LINEAR-фильтрация даёт билинейную интерполяцию бесплатно
  if (uEffect == 3) eff = vec3(1.0) - eff;      // инверсия
  if (uEffect == 4) eff = vec3(dot(eff, vec3(0.299, 0.587, 0.114))); // ч/б

  float m = 1.0;
  if (uMaskMode == 1) m = texture(uMask, uv).r;
  else if (uMaskMode == 2) m = 1.0 - texture(uMask, uv).r;

  fragColor = vec4(mix(base, eff, m), 1.0);
}`;

class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 недоступен в этом браузере');
    this.gl = gl;
    this.tainted = false;

    this.program = this._buildProgram(VS_SRC, FS_SRC);
    gl.useProgram(this.program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of ['uVideo', 'uMask', 'uRes', 'uTime', 'uWave', 'uSpeed', 'uStrength', 'uBlock', 'uEffect', 'uMaskMode'])
      this.u[n] = gl.getUniformLocation(this.program, n);

    this.texVideo = this._makeTexture(0);
    this.texMask = this._makeTexture(1);
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uMask, 1);

    // маска по умолчанию: сплошная белая (режим «только на лице» = весь кадр до первой детекции)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

    this.srcSize = [0, 0];
  }

  _makeTexture(unit) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('Shader compile: ' + gl.getShaderInfoLog(s));
    return s;
  }

  _buildProgram(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Program link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /**
   * Отрисовать кадр.
   * @param {HTMLVideoElement} video источник
   * @param {?HTMLCanvasElement} maskCanvas маска (RGBA, белое = лицо) или null
   * @param {object} p параметры эффекта (в пикселях кадра)
   */
  draw(video, maskCanvas, p) {
    const gl = this.gl;
    const w = video.videoWidth | 0, h = video.videoHeight | 0;
    if (w < 2 || h < 2) return;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.srcSize = [w, h];
    }
    gl.viewport(0, 0, w, h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      if (this.tainted) { this.tainted = false; this.onUntaint && this.onUntaint(); }
    } catch (e) {
      // видео с cross-origin без CORS-заголовков «отравляет» канвас:
      // читать пиксели (и писать в запись) нельзя — сообщаем об этом наверх
      if (!this.tainted) { this.tainted = true; this.onTaint && this.onTaint(e); }
      return;
    }

    if (maskCanvas) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    }

    gl.uniform2f(this.u.uRes, w, h);
    gl.uniform1f(this.u.uTime, p.time);
    gl.uniform4f(this.u.uWave, p.ampX, p.ampY, p.waveLenX, p.waveLenY);
    gl.uniform1f(this.u.uSpeed, p.speed);
    gl.uniform1f(this.u.uStrength, p.strength);
    gl.uniform1f(this.u.uBlock, p.block);
    gl.uniform1i(this.u.uEffect, p.effect);
    gl.uniform1i(this.u.uMaskMode, p.maskMode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  snapshotPNG() { return this.canvas.toDataURL('image/png'); }
}
