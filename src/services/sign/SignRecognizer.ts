// Sign recognition from hand landmarks (pure, testable).
//
// What this is: the recognizer for signs the PATIENT TEACHES in the camera
// section (3 examples each). It compares the movement and hand shapes of one
// sign with those examples, so it works for whatever sign language the patient
// uses (Egyptian/Arabic, ASL, home signs); it does not know any sign language
// by itself and cannot translate free signing. The built-in ASL signs YES and
// NO are recognized by rules in SignCommands.ts. No pre-trained Arabic or
// Egyptian sign-language model was available to include (see README).
//
// How: MediaPipe Hand Landmarker gives 21 points per hand per frame. Each frame
// becomes a feature vector (hand position in the picture, hand size, finger
// positions relative to the wrist and palm size). One sign = a sequence of
// frames, resampled to 16 steps, compared with dynamic time warping (DTW).
// A result is "recognized" only when it is close to the taught examples AND
// clearly closer than the next sign; otherwise it is "uncertain" (the patient
// chooses) or "not recognized" (never guessed).

export interface HandFrame { handedness: 'Left' | 'Right'; score: number; lm: [number, number, number][] }
export interface SignFrame { t: number; hands: HandFrame[] }

export interface SignWord { id: string; en: string; ar: string; samples: number[][][] }
export interface Vocabulary { v: 1; signs: SignWord[] }

export const STEPS = 16;
const HAND_DIM = 2 + 1 + 20 * 2 + 1; // wrist x,y · size · 20 points x,y · present
export const FRAME_DIM = HAND_DIM * 2;

const dist2 = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** One frame → numbers. Hands are ordered by handedness so left/right stay comparable. */
export function frameFeature(f: SignFrame): number[] {
  const out: number[] = [];
  for (const side of ['Right', 'Left'] as const) {
    const h = f.hands.find((x) => x.handedness === side) ?? (f.hands.length === 1 && side === 'Right' ? f.hands[0] : undefined);
    if (!h || h.lm.length < 21) { out.push(...new Array(HAND_DIM).fill(0)); continue; }
    const w = h.lm[0];
    const palm = Math.max(1e-3, dist2(h.lm[0], h.lm[9]));       // wrist → middle-finger base
    out.push((w[0] - 0.5) * 2, (w[1] - 0.5) * 2, palm * 4);
    for (let k = 1; k < 21; k++) out.push((h.lm[k][0] - w[0]) / palm * 0.5, (h.lm[k][1] - w[1]) / palm * 0.5);
    out.push(1);
  }
  return out;
}

/** Linear resampling of a sequence to n steps. */
export function resample(seq: number[][], n = STEPS): number[][] {
  if (!seq.length) return [];
  if (seq.length === 1) return Array.from({ length: n }, () => seq[0].slice());
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = (i * (seq.length - 1)) / (n - 1); const a = Math.floor(p); const b = Math.min(seq.length - 1, a + 1); const f = p - a;
    out.push(seq[a].map((v, k) => v * (1 - f) + seq[b][k] * f));
  }
  return out;
}

const frameDist = (a: number[], b: number[]) => { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s); };

/** Dynamic time warping distance (Sakoe-Chiba band), averaged per step. */
export function dtw(a: number[][], b: number[][], band = 4): number {
  const n = a.length, m = b.length; const INF = 1e18;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF)); D[0][0] = 0;
  for (let i = 1; i <= n; i++) for (let j = Math.max(1, i - band); j <= Math.min(m, i + band); j++) {
    D[i][j] = frameDist(a[i - 1], b[j - 1]) + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
  }
  return D[n][m] / Math.max(n, m);
}

export function sequenceOf(frames: SignFrame[]): number[][] {
  return resample(frames.filter((f) => f.hands.length).map(frameFeature));
}

/** Per-sign acceptance distance from how consistent its own examples are. */
export function signThreshold(w: SignWord): number {
  return Math.min(0.9, Math.max(0.18, maxIntra(w) * 2.2));
}
function maxIntra(w: SignWord): number {
  if (w.samples.length < 2) return 0.3;
  const d: number[] = [];
  for (let i = 0; i < w.samples.length; i++) for (let j = i + 1; j < w.samples.length; j++) d.push(dtw(w.samples[i], w.samples[j]));
  return Math.max(...d);
}

/** How alike the examples of one sign are (for the "record again" hint). */
export function sampleConsistency(w: SignWord): 'good' | 'fair' | 'poor' {
  if (w.samples.length < 2) return 'fair';
  const t = maxIntra(w);
  return t < 0.25 ? 'good' : t < 0.45 ? 'fair' : 'poor';
}

export type Recognition =
  | { status: 'recognized'; word: SignWord; distance: number; confidence: number }
  | { status: 'uncertain'; candidates: { word: SignWord; distance: number }[] }
  | { status: 'unknown'; reason: 'no_signs_taught' | 'no_hands' | 'too_short' | 'not_close' };

export function recognize(seq: number[][], vocab: Vocabulary, framesWithHands: number): Recognition {
  if (!vocab.signs.some((s) => s.samples.length)) return { status: 'unknown', reason: 'no_signs_taught' };
  if (framesWithHands === 0) return { status: 'unknown', reason: 'no_hands' };
  if (framesWithHands < 4) return { status: 'unknown', reason: 'too_short' };
  const scored = vocab.signs.filter((s) => s.samples.length).map((w) => {
    const ds = w.samples.map((s) => dtw(seq, s)).sort((a, b) => a - b);
    const d = ds.length > 1 ? (ds[0] + ds[1]) / 2 : ds[0];
    return { word: w, distance: d, threshold: signThreshold(w) };
  }).sort((a, b) => a.distance / a.threshold - b.distance / b.threshold);
  const best = scored[0]; const second = scored[1];
  const rel = best.distance / best.threshold;
  const margin = second ? (second.distance / second.threshold) - rel : 1;
  if (rel <= 1 && margin >= 0.25) return { status: 'recognized', word: best.word, distance: best.distance, confidence: Math.max(0, Math.min(1, 1 - rel / 2 + Math.min(margin, 0.5) / 2)) };
  const close = scored.filter((s) => s.distance / s.threshold <= 1.6).slice(0, 3);
  if (close.length) return { status: 'uncertain', candidates: close.map((c) => ({ word: c.word, distance: c.distance })) };
  return { status: 'unknown', reason: 'not_close' };
}

// ---------------------------------------------------------------- segmentation
/**
 * Cuts the live stream into single signs: a sign starts when a hand appears in
 * the signing area, and ends when the hands leave the picture or stay still
 * for a moment after moving (or after 4 seconds).
 */
export class Segmenter {
  private frames: SignFrame[] = [];
  private lastHand = 0;
  private stillSince = 0;
  private moved = false;
  private prev: number[] | null = null;
  constructor(private onSign: (frames: SignFrame[]) => void, private opt = { gapMs: 350, stillMs: 700, maxMs: 4000, minFrames: 5 }) {}

  push(f: SignFrame) {
    const has = f.hands.length > 0;
    if (has) {
      this.lastHand = f.t;
      const feat = frameFeature(f);
      const motion = this.prev ? frameDist(feat, this.prev) : 0;
      this.prev = feat;
      if (!this.frames.length) { this.moved = false; this.stillSince = f.t; }
      this.frames.push(f);
      if (motion > 0.12) { this.moved = true; this.stillSince = f.t; }
      const dur = f.t - this.frames[0].t;
      if ((this.moved && f.t - this.stillSince > this.opt.stillMs) || dur > this.opt.maxMs) this.flush();
      // a held hand shape (no movement) also counts as a sign after a moment
      else if (!this.moved && dur > this.opt.stillMs * 1.6 && this.frames.length >= this.opt.minFrames) this.flush();
    } else if (this.frames.length && f.t - this.lastHand > this.opt.gapMs) this.flush();
  }

  /** forces the current sign to end (e.g. the patient pressed "done") */
  flush() {
    const fr = this.frames; this.frames = []; this.prev = null; this.moved = false;
    if (fr.filter((x) => x.hands.length).length >= this.opt.minFrames) this.onSign(fr);
  }
  get active() { return this.frames.length > 0; }
}

// ---------------------------------------------------------------- framing feedback
export type Framing = 'no_hands' | 'edge' | 'too_close' | 'too_far' | 'ok';
export function framing(f: SignFrame): Framing {
  if (!f.hands.length) return 'no_hands';
  for (const h of f.hands) {
    const xs = h.lm.map((p) => p[0]); const ys = h.lm.map((p) => p[1]);
    if (Math.min(...xs) < 0.02 || Math.max(...xs) > 0.98 || Math.min(...ys) < 0.02 || Math.max(...ys) > 0.98) return 'edge';
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (size > 0.6) return 'too_close';
    if (size < 0.06) return 'too_far';
  }
  return 'ok';
}

// ---------------------------------------------------------------- vocabulary
const round = (x: number) => Math.round(x * 100) / 100;
export const compact = (seq: number[][]) => seq.map((f) => f.map(round));

const KEY = (owner: string) => `accesscare.signs.v1.${owner}`;
export function loadVocabulary(owner: string): Vocabulary {
  try {
    const raw = localStorage.getItem(KEY(owner));
    const v = raw ? JSON.parse(raw) as Vocabulary : null;
    if (v && v.v === 1 && Array.isArray(v.signs)) {
      return { v: 1, signs: v.signs.filter((s) => s && typeof s.id === 'string').map((s) => ({ id: s.id, en: String(s.en ?? '').slice(0, 60), ar: String(s.ar ?? '').slice(0, 60),
        samples: (s.samples ?? []).filter((x) => Array.isArray(x) && x.length === STEPS && x.every((f) => Array.isArray(f) && f.length === FRAME_DIM)).slice(0, 8) })) };
    }
  } catch { /* storage unavailable */ }
  return { v: 1, signs: [] };
}
export function saveVocabulary(owner: string, v: Vocabulary): boolean {
  try { localStorage.setItem(KEY(owner), JSON.stringify(v)); return true; } catch { return false; }
}

