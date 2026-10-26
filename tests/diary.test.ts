import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiaryRules, applyDiaryAI, diaryPrompt } from '../src/services/diary/understand';
import { whatChanged, applyChangesAI, changesPrompt, seriesOf } from '../src/services/diary/changes';
import { cleanDiaryEntry, type DiaryEntry } from '../src/domain/diary';
import { LocalDemoBackend } from '../src/services/backend/LocalDemoBackend';
import { MemoryStore } from '../src/services/storage';

test('diary rules: symptoms, strength, better/worse, medicine — English and Arabic', () => {
  const a = readDiaryRules('My headache is better today, about 4, but I feel dizzy');
  assert.deepEqual(a.items.map((i) => [i.concept, i.severity, i.trend]), [['headache', 4, 'better'], ['dizziness', null, null]]);
  const b = readDiaryRules('my knee hurts a lot, 7 out of 10, worse than yesterday');
  assert.equal(b.items[0].en, 'knee pain'); assert.equal(b.items[0].severity, 7); assert.equal(b.items[0].trend, 'worse');
  assert.equal(b.feeling, null, 'a trend for one symptom is not turned into how the patient feels overall');
  const c = readDiaryRules('I feel better today. I took my medicine');
  assert.equal(c.feeling, 'better'); assert.equal(c.medicine, 'yes'); assert.equal(c.items.length, 0);
  const d = readDiaryRules('الصداع خف النهارده بس عندي دوخة');
  assert.deepEqual(d.items.map((i) => [i.concept, i.trend]), [['headache', 'better'], ['dizziness', null]]);
  const e = readDiaryRules('ركبتي بتوجعني جامد ونسيت الدوا');
  assert.equal(e.items[0].ar, 'وجع في الركبة'); assert.equal(e.items[0].severity, 8); assert.equal(e.items[0].prov, 'interpretation', '"جامد" → 8 is an interpretation the patient checks');
  assert.equal(e.medicine, 'no');
  assert.deepEqual(readDiaryRules('I have chest pain since this morning').urgent, ['chest pain or pressure']);
});

test('diary AI: only items quoting the patient’s words, known symptoms, no invented numbers', () => {
  const text = 'so tired today, about 5';
  const base = readDiaryRules(text);
  const r = applyDiaryAI(text, base, { items: [
    { concept: 'fatigue', severity: 5, trend: null, quote: 'so tired' },
    { concept: 'fever', severity: 6, trend: 'worse', quote: 'burning up' },     // not in the words
    { concept: 'cancer', severity: null, quote: 'tired' },                       // not an allowed id
    { concept: 'nausea', severity: 9, quote: 'today' },                          // 9 not said
  ], feeling: 'worse' });
  const fat = r.items.find((i) => i.concept === 'fatigue')!;
  assert.equal(fat.severity, 5); assert.equal(r.items.some((i) => i.concept === 'fever' || i.concept === 'cancer'), false);
  assert.equal(r.items.find((i) => i.concept === 'nausea')?.severity ?? null, null);
  assert.equal(r.feeling, 'worse'); assert.equal(r.ai, true);
  assert.match(diaryPrompt(text, 'en'), /^You are AccessCare AI, a warm medical communication assistant/, 'accepted by the web worker');
});

const E = (day: number, items: Partial<DiaryEntry['items'][number]>[], extra: Partial<DiaryEntry> = {}): DiaryEntry => cleanDiaryEntry({
  id: `e${day}`, at: new Date(Date.UTC(2026, 9, day, 9)).toISOString(), text: 'x', via: 'text', feeling: null, medicine: null, urgent: [], ai: false, aiAllowed: true, sharedWith: 'd',
  items: items.map((i) => ({ concept: 'headache', en: 'headache', ar: 'صداع', severity: null, trend: null, quote: '', prov: 'said', ...i })), ...extra,
})!;

test('what changed: stronger symptom, new symptom, missed medicine, feeling, gaps — each with references', () => {
  const entries = [
    E(1, [{ severity: 4 }]), E(3, [{ severity: 5 }]),
    E(12, [{ severity: 7 }, { concept: 'dizziness', en: 'dizziness', ar: 'دوخة' }], { feeling: 'worse', medicine: 'no' }),
    E(14, [{ severity: 7 }], { feeling: 'worse', medicine: 'yes' }),
  ];
  const s = whatChanged(entries, [{ id: 'c1', at: new Date(Date.UTC(2026, 9, 2)).toISOString(), status: 'new' }], new Date(Date.UTC(2026, 9, 15)).toISOString());
  const txt = s.lines.map((l) => `${l.level}|${l.en}|${l.refs.join(',')}`).join('\n');
  assert.match(txt, /attention\|Headache got stronger: 4 → 7 out of 10 over 13 day\(s\)\.\|D1,D4/);
  assert.match(txt, /attention\|New: dizziness, first noted/);
  assert.match(txt, /attention\|Feels worse overall in 2 of the last 2/);
  assert.match(txt, /attention\|Medicine not taken or only partly taken in 1 of 2/);
  assert.match(txt, /check-in\(s\) since the last shared report.*\|C1/);
  assert.equal(s.lines[0].level, 'attention', 'attention first');
  assert.deepEqual(seriesOf(entries)[0].points.map((p) => p.v), [4, 5, 7, 7]);
  // an urgent entry comes first
  const u = whatChanged([...entries, E(15, [{ concept: 'chest_pain', en: 'chest pain', ar: 'وجع في الصدر' }], { urgent: ['chest pain or pressure'] })], [], new Date(Date.UTC(2026, 9, 15, 12)).toISOString());
  assert.equal(u.lines[0].level, 'urgent');
});

test('what changed AI: lines must cite real references, add no numbers and say nothing diagnostic', () => {
  const entries = [E(1, [{ severity: 4 }]), E(5, [{ severity: 7 }])];
  const s = whatChanged(entries, [], new Date(Date.UTC(2026, 9, 6)).toISOString());
  assert.match(changesPrompt(s), /^You support a licensed doctor reviewing a patient-approved symptom report\./);
  const r = applyChangesAI(s, { lines: [
    { text: 'Headache strength rose from 4 to 7.', refs: ['D1', 'D2'] },
    { text: 'This is likely a migraine.', refs: ['D2'] },
    { text: 'Strength reached 9.', refs: ['D2'] },
    { text: 'Medicine was missed.', refs: ['D99'] },
  ] });
  assert.deepEqual(r.ai!.lines.map((l) => l.text), ['Headache strength rose from 4 to 7.']);
  assert.equal(r.ai!.rejected, 3);
  // entries written without AI consent are never sent
  const noAi = whatChanged([E(1, [{ severity: 4 }], { aiAllowed: false })]);
  assert.doesNotMatch(changesPrompt(noAi), /D1 2026/);
});

test('diary storage: the patient keeps entries; the connected doctor sees only shared ones; others see nothing', async () => {
  const b = new LocalDemoBackend(new MemoryStore(), 1000);
  await b.signUp({ role: 'doctor', fullName: 'Dr. A', email: 'a@x.io', password: 'password-1' } as never);
  const did = (await b.restoreSession())!.doctor!.doctorId;
  await b.signOut();
  await b.signUp({ role: 'doctor', fullName: 'Dr. B', email: 'b@x.io', password: 'password-1' } as never); await b.signOut();
  const pat = await b.signUp({ role: 'patient', fullName: 'Pat', email: 'p@x.io', password: 'password-1' } as never);
  await b.connectToDoctor(did);
  const base = { text: 'better', via: 'text' as const, feeling: 'better' as const, items: [], medicine: null, urgent: [], ai: false, aiAllowed: false };
  await b.addDiaryEntry({ ...base, share: true });
  await b.addDiaryEntry({ ...base, text: 'private', share: false });
  assert.equal((await b.listDiary()).length, 2);
  await b.signOut();
  await b.signIn({ email: 'a@x.io', password: 'password-1' });
  const seen = await b.listDiary(pat.profile.id);
  assert.deepEqual(seen.map((e) => e.text), ['better']);
  await b.signOut();
  await b.signIn({ email: 'b@x.io', password: 'password-1' });
  await assert.rejects(() => b.listDiary(pat.profile.id), /not connected/);
});

import { CloudBackend, type SessionStore } from '../src/services/backend/CloudBackend';
import { MockCloud } from './support/mockCloud';
const device = (): SessionStore => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) }; };
test('cloud diary: stored encrypted; the connected doctor reads only shared entries; disconnecting removes the doctor’s copy', async () => {
  const cloud = new MockCloud();
  const mk = (uid: string) => { const c = cloud.clientFor(uid); return new CloudBackend(c.db, c.user, { iterations: 1000, sessionStore: device() }); };
  const doc = mk('u-d'); const d = await doc.signUp({ role: 'doctor', fullName: 'Dr. Cloud', password: 'doctor-pass-1' });
  const other = mk('u-o'); await other.signUp({ role: 'doctor', fullName: 'Dr. Other', password: 'doctor-pass-2' });
  const pat = mk('u-p'); const p = await pat.signUp({ role: 'patient', fullName: 'Cloud Patient', password: 'patient-pass-1' });
  await pat.connectToDoctor(d.doctor!.doctorId);
  const base = { via: 'text' as const, feeling: 'worse' as const, items: [], medicine: null, urgent: [], ai: false, aiAllowed: true };
  await pat.addDiaryEntry({ ...base, text: 'dizzy-secret shared', share: true });
  await pat.addDiaryEntry({ ...base, text: 'private-secret', share: false });
  assert.ok(!JSON.stringify([...cloud.store.values()]).includes('secret'), 'stored encrypted');
  assert.equal((await pat.listDiary()).length, 2);
  assert.deepEqual((await doc.listDiary(p.profile.id)).map((e) => e.text), ['dizzy-secret shared']);
  await assert.rejects(other.listDiary(p.profile.id));
  await pat.disconnectDoctor();
  await assert.rejects(doc.listDiary(p.profile.id));
  assert.equal((await pat.listDiary()).length, 2, 'the patient keeps everything');
});
