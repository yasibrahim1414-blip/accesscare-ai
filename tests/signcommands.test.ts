import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinSign, handshape, fingerReach, SignDetector, actionFor, confirmAction, commandOf, mappingProblems, moved, type SignEvent } from '../src/services/sign/SignCommands';
import { compact, sequenceOf, type SignFrame, type HandFrame } from '../src/services/sign/SignRecognizer';
import { cleanCameraPrefs } from '../src/domain/camera';

// A synthetic right hand: wrist at (cx, cy+0.09); each finger straight (reach≈2) or curled (reach≈1).
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
type Pose = { index: 'ext' | 'curl'; middle: 'ext' | 'curl'; ring: 'ext' | 'curl'; pinky: 'ext' | 'curl'; pinch?: boolean };
function hand(cx: number, cy: number, pose: Pose, size = 0.18, noise = 0.003): HandFrame['lm'] {
  const w: [number, number, number] = [cx, cy + size * 0.5, 0];
  const pts: HandFrame['lm'] = [w];
  // closed onto the thumb: thumb tip meets the index and middle tips in front of the hand
  const angI = -Math.PI / 2 - 0.33;
  const thumbTip: [number, number] = pose.pinch ? [w[0] + Math.cos(angI) * size * 1.25, w[1] + Math.sin(angI) * size * 1.25] : [cx - size * 0.32, cy + size * 0.05];
  // thumb (1-4)
  for (let j = 1; j <= 4; j++) pts.push([w[0] + (thumbTip[0] - w[0]) * j / 4 + rnd() * noise, w[1] + (thumbTip[1] - w[1]) * j / 4 + rnd() * noise, 0]);
  const fingers = [pose.index, pose.middle, pose.ring, pose.pinky];
  for (let f = 0; f < 4; f++) {
    const ang = -Math.PI / 2 + (f - 1.5) * 0.22;
    const mcp: [number, number] = [w[0] + Math.cos(ang) * size * 0.9, w[1] + Math.sin(ang) * size * 0.9];
    for (let j = 1; j <= 4; j++) {
      if (j === 1) { pts.push([mcp[0] + rnd() * noise, mcp[1] + rnd() * noise, 0]); continue; }
      let p: [number, number];
      if (fingers[f] === 'ext') p = [w[0] + Math.cos(ang) * size * (0.9 + 0.33 * (j - 1)), w[1] + Math.sin(ang) * size * (0.9 + 0.33 * (j - 1))];
      else if (pose.pinch && f < 2) p = [mcp[0] + (thumbTip[0] + f * 0.02 - mcp[0]) * (j - 1) / 3, mcp[1] + (thumbTip[1] - mcp[1]) * (j - 1) / 3];
      else p = [mcp[0] + (w[0] - mcp[0]) * 0.12 * (j - 1), mcp[1] + (w[1] - mcp[1]) * 0.12 * (j - 1)];
      pts.push([p[0] + rnd() * noise, p[1] + rnd() * noise, 0]);
    }
  }
  return pts;
}
const FIST: Pose = { index: 'curl', middle: 'curl', ring: 'curl', pinky: 'curl' };
const V: Pose = { index: 'ext', middle: 'ext', ring: 'curl', pinky: 'curl' };
const V_CLOSED: Pose = { index: 'curl', middle: 'curl', ring: 'curl', pinky: 'curl', pinch: true };
const OPEN: Pose = { index: 'ext', middle: 'ext', ring: 'ext', pinky: 'ext' };
const F = (t: number, lm: HandFrame['lm']): SignFrame => ({ t, hands: [{ handedness: 'Right', score: 0.9, lm }] });

/** ASL YES: fist nodding down and up twice */
function aslYes(t0 = 0, nods = 2, shape = FIST): SignFrame[] {
  const out: SignFrame[] = []; const n = nods * 16;
  for (let i = 0; i < n; i++) out.push(F(t0 + i * 33, hand(0.5, 0.5 + 0.035 * Math.sin((i / 16) * Math.PI * 2), shape)));
  return out;
}
/** ASL NO: two fingers open → closed on the thumb, twice */
function aslNo(t0 = 0, snaps = 2): SignFrame[] {
  const out: SignFrame[] = []; let t = t0;
  for (let s = 0; s < snaps; s++) { for (let i = 0; i < 6; i++) out.push(F(t += 33, hand(0.5, 0.5, V))); for (let i = 0; i < 5; i++) out.push(F(t += 33, hand(0.5, 0.5, V_CLOSED))); }
  return out;
}

test('hand shapes from landmarks: fist, two fingers open/closed onto the thumb, open hand', () => {
  assert.equal(handshape(hand(0.5, 0.5, FIST)), 'fist');
  assert.equal(handshape(hand(0.5, 0.5, V)), 'two_fingers_open');
  assert.equal(handshape(hand(0.5, 0.5, V_CLOSED)), 'two_fingers_closed');
  assert.equal(handshape(hand(0.5, 0.5, OPEN)), 'open');
  assert.ok(fingerReach(hand(0.5, 0.5, OPEN), 1) > 1.7 && fingerReach(hand(0.5, 0.5, FIST), 1) < 1.2);
});

test('built-in ASL YES (fist nodding) and NO (two fingers snapping onto the thumb)', () => {
  assert.deepEqual(builtinSign(aslYes()), { sign: 'asl_yes', quality: 'clear' });
  assert.deepEqual(builtinSign(aslNo()), { sign: 'asl_no', quality: 'clear' });
  assert.equal(builtinSign(aslYes(0, 2, OPEN)), null, 'an open hand waving is not YES');
  const still = Array.from({ length: 40 }, (_, i) => F(i * 33, hand(0.5, 0.5, FIST)));
  assert.equal(builtinSign(still), null, 'a still fist is not YES (YES needs the nod)');
  assert.equal(moved(still), false);
  assert.equal(builtinSign(aslYes(0, 0.5))?.quality, 'borderline', 'half a nod → ask again, never assume');
});

test('detector: only the signs in use are recognized; untaught movement is "not recognized"; resting hands are ignored', () => {
  const events: SignEvent[] = [];
  const det = new SignDetector(['asl_yes', 'asl_no'], [], (e) => events.push(e), 0);
  const gap = (t0: number) => Array.from({ length: 14 }, (_, i) => ({ t: t0 + i * 33, hands: [] }));
  let t = 0;
  const play = (frames: SignFrame[]) => { for (const f of frames) det.feed({ ...f, t: (t += 33) }); for (const f of gap(0)) det.feed({ ...f, t: (t += 33) }); };
  play(aslYes()); play(aslNo());
  play(Array.from({ length: 30 }, (_, i) => F(0, hand(0.3 + i * 0.015, 0.4, OPEN))));        // a sweep nobody defined
  play(Array.from({ length: 40 }, () => F(0, hand(0.5, 0.5, OPEN, 0.18, 0.001))));           // hand resting in view
  assert.deepEqual(events.map((e) => e.type === 'sign' ? e.sign : e.type), ['asl_yes', 'asl_no', 'unknown']);
  const onlyYes: SignEvent[] = [];
  const d2 = new SignDetector(['asl_yes'], [], (e) => onlyYes.push(e), 0);
  for (const f of [...aslNo(), ...gap(2000)]) d2.feed(f);
  assert.ok(onlyYes.every((e) => e.type !== 'sign'), 'NO is not recognized when the patient doesn’t use it');
});

test('taught sign (the patient’s own) works next to the built-in ones; two matches at once are "ambiguous"', () => {
  const wave = (t0 = 0) => Array.from({ length: 30 }, (_, i) => F(t0 + i * 33, hand(0.3 + 0.4 * Math.abs(Math.sin(i / 6)), 0.35, OPEN)));
  const taught = [{ id: 't_next', en: 'Next', ar: '', samples: [0, 1, 2].map(() => compact(sequenceOf(wave()))) }];
  const ev: SignEvent[] = [];
  const det = new SignDetector(['asl_yes', 'asl_no', 't_next'], taught, (e) => ev.push(e), 0);
  let t = 0; const gap = () => { for (let i = 0; i < 14; i++) det.feed({ t: (t += 33), hands: [] }); };
  for (const f of wave()) det.feed({ ...f, t: (t += 33) }); gap();
  for (const f of aslYes()) det.feed({ ...f, t: (t += 33) }); gap();
  assert.deepEqual(ev.map((e) => e.type === 'sign' ? e.sign : e.type), ['t_next', 'asl_yes']);
  // the patient taught a nodding fist for "Not sure" — the same as ASL YES: never decided silently
  const amb: SignEvent[] = [];
  const d3 = new SignDetector(['asl_yes', 't_unsure'], [{ id: 't_unsure', en: 'Not sure', ar: '', samples: [0, 1, 2].map(() => compact(sequenceOf(aslYes()))) }], (e) => amb.push(e), 0);
  for (const f of [...aslYes(), ...Array.from({ length: 14 }, (_, i) => ({ t: 2000 + i * 33, hands: [] }))]) d3.feed(f);
  assert.equal(amb[0]?.type, 'ambiguous');
});

test('signs drive the same Silent Signal commands as before', () => {
  const m = { yes: 'asl_yes', no: 'asl_no', unsure: 't_unsure' };
  assert.equal(commandOf('asl_yes', m), 'yes'); assert.equal(commandOf('t_unsure', m), 'unsure'); assert.equal(commandOf('t_x', m), null);
  assert.deepEqual(actionFor('yes', 'yesno', m), { kind: 'answer', value: 'yes' });
  assert.deepEqual(actionFor('no', 'choice', m), { kind: 'next' }, 'without a Next sign, No moves on in lists');
  assert.deepEqual(actionFor('yes', 'choice', m), { kind: 'select' });
  assert.equal(confirmAction('yes', m), 'confirm'); assert.equal(confirmAction('no', m), 'change');
  assert.deepEqual(mappingProblems({ yes: 'asl_yes' }, { asl_yes: { reliable: true, label: 'YES' } }), ['Choose a sign for No.']);
  assert.match(mappingProblems({ yes: 'asl_yes', no: 't_no' }, { asl_yes: { reliable: true, label: 'YES' } }).join(), /not available on this device/);
});

test('stored settings: only sign settings are kept; old eye/head movement settings need a new setup', () => {
  assert.equal(cleanCameraPrefs({ mapping: { yes: 'eyes_closed_hold' }, movements: {} }), undefined);
  const c = cleanCameraPrefs({ method: 'signs', mapping: { yes: 'asl_yes', no: 'asl_no', next: 'evil<script>' }, signs: { asl_yes: { kind: 'builtin', label: 'ASL YES', practiced: 3, recognized: 3, reliable: true }, asl_no: { kind: 'builtin', label: 'ASL NO', practiced: 3, recognized: 2, reliable: true } }, confirmedByPatient: true })!;
  assert.deepEqual(c.mapping, { yes: 'asl_yes', no: 'asl_no' }); assert.equal(c.signs.asl_no.recognized, 2);
});
