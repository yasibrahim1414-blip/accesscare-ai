// Sculpts public/body.glb — an original, anatomically proportioned human figure
// for AccessCare AI, in the standard anatomical position (standing, arms slightly
// away from the body, palms forward). ~1.75 m tall, metres, +Y up, facing +Z.
// The patient's LEFT side is +X.
//
// Method: the body is a signed-distance field made of ~80 smoothly blended
// anatomical forms (cranium, jaw, nose, pectorals, deltoids, biceps, calves,
// fingers...). The surface is extracted with surface nets, projected exactly
// onto the field, given analytic normals and baked ambient occlusion, then split
// into one named node per selectable region (node name = region id).
// Output is glTF 2.0 binary with KHR_mesh_quantization. Original work created
// for this project; no third-party assets.
//
// Run: tsx scripts/sculptBody.ts [voxel_mm]

import { writeFileSync, mkdirSync } from 'node:fs';
import { BODY_REGIONS } from '../src/domain/bodyRegions';

type V = [number, number, number];
const H = Number(process.argv[2] ?? 4.6) / 1000; // voxel size (m)

// ---------- SDF primitives ----------
const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
function sdEllipsoid(px: number, py: number, pz: number, c: V, r: V) {
  const qx = (px - c[0]) / r[0], qy = (py - c[1]) / r[1], qz = (pz - c[2]) / r[2];
  const k0 = len3(qx, qy, qz);
  const k1 = len3(qx / r[0], qy / r[1], qz / r[2]);
  return k1 === 0 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
}
function sdRoundCone(px: number, py: number, pz: number, a: V, b: V, r1: number, r2: number) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
const smin = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

// ---------- anatomy ----------
type Tag = string; // region tag before side/overrides
interface Part { name: string; tag: Tag; k: number; sub?: boolean; f: (x: number, y: number, z: number) => number; lo: V; hi: V }
const parts: Part[] = [];
const ell = (name: string, tag: Tag, c: V, r: V, k: number, sub = false) =>
  parts.push({ name, tag, k, sub, f: (x, y, z) => sdEllipsoid(x, y, z, c, r), lo: [c[0] - r[0], c[1] - r[1], c[2] - r[2]], hi: [c[0] + r[0], c[1] + r[1], c[2] + r[2]] });
const cone = (name: string, tag: Tag, a: V, b: V, r1: number, r2: number, k: number, sub = false) => {
  const R = Math.max(r1, r2);
  parts.push({ name, tag, k, sub, f: (x, y, z) => sdRoundCone(x, y, z, a, b, r1, r2),
    lo: [Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.min(a[2], b[2]) - R],
    hi: [Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R, Math.max(a[2], b[2]) + R] });
};
const both = (fn: (s: number, side: 'l' | 'r') => void) => { fn(1, 'l'); fn(-1, 'r'); };

// Head (top of head at ~1.75 m)
ell('cranium', 'head', [0, 1.655, -0.006], [0.074, 0.094, 0.091], 0.03);
ell('occiput', 'head', [0, 1.64, -0.045], [0.064, 0.075, 0.06], 0.03);
ell('lowerface', 'face', [0, 1.597, 0.018], [0.06, 0.07, 0.074], 0.03);
ell('chin', 'face', [0, 1.538, 0.057], [0.025, 0.019, 0.021], 0.02);
ell('mouth', 'face', [0, 1.574, 0.076], [0.021, 0.0085, 0.012], 0.014);
ell('brow', 'face', [0, 1.668, 0.069], [0.054, 0.014, 0.021], 0.02);
cone('nose', 'face', [0, 1.656, 0.084], [0, 1.614, 0.103], 0.008, 0.012, 0.012);
ell('nosetip', 'face', [0, 1.611, 0.101], [0.012, 0.01, 0.011], 0.008);
both((s) => {
  ell('jaw', 'face', [s * 0.048, 1.566, 0.0], [0.022, 0.03, 0.032], 0.025);
  ell('cheek', 'face', [s * 0.044, 1.622, 0.05], [0.022, 0.016, 0.02], 0.02);
  ell('nostril', 'face', [s * 0.0105, 1.608, 0.093], [0.008, 0.007, 0.008], 0.006);
  ell('ear', 'head', [s * 0.077, 1.634, -0.006], [0.011, 0.03, 0.02], 0.008);
});
// Neck
cone('neck', 'neck', [0, 1.46, -0.014], [0, 1.575, -0.014], 0.051, 0.046, 0.03);
both((s) => cone('scm', 'neck', [s * 0.03, 1.6, -0.024], [s * 0.013, 1.468, 0.03], 0.014, 0.011, 0.018));
// Torso
both((s) => {
  cone('trapezius', 'trap', [s * 0.035, 1.52, -0.03], [s * 0.15, 1.452, -0.03], 0.03, 0.022, 0.05);
  ell('pectoral', 'chest', [s * 0.064, 1.33, 0.05], [0.07, 0.052, 0.038], 0.05);
  cone('clavicle', 'chest', [s * 0.018, 1.447, 0.03], [s * 0.165, 1.457, -0.002], 0.017, 0.019, 0.03);
  ell('lat', 'chest', [s * 0.108, 1.27, -0.028], [0.05, 0.13, 0.07], 0.05);
  ell('oblique', 'abdomen', [s * 0.108, 1.07, 0.0], [0.04, 0.09, 0.07], 0.05);
  ell('glute', 'hip', [s * 0.07, 0.905, -0.048], [0.08, 0.09, 0.075], 0.055);
});
ell('ribcage', 'chest', [0, 1.29, -0.006], [0.145, 0.175, 0.1], 0.05);
ell('trapback', 'trap', [0, 1.405, -0.052], [0.12, 0.095, 0.062], 0.06);
ell('abdomen', 'abdomen', [0, 1.09, 0.012], [0.124, 0.13, 0.092], 0.06);
ell('pelvis', 'hip', [0, 0.955, 0.0], [0.145, 0.086, 0.098], 0.06);

// Joints used for region overrides
const J = {
  elbow: (s: number): V => [s * 0.226, 1.133, -0.02],
  wrist: (s: number): V => [s * 0.255, 0.873, 0.015],
  knee: (s: number): V => [s * 0.098, 0.505, 0.012],
  ankle: (s: number): V => [s * 0.095, 0.085, -0.02],
};
// Arms (anatomical position)
both((s) => {
  const sh: V = [s * 0.19, 1.425, -0.006];
  ell('deltoid', 'shoulder', [s * 0.194, 1.402, -0.004], [0.049, 0.066, 0.055], 0.04);
  cone('upperarm', 'upper_arm', sh, J.elbow(s), 0.041, 0.034, 0.03);
  ell('biceps', 'upper_arm', [s * 0.211, 1.255, 0.014], [0.03, 0.072, 0.03], 0.028);
  ell('triceps', 'upper_arm', [s * 0.214, 1.265, -0.026], [0.032, 0.082, 0.032], 0.028);
  cone('forearm', 'forearm', J.elbow(s), J.wrist(s), 0.038, 0.025, 0.025);
  ell('brachioradialis', 'forearm', [s * 0.234, 1.06, 0.006], [0.037, 0.076, 0.035], 0.03);
  // hand: palm faces forward (+Z), thumb points laterally
  cone('wristlink', 'hand', J.wrist(s), [s * 0.26, 0.838, 0.017], 0.025, 0.027, 0.015);
  ell('palm', 'hand', [s * 0.262, 0.812, 0.018], [0.039, 0.048, 0.0145], 0.015);
  const fingers: [number, number, number][] = [[0.0235, 0.068, 0.0092], [0.008, 0.076, 0.0094], [-0.0075, 0.071, 0.009], [-0.0225, 0.056, 0.0082]];
  for (const [dx, L, r] of fingers) {
    const base: V = [s * (0.262 + dx), 0.77, 0.018];
    const mid: V = [s * (0.262 + dx * 1.08), 0.77 - L * 0.55, 0.024];
    const tip: V = [s * (0.262 + dx * 1.12), 0.77 - L, 0.031];
    cone('finger', 'hand', base, mid, r, r * 0.9, 0.006);
    cone('finger', 'hand', mid, tip, r * 0.9, r * 0.78, 0.004);
  }
  cone('thumb', 'hand', [s * 0.284, 0.834, 0.024], [s * 0.302, 0.8, 0.036], 0.0125, 0.0105, 0.01);
  cone('thumb', 'hand', [s * 0.302, 0.8, 0.036], [s * 0.31, 0.772, 0.044], 0.0105, 0.0085, 0.005);
  ell('thenar', 'hand', [s * 0.278, 0.818, 0.028], [0.017, 0.026, 0.012], 0.012);
});
// Legs
both((s) => {
  const hp: V = [s * 0.09, 0.9, 0.0];
  cone('thigh', 'thigh', hp, J.knee(s), 0.088, 0.052, 0.05);
  ell('quadriceps', 'thigh', [s * 0.094, 0.71, 0.035], [0.062, 0.15, 0.058], 0.04);
  ell('adductor', 'thigh', [s * 0.058, 0.79, 0.0], [0.045, 0.1, 0.055], 0.04);
  ell('hamstring', 'thigh', [s * 0.095, 0.7, -0.036], [0.055, 0.14, 0.05], 0.04);
  ell('vastusmedialis', 'thigh', [s * 0.075, 0.57, 0.03], [0.034, 0.05, 0.035], 0.03);
  ell('patella', 'knee', [s * 0.098, 0.503, 0.046], [0.025, 0.029, 0.016], 0.025);
  ell('kneejoint', 'knee', [s * 0.098, 0.5, 0.006], [0.045, 0.046, 0.045], 0.045);
  cone('shin', 'lower_leg', J.knee(s), J.ankle(s), 0.047, 0.027, 0.03);
  ell('gastroc_lat', 'lower_leg', [s * 0.112, 0.375, -0.03], [0.034, 0.095, 0.04], 0.035);
  ell('gastroc_med', 'lower_leg', [s * 0.084, 0.36, -0.032], [0.036, 0.1, 0.042], 0.035);
  ell('tibialis', 'lower_leg', [s * 0.104, 0.35, 0.018], [0.023, 0.11, 0.023], 0.05);
  ell('malleolus_lat', 'ankle', [s * 0.121, 0.088, -0.022], [0.014, 0.017, 0.015], 0.015);
  ell('malleolus_med', 'ankle', [s * 0.072, 0.096, -0.018], [0.014, 0.017, 0.015], 0.015);
  cone('anklelink', 'ankle', J.ankle(s), [s * 0.095, 0.055, -0.012], 0.03, 0.033, 0.02);
  ell('heel', 'foot', [s * 0.095, 0.045, -0.046], [0.032, 0.04, 0.04], 0.02);
  cone('footbody', 'foot', [s * 0.095, 0.05, -0.03], [s * 0.106, 0.03, 0.13], 0.034, 0.027, 0.03);
  ell('toes', 'foot', [s * 0.108, 0.022, 0.152], [0.04, 0.018, 0.03], 0.02);
  ell('bigtoe', 'foot', [s * 0.088, 0.024, 0.172], [0.016, 0.016, 0.02], 0.01);
});
// Subtractive details
both((s) => ell('eyesocket', 'face', [s * 0.03, 1.645, 0.093], [0.019, 0.012, 0.012], 0.02, true));
ell('navel', 'abdomen', [0, 1.04, 0.103], [0.006, 0.008, 0.006], 0.006, true);
const additive = parts.filter((p) => !p.sub);
const subtractive = parts.filter((p) => p.sub);
// eyes are added after the sockets are carved
const eyes: Part[] = [];
both((s) => eyes.push({ name: 'eye', tag: 'face', k: 0.01, f: (x, y, z) => sdEllipsoid(x, y, z, [s * 0.03, 1.644, 0.077], [0.014, 0.009, 0.011]), lo: [0, 0, 0], hi: [0, 0, 0] }));

const boxDist = (x: number, y: number, z: number, p: Part) => {
  const dx = Math.max(p.lo[0] - x, 0, x - p.hi[0]);
  const dy = Math.max(p.lo[1] - y, 0, y - p.hi[1]);
  const dz = Math.max(p.lo[2] - z, 0, z - p.hi[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

function sdf(x: number, y: number, z: number): number {
  let d = 1e9;
  for (const p of additive) {
    if (boxDist(x, y, z, p) * 0.5 - p.k > d) continue; // conservative: ellipsoid distances are approximate
    d = smin(d, p.f(x, y, z), p.k);
  }
  for (const p of subtractive) if (boxDist(x, y, z, p) < 0.03) d = smax(d, -p.f(x, y, z), p.k);
  for (const p of eyes) d = smin(d, p.f(x, y, z), p.k);
  return smax(d, -y, 0.006); // flat soles on the floor
}

// ---------- grid evaluation (narrow band) ----------
const lo: V = [-0.37, -0.012, -0.175], hi: V = [0.37, 1.775, 0.205];
const nx = Math.ceil((hi[0] - lo[0]) / H) + 1, ny = Math.ceil((hi[1] - lo[1]) / H) + 1, nz = Math.ceil((hi[2] - lo[2]) / H) + 1;
const field = new Float32Array(nx * ny * nz);
const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
const B = 8;
let evals = 0;
const t0 = Date.now();
for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
  const cx = lo[0] + (bi + B / 2) * H, cy = lo[1] + (bj + B / 2) * H, cz = lo[2] + (bk + B / 2) * H;
  const dc = sdf(cx, cy, cz);
  const half = ((B * H * Math.sqrt(3)) / 2) * 1.6 + 0.012; // generous: blended ellipsoid distances are approximate
  const skip = Math.abs(dc) > half;
  for (let k = bk; k < Math.min(bk + B, nz); k++) for (let j = bj; j < Math.min(bj + B, ny); j++) for (let i = bi; i < Math.min(bi + B, nx); i++) {
    field[at(i, j, k)] = skip ? dc : (evals++, sdf(lo[0] + i * H, lo[1] + j * H, lo[2] + k * H));
  }
}
console.log(`grid ${nx}x${ny}x${nz}, ${evals} fine evals, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- surface nets ----------
const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
const cAt = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
const pos: number[] = [];
const EDGES: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const corner = (c: number): V => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
  const v: number[] = [];
  let mask = 0;
  for (let c = 0; c < 8; c++) {
    const [a, b, d] = corner(c);
    const f = field[at(i + a, j + b, k + d)];
    v.push(f);
    if (f < 0) mask |= 1 << c;
  }
  if (mask === 0 || mask === 255) continue;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const [e0, e1] of EDGES) {
    if ((v[e0] < 0) === (v[e1] < 0)) continue;
    const t = v[e0] / (v[e0] - v[e1]);
    const a = corner(e0), b = corner(e1);
    sx += a[0] + (b[0] - a[0]) * t; sy += a[1] + (b[1] - a[1]) * t; sz += a[2] + (b[2] - a[2]) * t; n++;
  }
  cellVert[cAt(i, j, k)] = pos.length / 3;
  pos.push(lo[0] + (i + sx / n) * H, lo[1] + (j + sy / n) * H, lo[2] + (k + sz / n) * H);
}
const tris: number[] = [];
const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
  if (a < 0 || b < 0 || c < 0 || d < 0) return;
  const q = flip ? [a, d, c, b] : [a, b, c, d];
  tris.push(q[0], q[1], q[2], q[0], q[2], q[3]);
};
for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
  const f0 = field[at(i, j, k)] < 0;
  if (i < nx - 1 && f0 !== (field[at(i + 1, j, k)] < 0)) // x edge: cells around it vary in j,k
    quad(cellVert[cAt(i, j - 1, k - 1)], cellVert[cAt(i, j, k - 1)], cellVert[cAt(i, j, k)], cellVert[cAt(i, j - 1, k)], !f0);
  if (j < ny - 1 && f0 !== (field[at(i, j + 1, k)] < 0))
    quad(cellVert[cAt(i - 1, j, k - 1)], cellVert[cAt(i - 1, j, k)], cellVert[cAt(i, j, k)], cellVert[cAt(i, j, k - 1)], !f0);
  if (k < nz - 1 && f0 !== (field[at(i, j, k + 1)] < 0))
    quad(cellVert[cAt(i - 1, j - 1, k)], cellVert[cAt(i, j - 1, k)], cellVert[cAt(i, j, k)], cellVert[cAt(i - 1, j, k)], !f0);
}

// ---------- refine: project to surface, normals, ambient occlusion ----------
const nv = pos.length / 3;
const nrm = new Float32Array(nv * 3);
const ao = new Float32Array(nv);
const e = H * 0.25;
const grad = (x: number, y: number, z: number): V => {
  const gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
  const l = len3(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
};
for (let v = 0; v < nv; v++) {
  let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
  const x0 = x, y0 = y, z0 = z;
  for (let it = 0; it < 3; it++) {
    const d = sdf(x, y, z);
    if (Math.abs(d) < 1e-5) break;
    const g = grad(x, y, z);
    const step = Math.max(-H * 0.5, Math.min(H * 0.5, d));
    x -= g[0] * step; y -= g[1] * step; z -= g[2] * step;
  }
  // never move a vertex out of its own cell neighbourhood (avoids folded triangles)
  if (len3(x - x0, y - y0, z - z0) > H * 0.9) { x = x0; y = y0; z = z0; }
  pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
  const g = grad(x, y, z);
  nrm[v * 3] = g[0]; nrm[v * 3 + 1] = g[1]; nrm[v * 3 + 2] = g[2];
  let occ = 0, w = 1;
  for (const t of [0.008, 0.018, 0.035, 0.065, 0.11]) {
    const d = sdf(x + g[0] * t, y + g[1] * t, z + g[2] * t);
    occ += w * Math.max(0, (t - d) / t);
    w *= 0.62;
  }
  // floor contact darkening for the feet
  const floor = Math.max(0, 1 - y / 0.05) * 0.25;
  ao[v] = Math.max(0.22, Math.min(1, 1 - occ * 0.42 - floor));
}

// ---------- regions ----------
const nearest = (x: number, y: number, z: number): Part => {
  let best = parts[0], bd = 1e9;
  for (const p of additive) {
    if (boxDist(x, y, z, p) > bd) continue;
    const d = p.f(x, y, z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
};
const dist = (x: number, y: number, z: number, j: V) => len3(x - j[0], y - j[1], z - j[2]);
function regionOf(x: number, y: number, z: number): string {
  const side = x >= 0 ? 'l' : 'r';
  const s = x >= 0 ? 1 : -1;
  const p = nearest(x, y, z);
  let tag = p.tag;
  if (tag === 'head' && z > 0.045 && y < 1.69 && y > 1.52 && Math.abs(x) < 0.062) tag = 'face';
  if (tag === 'trap') tag = Math.abs(x) < 0.11 ? (y > 1.5 ? 'neck' : 'upper_back') : 'shoulder';
  if (tag === 'chest' && z < -0.005) tag = 'upper_back';
  if (tag === 'abdomen' && z < 0) tag = 'lower_back';
  if (tag === 'hip' && z < -0.02 && y > 0.97) tag = 'lower_back';
  if (tag === 'upper_arm' || tag === 'forearm') { if (dist(x, y, z, J.elbow(s)) < 0.05) tag = 'elbow'; }
  if (tag === 'forearm' || tag === 'hand') { if (dist(x, y, z, J.wrist(s)) < 0.03 && y > 0.85) tag = 'wrist'; }
  if (tag === 'thigh' || tag === 'lower_leg') { if (dist(x, y, z, J.knee(s)) < 0.068) tag = 'knee'; }
  if ((tag === 'lower_leg' || tag === 'foot') && y > 0.062 && y < 0.14 && dist(x, y, z, J.ankle(s)) < 0.058) tag = 'ankle';
  const center = ['head', 'face', 'neck', 'chest', 'upper_back', 'lower_back'];
  return center.includes(tag) ? tag : `${tag}_${side}`;
}

const valid = new Set(BODY_REGIONS.map((r) => r.id));
// label vertices, smooth labels over the mesh (majority of neighbours), then
// give each triangle the majority label of its corners: clean region borders
const ids = [...valid];
const idIndex = new Map(ids.map((r, i) => [r, i]));
let label = new Int32Array(nv);
for (let v = 0; v < nv; v++) {
  const r = regionOf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  if (!valid.has(r)) throw new Error(`unknown region ${r}`);
  label[v] = idIndex.get(r)!;
}
const nbr: number[][] = Array.from({ length: nv }, () => []);
for (let t = 0; t < tris.length; t += 3) {
  const a = tris[t], b = tris[t + 1], c = tris[t + 2];
  nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
}
for (let it = 0; it < 8; it++) {
  const next = new Int32Array(label);
  for (let v = 0; v < nv; v++) {
    const count = new Map<number, number>();
    count.set(label[v], 1.5);
    for (const u of nbr[v]) count.set(label[u], (count.get(label[u]) ?? 0) + 1);
    let best = label[v], bc = -1;
    for (const [l, c] of count) if (c > bc) { bc = c; best = l; }
    // never relabel across the body's midline (keeps left/right exact)
    const side = (r: string) => (r.endsWith('_l') ? 1 : r.endsWith('_r') ? -1 : 0);
    if (side(ids[best]) * Math.sign(pos[v * 3]) < 0) continue;
    next[v] = best;
  }
  label = next;
}
const byRegion = new Map<string, number[]>();
for (let t = 0; t < tris.length; t += 3) {
  const a = tris[t], b = tris[t + 1], c = tris[t + 2];
  const la = label[a], lb = label[b], lc = label[c];
  const l = lb === lc ? lb : la;
  const r = ids[l];
  if (!byRegion.has(r)) byRegion.set(r, []);
  byRegion.get(r)!.push(a, b, c);
}
const missing = [...valid].filter((r) => !byRegion.has(r));
if (missing.length) throw new Error('regions without geometry: ' + missing.join(', '));

// ---------- write quantized GLB ----------
let mn: V = [1e9, 1e9, 1e9], mx: V = [-1e9, -1e9, -1e9];
for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pos[v * 3 + c]); mx[c] = Math.max(mx[c], pos[v * 3 + c]); }
const scale: V = [(mx[0] - mn[0]) / 65535, (mx[1] - mn[1]) / 65535, (mx[2] - mn[2]) / 65535];

const chunks: Buffer[] = [];
let offset = 0;
const bufferViews: object[] = [], accessors: object[] = [], meshes: object[] = [], nodes: object[] = [];
const view = (buf: Buffer, target: number, byteStride?: number) => {
  const pad = (4 - (buf.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target, ...(byteStride ? { byteStride } : {}) });
  chunks.push(buf, Buffer.alloc(pad));
  offset += buf.length + pad;
  return bufferViews.length - 1;
};

let totalTris = 0, totalVerts = 0;
for (const r of BODY_REGIONS) {
  const idx = byRegion.get(r.id)!;
  const map = new Map<number, number>();
  const local: number[] = [];
  for (const v of idx) { if (!map.has(v)) { map.set(v, local.length); local.push(v); } }
  if (local.length > 65535) throw new Error(`${r.id}: too many vertices`);
  const P = Buffer.alloc(local.length * 8), N = Buffer.alloc(local.length * 4), C = Buffer.alloc(local.length * 4);
  const qmin = [65535, 65535, 65535], qmax = [0, 0, 0];
  local.forEach((v, i) => {
    for (let c = 0; c < 3; c++) {
      const q = Math.round((pos[v * 3 + c] - mn[c]) / scale[c]);
      P.writeUInt16LE(q, i * 8 + c * 2); qmin[c] = Math.min(qmin[c], q); qmax[c] = Math.max(qmax[c], q);
      N.writeInt8(Math.round(nrm[v * 3 + c] * 127), i * 4 + c);
    }
    const g = Math.round(ao[v] * 255);
    C.writeUInt8(g, i * 4); C.writeUInt8(g, i * 4 + 1); C.writeUInt8(g, i * 4 + 2); C.writeUInt8(255, i * 4 + 3);
  });
  const I = Buffer.from(Uint16Array.from(idx.map((v) => map.get(v)!)).buffer);
  accessors.push({ bufferView: view(P, 34962, 8), componentType: 5123, count: local.length, type: 'VEC3', min: qmin, max: qmax });
  accessors.push({ bufferView: view(N, 34962, 4), componentType: 5120, normalized: true, count: local.length, type: 'VEC3' });
  accessors.push({ bufferView: view(C, 34962, 4), componentType: 5121, normalized: true, count: local.length, type: 'VEC4' });
  accessors.push({ bufferView: view(I, 34963), componentType: 5123, count: idx.length, type: 'SCALAR' });
  const a = accessors.length;
  meshes.push({ name: r.id, primitives: [{ attributes: { POSITION: a - 4, NORMAL: a - 3, COLOR_0: a - 2 }, indices: a - 1, material: 0 }] });
  nodes.push({ name: r.id, mesh: meshes.length - 1, translation: mn, scale, extras: { label: r.label, side: r.side } });
  totalTris += idx.length / 3; totalVerts += local.length;
}
const bin = Buffer.concat(chunks);
const gltf = {
  asset: { version: '2.0', generator: 'AccessCare AI sculptBody.ts', copyright: 'Original anatomical figure created for AccessCare AI.' },
  extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
  scene: 0, scenes: [{ name: 'AccessCareBody', nodes: nodes.map((_, i) => i) }],
  nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: bin.length }],
  materials: [{ name: 'skin', pbrMetallicRoughness: { baseColorFactor: [0.86, 0.88, 0.91, 1], metallicFactor: 0, roughnessFactor: 0.62 } }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const ch = (l: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(l, 0); b.writeUInt32LE(type, 4); return b; };
const glb = Buffer.concat([header, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]);
mkdirSync('public', { recursive: true });
writeFileSync('public/body.glb', glb);
console.log(`body.glb: ${BODY_REGIONS.length} regions, ${totalVerts} verts, ${totalTris} tris, ${(glb.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
