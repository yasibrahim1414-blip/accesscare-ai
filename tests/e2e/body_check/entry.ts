import { BodyRenderer, LIGHT_PALETTE } from '../../../src/body/BodyRenderer';
import { parseGlb } from '../../../src/body/glb';
(window as any).show = async (url: string, yaw: number, sel: string[], dist = 3.05, ty = 0.89, pitch = 0.04) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const meshes = parseGlb(buf);
  const c = document.getElementById('c') as HTMLCanvasElement;
  const r = new BodyRenderer(c, meshes); r.palette = LIGHT_PALETTE;
  r.view = { yaw, pitch, distance: dist, target: [0, ty, 0] }; r.selected = new Set(sel); r.render();
  return meshes.map((m) => m.name);
};
(window as any).pickTest = async (url: string) => {
  const meshes = parseGlb(await (await fetch(url)).arrayBuffer());
  const c = document.getElementById('c') as HTMLCanvasElement;
  const r = new BodyRenderer(c, meshes) as any;
  const out: Record<string, string> = {};
  for (const m of meshes) {
    for (const yaw of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    const vd = [Math.sin(yaw), 0, Math.cos(yaw)];
    // surface vertex near the region centre that faces the camera
    let best = -1, bs = -1e9;
    for (let i = 0; i < m.positions.length / 3; i++) {
      const d = Math.hypot(m.positions[i*3]-m.center[0], m.positions[i*3+1]-m.center[1]);
      const f = m.normals[i*3]*vd[0] + m.normals[i*3+2]*vd[2];
      const s = f * 0.6 - d * 8;
      if (s > bs) { bs = s; best = i; }
    }
    const p = [m.positions[best*3], m.positions[best*3+1], m.positions[best*3+2]];
    r.view = { yaw, pitch: 0.04, distance: 3.05, target: [0, 0.89, 0] };
    r.render();
    const { mvp } = r.matrices();
    const x = mvp[0]*p[0]+mvp[4]*p[1]+mvp[8]*p[2]+mvp[12], y = mvp[1]*p[0]+mvp[5]*p[1]+mvp[9]*p[2]+mvp[13], w = mvp[3]*p[0]+mvp[7]*p[1]+mvp[11]*p[2]+mvp[15];
    const rect = c.getBoundingClientRect();
    const sx = rect.left + (x / w * 0.5 + 0.5) * rect.width, sy = rect.top + (1 - (y / w * 0.5 + 0.5)) * rect.height;
    const got = r.pick(sx, sy) ?? 'none';
    if (!out[m.name] || got === m.name) out[m.name] = got;
    }
  }
  return out;
};
