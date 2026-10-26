import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudBackend, type SessionStore } from '../src/services/backend/CloudBackend';
import { MockCloud } from './support/mockCloud';
import { DOCTOR_ID_PATTERN } from '../src/services/crypto';
import { DemoIntentBridge } from '../src/services/intentBridge/DemoIntentBridge';
import { DEFAULT_PREFERENCES } from '../src/domain/types';

const PW = 'doctor-pass-9';
const device = (): SessionStore => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) }; };
const backendFor = (cloud: MockCloud, uid: string, store = device()) => {
  const c = cloud.clientFor(uid);
  return { b: new CloudBackend(c.db, c.user, { iterations: 1000, sessionStore: store }), store };
};
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; });
}

test('cloud: full cross-device patient → doctor workflow with encryption and isolation', async () => {
  const cloud = new MockCloud();

  // 1-2. doctor signs up on device A, gets a Doctor ID
  const { b: docA } = backendFor(cloud, 'u-doctor');
  const doc = await docA.signUp({ role: 'doctor', fullName: 'Dr. Layla Hassan', password: PW, specialty: 'Neurology' });
  const doctorId = doc.doctor!.doctorId;
  assert.match(doctorId, DOCTOR_ID_PATTERN);
  await rejects(docA.signUp({ role: 'doctor', fullName: 'Dup', password: PW }), 'email_taken');

  // 3-5. logs out, logs in on device B: same ID; wrong password rejected
  await docA.signOut();
  await rejects(docA.listMyPatients(), 'unauthenticated');
  const { b: docB, store: docBStore } = backendFor(cloud, 'u-doctor');
  await rejects(docB.signIn({ role: 'doctor', password: 'wrong-pass' }), 'invalid_credentials');
  assert.equal((await docB.signIn({ role: 'doctor', password: PW })).doctor!.doctorId, doctorId);
  // session persists across a reload on device B
  const { b: docB2 } = backendFor(cloud, 'u-doctor', docBStore);
  assert.equal((await docB2.restoreSession())!.doctor!.doctorId, doctorId);
  // a different device without a session is not signed in
  assert.equal(await backendFor(cloud, 'u-doctor').b.restoreSession(), null);

  // 6-8. patient on another device connects with the Doctor ID
  const { b: pat } = backendFor(cloud, 'u-patient');
  await pat.signUp({ role: 'patient', fullName: 'Mariam Saleh', password: 'patient-pass-1' });
  await rejects(pat.lookupDoctor('AC-DOC-ZZZZZZ'), 'doctor_not_found');
  const info = await pat.lookupDoctor(doctorId.toLowerCase());
  assert.equal(info.fullName, 'Dr. Layla Hassan');
  assert.equal(await pat.getMyDoctor(), null, 'lookup alone must not connect');
  await pat.connectToDoctor(doctorId);
  await rejects(pat.connectToDoctor(doctorId), 'already_connected');
  assert.equal((await pat.getMyDoctor())!.doctorId, doctorId);
  await rejects(pat.listMyPatients(), 'forbidden');

  // doctor sees the connected patient from device B
  const pats = await docB.listMyPatients();
  assert.equal(pats.length, 1);
  assert.equal(pats[0].profile.fullName, 'Mariam Saleh');

  // 9-10. patient builds and approves a report
  const bridge = new DemoIntentBridge();
  const c = await pat.createConsultation();
  await pat.updateDraft(c.id, { regionIds: ['forearm_l'], sensations: ['numbness'], details: {} });
  const input = { regionIds: ['forearm_l'], sensations: ['numbness' as const], details: {} };
  const report = bridge.buildReport(input, [{ questionId: 'onset', question: 'When?', status: 'skipped' }]);
  const text = bridge.renderSummary(report, DEFAULT_PREFERENCES) + '\nWorse in the morning.';
  assert.equal((await docB.listConsultations()).length, 0, 'drafts are private to the patient');
  await pat.approveAndShare(c.id, { text, report, editedByPatient: true });
  await rejects(pat.updateDraft(c.id, { regionIds: [] }), 'locked');
  await pat.sendMessage(c.id, 'Hello doctor');

  // raw database contains no readable health data
  const raw = JSON.stringify([...cloud.store.values()]);
  for (const secret of ['Worse in the morning', 'Numbness', 'forearm_l', 'Mariam Saleh', 'Hello doctor']) {
    assert.ok(!raw.includes(secret), `"${secret}" must not be stored in plain text`);
  }

  // 11-12. doctor reviews and updates the status
  const stats = await docB.doctorStats();
  assert.deepEqual(stats, { connectedPatients: 1, newCount: 1, inReviewCount: 0, completedCount: 0 });
  const v = await docB.getConsultation(c.id);
  assert.equal(v.consultation.approved!.text, text);
  assert.deepEqual(v.consultation.regionIds, ['forearm_l']);
  await docB.addNote(c.id, 'Private note');
  await docB.setStatus(c.id, 'in_review');
  await docB.sendMessage(c.id, 'Does it wake you at night?', 'yes_no_question');

  // 13-14. patient sees the update from their own device; notes are not reachable
  const pv = await pat.getConsultation(c.id);
  assert.equal(pv.consultation.status, 'in_review');
  await rejects(pat.listNotes(c.id), 'forbidden');
  const msgs = await pat.listMessages(c.id);
  assert.deepEqual(msgs.map((m) => [m.senderRole, m.kind]), [['patient', 'text'], ['doctor', 'yes_no_question']]);
  const hist = await pat.statusHistory(c.id);
  assert.deepEqual(hist.map((h) => h.to), ['draft', 'new', 'in_review']);

  // an unrelated doctor and a curious third user can't see or forge anything
  const { b: other } = backendFor(cloud, 'u-other');
  await other.signUp({ role: 'doctor', fullName: 'Dr. Other', password: PW });
  assert.equal((await other.listMyPatients()).length, 0);
  assert.equal((await other.listConsultations()).length, 0);
  await rejects(other.getConsultation(c.id), 'not_found');
  const snoop = cloud.clientFor('u-other').db;
  assert.equal((await snoop.doc('data/users/u-patient/patient').get()).exists, false, 'private account is invisible');
  await assert.rejects(snoop.doc(`doc/u-doctor/s/${c.id}`).set({ status: 'completed' }), 'cannot write another doctor’s status');
  await assert.rejects(snoop.doc('pat/u-patient').update({ doctorUid: 'u-other' }), 'cannot hijack a connection');
  // forged link written into the other user's own patient record is ignored by the doctor (not decryptable)
  const { b: forger } = backendFor(cloud, 'u-forger');
  await forger.signUp({ role: 'patient', fullName: 'Forger', password: PW });
  await cloud.clientFor('u-forger').db.doc('pat/u-forger').update({ doctorUid: 'u-doctor', linkActive: true, sealedLink: { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' } });
  assert.equal((await docB.listMyPatients()).length, 1, 'forged connection not accepted');

  // 15. both log out and back in: data persists
  await pat.signOut(); await docB.signOut();
  const { b: pat2 } = backendFor(cloud, 'u-patient');
  await pat2.signIn({ role: 'patient', password: 'patient-pass-1' });
  assert.equal((await pat2.listConsultations())[0].consultation.status, 'in_review');
  const { b: doc3 } = backendFor(cloud, 'u-doctor');
  await doc3.signIn({ role: 'doctor', password: PW });
  assert.equal((await doc3.listNotes(c.id))[0].body, 'Private note');

  // disconnect revokes the doctor's copy; the patient keeps theirs
  await pat2.disconnectDoctor();
  assert.equal((await doc3.listMyPatients()).length, 0);
  await rejects(doc3.getConsultation(c.id), 'not_found');
  assert.equal((await pat2.getConsultation(c.id)).consultation.approved!.text, text);
  const sharedDoc = cloud.store.get(`pat/u-patient/c/${c.id}`)!;
  assert.equal(sharedDoc.sealed, null, 'doctor-readable ciphertext removed on disconnect');
});

test('cloud: one Claude account can hold a patient and a doctor account separately', async () => {
  const cloud = new MockCloud();
  const { b } = backendFor(cloud, 'u-solo');
  const d = await b.signUp({ role: 'doctor', fullName: 'Dr. Solo', password: PW });
  await b.signOut();
  await b.signUp({ role: 'patient', fullName: 'Solo Patient', password: 'other-pass-1' });
  assert.deepEqual((await b.authInfo()).existingRoles!.sort(), ['doctor', 'patient']);
  await b.connectToDoctor(d.doctor!.doctorId);
  await b.signOut();
  await rejects(b.signIn({ role: 'doctor', password: 'other-pass-1' }), 'invalid_credentials');
  await b.signIn({ role: 'doctor', password: PW });
  assert.equal((await b.listMyPatients())[0].profile.fullName, 'Solo Patient');
});

test('cloud: doctor ending a connection removes access on both sides', async () => {
  const cloud = new MockCloud();
  const { b: doc } = backendFor(cloud, 'd1');
  const me = await doc.signUp({ role: 'doctor', fullName: 'Dr. A', password: PW });
  const { b: pat } = backendFor(cloud, 'p1');
  await pat.signUp({ role: 'patient', fullName: 'Pat', password: PW });
  await pat.connectToDoctor(me.doctor!.doctorId);
  const [p] = await doc.listMyPatients();
  await doc.disconnectPatient(p.profile.id);
  assert.equal((await doc.listMyPatients()).length, 0);
  assert.equal(await pat.getMyDoctor(), null);
  await pat.connectToDoctor(me.doctor!.doctorId); // can reconnect later
  assert.equal((await doc.listMyPatients()).length, 1);
});

test('cloud: account deletion removes the user’s records', async () => {
  const cloud = new MockCloud();
  const { b } = backendFor(cloud, 'p9');
  await b.signUp({ role: 'patient', fullName: 'Del Me', password: PW });
  await b.createConsultation();
  await rejects(b.deleteAccount('nope-nope'), 'invalid_credentials');
  await b.deleteAccount(PW);
  assert.equal([...cloud.store.keys()].filter((k) => k.includes('p9')).length, 0);
});

test('cloud: Patient ID and recovery code keep encrypted data after a password reset (any device)', async () => {
  const cloud = new MockCloud();
  const { b } = backendFor(cloud, 'u-blind');
  const me = await b.signUp({ role: 'patient', fullName: 'Blind Patient', password: 'first-pass-1' });
  assert.match(me.profile.patientCode!, /^AC-PAT-[2-9A-HJKMNP-Z]{6}$/);
  await b.savePreferences({ ...me.preferences, blind: { enabled: true, lang: 'en', rate: 1.2, guidance: 'brief', navigation: 'gestures', gestures: { swipeRight: 'next', swipeLeft: 'previous', doubleTap: 'activate', longPress: 'describe' }, announce: 'all', input: 'voice', autoListen: true } });
  const code = await b.createRecoveryCode!();
  await b.signOut();
  // the Patient ID alone never signs in; a wrong recovery code is refused
  const { b: other } = backendFor(cloud, 'u-blind');
  await rejects(other.signIn({ role: 'patient', password: me.profile.patientCode! }), 'invalid_credentials');
  await rejects(other.recoverAccount!({ role: 'patient', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'second-pass-2' }), 'invalid_credentials');
  const back = await other.recoverAccount!({ role: 'patient', recoveryCode: code.toLowerCase(), newPassword: 'second-pass-2' });
  assert.equal(back.profile.patientCode, me.profile.patientCode);
  assert.equal(back.preferences.blind?.rate, 1.2, 'encrypted preferences survive the reset');
  await other.signOut();
  await rejects(other.signIn({ role: 'patient', password: 'first-pass-1' }), 'invalid_credentials');
  assert.ok(await other.signIn({ role: 'patient', password: 'second-pass-2' }));
  await other.signOut();
  await rejects(other.recoverAccount!({ role: 'patient', recoveryCode: code, newPassword: 'third-pass-3' }), 'invalid_credentials'); // single use
  // another Claude account cannot use it
  await rejects(backendFor(cloud, 'u-someone').b.recoverAccount!({ role: 'patient', recoveryCode: code, newPassword: 'x-pass-1234' }), 'invalid_credentials');
});
