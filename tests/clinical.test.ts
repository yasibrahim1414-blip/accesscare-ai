import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startConsult, ruleTurn, type ConsultInput, type ConsultTurn } from '../src/services/conversation/Consult';
import { analyze, analyzeRules, applyAI, suggestMeds, medsGate, PROMPT_PREFIX, analysisPrompt, type EngineInput } from '../src/services/clinical/engine';
import { build, buildBrief, toStructuredReport } from '../src/services/intent/ReconstructionEngine';
import { EMPTY_DOCUMENTED, cleanRxMeta, cleanReview, newReview, type Documented } from '../src/domain/clinical';
import { messageKindFor, cleanMeta, requireValidRx, readKind } from '../src/services/backend/sanitize';
import { LocalDemoBackend } from '../src/services/backend/LocalDemoBackend';
import { MemoryStore } from '../src/services/storage';
import { CloudBackend, type SessionStore } from '../src/services/backend/CloudBackend';
import { MockCloud } from './support/mockCloud';
import { REF_BY_ID } from '../src/services/clinical/references';
import type { Message, StructuredReport } from '../src/domain/types';

const T = (text: string, via: ConsultInput['via'] = 'text'): ConsultInput => ({ kind: 'text', text, via });
const O = (id: string, label = id): ConsultInput => ({ kind: 'option', id, label, via: 'touch' });
function talk(lang: 'en', inputs: (string | ConsultInput)[]): ConsultTurn {
  let t = startConsult(lang);
  for (const i of inputs) t = ruleTurn(t.rec, typeof i === 'string' ? T(i) : i);
  return t;
}
const emptyReport = (): StructuredReport => ({ regions: [], sensations: [], fields: [], clarifications: [], flags: [], generatedBy: 'demo-rules' });
function convInput(t: ConsultTurn, aiConsent = true, messages: Message[] = [], documented: Documented = EMPTY_DOCUMENTED): EngineInput {
  const report = { ...emptyReport(), conversation: t.rec, aiConsent } as StructuredReport;
  return { consultation: { regionIds: [], sensations: [], details: {}, urgentGuidanceShown: t.rec.urgent.length > 0, approved: { text: 'x', report, editedByPatient: false, approvedAt: '' } }, messages, documented };
}
const ids = (a: { warnings: { id: string; level: string }[] }, level: string) => a.warnings.filter((w) => w.level === level).map((w) => w.id);
const doc = (p: Partial<Documented>): Documented => ({ ...JSON.parse(JSON.stringify(EMPTY_DOCUMENTED)), ...p });

// ---------------------------------------------------------------- reasoning
test('headache that began suddenly + new trouble speaking → emergency (stroke signs / headache with neuro), not a routine questionnaire', () => {
  const t = talk('en', ['I have a headache', O('v:today', 'Today'), O('v:sudden', 'Suddenly'), 'and now I have trouble speaking']);
  assert.ok(t.rec.urgent.length > 0, 'the conversation itself showed emergency guidance right away');
  const a = analyzeRules(convInput(t));
  const em = ids(a, 'emergency');
  assert.ok(em.includes('stroke_signs') && em.includes('headache_neuro'), em.join());
  const w = a.warnings.find((x) => x.id === 'headache_neuro')!;
  assert.ok(w.evidence.length >= 2 && w.evidence.every((e) => a.facts.some((f) => f.id === e)), 'every warning points at real facts');
  assert.ok(w.refs.every((r) => REF_BY_ID[r]), 'references come from the checked catalog');
  assert.equal(a.nextSteps[0].text, 'Contact the patient now and advise emergency care.');
  assert.ok(medsGate(a, doc({ age: '40', allergies: { status: 'none_known', items: [] }, medications: { status: 'none', items: [] }, sex: 'male' }), true)[0].startsWith('An emergency warning is active'));
});

test('the same rules apply to free wording: "my head is pounding" + "I suddenly can\'t find my words"', () => {
  const t = talk('en', ['I have a headache that came on suddenly', "and now my speech is slurred"]);
  const a = analyzeRules(convInput(t));
  assert.ok(ids(a, 'emergency').includes('headache_neuro'), JSON.stringify(a.warnings.map((w) => w.id)));
});

test('ordinary gradual headache: no emergency; missing info is about the head (neuro screen, fever/stiff neck) — never chest or back', () => {
  const t = talk('en', ['I have a headache since yesterday', O('v:gradual', 'Gradually')]);
  const a = analyzeRules(convInput(t));
  assert.deepEqual(ids(a, 'emergency'), []);
  const topics = a.missing.map((m) => m.topic).join(' | ');
  assert.match(topics, /Trouble speaking, weakness or numbness/); assert.match(topics, /Fever or a stiff neck/);
  assert.doesNotMatch(topics, /chest|back|stomach|belly/i);
  assert.ok(!a.missing.some((m) => m.topic.startsWith('How it started')), 'already answered → not asked again');
  // unanswered is not negative: nothing about speech/weakness is recorded as denied
  assert.ok(!a.facts.some((f) => f.status === 'denied'));
  assert.ok(a.missing.find((m) => m.id === 'headache:neuro')!.status === 'missing');
});

test('"not sure" stays uncertain (never “no”), and a sudden headache of unknown strength is flagged', () => {
  const t = talk('en', ['I have a headache', O('v:today', 'Today'), O('v:sudden', 'Suddenly'), O('ns', 'Not sure'), O('ns', 'Not sure')]);
  const a = analyzeRules(convInput(t));
  assert.ok(a.facts.some((f) => f.status === 'unsure'));
  assert.ok(ids(a, 'urgent').includes('thunderclap_unclear') || ids(a, 'emergency').includes('thunderclap'), a.warnings.map((w) => w.id).join());
});

test('contradictions: reported and denied; strength given but also "not sure"; later answer differs', () => {
  const t = talk('en', ['I have a headache']);
  const rec = t.rec;
  rec.denied.push('nausea'); rec.complaints.push({ ...rec.complaints[0], id: 'c9', concept: 'nausea', en: 'nausea', quote: 'nausea', regions: [], facts: {}, unknown: [], asked: [] });
  rec.complaints[0].facts.severity = { value: '9', en: '9 out of 10', prov: 'said', by: 'patient', via: 'text', confirmed: true };
  rec.complaints[0].unknown.push('severity');
  const a = analyzeRules(convInput({ ...t, rec }));
  const d = a.conflicts.map((c) => c.description).join(' | ');
  assert.match(d, /Nausea was reported and also denied/); assert.match(d, /9\/10 was given, but the patient also said they were not sure/);
});

test('body-map report: head + pain → headache; patient’s words "suddenly can’t speak properly, slurred" → emergency', () => {
  const input = { regionIds: ['head'], sensations: ['pain' as const], details: { description: 'it started suddenly and my speech is slurred' } };
  const rec = build(input);
  const report = toStructuredReport(rec, buildBrief(rec), [], 'demo-rules');
  const a = analyzeRules({ consultation: { ...input, urgentGuidanceShown: false, approved: { text: 'x', report, editedByPatient: false, approvedAt: '' } }, messages: [], documented: EMPTY_DOCUMENTED });
  assert.ok(a.facts.some((f) => f.label === 'Headache' && f.source === 'body_map'));
  assert.ok(a.facts.some((f) => f.label === 'Trouble speaking' && f.status === 'interpretation'), 'symptom found in words is an interpretation');
  assert.ok(ids(a, 'emergency').includes('headache_neuro') || ids(a, 'emergency').includes('stroke_signs'));
});

test('answers after sending close missing items; open questions are "asked"; a YES to a several-symptom question is treated conservatively', () => {
  const t = talk('en', ['I have a headache since yesterday', O('v:gradual', 'Gradually')]);
  const q1: Message = { id: 'q1', consultationId: 'c', senderId: 'd', senderRole: 'doctor', body: 'Do you have a fever or a stiff neck?', kind: 'clarification', createdAt: '1', meta: { itemKey: 'clinical:headache:fever_neck', itemLabel: 'Fever or a stiff neck', format: 'yes_no', options: ['Yes', 'No'] } };
  const q2: Message = { id: 'q2', consultationId: 'c', senderId: 'd', senderRole: 'doctor', body: 'Along with the headache, do you have trouble speaking, weakness, or numbness in your face, arm or leg?', kind: 'clarification', createdAt: '2', meta: { itemKey: 'clinical:headache:neuro', itemLabel: 'Trouble speaking, weakness or numbness', format: 'yes_no' } };
  const a1 = analyzeRules(convInput(t, true, [q1, q2]));
  assert.equal(a1.missing.find((m) => m.id === 'headache:neuro')!.status, 'asked');
  const ans = (id: string, raw: string, reply: string): Message => ({ id, consultationId: 'c', senderId: 'p', senderRole: 'patient', body: raw, kind: 'clarification_answer', createdAt: '3', meta: { replyTo: reply, raw, approvedByPatient: true, itemKey: reply === 'q1' ? 'clinical:headache:fever_neck' : 'clinical:headache:neuro' } });
  const a2 = analyzeRules(convInput(t, true, [q1, q2, ans('a1', 'No', 'q1'), ans('a2', 'Yes', 'q2')]));
  assert.ok(!a2.missing.some((m) => m.id === 'headache:fever_neck' || m.id === 'headache:neuro'));
  assert.ok(a2.facts.some((f) => f.source === 'clarification' && /answered after sending/.test(f.value)));
  assert.ok(ids(a2, 'emergency').includes('headache_neuro'), 'yes to "trouble speaking, weakness or numbness" with a headache → emergency');
  assert.ok(a2.warnings.some((w) => w.id.startsWith('interp:')), 'which of the symptoms is unclear → marked as interpretation for the doctor');
});

// ---------------------------------------------------------------- AI (validated)
test('AI: only consented reports are sent; malformed/unsafe output is dropped; refs only from the catalog; AI can add but not remove warnings', async () => {
  const t = talk('en', ['I have a headache since yesterday', O('v:gradual', 'Gradually')]);
  let calls = 0;
  const no = await analyze(convInput(t, false), async () => { calls++; return { json: {} }; });
  assert.equal(no.ai.status, 'not_consented'); assert.equal(calls, 0, 'no AI call without the patient’s consent');
  const base = analyzeRules(convInput(t));
  assert.ok(analysisPrompt(base).startsWith(PROMPT_PREFIX));
  const f1 = base.facts[0].id;
  const out = applyAI(base, {
    considerations: [
      { title: 'Tension-type headache to evaluate', supporting: [f1], missing: ['neuro screen'], uncertainty: 'Limited history.', refs: ['nhs_headache', 'made_up_guideline_2025'] },
      { title: 'Migraine (80% likely)', supporting: [f1] },                 // probability → dropped
      { title: 'Something with no evidence', supporting: ['F999'] },        // invented fact → dropped
      { title: 'Start ibuprofen 400 mg', supporting: [f1] },                // dose → dropped
    ],
    next_steps: [{ kind: 'examination', text: 'Neurological examination', why: 'Headache reported', supporting: [f1] }, { kind: 'other', text: 'Reassure', why: 'nothing serious', supporting: [f1] }],
    extra_warnings: [{ title: 'Worsening pattern', why: 'x', evidence: [f1] }],
  });
  assert.equal(out.considerations.length, 1); assert.deepEqual(out.considerations[0].refs, ['nhs_headache']);
  assert.equal(out.nextSteps.filter((s) => s.by === 'ai').length, 1);
  assert.equal(out.ai.rejected, 4);
  assert.ok(out.warnings.some((w) => w.by === 'ai' && w.level === 'urgent'));
  assert.ok(base.warnings.every((w) => out.warnings.some((x) => x.id === w.id)), 'rule warnings are kept');
  const bad = await analyze(convInput(t), async () => ({ json: 'not json' }));
  assert.equal(bad.ai.status, 'failed');
  const err = await analyze(convInput(t), async () => ({ error: 'AI service 502' }));
  assert.equal(err.ai.status, 'failed'); assert.match(err.ai.error!, /502/);
});

// ---------------------------------------------------------------- medication options
const label = (generic: string, extra: Record<string, unknown> = {}) => ({ set_id: `set-${generic}`, effective_time: '20260101', openfda: { generic_name: [generic.toUpperCase()], brand_name: ['Brand'], product_type: ['HUMAN PRESCRIPTION DRUG'], substance_name: [generic.toUpperCase()], pharm_class_epc: extra.cls ?? [] }, contraindications: [extra.ci ?? 'Known hypersensitivity.'], drug_interactions: [extra.di ?? 'No interaction text.'], ...extra });
function fakeFda(labels: Record<string, Record<string, unknown>>, down = false) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    if (down) throw new TypeError('Failed to fetch');
    const g = decodeURIComponent(String(url).match(/generic_name:%22([^%]+)%22/)![1]);
    const l = labels[g];
    return l ? new Response(JSON.stringify({ results: [l] }), { status: 200 }) : new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
  }) as unknown as typeof fetch;
  return { src: { base: 'https://fda.test', fetch: f }, urls };
}

test('medication options: withheld until age, allergies and medicines are documented; FDA label required; allergy class conflict removed; no doses; patient data never sent to FDA', async () => {
  const t = talk('en', ['my knee hurts since last week', O('v:moderate', 'Moderate')]);
  const a = analyzeRules(convInput(t));
  const ai = async () => ({ json: { withhold: false, options: [
    { generic: 'naproxen', reason: 'Knee pain reported by the patient', supporting: [a.facts[0].id], checks: ['kidney function'] },
    { generic: 'amoxicillin', reason: 'test option', supporting: [a.facts[0].id], checks: [] },
    { generic: 'unknownium', reason: 'test', supporting: [a.facts[0].id], checks: [] },
    { generic: 'ibuprofen 400 mg', reason: 'dose given', supporting: [a.facts[0].id], checks: [] },
  ] } });
  const gated = await suggestMeds(a, EMPTY_DOCUMENTED, true, ai, fakeFda({}).src);
  assert.equal(gated.status, 'withheld');
  assert.ok(gated.reasons.some((r) => /Allergies are not documented/.test(r)) && gated.reasons.some((r) => /Age is not documented/.test(r)));
  const d = doc({ age: '45', sex: 'male', allergies: { status: 'listed', items: ['penicillin'] }, medications: { status: 'listed', items: ['warfarin'] } });
  const fda = fakeFda({ naproxen: label('naproxen', { di: 'Anticoagulants such as warfarin: increased bleeding risk.' }), amoxicillin: label('amoxicillin', { cls: ['Penicillin-class Antibacterial [EPC]'] }) });
  const m = await suggestMeds(a, d, true, ai, fda.src);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.options.map((o) => o.generic), ['naproxen']);
  const nap = m.options[0];
  assert.equal(nap.verification, 'label_found'); assert.match(nap.label!.url, /^https:\/\/dailymed\.nlm\.nih\.gov\//);
  assert.equal(nap.label!.interactionMentions[0].term, 'warfarin');
  assert.ok(m.reasons.some((r) => /amoxicillin removed: it matches a documented allergy/.test(r)));
  assert.deepEqual(m.unverified, ['unknownium']);
  assert.ok(fda.urls.every((u) => !/knee|warfarin|penicillin|45/.test(u.replace(/generic_name:%22[^%]+%22/, ''))), 'only the medicine name goes to openFDA');
  const down = await suggestMeds(a, d, true, ai, fakeFda({}, true).src);
  assert.equal(down.status, 'unavailable'); assert.equal(down.options.length, 0, 'nothing is shown unchecked');
  const withhold = await suggestMeds(a, d, true, async () => ({ json: { withhold: true, reason: 'Examination needed first.' } }), fda.src);
  assert.equal(withhold.status, 'withheld'); assert.match(withhold.reasons[0], /Examination needed first/);
  const noConsent = await suggestMeds(a, d, false, ai, fda.src);
  assert.equal(noConsent.status, 'withheld');
});

// ---------------------------------------------------------------- prescriptions & storage
test('prescriptions: only doctors can send them, and only with a doctor approval; patients cannot forge one', () => {
  assert.equal(messageKindFor('patient', 'prescription'), 'text');
  assert.equal(messageKindFor('doctor', 'prescription'), 'prescription');
  const rx = { id: 'rx1', medication: 'naproxen', dose: '1 tablet', route: 'oral', frequency: 'twice daily', duration: '5 days', instructions: 'with food', approvedAt: '2026-10-23T10:00:00Z', approvedBy: 'Dr X' };
  assert.ok(cleanRxMeta(rx));
  assert.equal(cleanRxMeta({ ...rx, approvedAt: '' }), undefined, 'not approved → not a prescription');
  assert.throws(() => requireValidRx('prescription', cleanMeta({ rx: { ...rx, approvedBy: '' } }, 'prescription')), /approves/);
  assert.equal(readKind('prescription', undefined), 'text');
  assert.equal(cleanRxMeta({ ...rx, labelUrl: 'https://evil.example/x' })!.labelUrl, undefined);
});

const pw = 'correct-horse-1';
test('local backend: review is private to the doctor; prescription reaches the patient through messages; consent is recorded by the backend', async () => {
  const b = new LocalDemoBackend(new MemoryStore(), 1000);
  const d = await b.signUp({ role: 'doctor', fullName: 'Dr Rx', email: 'rx@x.co', password: pw }); await b.signOut();
  await b.signUp({ role: 'patient', fullName: 'Pat Rx', email: 'p@x.co', password: pw });
  const me = await b.restoreSession();
  await b.savePreferences({ ...me!.preferences, aiAssist: true });
  await b.connectToDoctor(d.doctor!.doctorId);
  const c = await b.createConsultation();
  await b.approveAndShare(c.id, { text: 'Knee pain since last week', report: { ...emptyReport(), aiConsent: false }, editedByPatient: false });
  await assert.rejects(b.getClinicalReview(c.id), (e: any) => e.code === 'forbidden' || e.code === 'wrong_role' || /doctor/i.test(e.message));
  await assert.rejects(b.sendMessage(c.id, 'fake rx', 'prescription', { rx: { id: 'r', medication: 'x', dose: 'y', route: '', frequency: '', duration: '', instructions: '', approvedAt: 'now', approvedBy: 'me' } }).then((m) => { if (m.kind === 'prescription') throw new Error('forged'); throw Object.assign(new Error('downgraded'), { code: 'downgraded' }); }), (e: any) => e.code === 'downgraded');
  await b.signOut();
  await b.signIn({ email: 'rx@x.co', password: pw });
  const v = await b.getConsultation(c.id);
  assert.equal(v.consultation.approved!.report.aiConsent, true, 'the backend records the patient’s real consent, not what the screen sent');
  const r = await b.getClinicalReview(c.id);
  r.documented.allergies = { status: 'none_known', items: [] };
  r.decisions.AC1 = { status: 'rejected', at: 'now' };
  r.log.push({ at: 'now', action: 'decision', detail: 'AC1 rejected' });
  await b.saveClinicalReview(c.id, r);
  const again = await b.getClinicalReview(c.id);
  assert.equal(again.documented.allergies.status, 'none_known'); assert.equal(again.decisions.AC1.status, 'rejected');
  await assert.rejects(b.sendMessage(c.id, 'Prescription', 'prescription', {}), /approves/);
  await b.sendMessage(c.id, 'Prescription: naproxen', 'prescription', { rx: { id: 'rx1', medication: 'naproxen', dose: '1 tablet', route: 'oral', frequency: 'twice daily', duration: '5 days', instructions: 'with food', approvedAt: '2026-10-23T10:00:00Z', approvedBy: 'Dr Rx' } });
  await b.signOut();
  await b.signIn({ email: 'p@x.co', password: pw });
  const msgs = await b.listMessages(c.id);
  const p = msgs.find((m) => m.kind === 'prescription')!;
  assert.equal(p.meta!.rx!.medication, 'naproxen'); assert.equal(p.senderRole, 'doctor');
  assert.equal(cleanReview({ junk: true }, 'x').prescriptions.length, 0);
  assert.equal(newReview('x').documented.allergies.status, 'unknown');
});

const device = (): SessionStore => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) }; };
test('cloud backend: clinical review is encrypted and readable only by that doctor; prescriptions are pair-encrypted', async () => {
  const cloud = new MockCloud();
  const mk = (uid: string) => { const c = cloud.clientFor(uid); return new CloudBackend(c.db, c.user, { iterations: 1000, sessionStore: device() }); };
  const doc1 = mk('u-d'); const d = await doc1.signUp({ role: 'doctor', fullName: 'Dr. Cloud', password: 'doctor-pass-1' });
  const pat = mk('u-p'); await pat.signUp({ role: 'patient', fullName: 'Cloud Patient', password: 'patient-pass-1' });
  await pat.connectToDoctor(d.doctor!.doctorId);
  const c = await pat.createConsultation();
  await pat.approveAndShare(c.id, { text: 'Headache since yesterday', report: emptyReport(), editedByPatient: false });
  const r = await doc1.getClinicalReview(c.id);
  r.documented.medications = { status: 'listed', items: ['metformin-secret'] };
  await doc1.saveClinicalReview(c.id, r);
  assert.ok(!JSON.stringify([...cloud.store.values()]).includes('metformin-secret'), 'stored encrypted');
  assert.deepEqual((await doc1.getClinicalReview(c.id)).documented.medications.items, ['metformin-secret']);
  await assert.rejects(pat.getClinicalReview(c.id));
  await doc1.sendMessage(c.id, 'Prescription', 'prescription', { rx: { id: 'rx9', medication: 'paracetamol', dose: '1 tablet', route: 'oral', frequency: 'up to 3 times daily', duration: '3 days', instructions: '', approvedAt: '2026-10-23T10:00:00Z', approvedBy: 'Dr. Cloud' } });
  assert.ok(!JSON.stringify([...cloud.store.values()]).includes('paracetamol'));
  const m = (await pat.listMessages(c.id)).find((x) => x.kind === 'prescription');
  assert.equal(m?.meta?.rx?.approvedBy, 'Dr. Cloud');
});

// ---------------------------------------------------------------- follow-up and visit explanation
import { followUpFlags, cleanFollowUpAnswer, cleanFollowUp, cleanVisitSummary } from '../src/domain/clinical';
import { checkSummary, summaryPrompt } from '../src/services/clinical/visit';

test('follow-up answers: allergic-reaction signs → emergency; rash / worse → urgent; not taking → note; only patient-approved answers count', () => {
  const base = { replyTo: 'f1', feeling: 'better' as const, sideEffects: ['none'], adherence: 'yes' as const, approvedByPatient: true as const };
  assert.deepEqual(followUpFlags(base), []);
  assert.equal(followUpFlags({ ...base, sideEffects: ['swelling'] })[0].level, 'emergency');
  assert.equal(followUpFlags({ ...base, sideEffects: ['breathing'] })[0].refs[0], 'nhs_anaphylaxis');
  assert.ok(followUpFlags({ ...base, sideEffects: ['rash'] }).some((f) => f.level === 'urgent'));
  assert.ok(followUpFlags({ ...base, feeling: 'worse' }).some((f) => f.level === 'urgent'));
  assert.ok(followUpFlags({ ...base, adherence: 'no' }).some((f) => f.level === 'info'));
  assert.equal(cleanFollowUpAnswer({ ...base, approvedByPatient: false as unknown as true }), undefined);
  assert.deepEqual(cleanFollowUpAnswer({ ...base, sideEffects: ['made_up'] })!.sideEffects, ['not_sure'], 'unknown answers stay "not sure", never "none"');
  assert.equal(cleanFollowUp({ id: 'f', dueAt: 'not a date', askedBy: 'Dr' }), undefined);
  assert.equal(cleanVisitSummary({ id: 'v', text: 'x', source: 'doctor', approvedBy: '', approvedAt: 'now' }), undefined, 'needs the doctor’s approval');
  assert.equal(messageKindFor('patient', 'followup'), 'text'); assert.equal(messageKindFor('patient', 'visit_summary'), 'text');
  assert.equal(messageKindFor('doctor', 'followup_answer'), 'text'); assert.equal(messageKindFor('patient', 'followup_answer'), 'followup_answer');
  assert.throws(() => requireValidRx('followup_answer', cleanMeta({ followupAnswer: { ...base, approvedByPatient: false as unknown as true } }, 'followup_answer')));
});

test('visit explanation: AI may not add numbers or reassurance; dropped medicines and urgent-help advice are flagged for the doctor', () => {
  const src = 'Take it twice a day for 5 days. If your lips swell, call the emergency number.\n- naproxen: 1 tablet, by mouth';
  assert.ok(summaryPrompt('x', ['- naproxen: 1 tablet']).includes('plain English')); assert.ok(summaryPrompt('x', [], 'ar').includes('Egyptian Arabic'));
  assert.match((checkSummary(src, { text: 'Take naproxen twice a day for 7 days.' }) as { rejected: string }).rejected, /7/);
  assert.match((checkSummary(src, { text: 'Take naproxen twice a day for 5 days. Don’t worry, it is nothing serious.' }) as { rejected: string }).rejected, /reassurance/);
  const ok = checkSummary(src, { text: 'Take naproxen, 1 tablet, twice a day for 5 days. If your lips swell, call the emergency number.' });
  assert.ok('text' in ok && ok.warnings.length === 0, JSON.stringify(ok));
  const dropped = checkSummary(src, { text: 'Take your medicine twice a day for 5 days.' });
  assert.ok('text' in dropped && dropped.warnings.some((w) => /naproxen/.test(w)) && dropped.warnings.some((w) => /urgent help/.test(w)));
  assert.ok('rejected' in checkSummary(src, null));
});


// ---------------------------------------------------------------- Arabic (restored)
test('same rules work in Arabic (Egyptian): صداع جه فجأة + لساني تقيل', () => {
  const t = talk('ar', ['عندي صداع جه فجأة', 'ولساني تقيل']);
  const a = analyzeRules(convInput(t));
  assert.ok(ids(a, 'emergency').includes('headache_neuro'), JSON.stringify(a.warnings.map((w) => w.id)));
});
