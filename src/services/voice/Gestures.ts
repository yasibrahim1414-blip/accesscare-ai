// Touch gesture recognition for Blind Access. Pure logic: it receives pointer
// samples (from touch only) and reports swipes, taps, double taps, long presses
// and the "three deliberate left swipes" activation pattern.
//
// A movement counts as a swipe only when it is fast, long, mostly horizontal
// and made with one finger. Scrolls (mostly vertical), slow drags, short
// twitches and multi-finger touches never count.

export interface Pt { x: number; y: number; t: number }
export type Gesture =
  | { type: 'swipe'; dir: 'left' | 'right' | 'up' | 'down'; at: number }
  | { type: 'tap'; x: number; y: number; at: number }
  | { type: 'doubleTap'; x: number; y: number; at: number }
  | { type: 'longPress'; x: number; y: number; at: number };

export const SWIPE = { minDist: 60, maxMs: 700, maxOffAxis: 0.45, minSpeed: 0.18 } as const; // px, ms, ratio, px/ms
export const TAP = { maxMove: 12, maxMs: 300, doubleGapMs: 320 } as const;
export const LONG_PRESS_MS = 650;
export const TRIPLE = { count: 3, maxGapMs: 1200, maxTotalMs: 3200 } as const;

/** Classifies one completed single-finger stroke. */
export function classifyStroke(start: Pt, end: Pt, maxMove: number): Gesture | null {
  const dx = end.x - start.x, dy = end.y - start.y, dt = Math.max(1, end.t - start.t);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (maxMove <= TAP.maxMove) {
    if (dt <= TAP.maxMs) return { type: 'tap', x: end.x, y: end.y, at: end.t };
    if (dt >= LONG_PRESS_MS) return { type: 'longPress', x: end.x, y: end.y, at: end.t };
    return null;
  }
  const major = Math.max(ax, ay), minor = Math.min(ax, ay);
  if (major < SWIPE.minDist || dt > SWIPE.maxMs || minor / major > SWIPE.maxOffAxis || major / dt < SWIPE.minSpeed) return null;
  const dir = ax >= ay ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  return { type: 'swipe', dir, at: end.t };
}

/**
 * Stateful recognizer: feed pointer events (touch only), get gestures.
 * A second finger cancels the stroke (so pinch-zoom and screen-reader
 * multi-finger gestures are never misread).
 */
export class GestureRecognizer {
  private start: Pt | null = null;
  private maxMove = 0;
  private pointers = new Set<number>();
  private lastTap: { x: number; y: number; at: number } | null = null;
  private cancelled = false;

  down(id: number, p: Pt) {
    this.pointers.add(id);
    if (this.pointers.size > 1) { this.cancelled = true; return; }
    this.start = p; this.maxMove = 0; this.cancelled = false;
  }
  move(id: number, p: Pt) {
    if (!this.start || !this.pointers.has(id)) return;
    this.maxMove = Math.max(this.maxMove, Math.hypot(p.x - this.start.x, p.y - this.start.y));
  }
  up(id: number, p: Pt): Gesture | null {
    this.pointers.delete(id);
    if (!this.start || this.cancelled) { if (this.pointers.size === 0) { this.start = null; this.cancelled = false; } return null; }
    this.maxMove = Math.max(this.maxMove, Math.hypot(p.x - this.start.x, p.y - this.start.y));
    const g = classifyStroke(this.start, p, this.maxMove);
    this.start = null;
    if (g?.type === 'tap') {
      const prev = this.lastTap;
      if (prev && g.at - prev.at <= TAP.doubleGapMs && Math.hypot(g.x - prev.x, g.y - prev.y) < 40) {
        this.lastTap = null;
        return { type: 'doubleTap', x: g.x, y: g.y, at: g.at };
      }
      this.lastTap = { x: g.x, y: g.y, at: g.at };
    }
    return g;
  }
  cancel() { this.start = null; this.pointers.clear(); this.cancelled = false; }
}

/** Detects exactly three deliberate swipes in one direction in a row; anything else in between resets it. */
export class TripleSwipeDetector {
  private times: number[] = [];
  /** left: turns Blind Mode on; right: turns it off. Turning off needs a faster burst (each swipe within
   *  0.5 s of the last, all three within 1.2 s), so ordinary swipe-right navigation, one item at a time, doesn't trigger it. */
  constructor(private dir: 'left' | 'right' = 'left', private maxGap: number = dir === 'right' ? 500 : TRIPLE.maxGapMs, private maxTotal: number = dir === 'right' ? 1200 : TRIPLE.maxTotalMs) {}
  /** returns true when the pattern completes */
  feed(g: Gesture | null): boolean {
    if (!g) return false;
    if (g.type === 'tap') { this.times = []; return false; }
    if (g.type !== 'swipe' || g.dir !== this.dir) { this.times = []; return false; }
    const last = this.times[this.times.length - 1];
    if (last !== undefined && g.at - last > this.maxGap) this.times = [];
    this.times.push(g.at);
    if (this.times.length >= TRIPLE.count) {
      const ok = this.times[this.times.length - 1] - this.times[this.times.length - TRIPLE.count] <= this.maxTotal;
      this.times = [];
      return ok;
    }
    return false;
  }
  reset() { this.times = []; }
}

export const TRIPLE_TAP = { maxGapMs: 450, maxTotalMs: 1200 } as const;

/** Three quick taps in a row (anywhere). Swipes, long presses or slow taps reset it. */
export class TripleTapDetector {
  private times: number[] = [];
  feed(g: Gesture | null): boolean {
    if (!g) return false;
    if (g.type !== 'tap' && g.type !== 'doubleTap') { this.times = []; return false; }
    const last = this.times[this.times.length - 1];
    if (last !== undefined && g.at - last > TRIPLE_TAP.maxGapMs) this.times = [];
    this.times.push(g.at);
    if (this.times.length >= 3) {
      const ok = this.times[this.times.length - 1] - this.times[this.times.length - 3] <= TRIPLE_TAP.maxTotalMs;
      this.times = [];
      return ok;
    }
    return false;
  }
  reset() { this.times = []; }
}
