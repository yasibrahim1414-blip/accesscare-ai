// WebGL renderer for the AccessCare body: orbit camera with a movable target,
// studio lighting (key, fill, rim, sky/ground ambient), baked ambient occlusion,
// a soft contact shadow, gentle region highlighting and pixel-exact picking
// through an ID buffer. No third-party 3D library is required.

import type { BodyMesh } from './glb';

type M4 = Float32Array;
const perspective = (fovy: number, aspect: number, near: number, far: number): M4 => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};
const lookAt = (e: number[], c: number[], up: number[]): M4 => {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
};
const multiply = (a: M4, b: M4): M4 => {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
};

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute float aOcc;
uniform mat4 uMVP; varying vec3 vN; varying vec3 vP; varying float vOcc;
void main(){ vN = aNrm; vP = aPos; vOcc = aOcc; gl_Position = uMVP * vec4(aPos,1.0); }`;
const FS = `
precision mediump float;
uniform vec3 uBase; uniform vec3 uTint; uniform float uTintAmt; uniform vec3 uEye; uniform float uPick; uniform vec3 uPickColor;
uniform float uDark; uniform vec3 uKey; uniform vec3 uFill; uniform vec3 uBack;
varying vec3 vN; varying vec3 vP; varying float vOcc;
void main(){
  if (uPick > 0.5) { gl_FragColor = vec4(uPickColor, 1.0); return; }
  vec3 n = normalize(vN);
  vec3 v = normalize(uEye - vP);
  vec3 key = uKey; vec3 fill = uFill; vec3 back = uBack;
  float wrapKey = clamp((dot(n, key) + 0.35) / 1.35, 0.0, 1.0);
  float wrapFill = clamp((dot(n, fill) + 0.5) / 1.5, 0.0, 1.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 albedo = mix(uBase, uTint, uTintAmt);
  vec3 ambient = mix(vec3(0.46, 0.42, 0.42), vec3(0.66, 0.68, 0.72), hemi);
  vec3 col = albedo * (ambient * 0.55 + vec3(1.0, 0.97, 0.93) * wrapKey * 0.62 + vec3(0.72, 0.8, 0.92) * wrapFill * 0.22);
  // soft subsurface-like warmth in the terminator
  float sss = smoothstep(0.0, 0.5, wrapKey) * (1.0 - smoothstep(0.5, 1.0, wrapKey));
  col += albedo * vec3(0.16, 0.05, 0.03) * sss * (1.0 - uTintAmt);
  col += albedo * vec3(0.06, 0.015, 0.0) * (1.0 - vOcc) * (1.0 - uTintAmt); // warm light bleeding into creases
  vec3 h = normalize(key + v);
  col += vec3(0.06, 0.055, 0.05) * pow(max(dot(n, h), 0.0), 18.0) * (1.0 - uTintAmt * 0.5);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += rim * mix(vec3(0.16, 0.20, 0.26), uTint, uTintAmt) * (0.30 + uTintAmt * 0.8) * max(dot(n, back) * 0.5 + 0.6, 0.0);
  col *= mix(0.42, 1.0, vOcc);
  col = mix(col, col * 0.86 + 0.02, uDark);
  gl_FragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;
const SHADOW_VS = `attribute vec2 aXZ; uniform mat4 uMVP; varying vec2 vUV;
void main(){ vUV = aXZ; gl_Position = uMVP * vec4(aXZ.x * 0.42, 0.0, aXZ.y * 0.26, 1.0); }`;
const SHADOW_FS = `precision mediump float; varying vec2 vUV; uniform float uAlpha;
void main(){ float d = length(vUV); float a = (1.0 - smoothstep(0.15, 1.0, d)) * uAlpha; gl_FragColor = vec4(0.03, 0.08, 0.16, a); }`;

interface GpuMesh { name: string; pos: WebGLBuffer; nrm: WebGLBuffer; occ: WebGLBuffer; idx: WebGLBuffer; count: number; type: number; id: number; center: [number, number, number] }

export interface ViewState { yaw: number; pitch: number; distance: number; target: [number, number, number] }
export const DEFAULT_VIEW: ViewState = { yaw: 0, pitch: 0.04, distance: 3.05, target: [0, 0.89, 0] };

export interface Palette { base: number[]; selected: number[]; hover: number[]; focus: number[]; dark: boolean }
export const LIGHT_PALETTE: Palette = { base: [0.82, 0.68, 0.59], selected: [0.04, 0.6, 0.58], hover: [0.36, 0.72, 0.74], focus: [0.95, 0.55, 0.16], dark: false };
export const DARK_PALETTE: Palette = { base: [0.80, 0.65, 0.55], selected: [0.12, 0.76, 0.70], hover: [0.4, 0.72, 0.74], focus: [0.98, 0.62, 0.24], dark: true };

export class BodyRenderer {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private shadowProg: WebGLProgram;
  private shadowBuf: WebGLBuffer;
  private meshes: GpuMesh[] = [];
  private pickFb: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickRb: WebGLRenderbuffer | null = null;
  private pickSize = [0, 0];
  private u: Record<string, WebGLUniformLocation | null> = {};
  private a: Record<string, number> = {};
  view: ViewState = { ...DEFAULT_VIEW, target: [...DEFAULT_VIEW.target] };
  selected = new Set<string>();
  focus: string | null = null;
  hover: string | null = null;
  palette: Palette = LIGHT_PALETTE;
  /** 0..1 pulse for selected regions (kept at 0 with reduced motion) */
  pulse = 0;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, meshes: BodyMesh[]) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false })
      ?? (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) throw new Error('WebGL is not available on this device');
    this.gl = gl;
    const uint = gl.getExtension('OES_element_index_uint');
    this.prog = this.program(VS, FS);
    this.shadowProg = this.program(SHADOW_VS, SHADOW_FS);
    for (const n of ['uMVP', 'uBase', 'uTint', 'uTintAmt', 'uEye', 'uPick', 'uPickColor', 'uDark', 'uKey', 'uFill', 'uBack']) this.u[n] = gl.getUniformLocation(this.prog, n);
    this.u.sMVP = gl.getUniformLocation(this.shadowProg, 'uMVP');
    this.u.sAlpha = gl.getUniformLocation(this.shadowProg, 'uAlpha');
    this.a.pos = gl.getAttribLocation(this.prog, 'aPos');
    this.a.nrm = gl.getAttribLocation(this.prog, 'aNrm');
    this.a.occ = gl.getAttribLocation(this.prog, 'aOcc');
    this.a.xz = gl.getAttribLocation(this.shadowProg, 'aXZ');
    this.shadowBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    meshes.forEach((m, i) => {
      const mk = (target: number, data: BufferSource) => { const b = gl.createBuffer()!; gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
      const is32 = m.indices instanceof Uint32Array;
      if (is32 && !uint) return;
      this.meshes.push({
        name: m.name, id: i + 1, count: m.indices.length, center: m.center,
        type: is32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
        pos: mk(gl.ARRAY_BUFFER, m.positions), nrm: mk(gl.ARRAY_BUFFER, m.normals), occ: mk(gl.ARRAY_BUFFER, m.occlusion),
        idx: mk(gl.ELEMENT_ARRAY_BUFFER, m.indices),
      });
    });
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  private program(vs: string, fs: string) {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program link failed');
    return p;
  }

  regionCenter(name: string): [number, number, number] | null {
    return this.meshes.find((m) => m.name === name)?.center ?? null;
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  private matrices() {
    const { yaw, pitch, distance, target } = this.view;
    const eye = [target[0] + distance * Math.sin(yaw) * Math.cos(pitch), target[1] + distance * Math.sin(pitch), target[2] + distance * Math.cos(yaw) * Math.cos(pitch)];
    const aspect = this.canvas.width / this.canvas.height;
    // keep the full figure in frame on narrow canvases
    const fov = aspect < 0.6 ? 0.62 + (0.6 - aspect) * 0.6 : 0.62;
    return { mvp: multiply(perspective(fov, aspect, 0.03, 20), lookAt(eye, target, [0, 1, 0])), eye };
  }

  private drawBody(pick: boolean, mvp: M4, eye: number[]) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uMVP, false, mvp);
    gl.uniform3fv(this.u.uEye, eye);
    gl.uniform1f(this.u.uPick, pick ? 1 : 0);
    gl.uniform3fv(this.u.uBase, this.palette.base);
    gl.uniform1f(this.u.uDark, this.palette.dark ? 1 : 0);
    // studio lights travel with the camera so every side of the body is lit
    const rot = (x: number, y: number, z: number) => {
      const c = Math.cos(this.view.yaw), s = Math.sin(this.view.yaw);
      const l = Math.hypot(x, y, z);
      return [(x * c + z * s) / l, y / l, (-x * s + z * c) / l];
    };
    gl.uniform3fv(this.u.uKey, rot(0.45, 0.75, 0.55));
    gl.uniform3fv(this.u.uFill, rot(-0.7, 0.25, 0.35));
    gl.uniform3fv(this.u.uBack, rot(0.0, 0.4, -1.0));
    gl.enableVertexAttribArray(this.a.pos); gl.enableVertexAttribArray(this.a.nrm); gl.enableVertexAttribArray(this.a.occ);
    for (const m of this.meshes) {
      if (pick) gl.uniform3fv(this.u.uPickColor, [(m.id & 255) / 255, ((m.id >> 8) & 255) / 255, 0]);
      else {
        const sel = this.selected.has(m.name);
        let tint = this.palette.selected, amt = 0;
        if (m.name === this.focus) { tint = this.palette.focus; amt = 0.78; }
        else if (sel) amt = 0.6 + this.pulse * 0.12;
        else if (m.name === this.hover) { tint = this.palette.hover; amt = 0.38; }
        gl.uniform3fv(this.u.uTint, tint);
        gl.uniform1f(this.u.uTintAmt, amt);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.vertexAttribPointer(this.a.pos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.nrm); gl.vertexAttribPointer(this.a.nrm, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.occ); gl.vertexAttribPointer(this.a.occ, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
      gl.drawElements(gl.TRIANGLES, m.count, m.type, 0);
    }
    gl.disableVertexAttribArray(this.a.occ);
  }

  private drawShadow(mvp: M4) {
    const gl = this.gl;
    gl.useProgram(this.shadowProg);
    gl.uniformMatrix4fv(this.u.sMVP, false, mvp);
    gl.uniform1f(this.u.sAlpha, this.palette.dark ? 0.55 : 0.28);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    gl.enableVertexAttribArray(this.a.xz);
    gl.vertexAttribPointer(this.a.xz, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(this.a.xz);
  }

  render = () => {
    this.raf = 0;
    const gl = this.gl;
    this.resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { mvp, eye } = this.matrices();
    this.drawShadow(mvp);
    this.drawBody(false, mvp, eye);
  };

  requestRender() { if (!this.raf) this.raf = requestAnimationFrame(this.render); }

  /** Region id under a CSS-pixel point, or null. */
  pick(cssX: number, cssY: number): string | null {
    const gl = this.gl;
    this.resize();
    const w = this.canvas.width, h = this.canvas.height;
    if (!this.pickFb || this.pickSize[0] !== w || this.pickSize[1] !== h) {
      if (this.pickFb) { gl.deleteFramebuffer(this.pickFb); gl.deleteTexture(this.pickTex); gl.deleteRenderbuffer(this.pickRb); }
      this.pickTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      this.pickRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      this.pickFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickRb);
      this.pickSize = [w, h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { mvp, eye } = this.matrices();
    this.drawBody(true, mvp, eye);
    const rect = this.canvas.getBoundingClientRect();
    const px = Math.floor(((cssX - rect.left) / rect.width) * w);
    const py = Math.floor((1 - (cssY - rect.top) / rect.height) * h);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const id = out[0] + (out[1] << 8);
    this.requestRender();
    return this.meshes.find((m) => m.id === id)?.name ?? null;
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    const gl = this.gl;
    for (const m of this.meshes) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.nrm); gl.deleteBuffer(m.occ); gl.deleteBuffer(m.idx); }
    if (this.pickFb) { gl.deleteFramebuffer(this.pickFb); gl.deleteTexture(this.pickTex); gl.deleteRenderbuffer(this.pickRb); }
    gl.deleteBuffer(this.shadowBuf);
    gl.deleteProgram(this.prog); gl.deleteProgram(this.shadowProg);
  }
}
