import React from 'react';
import { regionLabel } from '../domain/bodyRegions';

// 2D fallback body map. Same region ids as the 3D model.
// Front view: patient's LEFT is on the viewer's right. Back view: mirrored.

type Shape = { id: string; kind: 'e' | 'r'; x: number; y: number; w: number; h: number; r?: number };

const C = 100; // center line
function limbs(view: 'front' | 'back'): Shape[] {
  const out: Shape[] = [];
  const sides: ['l' | 'r', number][] = [['l', view === 'front' ? 1 : -1], ['r', view === 'front' ? -1 : 1]];
  for (const [s, dir] of sides) {
    const X = (dx: number) => C + dir * dx;
    out.push(
      { id: `shoulder_${s}`, kind: 'e', x: X(37), y: 86, w: 12, h: 11 },
      { id: `upper_arm_${s}`, kind: 'r', x: X(42) - 8, y: 96, w: 16, h: 44, r: 7 },
      { id: `elbow_${s}`, kind: 'e', x: X(44), y: 147, w: 8.5, h: 8 },
      { id: `forearm_${s}`, kind: 'r', x: X(46) - 7, y: 156, w: 14, h: 40, r: 6 },
      { id: `wrist_${s}`, kind: 'e', x: X(47.5), y: 202, w: 7, h: 6 },
      { id: `hand_${s}`, kind: 'e', x: X(49), y: 221, w: 9, h: 13 },
      { id: `hip_${s}`, kind: 'r', x: dir > 0 ? C : C - 29, y: 172, w: 29, h: 24, r: 9 },
      { id: `thigh_${s}`, kind: 'r', x: X(16) - 12.5, y: 198, w: 25, h: 64, r: 11 },
      { id: `knee_${s}`, kind: 'e', x: X(16), y: 273, w: 11, h: 10 },
      { id: `lower_leg_${s}`, kind: 'r', x: X(16) - 10, y: 285, w: 20, h: 64, r: 9 },
      { id: `ankle_${s}`, kind: 'e', x: X(16), y: 357, w: 7.5, h: 6.5 },
      { id: `foot_${s}`, kind: 'e', x: X(18), y: 373, w: 12, h: 8 },
    );
  }
  return out;
}

const FRONT: Shape[] = [
  { id: 'head', kind: 'e', x: C, y: 36, w: 23, h: 27 },
  { id: 'face', kind: 'e', x: C, y: 43, w: 15, h: 17 },
  { id: 'neck', kind: 'r', x: C - 9, y: 62, w: 18, h: 15, r: 5 },
  { id: 'chest', kind: 'r', x: C - 30, y: 77, w: 60, h: 51, r: 14 },
  { id: 'abdomen_r', kind: 'r', x: C - 26, y: 129, w: 26, h: 42, r: 10 },
  { id: 'abdomen_l', kind: 'r', x: C, y: 129, w: 26, h: 42, r: 10 },
  ...limbs('front'),
];
const BACK: Shape[] = [
  { id: 'head', kind: 'e', x: C, y: 36, w: 23, h: 27 },
  { id: 'neck', kind: 'r', x: C - 9, y: 62, w: 18, h: 15, r: 5 },
  { id: 'upper_back', kind: 'r', x: C - 30, y: 77, w: 60, h: 51, r: 14 },
  { id: 'lower_back', kind: 'r', x: C - 26, y: 129, w: 52, h: 42, r: 12 },
  ...limbs('back'),
];

function Figure({ view, selected, focus, onToggle, readOnly }: {
  view: 'front' | 'back'; selected: string[]; focus?: string | null; onToggle?: (id: string) => void; readOnly?: boolean;
}) {
  const side = view === 'front' ? 'Front' : 'Back';
  const R = 'R', Lm = 'L';
  const shapes = view === 'front' ? FRONT : BACK;
  const leftOnRight = view === 'front';
  return (
    <figure style={{ margin: 0, flex: 1, minWidth: 0 }}>
      <svg viewBox="0 0 200 392" className="map2d" role="group" aria-label={`${side} body map`}>
        <text x={8} y={14}>{leftOnRight ? R : Lm}</text>
        <text x={186} y={14}>{leftOnRight ? Lm : R}</text>
        {shapes.map((s) => {
          const on = selected.includes(s.id);
          const cls = `rg${on ? ' on' : ''}${focus === s.id ? ' focus' : ''}`;
          const label = `${side}: ${regionLabel(s.id)}${on ? ', selected' : ''}`;
          const props = {
            className: cls, 'data-region': s.id, role: readOnly ? undefined : 'button', tabIndex: readOnly ? -1 : 0, 'aria-label': label, 'aria-pressed': readOnly ? undefined : on,
            onClick: () => !readOnly && onToggle?.(s.id),
            onKeyDown: (e: React.KeyboardEvent) => { if (!readOnly && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle?.(s.id); } },
          };
          return s.kind === 'e'
            ? <ellipse key={s.id} cx={s.x} cy={s.y} rx={s.w} ry={s.h} {...props}><title>{regionLabel(s.id)}</title></ellipse>
            : <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} {...props}><title>{regionLabel(s.id)}</title></rect>;
        })}
      </svg>
      <figcaption className="small muted" style={{ textAlign: 'center', fontWeight: 700 }}>{side}</figcaption>
    </figure>
  );
}

export function Body2DMap(props: { selected: string[]; focus?: string | null; onToggle?: (id: string) => void; readOnly?: boolean }) {
  return (
    <div className="body-wrap" style={{ padding: 12 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
        <Figure view="front" {...props} />
        <Figure view="back" {...props} />
      </div>
    </div>
  );
}
