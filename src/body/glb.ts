// GLB (binary glTF 2.0) reader for the AccessCare body model.
// Supports what body.glb uses: one buffer, POSITION / NORMAL / COLOR_0 /
// indices, KHR_mesh_quantization (uint16 positions dequantized by the node's
// translation + scale, normalized int8 normals, normalized uint8 colors),
// interleaving via byteStride. Also reads plain float models.

export interface BodyMesh {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  /** per-vertex ambient occlusion 0..1 (1 = fully lit) */
  occlusion: Float32Array;
  indices: Uint16Array | Uint32Array;
  center: [number, number, number];
}

export class GlbError extends Error {}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function parseGlb(data: ArrayBuffer): BodyMesh[] {
  const dv = new DataView(data);
  if (data.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new GlbError('Not a GLB file');
  if (dv.getUint32(4, true) !== 2) throw new GlbError('Unsupported glTF version');
  let off = 12;
  let json: any = null;
  let bin: DataView | null = null;
  while (off < data.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, len)));
    else if (type === 0x004e4942) bin = new DataView(data, start, len);
    off = start + len;
  }
  if (!json || !bin) throw new GlbError('GLB is missing JSON or BIN chunk');

  /** Reads an accessor into a Float32Array (normalized ints mapped to 0..1 / -1..1). */
  const readFloat = (i: number): { arr: Float32Array; comps: number; count: number } => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const comps = COMPONENTS[a.type];
    const size = SIZES[a.componentType];
    if (!comps || !size) throw new GlbError('Unsupported accessor');
    const stride = bv.byteStride ?? comps * size;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float32Array(a.count * comps);
    for (let n = 0; n < a.count; n++) for (let c = 0; c < comps; c++) {
      const o = base + n * stride + c * size;
      let v: number;
      switch (a.componentType) {
        case 5126: v = bin!.getFloat32(o, true); break;
        case 5123: v = bin!.getUint16(o, true); if (a.normalized) v /= 65535; break;
        case 5122: v = bin!.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
        case 5121: v = bin!.getUint8(o); if (a.normalized) v /= 255; break;
        case 5120: v = bin!.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
        default: v = bin!.getUint32(o, true);
      }
      out[n * comps + c] = v;
    }
    return { arr: out, comps, count: a.count };
  };
  const readIndices = (i: number): Uint16Array | Uint32Array => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = a.componentType === 5125 ? new Uint32Array(a.count) : new Uint16Array(a.count);
    for (let n = 0; n < a.count; n++) {
      out[n] = a.componentType === 5125 ? bin!.getUint32(base + n * 4, true)
        : a.componentType === 5123 ? bin!.getUint16(base + n * 2, true) : bin!.getUint8(base + n);
    }
    return out;
  };

  const out: BodyMesh[] = [];
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const mesh = json.meshes[node.mesh];
    const t: number[] = node.translation ?? [0, 0, 0];
    const s: number[] = node.scale ?? [1, 1, 1];
    for (const prim of mesh.primitives) {
      const P = readFloat(prim.attributes.POSITION);
      const pos = P.arr;
      const c = [0, 0, 0];
      for (let i = 0; i < pos.length; i += 3) {
        for (let k = 0; k < 3; k++) { pos[i + k] = pos[i + k] * s[k] + t[k]; c[k] += pos[i + k]; }
      }
      const n = P.count || 1;
      const N = prim.attributes.NORMAL !== undefined ? readFloat(prim.attributes.NORMAL).arr : new Float32Array(pos.length);
      for (let i = 0; i < N.length; i += 3) {
        const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
        N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
      }
      const occ = new Float32Array(P.count).fill(1);
      if (prim.attributes.COLOR_0 !== undefined) {
        const C = readFloat(prim.attributes.COLOR_0);
        for (let v = 0; v < P.count; v++) occ[v] = C.arr[v * C.comps];
      }
      out.push({
        name: node.name ?? mesh.name, positions: pos, normals: N, occlusion: occ,
        indices: readIndices(prim.indices), center: [c[0] / n, c[1] / n, c[2] / n],
      });
    }
  }
  if (!out.length) throw new GlbError('GLB contains no meshes');
  return out;
}
