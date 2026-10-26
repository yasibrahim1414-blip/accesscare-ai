import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDemoBackend } from '../src/services/backend/LocalDemoBackend';
import { MemoryStore } from '../src/services/storage';
import { DOCTOR_ID_PATTERN, generateDoctorId } from '../src/services/crypto';
import { DemoIntentBridge } from '../src/services/intentBridge/DemoIntentBridge';
import { assessSafety } from '../src/services/safety';
import { DEFAULT_PREFERENCES } from '../src/domain/types';

const fast = (store = new MemoryStore()) => new LocalDemoBackend(store, 1000);
const pw = 'correct-horse-1';

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code); return true; });
}

test('doctor IDs match format and are unique across many generations', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const id = generateDoctorId();
    assert.match(id, DOCTOR_ID_PATTERN);
    seen.add(id);
  }
  assert.ok(seen.size >= 4995);
});

test('registration validation and password hashing', async () => {
  const store = new MemoryStore();
  const b = fast(store);
  await rejects(b.signUp({ role: 'patient', fullName: 'A', email: 'a@b.co', password: pw }), 'invalid_name');
  await rejects(b.signUp({ role: 'patient', fullName: 'Ann', email: 'bad', password: pw }), 'invalid_email');
  await rejects(b.signUp({ role: 'patient', fullName: 'Ann', email: 'a@b.co', password: 'short' }), 'weak_password');
  await b.signUp({ role: 'patient', fullName: 'Ann', email: 'A@B.co', password: pw });
  await rejects(b.signUp({ role: 'doctor', fullName: 'Ann', email: 'a@b.co', password: pw }), 'email_taken');
  const raw = store.get('accesscare.db.v1')!;
  assert.ok(!raw.includes(pw), 'plain password must not be stored');
});

test('doctor ID is stable across sign out / sign in and session restore', async () => {
  const store = new MemoryStore();
  const b = fast(store);
  const me = await b.signUp({ role: 'doctor', fullName: 'Dr Who', email: 'd@x.co', password: pw });
  const id = me.doctor!.doctorId;
  assert.match(id, DOCTOR_ID_PATTERN);
  await b.signOut();
  const again = await b.signIn({ email: 'd@x.co', password: pw });
  assert.equal(again.doctor!.doctorId, id);
  const b2 = fast(store); // simulates reopening the app
  const restored = await b2.restoreSession();
  assert.equal(restored!.doctor!.doctorId, id);
  await rejects(b2.signIn({ email: 'd@x.co', password: 'wrong-password' }), 'invalid_credentials');
});

test('end-to-end: connect by Doctor ID, share approved summary, doctor reviews; isolation holds', async () => {
  const store = new MemoryStore();
  const b = fast(store);
  const doc = await b.signUp({ role: 'doctor', fullName: 'Dr One', email: 'one@x.co', password: pw });
  await b.signOut();
  const doc2 = await b.signUp({ role: 'doctor', fullName: 'Dr Two', email: 'two@x.co', password: pw });
  await b.signOut();

  await b.signUp({ role: 'patient', fullName: 'Pat', email: 'p@x.co', password: pw });
  await rejects(b.lookupDoctor('nonsense'), 'invalid_format');
  await rejects(b.lookupDoctor('AC-DOC-ZZZZZZ'), 'doctor_not_found');
  const found = await b.lookupDoctor(doc.doctor!.doctorId.toLowerCase());
  assert.equal(found.fullName, 'Dr One');
  assert.equal(await b.getMyDoctor(), null, 'lookup alone must not connect');
  await b.connectToDoctor(doc.doctor!.doctorId);
  await rejects(b.connectToDoctor(doc.doctor!.doctorId), 'already_connected');
  await rejects(b.connectToDoctor(doc2.doctor!.doctorId), 'has_doctor');
  await rejects(b.setStatus('x', 'completed'), 'forbidden');
  await rejects(b.listMyPatients(), 'forbidden');

  const c = await b.createConsultation();
  await b.updateDraft(c.id, { regionIds: ['forearm_l', 'bogus'], sensations: ['numbness'], details: {} });
  const draft = await b.getConsultation(c.id);
  assert.deepEqual(draft.consultation.regionIds, ['forearm_l']);
  await rejects(b.sendMessage(c.id, 'hi'), 'not_shared');
  await b.approveAndShare(c.id, { text: 'Patient-approved text', report: { regions: [], sensations: [], fields: [], clarifications: [], flags: [], generatedBy: 'demo-rules' }, editedByPatient: true });
  await rejects(b.updateDraft(c.id, { regionIds: [] }), 'locked');
  await b.sendMessage(c.id, 'Hello doctor');
  await b.signOut();

  // unrelated doctor sees nothing
  await b.signIn({ email: 'two@x.co', password: pw });
  assert.equal((await b.listConsultations()).length, 0);
  assert.equal((await b.listMyPatients()).length, 0);
  await rejects(b.getConsultation(c.id), 'not_found');
  await rejects(b.addNote(c.id, 'snoop'), 'not_found');
  await b.signOut();

  // connected doctor reviews
  await b.signIn({ email: 'one@x.co', password: pw });
  const stats = await b.doctorStats();
  assert.deepEqual(stats, { connectedPatients: 1, newCount: 1, inReviewCount: 0, completedCount: 0 });
  const v = await b.getConsultation(c.id);
  assert.equal(v.consultation.approved!.text, 'Patient-approved text');
  await b.addNote(c.id, 'Private note');
  await b.setStatus(c.id, 'in_review');
  await b.sendMessage(c.id, 'Is it worse at night?', 'yes_no_question');
  await rejects(b.setStatus(c.id, 'draft'), 'invalid');
  await b.signOut();

  // patient: status persisted, notes hidden, messages visible
  const b3 = fast(store);
  await b3.signIn({ email: 'p@x.co', password: pw });
  const pv = await b3.getConsultation(c.id);
  assert.equal(pv.consultation.status, 'in_review');
  await rejects(b3.listNotes(c.id), 'forbidden');
  const msgs = await b3.listMessages(c.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].kind, 'yes_no_question');

  // disconnect revokes doctor access
  await b3.disconnectDoctor();
  await b3.signOut();
  await b3.signIn({ email: 'one@x.co', password: pw });
  await rejects(b3.getConsultation(c.id), 'not_found');
});

test('Intent Bridge asks only for missing info and never invents details', async () => {
  const bridge = new DemoIntentBridge();
  const input = { regionIds: ['upper_arm_l'], sensations: ['numbness' as const], details: {} };
  const qs = await bridge.generateQuestions(input, DEFAULT_PREFERENCES);
  const ids = qs.map((q) => q.id);
  assert.ok(ids.includes('onset') && ids.includes('pattern') && ids.includes('extent'));
  // patient skips onset, answers pattern
  const answers = [
    { questionId: 'onset', question: 'When?', status: 'skipped' as const },
    { questionId: 'pattern', question: 'Constant?', status: 'answered' as const, value: 'Comes and goes' },
    { questionId: 'extent', question: 'Where?', status: 'unsure' as const },
  ];
  const report = bridge.buildReport(input, answers);
  const f = (l: string) => report.fields.find((x) => x.label === l)!;
  assert.equal(f('Onset').value, 'Not specified');
  assert.equal(f('Onset').status, 'unanswered');
  assert.equal(f('Pattern').value, 'Comes and goes');
  assert.equal(f('Extent').status, 'unsure');
  const text = bridge.renderSummary(report, DEFAULT_PREFERENCES);
  assert.match(text, /Left upper arm/);
  assert.match(text, /Onset: Not specified/);
  assert.doesNotMatch(text, /\d+ (days|hours|weeks)/, 'no invented duration');
  assert.match(text, /not a diagnosis/);

  // already-provided details are not asked again
  const qs2 = await bridge.generateQuestions({ regionIds: ['chest'], sensations: ['pain'], details: { onset: 'Today', pattern: 'constant', severity: 4, description: 'dull' } }, DEFAULT_PREFERENCES);
  assert.deepEqual(qs2.map((q) => q.id), []);

  // contradiction detection
  const qs3 = await bridge.generateQuestions({ regionIds: ['knee_l', 'knee_r'], sensations: ['pain', 'not_sure'], details: { pattern: 'constant', description: 'it comes and goes' } }, DEFAULT_PREFERENCES);
  const ids3 = qs3.map((q) => q.id);
  assert.ok(ids3.includes('pattern_conflict') && ids3.includes('confirm_sensation') && ids3.includes('both_sides'));

  // yes/no only preference converts formats
  const qs4 = await bridge.generateQuestions(input, { ...DEFAULT_PREFERENCES, multipleChoice: false, yesNoQuestions: true });
  assert.ok(qs4.filter((q) => q.id !== 'anything_else').every((q) => q.format === 'yes_no'));
});

test('emergency rules flag urgent situations and do not flag ordinary ones', () => {
  assert.equal(assessSafety({ regionIds: ['knee_l'], sensations: ['pain'], details: { severity: 3 } }).urgent, false);
  assert.equal(assessSafety({ regionIds: [], sensations: [], details: {}, redFlags: ['breathing'] }).urgent, true);
  assert.equal(assessSafety({ regionIds: ['chest'], sensations: ['pain'], details: { description: 'pressure in my chest' } }).urgent, true);
  assert.equal(assessSafety({ regionIds: ['forearm_l'], sensations: ['weakness'], details: { onset: 'Today' } }).urgent, true);
  assert.equal(assessSafety({ regionIds: ['chest'], sensations: ['itching'], details: {} }).suggestCheck, true);
});

test('local: patient without email signs in with Patient ID + password; recovery code resets it once', async () => {
  const b = fast();
  const me = await b.signUp({ role: 'patient', fullName: 'Blind Patient', password: 'first-pass-1' });
  const pid = me.profile.patientCode!;
  assert.match(pid, /^AC-PAT-/); assert.equal(me.profile.email, '');
  const code = await b.createRecoveryCode!();
  await b.signOut();
  await rejects(b.signIn({ email: pid, password: 'wrong-pass-1' }), 'invalid_credentials');
  assert.equal((await b.signIn({ email: pid.toLowerCase().replace(/-/g, ' '), password: 'first-pass-1' })).profile.id, me.profile.id);
  await b.signOut();
  await rejects(b.recoverAccount!({ login: pid, recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', newPassword: 'second-pass-2' }), 'invalid_credentials');
  await b.recoverAccount!({ login: pid, recoveryCode: code, newPassword: 'second-pass-2' });
  await b.signOut();
  await rejects(b.signIn({ email: pid, password: 'first-pass-1' }), 'invalid_credentials');
  assert.ok(await b.signIn({ email: pid, password: 'second-pass-2' }));
  await b.signOut();
  await rejects(b.recoverAccount!({ login: pid, recoveryCode: code, newPassword: 'third-pass-3' }), 'invalid_credentials');
});
