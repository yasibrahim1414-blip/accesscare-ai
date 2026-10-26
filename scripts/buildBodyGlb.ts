// Generates public/body.glb — an original, procedurally built human mannequin
// for AccessCare AI. Every selectable body region is its own named mesh/node
// (node name = region id from src/domain/bodyRegions.ts), so the app can pick
// and highlight regions directly. Created for this project; no third-party
// assets are used, so there are no external license obligations.
//
// Run: tsx scripts/buildBodyGlb.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { BODY_REGIONS } from '../src/domain/bodyRegions';

type V3 = [number, number, number];
interface Mesh { pos: number[]; nrm: number[]; idx: number[] }

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function ellipsoid(c: V3, r: V3, seg = 28, rings = 20): Mesh {
  const m: Mesh = { pos: [], nrm: [], idx: [] };
  for (let i = 0; i <= rings; i++) {
    const v = (i / rings) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const u = (j / seg) * Math.PI * 2;
      const n: V3 = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
      m.pos.push(c[0] + n[0] * r[0], c[1] + n[1] * r[1], c[2] + n[2] * r[2]);
      m.nrm.push(...norm([n[0] / r[0], n[1] / r[1], n[2] / r[2]]));
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    m.idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  return m;
}

/** Tapered capsule from a (radius ra) to b (radius rb), with rounded caps. */
function capsule(a: V3, b: V3, ra: number, rb: number, seg = 24): Mesh {
  const axis = norm(sub(b, a));
  const helper: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(axis, helper));
  const w = cross(axis, u);
  const L = len(sub(b, a));
  // profile: [t along axis (0..1 in length units), radius, normal-axial component]
  const prof: [number, number, number][] = [];
  const capRings = 6;
  for (let i = 0; i <= capRings; i++) { // cap at a
    const th = (Math.PI / 2) * (1 - i / capRings);
    prof.push([-Math.sin(th) * ra, Math.cos(th) * ra, -Math.sin(th)]);
  }
  for (let i = 1; i < 6; i++) { const t = i / 6; prof.push([t * L, ra + (rb - ra) * t, 0]); }
  for (let i = 0; i <= capRings; i++) { // cap at b
    const th = (Math.PI / 2) * (i / capRings);
    prof.push([L + Math.sin(th) * rb, Math.cos(th) * rb, Math.sin(th)]);
  }
  const m: Mesh = { pos: [], nrm: [], idx: [] };
  prof.forEach(([t, r, na]) => {
    for (let j = 0; j <= seg; j++) {
      const ang = (j / seg) * Math.PI * 2;
      const radial = add(mul(u, Math.cos(ang)), mul(w, Math.sin(ang)));
      const p = add(add(a, mul(axis, t)), mul(radial, r));
      const nr = Math.sqrt(Math.max(0, 1 - na * na));
      m.pos.push(...p);
      m.nrm.push(...norm(add(mul(radial, nr), mul(axis, na))));
    }
  });
  for (let i = 0; i < prof.length - 1; i++) for (let j = 0; j < seg; j++) {
    const p = i * (seg + 1) + j, q = p + seg + 1;
    m.idx.push(p, q, p + 1, p + 1, q, q + 1);
  }
  return m;
}

/** Split a mesh into two by triangle centroid. */
function split(m: Mesh, pred: (c: V3) => boolean): [Mesh, Mesh] {
  const outs: [Mesh, Mesh] = [{ pos: [], nrm: [], idx: [] }, { pos: [], nrm: [], idx: [] }];
  const maps = [new Map<number, number>(), new Map<number, number>()];
  for (let t = 0; t < m.idx.length; t += 3) {
    const tri = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const c: V3 = [0, 1, 2].map((k) => (m.pos[tri[0] * 3 + k] + m.pos[tri[1] * 3 + k] + m.pos[tri[2] * 3 + k]) / 3) as V3;
    const which = pred(c) ? 0 : 1;
    const o = outs[which], map = maps[which];
    for (const v of tri) {
      if (!map.has(v)) {
        map.set(v, o.pos.length / 3);
        o.pos.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
        o.nrm.push(m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]);
      }
      o.idx.push(map.get(v)!);
    }
  }
  return outs;
}

const regions: Record<string, Mesh> = {};
const put = (id: string, m: Mesh) => { regions[id] = m; };

// head & face (face = front-lower part of the head)
const headCenter: V3 = [0, 1.62, 0];
const [face, head] = split(ellipsoid(headCenter, [0.088, 0.112, 0.1]), (c) => c[2] > 0.045 && c[1] < 1.67);
put('face', face); put('head', head);
put('neck', capsule([0, 1.46, -0.005], [0, 1.53, 0], 0.052, 0.045));
const [chest, upperBack] = split(ellipsoid([0, 1.3, 0], [0.175, 0.165, 0.105]), (c) => c[2] >= 0);
put('chest', chest); put('upper_back', upperBack);
const [abdomen, lowerBack] = split(ellipsoid([0, 1.075, 0], [0.145, 0.135, 0.095]), (c) => c[2] >= 0);
put('abdomen', abdomen); put('lower_back', lowerBack);
const [hipL, hipR] = split(ellipsoid([0, 0.925, 0], [0.165, 0.09, 0.1]), (c) => c[0] >= 0);
put('hip_l', hipL); put('hip_r', hipR);

for (const [s, sx] of [['l', 1], ['r', -1]] as const) {
  const X = (x: number) => x * sx;
  put(`shoulder_${s}`, ellipsoid([X(0.2), 1.405, 0], [0.068, 0.06, 0.066]));
  put(`upper_arm_${s}`, capsule([X(0.225), 1.35, 0], [X(0.258), 1.13, 0], 0.048, 0.04));
  put(`elbow_${s}`, ellipsoid([X(0.262), 1.095, 0], [0.042, 0.042, 0.042]));
  put(`forearm_${s}`, capsule([X(0.268), 1.06, 0.004], [X(0.286), 0.865, 0.012], 0.039, 0.03));
  put(`wrist_${s}`, ellipsoid([X(0.289), 0.835, 0.013], [0.03, 0.026, 0.026]));
  put(`hand_${s}`, ellipsoid([X(0.294), 0.75, 0.02], [0.026, 0.062, 0.044]));
  put(`thigh_${s}`, capsule([X(0.088), 0.87, 0], [X(0.1), 0.56, 0.005], 0.074, 0.056));
  put(`knee_${s}`, ellipsoid([X(0.1), 0.51, 0.01], [0.056, 0.055, 0.056]));
  put(`lower_leg_${s}`, capsule([X(0.1), 0.465, 0], [X(0.1), 0.12, -0.005], 0.05, 0.034));
  put(`ankle_${s}`, ellipsoid([X(0.1), 0.085, -0.004], [0.035, 0.03, 0.035]));
  put(`foot_${s}`, ellipsoid([X(0.1), 0.032, 0.052], [0.04, 0.03, 0.1]));
}

const missing = BODY_REGIONS.filter((r) => !regions[r.id]).map((r) => r.id);
if (missing.length) throw new Error('Missing region meshes: ' + missing.join(', '));

// ---------- GLB writer ----------
const bins: Buffer[] = [];
let offset = 0;
const bufferViews: object[] = [], accessors: object[] = [], meshes: object[] = [], nodes: object[] = [];
const pushView = (buf: Buffer, target: number) => {
  const pad = (4 - (buf.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
  bins.push(buf, Buffer.alloc(pad));
  offset += buf.length + pad;
  return bufferViews.length - 1;
};

for (const r of BODY_REGIONS) {
  const m = regions[r.id];
  const pos = Float32Array.from(m.pos), nrm = Float32Array.from(m.nrm);
  if (m.pos.length / 3 > 65535) throw new Error('too many vertices for uint16');
  const idx = Uint16Array.from(m.idx);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]);
  }
  const vp = pushView(Buffer.from(pos.buffer), 34962);
  const vn = pushView(Buffer.from(nrm.buffer), 34962);
  const vi = pushView(Buffer.from(idx.buffer), 34963);
  accessors.push({ bufferView: vp, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
  accessors.push({ bufferView: vn, componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
  accessors.push({ bufferView: vi, componentType: 5123, count: idx.length, type: 'SCALAR' });
  const a = accessors.length;
  meshes.push({ name: r.id, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: 0 }] });
  nodes.push({ name: r.id, mesh: meshes.length - 1, extras: { label: r.label, side: r.side } });
}

const bin = Buffer.concat(bins);
const gltf = {
  asset: {
    version: '2.0', generator: 'AccessCare AI buildBodyGlb.ts',
    copyright: 'Original procedural mannequin created for AccessCare AI. Free to use with this project.',
  },
  scene: 0,
  scenes: [{ name: 'AccessCareBody', nodes: nodes.map((_, i) => i) }],
  nodes, meshes, accessors, bufferViews,
  buffers: [{ byteLength: bin.length }],
  materials: [{ name: 'skin', pbrMetallicRoughness: { baseColorFactor: [0.78, 0.82, 0.87, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
const glb = Buffer.concat([header, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]);
mkdirSync('public', { recursive: true });
writeFileSync('public/body.glb', glb);
console.log(`body.glb: ${BODY_REGIONS.length} regions, ${(glb.length / 1024).toFixed(1)} KB`);
