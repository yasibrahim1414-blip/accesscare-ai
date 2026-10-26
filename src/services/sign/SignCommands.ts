// Sign language → Silent Signal commands (pure, testable).
//
// Two kinds of signs can drive the camera section's commands (Yes, No, Next,
// Choose, Not sure):
//
// 1. Built-in ASL signs (American Sign Language), recognized from hand
//    landmarks by rules written from the dictionary form of each sign:
//      YES — "S" handshape (a fist, thumb across the fingers), the fist nods
//            down and up at the wrist, usually twice.
//      NO  — index and middle fingers held out together with the thumb, then
//            snapped closed onto the thumb (usually twice).
//    Only these two signs are built in. They are ASL; Arabic and Egyptian sign
//    languages use different signs and are not built in (no suitable model or
//    data was available to include).
// 2. Signs the patient teaches (any sign language, e.g. Egyptian Sign Language,
//    or a personal home sign): 3 examples each, matched by DTW
//    (see SignRecognizer.ts).
//
// The camera never guesses: a movement that matches nothing, or two signs at
// once, is reported as such, and every answer is confirmed by the patient.

import type { Command } from '../../domain/camera';
import { Segmenter, recognize, sequenceOf, type HandFrame, type SignFrame, type SignWord } from './SignRecognizer';

export type BuiltinSign = 'asl_yes' | 'asl_no';
export const BUILTIN: Record<BuiltinSign, { label: string; language: string; how: string; meaning: string }> = {
  asl_yes: { label: 'ASL sign “YES”', language: 'American Sign Language', meaning: 'yes', how: 'Make a fist (thumb across your fingers) in front of your chest and nod the fist down and up at the wrist, twice — like a head nodding “yes”.' },
  asl_no: { label: 'ASL sign “NO”', language: 'American Sign Language', meaning: 'no', how: 'Hold your index and middle fingers out together with your thumb, then snap them closed onto your thumb, twice.' },
};
export const isBuiltin = (id: string): id is BuiltinSign => id === 'asl_yes' || id === 'asl_no';

export const COMMAND_LABEL: Record<Command, string> = { yes: 'Yes', no: 'No', next: 'Next option', select: 'Choose this', unsure: 'Not sure' };

// ---------------------------------------------------------------- handshapes
const d2 = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** how far a finger reaches out: fingertip-to-wrist divided by knuckle-to-wrist (≈2 straight, ≈1 curled) */
export function fingerReach(lm: HandFrame['lm'], finger: 1 | 2 | 3 | 4): number {
  const mcp = [5, 9, 13, 17][finger - 1]; const tip = [8, 12, 16, 20][finger - 1];
  return d2(lm[tip], lm[0]) / Math.max(1e-6, d2(lm[mcp], lm[0]));
}
const palm = (lm: HandFrame['lm']) => Math.max(1e-6, d2(lm[0], lm[9]));
const EXT = 1.5, CURL = 1.25;

export type Handshape = 'fist' | 'two_fingers_open' | 'two_fingers_closed' | 'open' | 'other';
export function handshape(lm: HandFrame['lm']): Handshape {
  const [i, m, r, p] = ([1, 2, 3, 4] as const).map((f) => fingerReach(lm, f));
  const pinch8 = d2(lm[8], lm[4]) / palm(lm), pinch12 = d2(lm[12], lm[4]) / palm(lm);
  if (r < CURL && p < CURL) {
    if (i > EXT && m > EXT) return 'two_fingers_open';
    if (pinch8 < 0.45 && pinch12 < 0.55 && i >= 1.05) return 'two_fingers_closed';
    if (i < CURL && m < CURL) return 'fist';
  }
  if (i > EXT && m > EXT && r > EXT && p > EXT) return 'open';
  return 'other';
}

/** The main hand in a frame (the larger one when two are visible). */
const mainHand = (f: SignFrame) => f.hands.slice().sort((a, b) => palm(b.lm) - palm(a.lm))[0];

export interface BuiltinResult { sign: BuiltinSign; quality: 'clear' | 'borderline' }

/** Checks one sign attempt (a segment of frames) against the built-in ASL signs. */
export function builtinSign(frames: SignFrame[]): BuiltinResult | null {
  const hs = frames.map(mainHand).filter(Boolean) as HandFrame[];
  if (hs.length < 5) return null;
  const shapes = hs.map((h) => handshape(h.lm));
  const rate = (s: Handshape) => shapes.filter((x) => x === s).length / shapes.length;
  // YES: a fist that moves down and up (wrist nod), ≥ 2 turns
  const fist = rate('fist');
  if (fist >= 0.45) {
    const ys = hs.map((h) => h.lm[9][1]); const amp = 0.12 * (hs.reduce((s, h) => s + palm(h.lm), 0) / hs.length);
    let turns = 0, dir = 0, ref = ys[0];
    for (const y of ys) {
      if (dir === 0) { if (y > ref + amp) { dir = 1; ref = y; } else if (y < ref - amp) { dir = -1; ref = y; } }
      else if (dir === 1) { if (y > ref) ref = y; else if (y < ref - amp) { turns++; dir = -1; ref = y; } }
      else { if (y < ref) ref = y; else if (y > ref + amp) { turns++; dir = 1; ref = y; } }
    }
    if (turns >= 2 && fist >= 0.6) return { sign: 'asl_yes', quality: 'clear' };
    if (turns >= 1) return { sign: 'asl_yes', quality: 'borderline' };
  }
  // NO: two fingers open → closed onto the thumb, at least once (usually twice)
  let snaps = 0, wasOpen = 0;
  for (const s of shapes) {
    if (s === 'two_fingers_open') wasOpen++;
    else if (s === 'two_fingers_closed' && wasOpen >= 2) { snaps++; wasOpen = 0; }
  }
  if (snaps >= 2) return { sign: 'asl_no', quality: 'clear' };
  if (snaps === 1) return { sign: 'asl_no', quality: 'clear' };
  if (rate('two_fingers_open') + rate('two_fingers_closed') > 0.6 && rate('two_fingers_closed') > 0) return { sign: 'asl_no', quality: 'borderline' };
  return null;
}

/** did the hand move or change shape during the attempt? */
export function moved(frames: SignFrame[]): boolean {
  const hs = frames.map(mainHand).filter(Boolean) as HandFrame[];
  if (hs.length < 2) return false;
  const p = hs.reduce((s, h) => s + palm(h.lm), 0) / hs.length;
  const xs = hs.map((h) => h.lm[9][0]), ys = hs.map((h) => h.lm[9][1]);
  const travel = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / p;
  const shapes = new Set(hs.map((h) => handshape(h.lm)));
  return travel > 0.35 || shapes.size > 1;
}

// ---------------------------------------------------------------- detector
export type SignEvent =
  | { type: 'sign'; sign: string; quality: 'clear' | 'borderline'; at: number }
  | { type: 'ambiguous'; signs: string[]; at: number }
  | { type: 'unknown'; reason: 'not_recognized' | 'too_short'; at: number };

/**
 * Turns the live hand stream into sign events. `active` lists the sign ids the
 * patient uses (built-in ids and taught ids); only those can be recognized.
 */
export class SignDetector {
  private seg: Segmenter;
  private last = 0;
  constructor(private active: string[], private taught: SignWord[], private emit: (e: SignEvent) => void, private refractoryMs = 900) {
    this.seg = new Segmenter((frames) => this.onSegment(frames));
  }
  feed(f: SignFrame) { this.seg.push(f); }
  /** ends the current attempt now (e.g. the camera is stopping) */
  flush() { this.seg.flush(); }

  private onSegment(frames: SignFrame[]) {
    const at = frames[frames.length - 1].t;
    if (at - this.last < this.refractoryMs) return;
    const withHands = frames.filter((f) => f.hands.length).length;
    const found: { sign: string; quality: 'clear' | 'borderline' }[] = [];
    const b = builtinSign(frames);
    if (b && this.active.includes(b.sign)) found.push(b);
    const taughtActive = this.taught.filter((w) => this.active.includes(w.id) && w.samples.length >= 2);
    if (taughtActive.length) {
      const r = recognize(sequenceOf(frames), { v: 1, signs: taughtActive }, withHands);
      if (r.status === 'recognized') found.push({ sign: r.word.id, quality: 'clear' });
      else if (r.status === 'uncertain' && r.candidates.length === 1) found.push({ sign: r.candidates[0].word.id, quality: 'borderline' });
      else if (r.status === 'uncertain') { this.last = at; this.emit({ type: 'ambiguous', signs: r.candidates.map((c) => c.word.id), at }); return; }
    }
    const clear = found.filter((x) => x.quality === 'clear');
    if (clear.length > 1 || (clear.length === 0 && found.length > 1)) { this.last = at; this.emit({ type: 'ambiguous', signs: found.map((x) => x.sign), at }); return; }
    const pick = clear[0] ?? found[0];
    if (pick) { this.last = at; this.emit({ type: 'sign', sign: pick.sign, quality: pick.quality, at }); return; }
    // hands simply resting in view are not an attempt to sign: say nothing
    if (!moved(frames)) return;
    this.emit({ type: 'unknown', reason: withHands < 5 ? 'too_short' : 'not_recognized', at });
  }
}

// ---------------------------------------------------------------- mapping
export type Mapping = Partial<Record<Command, string>>;

export function commandOf(sign: string, mapping: Mapping): Command | null {
  for (const [c, s] of Object.entries(mapping)) if (s === sign) return c as Command;
  return null;
}

export function mappingProblems(mapping: Mapping, available: Record<string, { reliable: boolean; label: string }>): string[] {
  const p: string[] = [];
  if (!mapping.yes) p.push('Choose a sign for Yes.');
  if (!mapping.no) p.push('Choose a sign for No.');
  const used = Object.values(mapping).filter(Boolean) as string[];
  if (new Set(used).size !== used.length) p.push('Each sign can mean only one thing.');
  for (const s of used) {
    const a = available[s];
    if (!a) p.push('A sign you chose is not available on this device — teach it again here.');
    else if (!a.reliable) p.push(`“${a.label}” was not recognized reliably in practice yet.`);
  }
  return p;
}

export type QuestionAction =
  | { kind: 'answer'; value: 'yes' | 'no' | 'unsure' }
  | { kind: 'next' } | { kind: 'select' } | { kind: 'not_sure' }
  | { kind: 'unused' };

/** What a command means for the current question. Unmapped meanings are never guessed. */
export function actionFor(cmd: Command, question: 'yesno' | 'choice', mapping: Mapping): QuestionAction {
  if (question === 'yesno') {
    if (cmd === 'yes') return { kind: 'answer', value: 'yes' };
    if (cmd === 'no') return { kind: 'answer', value: 'no' };
    if (cmd === 'unsure') return { kind: 'answer', value: 'unsure' };
    return { kind: 'unused' };
  }
  const nextCmd: Command = mapping.next ? 'next' : 'no';
  const selectCmd: Command = mapping.select ? 'select' : 'yes';
  if (cmd === nextCmd) return { kind: 'next' };
  if (cmd === selectCmd) return { kind: 'select' };
  if (cmd === 'unsure') return { kind: 'not_sure' };
  return { kind: 'unused' };
}

export function confirmAction(cmd: Command, mapping: Mapping): 'confirm' | 'change' | null {
  if (cmd === 'yes' || (cmd === 'select' && mapping.select)) return 'confirm';
  if (cmd === 'no' || (cmd === 'next' && mapping.next)) return 'change';
  return null;
}
