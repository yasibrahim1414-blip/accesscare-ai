import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, step, matchOption, spokenNumber, spell, summaryLines, type Ctx, type DialogState, type Input, type Turn } from '../src/services/voice/VoiceDialog';
import { GestureRecognizer, TripleSwipeDetector, classifyStroke } from '../src/services/voice/Gestures';
import { cleanBlindPrefs, DEFAULT_BLIND } from '../src/domain/voice';
import { cleanPreferences } from '../src/domain/types';
import { generatePatientId, generateRecoveryCode, PATIENT_ID_PATTERN, normalizePatientId, normalizeRecoveryCode } from '../src/services/crypto';

const CTX: Ctx = { signedIn: true, shared: true, claudeAccount: true, aiSupported: false, aiOn: false, doctorName: 'Dr. Layla Hassan' };
function run(st: DialogState, inputs: (string | Input)[], ctx = CTX): Turn {
  let turn: Turn = { state: st, say: [], options: [], effects: [], listen: false };
  for (const i of inputs) turn = step(turn.state, typeof i === 'string' ? { kind: 'utterance', text: i } : i, ctx);
  return turn;
}

import { ruleTurn, startConsult } from '../src/services/conversation/Consult';
/** Plays the app's part: runs the conversation manager for `converse` / `consult_start` effects (rules only here). */
function loop(st: DialogState, inputs: (string | Input)[], ctx = CTX): Turn {
  let turn: Turn = { state: st, say: [], options: [], effects: [], listen: false };
  const settle = (t: Turn): Turn => {
    for (const e of t.effects) {
      if (e.type === 'consult_start') { const c = startConsult(t.state.lang, e.change ? t.state.consult : undefined); return settle(step(t.state, { kind: 'event', name: 'consult_turn', data: { rec: c.rec, say: c.say, options: c.options, review: c.review, urgent: c.urgent } }, ctx)); }
      if (e.type === 'converse') { const c = ruleTurn(t.state.consult!, e.input); return settle(step(t.state, { kind: 'event', name: 'consult_turn', data: { rec: c.rec, say: c.say, options: c.options, review: c.review, urgent: c.urgent } }, ctx)); }
    }
    return t;
  };
  for (const i of inputs) turn = settle(step(turn.state, typeof i === 'string' ? { kind: 'utterance', text: i } : i, ctx));
  return turn;
}

test('English consultation by voice follows the symptom: a headache gets head questions, never chest/back choices', () => {
  const t0 = step(initialState('en'), { kind: 'start' }, CTX);
  assert.match(t0.say.join(' '), /Welcome back/);
  let t = loop(t0.state, ['I want to start a new consultation']);
  assert.equal(t.state.phase, 'consult'); assert.match(t.say.join(' '), /What is bothering you/);
  t = loop(t.state, ['I have had a severe headache since this morning']);
  assert.match(t.say.join(' '), /headache/i); assert.match(t.say.join(' '), /suddenly, or build up gradually/);
  assert.ok(!t.options.some((o) => /chest|back/i.test(o.label)), t.options.map((o) => o.label).join());
  t = loop(t.state, ['gradually', 'mostly my forehead', 'it comes and goes', 'no, none of those', 'no that is all']);
  assert.equal(t.state.phase, 'review', t.say.join(' | '));
  const lines = summaryLines(t.state).join('\n');
  assert.match(lines, /Headache — you said: "I have had a severe headache since this morning"/);
  assert.match(lines, /Strength: severe \(your words: "severe"\)/); assert.match(lines, /Started: today \(your words: "this morning"\)/);
  assert.match(lines, /Where exactly: forehead/); assert.match(lines, /Pattern: comes and goes/);
  const send = loop(t.state, ['approve', 'yes']);
  assert.deepEqual(send.effects, [{ type: 'send_report', toDoctor: true }]);
  const done = step(send.state, { kind: 'event', name: 'sent' }, CTX);
  assert.match(done.say.join(' '), /Sent to Dr. Layla Hassan/); assert.equal(done.state.phase, 'menu'); assert.equal(done.state.consult, undefined);
});

test('corrections, repeat and reject; going back to change keeps what was said', () => {
  let t = loop(step(initialState('en'), { kind: 'start' }, CTX).state, ['new consultation', 'my knee hurts since yesterday', 'left']);
  const r = loop(t.state, ['repeat']);
  assert.ok(r.say.length > 0);
  t = loop(t.state, ['actually it started today']);
  assert.equal(t.state.consult!.complaints[0].facts.onset?.value, 'today');
  assert.match(t.state.consult!.corrections.map((c) => `${c.from}→${c.to}`).join(), /a few days ago→today/);
  // finish quickly, then change something from the review
  t = loop(t.state, ['not sure', 'not sure', 'not sure', 'not sure', 'no that is all']);
  assert.equal(t.state.phase, 'review', t.say.join(' | '));
  const ch = loop(t.state, ['change', 'it is severe']);
  assert.equal(ch.state.consult!.complaints[0].facts.severity?.value, 'severe');
  assert.equal(ch.state.consult!.complaints[0].regions[0].id, 'knee_l', 'nothing else was lost');
  const rej = loop(t.state, ['reject', 'yes']);
  assert.equal(rej.state.phase, 'menu'); assert.match(rej.say.join(' '), /Nothing was sent/); assert.equal(rej.effects.length, 0);
});

test('urgent words stop the consultation immediately; continue returns to the same question', () => {
  const t = loop(step(initialState('en'), { kind: 'start' }, CTX).state, ['new consultation', "I can't breathe and my chest feels tight"]);
  assert.equal(t.state.phase, 'urgent'); assert.match(t.say.join(' '), /urgent medical help/);
  const c = loop(t.state, ['continue']);
  assert.equal(c.state.phase, 'consult'); assert.ok(c.say.length);
  const h = loop(step(initialState('en'), { kind: 'start' }, CTX).state, ['new consultation', 'I passed out this morning']);
  assert.equal(h.state.phase, 'urgent');
});

test('unclear answers in menus: no guessing without AI; with AI the interpretation must be confirmed', () => {
  const s = step(initialState('en'), { kind: 'start' }, CTX).state;
  const miss = step(s, { kind: 'utterance', text: 'purple elephant' }, CTX);
  assert.equal(miss.state.phase, 'menu'); assert.ok(miss.effects.some((e) => e.type === 'nomatch')); assert.match(miss.say.join(' '), /did not understand/);
  const aiCtx = { ...CTX, aiSupported: true, aiOn: true };
  const m2 = step(s, { kind: 'utterance', text: 'what did the doc write me' }, aiCtx);
  assert.equal(m2.say.length, 0, 'waits for the AI interpretation');
  const g = step(m2.state, { kind: 'ai_guess', id: 'messages' }, aiCtx);
  assert.match(g.say.join(' '), /I understood: My messages. Is that right/);
  const ok = step(g.state, { kind: 'utterance', text: 'yes' }, aiCtx);
  assert.deepEqual(ok.effects, [{ type: 'load_messages' }]);
});

test('account onboarding (not signed in): consent → name → password form → ID read-out → recovery code → doctor → menu', () => {
  const ctx: Ctx = { signedIn: false, shared: false, claudeAccount: false, aiSupported: false, aiOn: false, doctorName: null };
  let t = step(initialState('en'), { kind: 'start' }, ctx);
  assert.match(t.say.join(' '), /Blind Mode is active/);
  t = run(t.state, ['new account'], ctx);
  assert.match(t.say.join(' '), /saved only on this device/);
  t = run(t.state, ['yes', 'my name is Mariam Saleh'], ctx);
  assert.match(t.say.join(' '), /I heard: Mariam Saleh/);
  t = run(t.state, ['yes'], ctx);
  assert.deepEqual(t.effects, [{ type: 'show_signup' }]); assert.equal(t.listen, false);
  t = step(t.state, { kind: 'event', name: 'signed_up', data: { patientCode: 'AC-PAT-7K4P9X' } }, ctx);
  assert.deepEqual(t.effects, [{ type: 'create_recovery' }]);
  assert.match(t.say.join(' '), /Your Patient ID is: A C\. P A T\. 7 K 4\. P 9 X\./);
  t = run(t.state, ['spell it slowly'], ctx);
  assert.match(t.say.join(' '), /7, K, 4/);
  t = step(t.state, { kind: 'event', name: 'recovery_created', data: { code: 'ABCD-EFGH-JKMN-PQRS' } }, ctx);
  t = run(t.state, ['continue'], ctx);
  assert.match(t.say.join(' '), /recovery code is: A B C D\./);
  t = run(t.state, ['save'], ctx);
  assert.deepEqual(t.effects, [{ type: 'save_recovery_file' }]);
  t = run(t.state, ['continue', 'yes', 'A C D O C 7 K 4 P 9 X'], ctx);
  assert.deepEqual(t.effects, [{ type: 'lookup_doctor', code: 'ACDOC7K4P9X' }]);
  t = step(t.state, { kind: 'event', name: 'doctor_found', data: { id: 'AC-DOC-7K4P9X', name: 'Dr. Layla Hassan' } }, ctx);
  t = run(t.state, ['yes'], ctx);
  assert.deepEqual(t.effects, [{ type: 'connect_doctor', code: 'AC-DOC-7K4P9X' }]);
  t = step(t.state, { kind: 'event', name: 'doctor_connected', data: { name: 'Dr. Layla Hassan' } }, ctx);
  assert.equal(t.state.phase, 'menu'); assert.match(t.say.join(' '), /AI help is not available/);
});

test('messages: read newest, navigate, dictate a reply and confirm before sending', () => {
  let t = run(step(initialState('en'), { kind: 'start' }, CTX).state, ['my messages']);
  assert.deepEqual(t.effects, [{ type: 'load_messages' }]);
  t = step(t.state, { kind: 'event', name: 'messages', data: { status: 'seen by your doctor', list: [
    { from: 'doctor', body: 'Is the pain worse at night?', at: '2026-10-22T10:00:00Z', cid: 'c1' },
    { from: 'patient', body: 'Hello doctor', at: '2026-10-21T10:00:00Z', cid: 'c1' }] } }, CTX);
  assert.match(t.say.join(' '), /seen by your doctor.*2 message/s); assert.match(t.say.join(' '), /Is the pain worse at night/);
  t = run(t.state, ['next']); assert.match(t.say.join(' '), /Hello doctor/);
  t = run(t.state, ['previous', 'reply', 'yes it is worse at night']);
  assert.match(t.say.join(' '), /Your reply is: yes it is worse at night\. Send it/);
  const no = run(t.state, ['no']); assert.equal(no.state.phase, 'reply');
  t = run(t.state, ['yes']);
  assert.deepEqual(t.effects, [{ type: 'send_reply', cid: 'c1', text: 'yes it is worse at night' }]);
});

test('settings, logout confirmation, word and number matching', () => {
  let t = run(step(initialState('en'), { kind: 'start' }, CTX).state, ['settings', 'slower']);
  assert.deepEqual(t.effects, [{ type: 'settings', change: 'slower' }]);
  t = run(t.state, ['brief']); assert.deepEqual(t.effects, [{ type: 'settings', change: 'brief' }]);
  t = run(step(initialState('en'), { kind: 'start' }, CTX).state, ['log out']);
  assert.equal(t.state.phase, 'logout_confirm'); assert.equal(t.effects.length, 0);
  t = run(t.state, ['yes']); assert.deepEqual(t.effects, [{ type: 'logout' }]);
  assert.equal(matchOption('yes please', ['yes', 'no']), 'yes');
  assert.equal(matchOption('no, not that', ['yes', 'no']), 'no');
  assert.equal(spokenNumber('about 8 out of ten'), 8); assert.equal(spokenNumber('five'), 5);
  assert.equal(spell('AC-PAT-7K4P9X', 'en'), 'A C. P A T. 7 K 4. P 9 X.');
});

test('gestures: swipes, scroll rejection, taps, double tap, long press, triple-left activation', () => {
  const P = (x: number, y: number, t: number) => ({ x, y, t });
  assert.deepEqual(classifyStroke(P(300, 400, 0), P(180, 410, 220), 120), { type: 'swipe', dir: 'left', at: 220 });
  assert.equal(classifyStroke(P(300, 400, 0), P(260, 250, 250), 155)?.type === 'swipe' && classifyStroke(P(300, 400, 0), P(260, 250, 250), 155)!.type, 'swipe');
  assert.equal((classifyStroke(P(300, 400, 0), P(260, 250, 250), 155) as { dir?: string }).dir, 'up', 'a vertical scroll is not a left swipe');
  assert.equal(classifyStroke(P(300, 400, 0), P(230, 400, 1500), 70), null, 'slow drag');
  assert.equal(classifyStroke(P(300, 400, 0), P(270, 400, 100), 30), null, 'too short');
  assert.equal(classifyStroke(P(300, 400, 0), P(200, 330, 200), 122), null, 'diagonal');
  const r = new GestureRecognizer();
  r.down(1, P(100, 100, 0)); assert.equal(r.up(1, P(102, 101, 80))?.type, 'tap');
  r.down(1, P(101, 100, 200)); assert.equal(r.up(1, P(101, 101, 260))?.type, 'doubleTap');
  r.down(1, P(100, 100, 1000)); assert.equal(r.up(1, P(101, 100, 1800))?.type, 'longPress');
  r.down(1, P(300, 300, 2000)); r.down(2, P(100, 300, 2010)); r.move(1, P(200, 300, 2100));
  assert.equal(r.up(1, P(150, 300, 2150)), null, 'two fingers never count'); r.up(2, P(100, 300, 2160));
  const tri = new TripleSwipeDetector();
  const L = (t: number) => ({ type: 'swipe' as const, dir: 'left' as const, at: t });
  assert.equal(tri.feed(L(0)), false); assert.equal(tri.feed(L(500)), false); assert.equal(tri.feed(L(1000)), true);
  assert.equal(tri.feed(L(0)) || tri.feed({ type: 'swipe', dir: 'up', at: 300 }) || tri.feed(L(600)) || tri.feed(L(1100)), false, 'a scroll in between resets');
  tri.reset();
  assert.equal(tri.feed(L(0)) || tri.feed(L(2000)) || tri.feed(L(2600)), false, 'too slow');
  assert.equal(tri.feed(L(3100)), true, 'third deliberate swipe after a fresh start completes');
});

test('Patient ID, recovery code and blind preferences', () => {
  const id = generatePatientId();
  assert.match(id, PATIENT_ID_PATTERN); assert.notEqual(id, generatePatientId());
  assert.equal(normalizePatientId(' ac pat 7k4p9x '), 'AC-PAT-7K4P9X');
  const code = generateRecoveryCode();
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
  assert.equal(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), code);
  const b = cleanBlindPrefs({ lang: 'ar', rate: 9, navigation: 'weird', gestures: { swipeLeft: 'activate', swipeRight: 'bogus' }, recording: 'x' })!;
  assert.equal(b.lang, 'ar'); assert.equal(cleanBlindPrefs({ lang: 'fr' })!.lang, 'fr'); assert.equal(cleanBlindPrefs({ lang: 'de' })!.lang, 'en'); assert.equal(b.rate, 1.6); assert.equal(b.navigation, 'gestures');
  assert.equal(b.gestures.swipeLeft, 'activate'); assert.equal(b.gestures.swipeRight, 'next'); assert.ok(!('recording' in b));
  assert.deepEqual(cleanPreferences({ blind: DEFAULT_BLIND } as never).blind, DEFAULT_BLIND);
  assert.equal(cleanPreferences({}).blind, undefined);
});

test('triple tap: three quick taps activate; slow taps or a swipe in between do not', async () => {
  const { TripleTapDetector } = await import('../src/services/voice/Gestures');
  const d = new TripleTapDetector();
  const T = (at: number) => ({ type: 'tap' as const, x: 10, y: 10, at });
  assert.equal(d.feed(T(0)) || d.feed({ type: 'doubleTap', x: 10, y: 10, at: 250 }), false);
  assert.equal(d.feed(T(500)), true);
  assert.equal(d.feed(T(1000)) || d.feed(T(1600)) || d.feed(T(2200)), false, 'too slow');
  d.reset();
  assert.equal(d.feed(T(0)) || d.feed(T(200)) || d.feed({ type: 'swipe', dir: 'up', at: 300 }) || d.feed(T(400)), false, 'scroll resets');
});

test('AI can be turned on from voice settings (only where AI exists)', () => {
  const ctx = { ...CTX, aiSupported: true };
  const s = loop(step(initialState('en'), { kind: 'start' }, ctx).state, ['settings'], ctx);
  assert.ok(s.options.some((o) => o.id === 'set_ai'));
  const a = loop(s.state, ['turn on ai'], ctx);
  assert.equal(a.state.phase, 'ai_consent');
  const on = loop(a.state, ['yes'], ctx);
  assert.deepEqual(on.effects.find((e) => e.type === 'enable_ai'), { type: 'enable_ai', on: true });
  assert.equal(loop(step(initialState('en'), { kind: 'start' }, CTX).state, ['settings']).options.some((o) => o.id === 'set_ai'), false);
});


// ---------------------------------------------------------------- Arabic (restored)
test('Arabic consultation by voice (Egyptian wording)', () => {
  const t = loop(step(initialState('ar'), { kind: 'start' }, CTX).state, ['عايز استشارة جديدة', 'بطني بتوجعني من امبارح', 'تحت', 'متوسط', 'على طول', 'مفيش', 'لا بس كده']);
  assert.equal(t.state.phase, 'review', t.say.join(' | '));
  const lines = summaryLines(t.state).join('\n');
  assert.match(lines, /وجع في البطن/); assert.match(lines, /تحت البطن/); assert.match(lines, /متوسط/); assert.match(lines, /امبارح/);
});

test('urgent words stop the consultation immediately (English and Arabic); continue returns to the same question', () => {
  const t = loop(step(initialState('en'), { kind: 'start' }, CTX).state, ['new consultation', "I can't breathe and my chest feels tight"]);
  assert.equal(t.state.phase, 'urgent'); assert.match(t.say.join(' '), /urgent medical help/);
  const c = loop(t.state, ['continue']);
  assert.equal(c.state.phase, 'consult'); assert.ok(c.say.length);
  const ar = loop(step(initialState('ar'), { kind: 'start' }, CTX).state, ['استشارة', 'مش قادر اتنفس']);
  assert.equal(ar.state.phase, 'urgent'); assert.match(ar.say.join(' '), /الطوارئ/);
});

test('three right swipes (turn Blind Mode off) are told apart from three left swipes (turn it on)', async () => {
  const { TripleSwipeDetector } = await import('../src/services/voice/Gestures');
  const right = new TripleSwipeDetector('right'); const left = new TripleSwipeDetector('left');
  const S = (dir: 'left' | 'right', at: number) => ({ type: 'swipe' as const, dir, at });
  assert.equal(right.feed(S('right', 0)) || right.feed(S('right', 300)), false);
  assert.equal(right.feed(S('right', 600)), true);
  assert.equal(left.feed(S('right', 0)) || left.feed(S('right', 300)) || left.feed(S('right', 600)), false, 'right swipes never turn it on');
  assert.equal(right.feed(S('right', 1000)) || right.feed(S('left', 1200)) || right.feed(S('right', 1400)), false, 'a swipe the other way resets it');
  const nav = new TripleSwipeDetector('right');
  assert.equal([0, 700, 1400, 2100].some((t) => nav.feed(S('right', 4000 + t))), false, 'swiping right one item at a time (to move between controls) does not turn it off');
});
