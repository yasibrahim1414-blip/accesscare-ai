"""Builds public/body.glb from the MakeHuman base mesh (CC0, see vendor/makehuman/).

Pipeline
  1. read the MakeHuman base mesh (13,380-vertex quad body + eyeballs)
  2. apply the CC0 "young adult" macro targets (male, mixed ancestry) -> realistic adult proportions
  3. label every face with one of AccessCare's 32 body regions, using MakeHuman's CC0 skin weights
     (which bone moves each vertex) refined by joint positions (elbow, wrist, knee, ankle bands,
     chest/abdomen and upper/lower back levels, face vs head)
  4. one Catmull-Clark subdivision for smooth anatomical contours (~53k vertices)
  5. smooth normals, voxel ambient occlusion, metres with feet on y = 0, patient's left = +x, facing +z
  6. write a quantized GLB with one mesh per region (the format src/body/glb.ts reads)

Run: python3 scripts/build_body_makehuman.py [--gender 1.0] [--out public/body.glb]
"""
import argparse, json, math, struct, sys, time
from collections import defaultdict
import numpy as np
from scipy import ndimage

t0 = time.time()
ap = argparse.ArgumentParser()
ap.add_argument('--gender', type=float, default=1.0, help='0 = female, 1 = male (MakeHuman macro)')
ap.add_argument('--out', default='public/body.glb')
ap.add_argument('--height', type=float, default=1.75)
ap.add_argument('--debug', default='')
args = ap.parse_args()
VD = 'vendor/makehuman'

# ---------------------------------------------------------------- 1. read mesh
verts = []; faces = []; groups = defaultdict(list)
g = None
for line in open(f'{VD}/base.obj'):
    if line.startswith('v '): verts.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('g '): g = line.split()[1]
    elif line.startswith('f '):
        f = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
        groups[g].append(f)
V = np.array(verts, dtype=np.float64)

# ---------------------------------------------------------------- 2. targets
def apply_target(name, w):
    if w <= 0: return
    for line in open(f'{VD}/targets/{name}.target'):
        if not line.strip() or line[0] == '#': continue
        p = line.split(); i = int(p[0])
        V[i] += w * np.array([float(p[1]), float(p[2]), float(p[3])])
for race in ('caucasian', 'african', 'asian'):
    apply_target(f'{race}-male-young', args.gender / 3)
    apply_target(f'{race}-female-young', (1 - args.gender) / 3)

def joint(name):
    idx = sorted({i for f in groups[f'joint-{name}'] for i in f})
    return V[idx].mean(0)
J = {n: joint(n) for n in ['l-shoulder', 'r-shoulder', 'l-elbow', 'r-elbow', 'l-hand', 'r-hand', 'l-upper-leg', 'r-upper-leg',
                          'l-knee', 'r-knee', 'l-ankle', 'r-ankle', 'neck', 'head', 'pelvis', 'l-eye', 'r-eye', 'jaw', 'l-clavicle', 'r-clavicle', 'ground',
                          'l-finger-3-1', 'r-finger-3-1', 'l-foot-1', 'r-foot-1']}

body_faces = np.array(groups['body'], dtype=np.int64)            # all quads
eye_faces = np.array(groups['helper-l-eye'] + groups['helper-r-eye'], dtype=np.int64)

# ---------------------------------------------------------------- 3. regions
W = json.load(open(f'{VD}/default_weights.mhw'))['weights']
best_w = np.zeros(len(V)); best_b = np.array([''] * len(V), dtype=object)
for bone, pairs in W.items():
    for i, w in pairs:
        if w > best_w[i]: best_w[i] = w; best_b[i] = bone

def vertex_normals(P, F):
    n = np.zeros_like(P)
    tris = np.concatenate([F[:, [0, 1, 2]], F[:, [0, 2, 3]]]) if F.shape[1] == 4 else F
    fn = np.cross(P[tris[:, 1]] - P[tris[:, 0]], P[tris[:, 2]] - P[tris[:, 0]])
    for k in range(3): np.add.at(n, tris[:, k], fn)
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
N0 = vertex_normals(V, body_faces)

def side_of(bone, x):
    if bone.endswith('.L'): return 'l'
    if bone.endswith('.R'): return 'r'
    return 'l' if x > 0 else 'r'

def along(p, a, b):
    """position of p along segment a->b (0 at a, 1 at b) and the segment length"""
    d = b - a; L = np.linalg.norm(d)
    return float(np.dot(p - a, d) / (L * L)), L

neck_y, pelvis_y = J['neck'][1], J['pelvis'][1]
torso_h = neck_y - pelvis_y
chest_cut = neck_y - 0.43 * torso_h          # bottom of the rib cage (front)
back_cut = neck_y - 0.47 * torso_h            # upper / lower back
eye_y = (J['l-eye'][1] + J['r-eye'][1]) / 2
face_top = eye_y + 0.42                        # mid-forehead (MakeHuman units = dm)
hip_y = (J['l-upper-leg'][1] + J['r-upper-leg'][1]) / 2

FAMILIES = ['head', 'neck', 'torso', 'arm_l', 'arm_r', 'hand_l', 'hand_r', 'leg_l', 'leg_r', 'foot_l', 'foot_r']
def family(b, x):
    base = b.split('.')[0]; s = side_of(b, x)
    if base in ('head', 'jaw', 'eye') or base.startswith(('oris', 'levator', 'risorius', 'orbicularis', 'oculi', 'temporalis', 'special', 'tongue')): return 'head'
    if base.startswith('neck'): return 'neck'
    if base.startswith(('upperarm', 'lowerarm', 'wrist')): return f'arm_{s}'
    if base.startswith(('metacarpal', 'finger')): return f'hand_{s}'
    if base.startswith(('upperleg', 'lowerleg')): return f'leg_{s}'
    if base.startswith(('foot', 'toe')): return f'foot_{s}'
    return 'torso'
FAM = np.zeros((len(V), len(FAMILIES)))
for i in range(len(V)):
    if best_b[i]: FAM[i, FAMILIES.index(family(best_b[i], V[i, 0]))] = 1

def classify(p, n, fam):
    """region of one point of the smooth (subdivided) surface; planes and spheres give smooth borders"""
    x = p[0]; s = 'l' if x > 0 else 'r'
    if fam == 'head':
        return 'face' if n[2] > 0.25 and p[1] < face_top and abs(x) < 0.62 else 'head'
    if fam == 'neck': return 'neck'
    sh = J[f'{s}-shoulder']
    if fam in ('torso', f'arm_{s}') and np.linalg.norm((p - sh) * np.array([1.0, 1.0, 1.25])) < 0.98 and p[1] > sh[1] - 0.9:
        if not (fam == 'torso' and abs(x) < 0.5 * abs(sh[0])): return f'shoulder_{s}'
    if fam.startswith(('arm', 'hand')):
        el, wr = J[f'{s}-elbow'], J[f'{s}-hand']
        t_up, L_up = along(p, sh, el); t_lo, L_lo = along(p, el, wr)
        # signed distance from the elbow along the arm (negative = towards the shoulder)
        d_up = np.linalg.norm(p - (sh + np.clip(t_up, 0, 1) * (el - sh))); d_lo = np.linalg.norm(p - (el + np.clip(t_lo, 0, 1) * (wr - el)))
        sd = t_lo * L_lo if d_lo < d_up else -(1 - t_up) * L_up
        if fam.startswith('hand'): return f'wrist_{s}' if sd < L_lo + 0.25 else f'hand_{s}'
        if -0.6 < sd < 0.6: return f'elbow_{s}'
        if sd > L_lo - 0.45: return f'wrist_{s}' if sd < L_lo + 0.3 else f'hand_{s}'
        return f'upper_arm_{s}' if sd < 0 else f'forearm_{s}'
    if fam.startswith(('leg', 'foot')):
        hp, kn, an = J[f'{s}-upper-leg'], J[f'{s}-knee'], J[f'{s}-ankle']
        t_up, L_up = along(p, hp, kn); t_lo, L_lo = along(p, kn, an)
        d_up = np.linalg.norm(p - (hp + np.clip(t_up, 0, 1) * (kn - hp))); d_lo = np.linalg.norm(p - (kn + np.clip(t_lo, 0, 1) * (an - kn)))
        sd = t_lo * L_lo if d_lo < d_up else -(1 - t_up) * L_up
        if fam.startswith('foot'): return f'ankle_{s}' if p[1] > an[1] - 0.3 else f'foot_{s}'
        if p[1] > hip_y - 0.55 and sd < -L_up + 1.0:
            return f'abdomen_{s}' if n[2] > 0.35 else f'hip_{s}'
        if -0.65 < sd < 0.65: return f'knee_{s}'
        if sd > L_lo - 0.55: return f'ankle_{s}'
        return f'thigh_{s}' if sd < 0 else f'lower_leg_{s}'
    # torso: front / back by the surface normal
    if n[2] > 0.0:
        if p[1] > chest_cut: return 'chest'
        return f'abdomen_{s}'
    if p[1] < hip_y + 1.1: return f'hip_{s}'
    if p[1] > neck_y - 0.1 and abs(x) < 0.5: return 'neck'
    return 'upper_back' if p[1] > back_cut else 'lower_back'

REGIONS = ['head', 'face', 'neck', 'chest', 'abdomen_l', 'abdomen_r', 'upper_back', 'lower_back'] + \
    [f'{b}_{s}' for b in ('shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand', 'hip', 'thigh', 'knee', 'lower_leg', 'ankle', 'foot') for s in ('l', 'r')]
RID = {r: k for k, r in enumerate(REGIONS)}
eye_v = np.unique(np.array(groups['helper-l-eye'] + groups['helper-r-eye']))
FAM[eye_v] = 0; FAM[eye_v, 0] = 1
# ---------------------------------------------------------------- 4. Catmull-Clark (one level)
def catmull_clark(P, F):
    nv = len(P); nf = len(F)
    fp = P[F].mean(1)
    e_map = {}; e_faces = []; e_verts = []
    fe = np.zeros((nf, 4), dtype=np.int64)
    for fi, f in enumerate(F):
        for k in range(4):
            a, b = int(f[k]), int(f[(k + 1) % 4]); key = (a, b) if a < b else (b, a)
            ei = e_map.get(key)
            if ei is None: ei = len(e_verts); e_map[key] = ei; e_verts.append(key); e_faces.append([])
            e_faces[ei].append(fi); fe[fi, k] = ei
    ev = np.array(e_verts); ne = len(ev)
    boundary = np.array([len(x) == 1 for x in e_faces])
    mid = (P[ev[:, 0]] + P[ev[:, 1]]) / 2
    ep = mid.copy()
    inner = ~boundary
    fa = np.array([x[0] for x in e_faces]); fb = np.array([x[-1] for x in e_faces])
    ep[inner] = (P[ev[inner, 0]] + P[ev[inner, 1]] + fp[fa[inner]] + fp[fb[inner]]) / 4
    # vertex points
    Q = np.zeros_like(P); nQ = np.zeros(nv)
    for k in range(4): np.add.at(Q, F[:, k], fp); np.add.at(nQ, F[:, k], 1)
    R = np.zeros_like(P); nR = np.zeros(nv)
    for k in range(2): np.add.at(R, ev[:, k], mid); np.add.at(nR, ev[:, k], 1)
    used = nQ > 0
    n = np.maximum(nQ, 1)[:, None]
    vp = P.copy()
    vp[used] = ((Q[used] / n[used]) + 2 * (R[used] / nR[used, None]) + (n[used] - 3) * P[used]) / n[used]
    bnd_n = np.zeros_like(P); bnd_c = np.zeros(nv)
    for k, o in ((0, 1), (1, 0)):
        np.add.at(bnd_n, ev[boundary, k], P[ev[boundary, o]]); np.add.at(bnd_c, ev[boundary, k], 1)
    isb = bnd_c >= 2
    vp[isb] = 0.75 * P[isb] + 0.125 * bnd_n[isb]
    NP = np.concatenate([vp, ep, fp])
    E0 = nv; F0 = nv + ne
    nfaces = []
    for fi, f in enumerate(F):
        for k in range(4):
            nfaces.append([f[k], E0 + fe[fi, k], F0 + fi, E0 + fe[fi, (k - 1) % 4]])
    return NP, np.array(nfaces, dtype=np.int64)

# keep only used vertices of body + eyes
allF = np.concatenate([body_faces, eye_faces])
used = np.unique(allF); remap = -np.ones(len(V), dtype=np.int64); remap[used] = np.arange(len(used))
X = np.concatenate([V[used], FAM[used]], axis=1); Fq = remap[allF]
X, Fq = catmull_clark(X, Fq)
P = X[:, :3].copy()
Nf = vertex_normals(P, Fq)
fam_of = np.array(FAMILIES)[X[:, 3:].argmax(1)]
vlab = np.array([RID[classify(P[i], Nf[i], fam_of[i])] for i in range(len(P))])
eye_fine = np.unique(Fq[len(body_faces) * 4:]); vlab[eye_fine] = RID['face']
def face_major(row):
    v, c = np.unique(row, return_counts=True); return v[c.argmax()]
# light diffusion of the per-vertex labels smooths any remaining jagged borders
Lv = np.zeros((len(P), len(REGIONS))); Lv[np.arange(len(P)), vlab] = 1
ei = np.unique(np.sort(np.concatenate([Fq[:, [0, 1]], Fq[:, [1, 2]], Fq[:, [2, 3]], Fq[:, [3, 0]]]), axis=1), axis=0)
deg = np.bincount(ei.ravel(), minlength=len(P)).astype(float)[:, None]
for _ in range(10):
    acc = np.zeros_like(Lv); np.add.at(acc, ei[:, 0], Lv[ei[:, 1]]); np.add.at(acc, ei[:, 1], Lv[ei[:, 0]])
    Lv = 0.5 * Lv + 0.5 * acc / np.maximum(deg, 1)
    Lv[eye_fine] = 0; Lv[eye_fine, RID['face']] = 1
# cut triangles along the border between two regions (where their label scores are equal),
# so region outlines are smooth curves instead of following the mesh edges
vl = Lv.argmax(1)
T0 = np.concatenate([Fq[:, [0, 1, 2]], Fq[:, [0, 2, 3]]])
P_list = [P]; extra = 0; cut = {}
def cut_point(a, b, A, B):
    global extra
    key = (min(a, b), max(a, b), min(A, B), max(A, B))
    if key in cut: return cut[key]
    fa = Lv[a, A] - Lv[a, B]; fb = Lv[b, A] - Lv[b, B]
    t = 0.5 if fa == fb else min(0.98, max(0.02, fa / (fa - fb)))
    P_list.append((P[a] + t * (P[b] - P[a]))[None]); idx = len(P) + extra; extra += 1
    cut[key] = idx; return idx
tris_out = []; reg_out = []
for tri in T0:
    labs = vl[tri]
    u = np.unique(labs)
    if len(u) == 1: tris_out.append(tri); reg_out.append(u[0]); continue
    if len(u) == 3:
        tris_out.append(tri); reg_out.append(Lv[tri].sum(0).argmax()); continue
    A, B = u
    k = [i for i in range(3) if (labs == labs[i]).sum() == 1][0]   # the lone corner
    lone, o1, o2 = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
    LA, LB = vl[lone], vl[o1]
    m1 = cut_point(lone, o1, LA, LB); m2 = cut_point(lone, o2, LA, LB)
    tris_out += [[lone, m1, m2], [m1, o1, o2], [m1, o2, m2]]; reg_out += [LA, LB, LB]
P = np.concatenate(P_list)
tris = np.array(tris_out, dtype=np.int64); treg = np.array(reg_out)

# ---------------------------------------------------------------- 5. units, normals, AO
P *= 0.1                                                 # decimetres -> metres
miny = P[:, 1].min(); P[:, 1] -= miny
P *= args.height / P[:, 1].max()
P[:, 0] -= (P[:, 0].max() + P[:, 0].min()) / 2
torso = (P[:, 1] > 0.9) & (P[:, 1] < 1.3) & (np.abs(P[:, 0]) < 0.15)
P[:, 2] -= (P[torso, 2].max() + P[torso, 2].min()) / 2
N = vertex_normals(P, tris)

# voxel solid for ambient occlusion
h = 0.006
lo = P.min(0) - 0.05; dims = np.ceil((P.max(0) + 0.05 - lo) / h).astype(int)
occ = np.zeros(dims, dtype=bool)
A, B, C = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
for u in np.linspace(0, 1, 5):
    for v in np.linspace(0, 1 - u, max(1, int(5 * (1 - u)))):
        pts = A + u * (B - A) + v * (C - A)
        ijk = np.floor((pts - lo) / h).astype(int)
        occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
occ = ndimage.binary_closing(occ, iterations=2)
solid = ndimage.binary_fill_holes(occ)
rng = np.random.default_rng(7)
dirs = rng.normal(size=(48, 3)); dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
steps = np.array([0.018, 0.03, 0.05, 0.08, 0.12, 0.18])
ao = np.zeros(len(P))
for d in dirs:
    cosang = N @ d
    front = cosang > 0.05
    hit = np.zeros(len(P), dtype=bool)
    for s in steps:
        q = P + N * 0.006 + d * s
        ijk = np.floor((q - lo) / h).astype(int)
        ok = np.all((ijk >= 0) & (ijk < dims), axis=1)
        inside = np.zeros(len(P), dtype=bool)
        inside[ok] = solid[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]]
        hit |= inside
    ao += np.where(front, hit * cosang, 0)
norm = np.zeros(len(P))
for d in dirs: norm += np.maximum(N @ d, 0) * (N @ d > 0.05)
ao = 1 - ao / np.maximum(norm, 1e-6)
ao = np.clip(0.25 + 0.75 * ao, 0.25, 1.0)
# smooth AO a little over the mesh
for _ in range(2):
    s = np.zeros(len(P)); c = np.zeros(len(P))
    for k in range(3):
        np.add.at(s, tris[:, k], ao[tris[:, (k + 1) % 3]] + ao[tris[:, (k + 2) % 3]]); np.add.at(c, tris[:, k], 2)
    ao = 0.5 * ao + 0.5 * s / np.maximum(c, 1)

if args.debug:
    np.savez(args.debug, P=P, tris=tris, treg=treg, N=N, ao=ao, regions=np.array(REGIONS))

# ---------------------------------------------------------------- 6. GLB
sys.path.insert(0, 'scripts')
LABEL = {r: r for r in REGIONS}
mn = P.min(0); mx = P.max(0); scale = (mx - mn) / 65535
chunks = []; offset = 0; bufferViews = []; accessors = []; meshes = []; nodes = []
def view(buf, target, stride=None):
    global offset
    pad = (4 - len(buf) % 4) % 4
    bv = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(buf), 'target': target}
    if stride: bv['byteStride'] = stride
    bufferViews.append(bv); chunks.append(buf + b'\0' * pad); offset += len(buf) + pad
    return len(bufferViews) - 1
total_v = total_t = 0
for rid, name in enumerate(REGIONS):
    T = tris[treg == rid]
    if len(T) == 0: raise SystemExit(f'region without geometry: {name}')
    local, inv = np.unique(T, return_inverse=True)
    if len(local) > 65535: raise SystemExit(f'{name}: too many vertices')
    q = np.round((P[local] - mn) / scale).astype(np.uint16)
    Pb = np.zeros((len(local), 4), dtype=np.uint16); Pb[:, :3] = q
    Nb = np.zeros((len(local), 4), dtype=np.int8); Nb[:, :3] = np.round(N[local] * 127).astype(np.int8)
    g8 = np.round(ao[local] * 255).astype(np.uint8)
    Cb = np.stack([g8, g8, g8, np.full_like(g8, 255)], 1)
    I = inv.reshape(-1).astype(np.uint16)
    accessors.append({'bufferView': view(Pb.tobytes(), 34962, 8), 'componentType': 5123, 'count': len(local), 'type': 'VEC3',
                      'min': q.min(0).tolist(), 'max': q.max(0).tolist()})
    accessors.append({'bufferView': view(Nb.tobytes(), 34962, 4), 'componentType': 5120, 'normalized': True, 'count': len(local), 'type': 'VEC3'})
    accessors.append({'bufferView': view(Cb.tobytes(), 34962, 4), 'componentType': 5121, 'normalized': True, 'count': len(local), 'type': 'VEC4'})
    accessors.append({'bufferView': view(I.tobytes(), 34963), 'componentType': 5123, 'count': len(I), 'type': 'SCALAR'})
    a = len(accessors)
    meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': a - 4, 'NORMAL': a - 3, 'COLOR_0': a - 2}, 'indices': a - 1, 'material': 0}]})
    nodes.append({'name': name, 'mesh': len(meshes) - 1, 'translation': mn.tolist(), 'scale': scale.tolist()})
    total_v += len(local); total_t += len(T)
binbuf = b''.join(chunks)
gltf = {
    'asset': {'version': '2.0', 'generator': 'AccessCare AI build_body_makehuman.py',
              'copyright': 'Based on the MakeHuman base mesh, targets and weights (CC0 1.0, makehumancommunity.org); region split, subdivision and shading data by AccessCare AI.'},
    'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
    'scene': 0, 'scenes': [{'name': 'AccessCareBody', 'nodes': list(range(len(nodes)))}],
    'nodes': nodes, 'meshes': meshes, 'accessors': accessors, 'bufferViews': bufferViews, 'buffers': [{'byteLength': len(binbuf)}],
    'materials': [{'name': 'skin', 'pbrMetallicRoughness': {'baseColorFactor': [0.87, 0.72, 0.62, 1], 'metallicFactor': 0, 'roughnessFactor': 0.6}}],
}
js = json.dumps(gltf).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binbuf), 0x004E4942) + binbuf
open(args.out, 'wb').write(glb)
counts = {r: int((treg == RID[r]).sum()) for r in REGIONS}
print(f'{args.out}: {len(REGIONS)} regions, {total_v} verts, {total_t} tris, {len(glb) / 1024:.0f} KB, height {P[:, 1].max():.2f} m, {time.time() - t0:.1f}s')
print('smallest regions:', sorted(counts.items(), key=lambda kv: kv[1])[:5])
