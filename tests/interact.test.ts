import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules, checkTeachBack, planPoints, teachBackDue, teachBackPrompt, timesPerDay, durationDays, doseCount } from '../src/services/teachback/check';
import { cleanProbe, cleanProbeAnswer, cleanTeachBack } from '../src/domain/interact';
import { cleanMeta, messageKindFor, readKind } from '../src/services/backend/sanitize';
import { LocalDemoBackend } from '../src/services/backend/LocalDemoBackend';
import { MemoryStore } from '../src/services/storage';
import type { Message } from '../src/domain/types';

const rx = (id: string, medication: string, dose: string, frequency: string, duration: string, at = '2026-10-20T10:00:00Z'): Message => ({ id: 'm' + id, consultationId: 'c', senderId: 'd', senderRole: 'doctor', body: '', kind: 'prescription', createdAt: at, meta: { rx: { id, medication, dose, route: 'by mouth', frequency, duration, instructions: '', approvedAt: at, approvedBy: 'Dr' } } });
const vs: Message = { id: 'v', consultationId: 'c', senderId: 'd', senderRole: 'doctor', body: '', kind: 'visit_summary', createdAt: '2026-10-20T11:00:00Z', meta: { summary: { id: 'v', text: 'Take naproxen twice a day with food, for 5 days. If your lips swell, call the emergency number now.', source: 'doctor', approvedBy: 'Dr', approvedAt: 'x' } } };

test('teach-back parsing: how often, how long, how much — English and Arabic', () => {
  assert.equal(timesPerDay('twice daily with food')!.value, 2); assert.equal(timesPerDay('every 8 hours')!.value, 3); assert.equal(timesPerDay('مرتين في اليوم')!.value, 2);
  assert.equal(timesPerDay('تلات مرات')!.value, 3); assert.equal(timesPerDay('once a day')!.value, 1); assert.equal(timesPerDay('الصبح وبالليل')!.value, 2);
  assert.equal(durationDays('for 5 days')!.value, 5); assert.equal(durationDays('once a day for 5 days')!.value, 5, 'skips "a day"'); assert.equal(durationDays('أسبوع')!.value, 7); assert.equal(durationDays('خمس ايام')!.value, 5);
  assert.equal(doseCount('1 tablet')!.value, 1); assert.equal(doseCount('حبايتين')!.value, 2); assert.equal(doseCount('two pills')!.value, 2);
});

test('teach-back rules: understood / different / not mentioned, against what the doctor wrote', () => {
  const pts = planPoints([rx('r1', 'naproxen', '1 tablet', 'twice daily with food', '5 days'), vs]);
  assert.deepEqual(pts.map((p) => p.id), ['rx:r1:name', 'rx:r1:dose', 'rx:r1:frequency', 'rx:r1:duration', 'visit:urgent']);
  const r = checkRules('I take naproxen once a day for 5 days, one tablet', pts);
  assert.deepEqual(r.map((p) => p.status), ['understood', 'understood', 'different', 'understood', 'missing']);
  assert.equal(r[2].correct, 'twice daily with food', 'the correct wording is the doctor’s');
  const ar = checkRules('حباية مرتين في اليوم لمدة خمس ايام ولو حصل تورم اتصل بالاسعاف', pts);
  assert.deepEqual(ar.map((p) => p.status), ['missing', 'understood', 'understood', 'understood', 'understood']);
  // nothing to check → no card
  assert.equal(teachBackDue([]), false);
  assert.equal(teachBackDue([rx('r1', 'naproxen', '1 tablet', 'twice daily', '5 days')]), true);
  const done: Message = { id: 't', consultationId: 'c', senderId: 'p', senderRole: 'patient', body: '', kind: 'teachback', createdAt: '2026-10-21T10:00:00Z', meta: {} };
  assert.equal(teachBackDue([rx('r1', 'naproxen', '1 tablet', 'twice daily', '5 days'), done]), false);
  assert.equal(teachBackDue([rx('r1', 'naproxen', '1 tablet', 'twice daily', '5 days'), done, rx('r2', 'naproxen', '1 tablet', 'once daily', '3 days', '2026-10-22T10:00:00Z')]), true, 'a new plan asks again');
});

test('teach-back AI: may only fill points the rules missed, and only by quoting the patient', async () => {
  const pts = planPoints([rx('r1', 'naproxen', '1 tablet', 'twice daily with food', '5 days'), vs]);
  const text = 'نابروكسين حباية مرتين في اليوم لمدة خمس ايام ولو حصل تورم اتصل بالاسعاف';
  let prompt = '';
  const r = await checkTeachBack(text, pts, 'ar', async (p) => { prompt = p; return { points: [
    { id: 'rx:r1:name', status: 'understood', quote: 'نابروكسين' },
    { id: 'rx:r1:frequency', status: 'different', quote: 'مرتين' },       // the rules already said "understood": stands
    { id: 'visit:urgent', status: 'different', quote: 'I will be fine' },  // not the patient's words
    { id: 'rx:zzz', status: 'understood', quote: 'حباية' },               // unknown point
  ] }; });
  assert.match(prompt, /^You are AccessCare AI, a warm medical communication assistant\. Task: teach-back check/);
  assert.equal(r.ai, true);
  assert.deepEqual(r.points.map((p) => [p.status, p.by]), [['understood', 'ai'], ['understood', 'rules'], ['understood', 'rules'], ['understood', 'rules'], ['understood', 'rules']]);
  const off = await checkTeachBack(text, pts, 'ar', null);
  assert.equal(off.points[0].status, 'missing', 'without AI the Arabic spelling of the medicine is not matched');
  assert.match(teachBackPrompt(text, pts, 'ar'), /doctor_wrote/);
});

test('"Here?" and teach-back messages: only valid, patient-approved data is kept; roles are enforced', () => {
  assert.equal(cleanProbe({ id: 'p', regions: ['knee_l', 'made_up'], question: 'Does it hurt here?', askStrength: true })!.regions.join(), 'knee_l');
  assert.equal(cleanProbe({ id: 'p', regions: ['nope'] }), undefined);
  assert.equal(cleanProbeAnswer({ replyTo: 'x', answer: 'yes', strength: 14, regions: ['knee_l'], via: 'voice', approvedByPatient: true })!.strength, 10);
  assert.equal(cleanProbeAnswer({ replyTo: 'x', answer: 'no', strength: 6, regions: [], via: '', approvedByPatient: true })!.strength, null);
  assert.equal(cleanProbeAnswer({ replyTo: 'x', answer: 'yes', approvedByPatient: false as unknown as true }), undefined);
  assert.equal(cleanTeachBack({ replyTo: 'x', text: 'a', points: [], ai: false, approvedByPatient: true }), undefined);
  assert.equal(messageKindFor('patient', 'body_probe'), 'text', 'patients cannot send a probe');
  assert.equal(messageKindFor('doctor', 'teachback'), 'text', 'doctors cannot write the patient’s teach-back');
  assert.equal(readKind('body_probe', cleanMeta({}, 'body_probe')), 'text');
});

test('local backend: probe → approved answer → doctor; teach-back reaches the doctor', async () => {
  const b = new LocalDemoBackend(new MemoryStore(), 1000);
  const d = await b.signUp({ role: 'doctor', fullName: 'Dr Here', email: 'h@x.co', password: 'password-1' }); await b.signOut();
  await b.signUp({ role: 'patient', fullName: 'Pat Here', email: 'q@x.co', password: 'password-1' });
  await b.connectToDoctor(d.doctor!.doctorId);
  const c = await b.createConsultation();
  await b.approveAndShare(c.id, { text: 'Knee pain', report: { regionIds: [], sensations: [], details: {}, answers: [] } as never, editedByPatient: false });
  await b.signOut(); await b.signIn({ email: 'h@x.co', password: 'password-1' });
  const probe = await b.sendMessage(c.id, 'Does it hurt here?', 'body_probe', { probe: { id: 'pb1', regions: ['knee_l'], question: 'Does it hurt here?', askStrength: true } });
  assert.equal(probe.kind, 'body_probe');
  await assert.rejects(() => b.sendMessage(c.id, 'x', 'body_probe', { probe: { id: 'pb2', regions: [], question: '', askStrength: true } }), /body area/);
  await b.signOut(); await b.signIn({ email: 'q@x.co', password: 'password-1' });
  await b.sendMessage(c.id, 'Yes, 6/10', 'body_probe_answer', { probeAnswer: { replyTo: probe.id, answer: 'yes', strength: 6, regions: ['knee_l'], via: 'buttons', approvedByPatient: true } });
  await b.sendMessage(c.id, 'my words', 'teachback', { teachback: { replyTo: probe.id, text: 'my words', points: [{ id: 'rx:1:name', label: 'Which medicine', correct: 'naproxen', status: 'missing', quote: '', by: 'rules' }], ai: false, approvedByPatient: true } });
  await b.signOut(); await b.signIn({ email: 'h@x.co', password: 'password-1' });
  const ms = await b.listMessages(c.id);
  assert.equal(ms.find((m) => m.kind === 'body_probe_answer')!.meta!.probeAnswer!.strength, 6);
  assert.equal(ms.find((m) => m.kind === 'teachback')!.meta!.teachback!.points[0].status, 'missing');
});

import worker from '../server/cloudflare-worker.mjs';
import { diaryPrompt } from '../src/services/diary/understand';
import { whatChanged, changesPrompt } from '../src/services/diary/changes';
import { cleanDiaryEntry } from '../src/domain/diary';
test('web worker accepts the new AI requests (diary, what changed — even with 60 check-ins — and teach-back)', async () => {
  const orig = globalThis.fetch; const sent: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { sent.push(init?.body ?? ''); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":1}' }] }), { status: 200 }); }) as typeof fetch;
  try {
    const env = { ANTHROPIC_API_KEY: 'k', ALLOWED_ORIGINS: '*' };
    const post = (prompt: string, max = 900) => worker.fetch(new Request('https://w/ai', { method: 'POST', headers: { origin: 'https://x', 'content-type': 'application/json' }, body: JSON.stringify({ prompt, max_tokens: max }) }), env);
    const many = Array.from({ length: 60 }, (_, k) => cleanDiaryEntry({ id: `e${k}`, at: new Date(Date.UTC(2026, 8, 1 + k)).toISOString(), text: 'my headache is worse today and I feel dizzy and tired, '.repeat(4), via: 'text', feeling: 'worse', medicine: 'yes', urgent: [], ai: false, aiAllowed: true, sharedWith: 'd',
      items: [{ concept: 'headache', en: 'headache', ar: 'صداع', severity: k % 10, trend: 'worse', quote: '', prov: 'said' }] })!);
    const pts = planPoints([rx('r1', 'naproxen', '1 tablet', 'twice daily', '5 days')]);
    for (const pr of [diaryPrompt('my headache is better', 'en'), changesPrompt(whatChanged(many)), teachBackPrompt('I take it once a day', pts, 'en')]) {
      const r = await post(pr);
      assert.equal(r.status, 200, `${pr.slice(0, 80)} … (${pr.length} chars) → ${r.status} ${await r.text()}`);
    }
    assert.equal(sent.length, 3);
  } finally { globalThis.fetch = orig; }
});
