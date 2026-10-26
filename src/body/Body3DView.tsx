import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuRotateCcw, LuRotateCw, LuZoomIn, LuZoomOut, LuRefreshCw, LuScan } from 'react-icons/lu';
import { BodyRenderer, DARK_PALETTE, DEFAULT_VIEW, LIGHT_PALETTE, type ViewState } from './BodyRenderer';
import { parseGlb, type BodyMesh } from './glb';
import { regionLabel } from '../domain/bodyRegions';

export const BODY_MODEL_URL = 'body.glb';
let cache: Promise<BodyMesh[]> | null = null;
export function loadBodyModel(): Promise<BodyMesh[]> {
  if (!cache) {
    // The in-Claude build embeds the GLB as base64 so it needs no network.
    const embedded = (globalThis as { __ACCESSCARE_BODY_GLB__?: string }).__ACCESSCARE_BODY_GLB__;
    cache = new Promise<BodyMesh[]>((resolve, reject) => {
      setTimeout(async () => {
        try {
          let buf: ArrayBuffer;
          if (embedded) {
            const bin = atob(embedded);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            buf = bytes.buffer;
          } else {
            const r = await fetch(BODY_MODEL_URL);
            if (!r.ok) throw new Error(`model download failed (${r.status})`);
            buf = await r.arrayBuffer();
          }
          resolve(parseGlb(buf));
        } catch (e) { cache = null; reject(e); }
      }, 30);
    });
  }
  return cache;
}

const VIEWS: Record<string, number> = { Front: 0, Back: Math.PI, Left: Math.PI / 2, Right: -Math.PI / 2 };
const isDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

export function Body3DView({ selected, onToggle, focus, readOnly, reducedMotion, onUnavailable, height = 400 }: {
  selected: string[]; onToggle?: (id: string) => void; focus?: string | null; readOnly?: boolean;
  reducedMotion?: boolean; onUnavailable: (reason: string) => void; height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<BodyRenderer | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [tapped, setTapped] = useState<{ id: string; on: boolean } | null>(null);
  const tapTimer = useRef(0);
  const [facing, setFacing] = useState('Front');
  const [zoomed, setZoomed] = useState(false);
  const anim = useRef(0);
  const spin = useRef({ v: 0, raf: 0 });

  const updateFacing = () => {
    const r = rRef.current; if (!r) return;
    const y = Math.atan2(Math.sin(r.view.yaw), Math.cos(r.view.yaw));
    setFacing(Math.abs(y) < Math.PI / 4 ? 'Front' : Math.abs(y) > (3 * Math.PI) / 4 ? 'Back' : y > 0 ? 'Left side' : 'Right side');
    setZoomed(r.view.distance < 2.4);
  };

  const animateTo = useCallback((to: Partial<ViewState>, ms = 520) => {
    const r = rRef.current; if (!r) return;
    cancelAnimationFrame(anim.current);
    cancelAnimationFrame(spin.current.raf);
    const from = { ...r.view, target: [...r.view.target] as [number, number, number] };
    let dy = (to.yaw ?? from.yaw) - from.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const end: ViewState = {
      yaw: from.yaw + dy, pitch: to.pitch ?? from.pitch, distance: to.distance ?? from.distance,
      target: (to.target ?? from.target) as [number, number, number],
    };
    if (reducedMotion) { r.view = end; r.requestRender(); updateFacing(); return; }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      r.view = {
        yaw: from.yaw + (end.yaw - from.yaw) * e, pitch: from.pitch + (end.pitch - from.pitch) * e,
        distance: from.distance + (end.distance - from.distance) * e,
        target: [0, 1, 2].map((i) => from.target[i] + (end.target[i] - from.target[i]) * e) as [number, number, number],
      };
      r.render(); updateFacing();
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  const focusRegion = useCallback((id: string) => {
    const r = rRef.current; if (!r) return;
    const c = r.regionCenter(id); if (!c) return;
    // face the region: back regions from behind, side regions from their side
    const yaw = /back/.test(id) ? Math.PI : Math.abs(c[0]) > 0.17 ? (c[0] > 0 ? 0.55 : -0.55) : 0;
    const dist = /head|face|neck|hand|wrist|foot|ankle/.test(id) ? 0.85 : 1.15;
    animateTo({ yaw, pitch: 0.05, distance: dist, target: [c[0] * 0.85, c[1], 0] }, 650);
  }, [animateTo]);

  const init = useCallback(() => {
    setStatus('loading');
    let disposed = false;
    loadBodyModel().then((meshes) => {
      if (disposed || !canvasRef.current) return;
      try {
        const r = new BodyRenderer(canvasRef.current, meshes);
        r.palette = isDark() ? DARK_PALETTE : LIGHT_PALETTE;
        r.selected = new Set(selected);
        rRef.current = r;
        r.requestRender();
        setStatus('ready');
      } catch (e) {
        setStatus('error'); setErr((e as Error).message);
        onUnavailable((e as Error).message);
      }
    }).catch((e) => { if (!disposed) { setStatus('error'); setErr((e as Error).message); onUnavailable((e as Error).message); } });
    return () => { disposed = true; cancelAnimationFrame(anim.current); cancelAnimationFrame(spin.current.raf); rRef.current?.dispose(); rRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(init, [init]);

  useEffect(() => {
    const r = rRef.current; if (!r) return;
    r.selected = new Set(selected); r.focus = focus ?? null; r.requestRender();
  }, [selected, focus, status]);
  useEffect(() => { if (status === 'ready' && focus) focusRegion(focus); }, [focus, status, focusRegion]);

  // gentle pulse on selected regions (off with reduced motion)
  useEffect(() => {
    if (status !== 'ready' || reducedMotion || !selected.length) { if (rRef.current) { rRef.current.pulse = 0; rRef.current.requestRender(); } return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const r = rRef.current; if (!r) return;
      r.pulse = 0.5 + 0.5 * Math.sin((t - t0) / 420);
      r.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const stop = setTimeout(() => { cancelAnimationFrame(raf); if (rRef.current) { rRef.current.pulse = 0; rRef.current.requestRender(); } }, 1800);
    return () => { cancelAnimationFrame(raf); clearTimeout(stop); };
  }, [selected.join(','), status, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => rRef.current?.requestRender();
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme = () => { if (rRef.current) { rRef.current.palette = isDark() ? DARK_PALETTE : LIGHT_PALETTE; rRef.current.requestRender(); } };
    window.addEventListener('resize', onResize);
    mq?.addEventListener?.('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { window.removeEventListener('resize', onResize); mq?.removeEventListener?.('change', onTheme); mo.disconnect(); };
  }, []);

  const zoom = (f: number) => {
    const r = rRef.current; if (!r) return;
    r.view.distance = Math.min(4.2, Math.max(0.6, r.view.distance * f));
    if (r.view.distance > 2.6) r.view.target = [r.view.target[0] * 0.8, 0.9 + (r.view.target[1] - 0.9) * 0.8, 0];
    r.requestRender(); updateFacing();
  };

  // gestures: one finger rotates (with momentum), two fingers pinch-zoom, tap selects, double-tap zooms to a region
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef({ moved: 0, pinch: 0, lastT: 0, vx: 0, lastTap: 0, lastTapId: '' as string | null });
  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    cancelAnimationFrame(spin.current.raf); cancelAnimationFrame(anim.current);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) { g.current.moved = 0; g.current.pinch = 0; g.current.vx = 0; g.current.lastT = performance.now(); }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.current.pinch = Math.hypot(a.x - b.x, a.y - b.y); g.current.moved = 99;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const r = rRef.current; if (!r) return;
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse' && !readOnly) { const h = r.pick(e.clientX, e.clientY); if (h !== r.hover) { r.hover = h; setHover(h); } }
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.current.pinch) zoom(g.current.pinch / d);
      g.current.pinch = d; return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    g.current.moved += Math.abs(dx) + Math.abs(dy);
    const now = performance.now();
    g.current.vx = (dx * 0.011) / Math.max(1, now - g.current.lastT) * 16;
    g.current.lastT = now;
    r.view.yaw -= dx * 0.011;
    r.view.pitch = Math.max(-0.5, Math.min(0.7, r.view.pitch + dy * 0.006));
    r.requestRender(); updateFacing();
  };
  const onUp = (e: React.PointerEvent) => {
    const was = pointers.current.size;
    pointers.current.delete(e.pointerId);
    const r = rRef.current;
    if (!r || was !== 1) return;
    if (g.current.moved < 8) {
      const id = r.pick(e.clientX, e.clientY);
      const now = performance.now();
      if (id && now - g.current.lastTap < 320 && g.current.lastTapId === id) {
        // double tap: zoom to the region (and undo the second toggle)
        if (!readOnly && onToggle) onToggle(id);
        focusRegion(id);
        g.current.lastTap = 0;
        return;
      }
      g.current.lastTap = now; g.current.lastTapId = id;
      if (id && !readOnly && onToggle) {
        onToggle(id);
        setTapped({ id, on: !selected.includes(id) });
        window.clearTimeout(tapTimer.current);
        tapTimer.current = window.setTimeout(() => setTapped(null), 1800);
      }
      return;
    }
    // momentum
    if (!reducedMotion && Math.abs(g.current.vx) > 0.004) {
      let v = g.current.vx;
      const step = () => {
        if (!rRef.current) return;
        rRef.current.view.yaw -= v; v *= 0.94;
        rRef.current.render(); updateFacing();
        if (Math.abs(v) > 0.0008) spin.current.raf = requestAnimationFrame(step);
      };
      spin.current.raf = requestAnimationFrame(step);
    }
  };
  const onWheel = (e: React.WheelEvent) => { zoom(e.deltaY > 0 ? 1.08 : 0.92); };
  const reset = () => animateTo({ yaw: 0, pitch: DEFAULT_VIEW.pitch, distance: DEFAULT_VIEW.distance, target: [...DEFAULT_VIEW.target] as [number, number, number] });

  const rl = (x: 'R' | 'L') => x;
  const leftLabel = facing === 'Front' ? rl('R') : facing === 'Back' ? rl('L') : '';
  const rightLabel = facing === 'Front' ? rl('L') : facing === 'Back' ? rl('R') : '';
  const facingText = facing;
  const label = (id: string) => regionLabel(id);

  return (
    <div className="body3d">
      <div className="body-stage" style={{ height }}>
        <canvas ref={canvasRef} className="body-canvas" data-testid="body-canvas"
          role="img" aria-label={`3D body model, ${facing} view. ${selected.length ? 'Selected: ' + selected.map(label).join(', ') : 'Nothing selected yet.'} Use the list view if touching the model is hard.`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => { if (rRef.current) { rRef.current.hover = null; rRef.current.requestRender(); setHover(null); } }} onWheel={onWheel} />
        {status === 'loading' && (
          <div className="body-overlay" aria-live="polite">
            <div className="body-loader"><span /><span /><span /></div>
            <span>{'Preparing the 3D body…'}</span>
          </div>
        )}
        {status === 'error' && (
          <div className="body-overlay" style={{ pointerEvents: 'auto' }}>
            <span>{'3D view unavailable:'} {err}</span>
            <button className="btn secondary" onClick={init}><LuRefreshCw aria-hidden /> {'Retry'}</button>
          </div>
        )}
        {status === 'ready' && <>
          <div className="stage-chip stage-tl">{facingText}</div>
          {leftLabel && <div className="side-mark" style={{ left: 12 }} aria-hidden>{leftLabel}</div>}
          {rightLabel && <div className="side-mark" style={{ right: 12 }} aria-hidden>{rightLabel}</div>}
          {tapped ? <div className="stage-chip stage-bottom" data-testid="tapped-label">{label(tapped.id)} · {tapped.on ? 'selected' : 'removed'}</div>
            : hover && <div className="stage-chip stage-bottom">{label(hover)}</div>}
          <div className="stage-tools" role="group" aria-label={'Zoom'}>
            <button className="tool" aria-label={'Zoom in'} onClick={() => zoom(0.82)}><LuZoomIn /></button>
            <button className="tool" aria-label={'Zoom out'} onClick={() => zoom(1.2)}><LuZoomOut /></button>
            {zoomed && <button className="tool" aria-label={'Show whole body'} onClick={reset}><LuScan /></button>}
          </div>
        </>}
      </div>
      <div className="view-bar" role="group" aria-label={'Rotate the body'}>
        <button className="tool" aria-label={'Turn left'} onClick={() => rRef.current && animateTo({ yaw: rRef.current.view.yaw + Math.PI / 4 }, 380)}><LuRotateCcw /></button>
        {Object.keys(VIEWS).map((v) => (
          <button key={v} className="view-btn" aria-pressed={facing.startsWith(v)} onClick={() => animateTo({ yaw: VIEWS[v] })} aria-label={`${v} view`}>{v}</button>
        ))}
        <button className="tool" aria-label={'Turn right'} onClick={() => rRef.current && animateTo({ yaw: rRef.current.view.yaw - Math.PI / 4 }, 380)}><LuRotateCw /></button>
      </div>
      <button className="link-btn" onClick={reset}>{'Reset view'}</button>
    </div>
  );
}
