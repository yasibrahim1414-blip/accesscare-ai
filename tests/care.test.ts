import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDose, cleanPhoto, cleanCard, cleanRecord, cleanDigest, cleanCaregiverItem, normalizeCaregiverId, CAREGIVER_ID_PATTERN, generateCaregiverId, type CareDigest } from '../src/domain/care';
import { LocalDemoBackend } from '../src/services/backend/LocalDemoBackend';
import { CloudBackend, type SessionStore } from '../src/services/backend/CloudBackend';
import type { Backend } from '../src/services/backend/Backend';
import { MemoryStore } from '../src/services/storage';
import { MockCloud } from './support/mockCloud';

const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
const dose = (status: 'taken' | 'missed' | 'side_effect', extra = {}) => ({ medicine: 'Naproxen', rxId: 'rx_1', dose: '250 mg', slot: '09:00', day: '2026-10-26', status, sideEffect: status === 'side_effect' ? 'stomach upset' : '', via: 'touch', urgent: [], ...extra });

test('care data is validated: doses, photos (JPEG only, size-capped), the emergency card, digests, caregiver items', () => {
  assert.equal(cleanDose(dose('taken'))!.status, 'taken');
  assert.equal(cleanDose({ ...dose('taken'), status: 'maybe' }), null);
  assert.equal(cleanDose({ ...dose('taken'), slot: '25:00' })!.slot, '', 'a bad time is dropped');
  assert.equal(cleanDose(dose('taken', { sideEffect: 'x' }))!.sideEffect, '', 'a side effect only on side-effect check-ins');
  assert.ok(cleanPhoto({ area: 'Left knee', note: '', image: JPEG, w: 400, h: 300 }));
  assert.equal(cleanPhoto({ image: 'data:image/png;base64,AAAA' }), null, 'only JPEG');
  assert.equal(cleanPhoto({ image: 'data:image/jpeg;base64,' + 'A'.repeat(200_000) }), null, 'size-capped');
  assert.equal(cleanPhoto({ image: 'javascript:alert(1)' }), null);
  assert.equal(cleanCard({}), null, 'an empty card is not saved');
  const c = cleanCard({ allergies: 'Penicillin', bloodType: 'o+ ', contactPhone: '+20 100 <b>123</b>' })!;
  assert.equal(c.bloodType, 'O+'); assert.equal(c.contactPhone, '+20 100 123');
  const card = cleanRecord({ id: 'x', kind: 'card', data: { allergies: 'none' }, sharedWith: 'd_1' })!;
  assert.equal(card.sharedWith, null, 'the emergency card is never shared');
  assert.equal(cleanRecord({ id: 'x', kind: 'bogus', data: {} }), null);
  const dg = cleanDigest({ patientName: 'P', updatedAt: 'now', medicines: [{ rxId: 'rx_a', name: 'A', dose: '1', times: ['09:00', 'bad'], today: [{ slot: '09:00', status: 'taken' }, { slot: '21:00', status: 'eaten' }] }], diary: [], consultations: [], alerts: [], card: null, adherence7d: { taken: 5, planned: 7 } })!;
  assert.deepEqual(dg.medicines[0].times, ['09:00']); assert.equal(dg.medicines[0].today.length, 1);
  assert.equal(cleanCaregiverItem({ id: 'a', kind: 'note', note: '' }), null);
  assert.ok(cleanCaregiverItem({ id: 'a', kind: 'dose', dose: dose('taken') }));
  const id = generateCaregiverId();
  assert.match(id, CAREGIVER_ID_PATTERN); assert.equal(normalizeCaregiverId(id.toLowerCase().replace(/-/g, ' ')), id);
});

const digest = (name: string): CareDigest => ({ patientName: name, updatedAt: new Date().toISOString(), medicines: [{ rxId: 'rx_1', name: 'Naproxen', dose: '250 mg', times: ['09:00'], today: [{ slot: '09:00', status: 'taken' }] }], adherence7d: { taken: 6, planned: 7 }, diary: [], consultations: [], alerts: [], card: { allergies: 'Penicillin', medicines: '', conditions: '', bloodType: 'O+', contactName: '', contactPhone: '', notes: '' } });

async function scenario(mk: (uid: string) => Backend, label: string, encryptedCheck?: () => string) {
  const doc = mk('u-d'); const d = await doc.signUp({ role: 'doctor', fullName: 'Dr. Care', email: 'd@x.io', password: 'doctor-pass-1' });
  const other = mk('u-o'); await other.signUp({ role: 'doctor', fullName: 'Dr. Other', email: 'o@x.io', password: 'doctor-pass-2' });
  const cg = mk('u-c'); const c = await cg.signUp({ role: 'caregiver', fullName: 'Mona Care', email: 'c@x.io', password: 'care-pass-1' });
  assert.match(c.caregiverId ?? '', CAREGIVER_ID_PATTERN, `${label}: caregivers get a Caregiver ID`);
  assert.equal(c.profile.role, 'caregiver');
  const pat = mk('u-p'); const p = await pat.signUp({ role: 'patient', fullName: 'Omar Care', email: 'p@x.io', password: 'patient-pass-1' });
  await pat.connectToDoctor(d.doctor!.doctorId);

  // records
  await pat.addRecord('dose', dose('taken'), { share: true });
  await pat.addRecord('dose', dose('side_effect', { sideEffect: 'rash-secret' }), { share: true });
  await pat.addRecord('dose', dose('missed'), { share: false });
  await pat.addRecord('photo', { area: 'Left knee', note: 'swelling', image: JPEG, w: 10, h: 10 }, { share: true });
  await pat.addRecord('card', { allergies: 'Penicillin-secret', bloodType: 'A+' }, { share: true });
  await pat.addRecord('card', { allergies: 'Penicillin-secret', bloodType: 'B+' });
  await assert.rejects(pat.addRecord('dose', { medicine: '' }), /incomplete/);
  assert.equal((await pat.listRecords('dose')).length, 3);
  const cards = await pat.listRecords('card');
  assert.equal(cards.length, 1, `${label}: one emergency card (replaced)`); assert.equal((cards[0].data as { bloodType: string }).bloodType, 'B+');
  assert.deepEqual((await doc.listRecords('dose', p.profile.id)).map((r) => (r.data as { status: string }).status).sort(), ['side_effect', 'taken'], `${label}: the doctor sees only shared check-ins`);
  assert.equal((await doc.listRecords('photo', p.profile.id)).length, 1);
  await assert.rejects(doc.listRecords('card', p.profile.id), `${label}: the doctor never reads the emergency card`);
  await assert.rejects(other.listRecords('dose', p.profile.id), `${label}: another doctor sees nothing`);
  if (encryptedCheck) assert.ok(!encryptedCheck().includes('secret'), `${label}: stored encrypted`);

  // caregiver link: the patient links by the caregiver's ID
  await assert.rejects(pat.lookupCaregiver('CG-0000-0000'), /looks like|No caregiver/);
  assert.equal((await pat.lookupCaregiver(c.caregiverId!)).name, 'Mona Care');
  assert.deepEqual(await cg.listCaredPatients(), [], `${label}: nothing before the patient links`);
  await assert.rejects(cg.caregiverAdd(p.profile.id, { kind: 'note', note: 'hi' }), /not linked/);
  const link = await pat.connectCaregiver(c.caregiverId!);
  assert.equal(link.name, 'Mona Care');
  assert.equal((await pat.listMyCaregivers()).length, 1);
  await pat.publishCareDigest(digest('Omar Care'));
  const cared = await cg.listCaredPatients();
  assert.equal(cared.length, 1); assert.equal(cared[0].name, 'Omar Care');
  assert.equal(cared[0].digest?.medicines[0].name, 'Naproxen'); assert.equal(cared[0].digest?.card?.allergies, 'Penicillin');
  await assert.rejects(cg.listRecords('dose', p.profile.id), `${label}: a caregiver cannot read raw records`);
  await assert.rejects(cg.listDiary(p.profile.id));
  // the caregiver records a dose; it reaches the patient's records marked with their name
  const item = await cg.caregiverAdd(cared[0].id, { kind: 'dose', dose: dose('taken', { slot: '21:00' }) });
  const pending = await pat.pendingCaregiverItems();
  assert.equal(pending.length, 1); assert.equal(pending[0].item.id, item.id); assert.equal(pending[0].caregiver.name, 'Mona Care');
  await pat.addRecord('dose', pending[0].item.dose, { share: true, by: 'Mona Care', id: item.id });
  assert.equal((await pat.pendingCaregiverItems()).length, 0, `${label}: imported once`);
  assert.equal((await pat.listRecords('dose')).find((r) => r.id === item.id)?.by, 'Mona Care');
  // removing the caregiver ends their access
  await pat.removeCaregiver(link.id);
  assert.deepEqual(await cg.listCaredPatients(), []);
  await assert.rejects(cg.caregiverAdd(cared[0].id, { kind: 'note', note: 'after removal' }), /not linked/);
  // disconnecting the doctor removes the doctor's copies
  await pat.disconnectDoctor();
  await assert.rejects(doc.listRecords('dose', p.profile.id));
  assert.equal((await pat.listRecords('dose')).length, 4, `${label}: the patient keeps everything`);
}

test('local demo: care records, sharing rules and caregivers', async () => {
  const store = new MemoryStore();
  const backends = new Map<string, LocalDemoBackend>();
  // one browser: each "person" signs in on their own backend object over the same store (like separate tabs)
  const mk = (uid: string) => { const b = new LocalDemoBackend(store, 1000); backends.set(uid, b); return b as Backend; };
  await scenario(mk, 'local');
});

test('cloud: care records encrypted, sharing rules and caregivers across devices', async () => {
  const cloud = new MockCloud();
  const device = (): SessionStore => { const m = new Map<string, string>(); return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) }; };
  const mk = (uid: string) => { const c = cloud.clientFor(uid); return new CloudBackend(c.db, c.user, { iterations: 1000, sessionStore: device() }) as Backend; };
  await scenario(mk, 'cloud', () => JSON.stringify([...cloud.store.values()]));
});
