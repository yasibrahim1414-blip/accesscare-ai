import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, framing, recognize, sequenceOf, compact, signThreshold, frameFeature, type SignFrame, type Vocabulary, FRAME_DIM, STEPS } from '../src/services/sign/SignRecognizer';

// Synthetic hands (21 points): an open hand or a fist, at a position, with a little noise.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
function hand(cx: number, cy: number, shape: 'open' | 'fist' | 'point', size = 0.18, noise = 0.004): [number, number, number][] {
  const pts: [number, number, number][] = [[cx, cy + size * 0.5, 0]];
  for (let f = 0; f < 5; f++) {
    const ang = -Math.PI / 2 + (f - 2) * 0.32;
    const ext = shape === 'open' ? 1 : shape === 'point' ? (f === 1 ? 1 : 0.35) : 0.35;
    for (let j = 1; j <= 4; j++) {
      const r = size * (0.35 + 0.17 * j * ext);
      pts.push([cx + Math.cos(ang) * r + rnd() * noise, cy + size * 0.5 + Math.sin(ang) * r + rnd() * noise, 0]);
    }
  }
  return pts;
}
/** a sign: the hand moves from a to b with a shape, sampled at 30 fps */
function sign(a: [number, number], b: [number, number], shape: 'open' | 'fist' | 'point', ms = 900, t0 = 0, jitter = 0.01): SignFrame[] {
  const n = Math.round(ms / 33); const out: SignFrame[] = [];
  const j = () => rnd() * jitter;
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    out.push({ t: t0 + i * 33, hands: [{ handedness: 'Right', score: 0.9, lm: hand(a[0] + (b[0] - a[0]) * p + j(), a[1] + (b[1] - a[1]) * p + j(), shape) }] });
  }
  return out;
}
const HEAD: [[number, number], [number, number], 'point'] = [[0.5, 0.45], [0.5, 0.2], 'point'];   // point up to the head
const PAIN: [[number, number], [number, number], 'fist'] = [[0.35, 0.6], [0.65, 0.6], 'fist'];     // fist across
const YES: [[number, number], [number, number], 'open'] = [[0.5, 0.55], [0.5, 0.65], 'open'];      // open hand nod

function vocab(): Vocabulary {
  const mk = (id: string, s: typeof HEAD | typeof PAIN | typeof YES) => ({ id, en: id, ar: id, samples: [0, 1, 2].map(() => compact(sequenceOf(sign(s[0], s[1], s[2], 800 + Math.round(rnd() * 300))))) });
  return { v: 1, signs: [mk('head', HEAD), mk('pain', PAIN), mk('yes', YES)] };
}

test('features: fixed size; hands are normalized by palm size (same sign far or near looks the same)', () => {
  const near: SignFrame = { t: 0, hands: [{ handedness: 'Right', score: 1, lm: hand(0.5, 0.5, 'open', 0.3, 0) }] };
  const far: SignFrame = { t: 0, hands: [{ handedness: 'Right', score: 1, lm: hand(0.5, 0.5, 'open', 0.15, 0) }] };
  const a = frameFeature(near), b = frameFeature(far);
  assert.equal(a.length, FRAME_DIM);
  const shapeDiff = a.slice(3, 43).reduce((s, v, i) => s + Math.abs(v - b[3 + i]), 0);
  assert.ok(shapeDiff < 0.05, `finger shape independent of distance (${shapeDiff})`);
  assert.equal(sequenceOf(sign(...HEAD)).length, STEPS);
});

test('taught signs are recognized; the same sign at another speed still matches', () => {
  const v = vocab();
  for (const [id, s] of [['head', HEAD], ['pain', PAIN], ['yes', YES]] as const) {
    const live = sign(s[0], s[1], s[2], 1300);
    const r = recognize(sequenceOf(live), v, live.length);
    assert.equal(r.status, 'recognized', `${id}: ${JSON.stringify(r).slice(0, 120)}`);
    assert.equal(r.status === 'recognized' && r.word.id, id);
  }
  assert.ok(signThreshold(v.signs[0]) >= 0.18 && signThreshold(v.signs[0]) <= 0.9);
});

test('an untaught sign is not guessed; no hands / too short are reported; nothing taught → says so', () => {
  const v = vocab();
  const other = sign([0.2, 0.3], [0.8, 0.8], 'open', 900);  // a big diagonal sweep nobody taught
  const r = recognize(sequenceOf(other), v, other.length);
  assert.notEqual(r.status, 'recognized');
  assert.deepEqual(recognize([], v, 0), { status: 'unknown', reason: 'no_hands' });
  assert.deepEqual(recognize(sequenceOf(sign(...HEAD).slice(0, 3)), v, 3), { status: 'unknown', reason: 'too_short' });
  assert.deepEqual(recognize(sequenceOf(sign(...HEAD)), { v: 1, signs: [] }, 20), { status: 'unknown', reason: 'no_signs_taught' });
});

test('two taught signs that look alike → "uncertain": the patient chooses', () => {
  const v: Vocabulary = { v: 1, signs: [
    { id: 'a', en: 'a', ar: 'a', samples: [0, 1, 2].map(() => compact(sequenceOf(sign([0.5, 0.5], [0.5, 0.3], 'point')))) },
    { id: 'b', en: 'b', ar: 'b', samples: [0, 1, 2].map(() => compact(sequenceOf(sign([0.52, 0.5], [0.52, 0.3], 'point')))) },
  ] };
  const live = sign([0.51, 0.5], [0.51, 0.3], 'point');
  const r = recognize(sequenceOf(live), v, live.length);
  assert.equal(r.status, 'uncertain'); assert.ok(r.status === 'uncertain' && r.candidates.length === 2);
});

test('segmentation: one sign per movement, ended by lowering the hands; a held shape counts too', () => {
  const got: SignFrame[][] = [];
  const s = new Segmenter((f) => got.push(f));
  const a = sign(...HEAD, 900, 0); const gap = Array.from({ length: 15 }, (_, i) => ({ t: 900 + i * 33, hands: [] }));
  const b = sign(...PAIN, 900, 1500); const gap2 = Array.from({ length: 15 }, (_, i) => ({ t: 2400 + i * 33, hands: [] }));
  [...a, ...gap, ...b, ...gap2].forEach((f) => s.push(f));
  assert.equal(got.length, 2);
  const held = Array.from({ length: 60 }, (_, i) => ({ t: 5000 + i * 33, hands: [{ handedness: 'Right' as const, score: 1, lm: hand(0.5, 0.5, 'fist', 0.18, 0.001) }] }));
  held.forEach((f) => s.push(f));
  assert.equal(got.length, 3, 'a still hand shape is one sign');
});

test('framing feedback', () => {
  assert.equal(framing({ t: 0, hands: [] }), 'no_hands');
  assert.equal(framing({ t: 0, hands: [{ handedness: 'Right', score: 1, lm: hand(0.5, 0.5, 'open') }] }), 'ok');
  assert.equal(framing({ t: 0, hands: [{ handedness: 'Right', score: 1, lm: hand(0.02, 0.5, 'open') }] }), 'edge');
  assert.equal(framing({ t: 0, hands: [{ handedness: 'Right', score: 1, lm: hand(0.5, 0.5, 'open', 0.7) }] }), 'too_close');
});
