import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plansFromMessages, todaySlots, nextDose, adherence, readDoseAnswer, sideEffectUrgent, defaultTimes, timesFromDoses } from '../src/services/care/meds';
import { checkBox, cleanBoxReading, namesMedicine, strengthOf, boxPrompt, VISION_PREFIX } from '../src/services/care/boxReader';
import { applyTranslation, numbersIn, interpPrompt, INTERP_PREFIX, transcriptText } from '../src/services/care/interpret';
import { buildBrief, applyBriefAI, briefPrompt, alertsFor } from '../src/services/care/brief';
import { localDay, type DoseData, type PatientRecord, type PhotoData } from '../src/domain/care';
import type { Message } from '../src/domain/types';

const at = (y: number, m: number, d: number, h = 8, mi = 0) => new Date(y, m - 1, d, h, mi);
const rxMsg = (id: string, medication: string, dose: string, frequency: string, duration: string, when: Date, instructions = ''): Message => ({
  id: `m_${id}`, consultationId: 'c1', senderId: 'd', senderRole: 'doctor', body: `Prescription ${medication}`, kind: 'prescription', createdAt: when.toISOString(),
  meta: { rx: { id, medication, dose, route: 'oral', frequency, duration, instructions, approvedAt: when.toISOString(), approvedBy: 'Dr' } },
});
const dose = (rxId: string, medicine: string, day: string, slot: string, status: DoseData['status'], by = '', extra: Partial<DoseData> = {}): PatientRecord<DoseData> => ({
  id: `${rxId}${day}${slot}${status}`, kind: 'dose', at: new Date(`${day}T${slot || '12:00'}:00`).toISOString(), sharedWith: 'd', by,
  data: { medicine, rxId, dose: '', slot, day, status, sideEffect: status === 'side_effect' ? 'rash on my arm' : '', via: 'touch', urgent: [], ...extra },
});

test('medicine plan: only from sent prescriptions; times from the frequency; course end from the duration', () => {
  const sent = at(2026, 10, 20, 7);
  const threads = [{ consultationId: 'c1', messages: [
    rxMsg('rx1', 'Naproxen', '250 mg', 'twice daily with food', '5 days', sent),
    rxMsg('rx2', 'Paracetamol', '500 mg', 'as needed for pain, max 4 a day', '', sent),
    rxMsg('rx3', 'Amoxicillin', '500 mg', 'three times a day', 'for a week', sent),
    { id: 'x', consultationId: 'c1', senderId: 'd', senderRole: 'doctor', body: 'Take vitamin C', kind: 'text', createdAt: sent.toISOString() } as Message,
  ] }];
  const plans = plansFromMessages(threads, at(2026, 10, 22));
  assert.deepEqual(plans.map((p) => p.name).sort(), ['Amoxicillin', 'Naproxen', 'Paracetamol'], 'a text message never becomes a medicine');
  const nap = plans.find((p) => p.name === 'Naproxen')!;
  assert.deepEqual(nap.times, ['09:00', '21:00']); assert.equal(nap.endDay, '2026-10-24'); assert.equal(nap.active, true);
  const para = plans.find((p) => p.name === 'Paracetamol')!;
  assert.equal(para.asNeeded, true); assert.deepEqual(para.times, []);
  assert.deepEqual(plans.find((p) => p.name === 'Amoxicillin')!.times, ['08:00', '14:00', '20:00']);
  assert.equal(plansFromMessages(threads, at(2026, 10, 30)).find((p) => p.name === 'Naproxen')!.active, false, 'the 5-day course has ended');
  assert.deepEqual(plansFromMessages(threads, at(2026, 10, 22), (id) => (id === 'rx1' ? ['07:30', '19:30'] : null)).find((p) => p.name === 'Naproxen')!.times, ['07:30', '19:30'], 'the patient’s own times');
  assert.deepEqual(defaultTimes(null), []);
});

test('today’s doses and adherence (counted per day, so changed times still count)', () => {
  const sent = at(2026, 10, 20, 7);
  const plans = plansFromMessages([{ consultationId: 'c1', messages: [rxMsg('rx1', 'Naproxen', '250 mg', 'twice daily', '10 days', sent)] }], at(2026, 10, 22));
  const now = at(2026, 10, 22, 9, 15);
  const day = localDay(now);
  let slots = todaySlots(plans, [], now);
  assert.deepEqual(slots.map((s) => [s.slot, s.state]), [['09:00', 'due'], ['21:00', 'upcoming']]);
  assert.equal(nextDose(slots)!.slot, '09:00');
  slots = todaySlots(plans, [dose('rx1', 'Naproxen', day, '09:00', 'taken')], now);
  assert.equal(slots[0].state, 'taken'); assert.equal(nextDose(slots)!.slot, '21:00');
  assert.equal(todaySlots(plans, [], at(2026, 10, 22, 12))[0].state, 'not_checked');
  // 20 Oct: 21:00 only (prescribed at 07:00 → 09:00 also counts); 21 Oct: two; 22 Oct by 09:15: one
  const doses = [
    dose('rx1', 'Naproxen', '2026-10-20', '09:00', 'taken'), dose('rx1', 'Naproxen', '2026-10-20', '21:00', 'taken'),
    dose('rx1', 'Naproxen', '2026-10-21', '08:00', 'taken'), dose('rx1', 'Naproxen', '2026-10-21', '20:00', 'missed'),
    dose('rx1', 'Naproxen', '2026-10-22', '09:00', 'side_effect'),
  ];
  const a = adherence(plans, doses, 7, now);
  assert.equal(a.planned, 5); assert.equal(a.taken, 4); assert.equal(a.missed, 1); assert.equal(a.notChecked, 0);
  assert.equal(a.sideEffects, 1); assert.equal(a.sideEffectNotes[0].text, 'rash on my arm');
  // the doctor counts with the patient's own times (shared with each check-in)
  const docPlans = plansFromMessages([{ consultationId: 'c1', messages: [rxMsg('rx1', 'Naproxen', '250 mg', 'twice daily', '10 days', sent)] }], now, timesFromDoses([dose('rx1', 'Naproxen', '2026-10-21', '07:30', 'taken', '', { times: ['07:30', '19:30'] })]));
  assert.deepEqual(docPlans[0].times, ['07:30', '19:30']);
  const alerts = alertsFor('p1', 'Omar', [], doses, plans, now);
  assert.ok(alerts.some((x) => x.kind === 'side_effect'));
});

test('dose answers and side-effect safety, English and Arabic', () => {
  assert.equal(readDoseAnswer('I took it')!.status, 'taken');
  assert.equal(readDoseAnswer('yes')!.status, 'taken');
  assert.equal(readDoseAnswer('خدتها')!.status, 'taken');
  assert.equal(readDoseAnswer('أيوه')!.status, 'taken');
  assert.equal(readDoseAnswer('I forgot')!.status, 'missed');
  assert.equal(readDoseAnswer("I didn't take it")!.status, 'missed');
  assert.equal(readDoseAnswer('نسيت')!.status, 'missed');
  assert.equal(readDoseAnswer('لأ')!.status, 'missed');
  assert.equal(readDoseAnswer('it made me dizzy')!.status, 'side_effect');
  assert.equal(readDoseAnswer('عملتلي طفح')!.status, 'side_effect');
  assert.equal(readDoseAnswer('banana'), null);
  assert.equal(sideEffectUrgent('my lips are swelling and I cannot breathe')[0], 'possible severe allergic reaction');
  assert.ok(sideEffectUrgent('شفايفي وارمة ومش قادر اتنفس').includes('possible severe allergic reaction'));
  assert.deepEqual(sideEffectUrgent('a bit of stomach upset'), []);
});

test('medicine box: AI reads text only; the match uses fixed rules; strength differences are flagged', () => {
  assert.ok(boxPrompt().startsWith(VISION_PREFIX));
  const plans = plansFromMessages([{ consultationId: 'c1', messages: [rxMsg('rx1', 'Naproxen', '250 mg', 'twice daily', '5 days', at(2026, 10, 25))] }], at(2026, 10, 26));
  const r = cleanBoxReading({ readable: true, names: ['Naprosyn', 'Naproxen'], strength: '250 mg', form: 'tablet', text: 'Naproxen 250 mg 20 tablets' })!;
  const v = checkBox(r, plans);
  assert.equal(v.kind, 'match'); assert.equal(v.kind === 'match' && v.strength, 'same');
  const v2 = checkBox(cleanBoxReading({ readable: true, names: ['Naproxen'], strength: '500 mg', text: '' }), plans);
  assert.equal(v2.kind === 'match' && v2.strength, 'different');
  assert.equal(checkBox(cleanBoxReading({ readable: true, names: ['Ibuprofen'], strength: '400 mg', text: 'Ibuprofen' }), plans).kind, 'not_prescribed');
  assert.equal(checkBox(cleanBoxReading({ readable: false, names: [], text: '' }), plans).kind, 'unreadable');
  assert.equal(checkBox(cleanBoxReading('nonsense'), plans).kind, 'unreadable');
  assert.ok(namesMedicine(cleanBoxReading({ readable: true, names: ['Naproxem'], text: '' })!, 'Naproxen'), 'one letter misread on a long name');
  assert.ok(!namesMedicine(cleanBoxReading({ readable: true, names: ['Napro'], text: '' })!, 'Naproxen'));
  assert.deepEqual(strengthOf('500mg'), { value: 500, unit: 'mg' });
});

test('interpreter: numbers are checked in every translation', () => {
  assert.ok(interpPrompt('خد حباية', 'ar', 'en', 'doctor').startsWith(INTERP_PREFIX));
  assert.deepEqual(numbersIn('خد ٢ حباية لمدة خمسة أيام'), ['2', '5']);
  assert.deepEqual(numbersIn('take 2 tablets for 5 days'), ['2', '5']);
  assert.equal(applyTranslation('take 2 tablets for 5 days', { translation: 'خد ٢ حباية لمدة ٥ أيام' })!.numbersOk, true);
  assert.equal(applyTranslation('take 2 tablets for 5 days', { translation: 'خد ٣ حبايات لمدة ٥ أيام' })!.numbersOk, false);
  assert.equal(applyTranslation('twice a day', { translation: 'مرتين في اليوم' })!.numbersOk, true);
  assert.equal(applyTranslation('x', { translation: '' }), null);
  assert.equal(applyTranslation('x', null), null);
  assert.match(transcriptText([{ speaker: 'patient', from: 'ar', source: 'راسي', translation: 'my head', at: '' }], 'en'), /AI translation[\s\S]*Patient \/ المريض: راسي\n→ my head/);
});

test('pre-visit brief: every line cites a source; AI lines must cite real ones and add no numbers', () => {
  const sent = at(2026, 10, 20, 7);
  const msgs: Message[] = [
    rxMsg('rx1', 'Naproxen', '250 mg', 'twice daily', '10 days', sent),
    { id: 'q1', consultationId: 'c1', senderId: 'd', senderRole: 'doctor', body: 'Is the swelling worse at night?', kind: 'yes_no_question', createdAt: at(2026, 10, 21).toISOString() },
    { id: 't1', consultationId: 'c1', senderId: 'p', senderRole: 'patient', body: 'teach-back', kind: 'teachback', createdAt: at(2026, 10, 21, 10).toISOString(),
      meta: { teachback: { replyTo: 'm_rx1', text: 'once a day', points: [{ id: 'a', label: 'How often', correct: 'twice daily', status: 'different', quote: 'once a day', by: 'rules' }, { id: 'b', label: 'Medicine', correct: 'Naproxen', status: 'understood', quote: 'naproxen', by: 'rules' }], ai: false, approvedByPatient: true } } } as Message,
  ];
  const plans = plansFromMessages([{ consultationId: 'c1', messages: msgs }], at(2026, 10, 22));
  const photos: PatientRecord<PhotoData>[] = [1, 3].map((d) => ({ id: `p${d}`, kind: 'photo', at: at(2026, 10, 20 + d).toISOString(), sharedWith: 'd', by: '', data: { area: 'Left knee', note: '', image: 'data:image/jpeg;base64,AAAA', w: 1, h: 1 } }));
  const b = buildBrief({ diary: [], reports: [{ id: 'c1', at: sent.toISOString(), status: 'in_review' }], threads: [{ consultationId: 'c1', messages: msgs }], plans,
    doses: [dose('rx1', 'Naproxen', '2026-10-21', '09:00', 'side_effect', 'Mona', { urgent: [] })], photos, now: at(2026, 10, 22, 22) });
  const all = b.sections.flatMap((s) => s.lines);
  assert.ok(all.every((l) => l.refs.length && l.refs.every((r) => b.sources.some((s) => s.ref === r))), 'every line cites a listed source');
  const txt = all.map((l) => l.en).join('\n');
  assert.match(txt, /Naproxen: 1 of \d+ scheduled doses/);
  assert.match(txt, /Side effect reported with Naproxen .*caregiver Mona/);
  assert.match(txt, /Understanding check: 1 of 2 points matched; different or missing: How often/);
  assert.match(txt, /Still unanswered by the patient: “Is the swelling worse at night\?”/);
  assert.match(txt, /2 photo\(s\) of Left knee/);
  assert.ok(briefPrompt(b).startsWith('You support a licensed doctor reviewing a patient-approved symptom report.'), 'accepted by the web worker');
  const ids = all.map((l) => l.id);
  const r = applyBriefAI(b, { lines: [
    { text: 'A side effect was reported; one point of the plan was misunderstood.', refs: [ids[0], 'M1'] },
    { text: 'Likely an allergy.', refs: [ids[0]] },
    { text: 'Took 99 doses.', refs: [ids[0]] },
    { text: 'No refs here.', refs: ['X9'] },
  ] });
  assert.equal(r.ai!.lines.length, 1); assert.equal(r.ai!.rejected, 3);
});
