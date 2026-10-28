import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import worker, { __resetMemoryDb } from '../server/cloudflare-worker.mjs';
import { WebSyncBackend, uidFor, type Identity } from '../src/services/backend/WebSyncBackend';
import type { SessionStore } from '../src/services/backend/CloudBackend';
import { DemoIntentBridge } from '../src/services/intentBridge/DemoIntentBridge';
import { DEFAULT_PREFERENCES } from '../src/domain/types';

// the real worker code, with its test-only memory store, answers the app's requests
const env = { MEMORY_DB: '1', ALLOWED_ORIGINS: '*' };
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (!String(url).startsWith('https://w.test/')) return realFetch(url, init);
  calls++;
  return worker.fetch(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin: 'https://app.test' } }), env);
}) as typeof fetch;

// a "device": its own session storage and its own remembered identity
const device = () => {
  const m = new Map<string, string>(); let ident: Identity | null = null;
  const sessionStore: SessionStore = { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) };
  const identity = { get: () => ident, set: (v: Identity | null) => { ident = v; } };
  return () => new WebSyncBackend('https://w.test/ai', { iterations: 1000, sessionStore, identity, pollMs: 50 });
};
async function rejects(p: Promise<unknown>, code: string) { await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); return true; }); }

test('website sync: doctor and patient on different devices — the prescription reaches the patient; encrypted; isolated', async () => {
  __resetMemoryDb();
  const docPhone = device(), patPhone = device(), patLaptop = device(), strangerPhone = device();
  const doc = docPhone();
  const d = await doc.signUp({ role: 'doctor', fullName: 'Dr. Layla Hassan', email: 'Layla@Clinic.example', password: 'doctor-pass-1' });
  await rejects(docPhone().signUp({ role: 'doctor', fullName: 'Dup', email: 'layla@clinic.example', password: 'whatever-123' }), 'email_taken');

  // patient signs up WITHOUT email: logs in with the Patient ID
  const pat = patPhone();
  const p = await pat.signUp({ role: 'patient', fullName: 'Omar Adel', password: 'patient-pass-1' });
  assert.match(p.profile.patientCode ?? '', /^AC-PAT-[A-Z0-9]{6}$/);
  await pat.connectToDoctor(d.doctor!.doctorId);
  const bridge = new DemoIntentBridge();
  const c = await pat.createConsultation();
  await pat.updateDraft(c.id, { regionIds: ['knee_l'], sensations: ['pain'], details: {} });
  const report = bridge.buildReport({ regionIds: ['knee_l'], sensations: ['pain'], details: {} }, []);
  await pat.approveAndShare(c.id, { text: bridge.renderSummary(report, DEFAULT_PREFERENCES) + '\nsecret-knee-words', report, editedByPatient: true });

  // the doctor (another device) sees it and sends a prescription
  assert.equal((await doc.listConsultations()).length, 1);
  const rx = { id: 'rx_1', medication: 'Naproxen', dose: '250 mg', route: 'by mouth', frequency: 'twice daily', duration: '5 days', instructions: 'with food', approvedAt: new Date().toISOString(), approvedBy: 'Dr. Layla Hassan' };
  await doc.sendMessage(c.id, 'Prescription: Naproxen 250 mg', 'prescription', { rx });

  // the patient's phone receives it — and so does the patient's laptop after logging in with the Patient ID
  const got = (await pat.listMessages(c.id)).find((m) => m.kind === 'prescription');
  assert.equal(got?.meta?.rx?.medication, 'Naproxen');
  const lap = patLaptop();
  await rejects(lap.signIn({ email: p.profile.patientCode, password: 'wrong-password' }), 'invalid_credentials');
  const me2 = await lap.signIn({ email: p.profile.patientCode!.toLowerCase(), password: 'patient-pass-1' });
  assert.equal(me2.profile.fullName, 'Omar Adel');
  assert.equal((await lap.listMessages(c.id)).filter((m) => m.kind === 'prescription').length, 1);
  // the doctor logs in by email on a new device (any letter case)
  const doc2 = docPhone();
  assert.equal((await doc2.signIn({ email: 'LAYLA@clinic.example', password: 'doctor-pass-1' })).doctor!.doctorId, d.doctor!.doctorId);

  // live updates: a change on one device reaches the other
  let fired = 0;
  const unsub = pat.onChange(() => { fired++; });
  await new Promise((r) => setTimeout(r, 120));
  await doc.sendMessage(c.id, 'How is the knee?', 'text');
  for (let i = 0; i < 40 && !fired; i++) await new Promise((r) => setTimeout(r, 50));
  unsub();
  assert.ok(fired > 0, 'the patient device was told about the new message');

  // a stranger: cannot read private records or write anyone else's paths
  const s = strangerPhone();
  await s.signUp({ role: 'patient', fullName: 'Stranger', email: 'x@y.example', password: 'stranger-pass-1' });
  assert.equal((await s.listConsultations()).length, 0);
  const patUid = await uidFor(p.profile.patientCode!);
  const priv = await s.db.call<{ data: unknown }>({ op: 'get', path: `data/users/${patUid}/patient` });
  assert.equal(priv.data, null, 'another account record is invisible');
  await assert.rejects(s.db.call({ op: 'set', path: `pat/${patUid}`, data: { doctorUid: 'evil' } }), 'cannot write another person’s records');
  await assert.rejects(s.db.call({ op: 'get', path: 'pat/x' }, { uid: patUid, secret: 'guessed-secret-xxxxxxxxxx', login: '' }), 'a wrong secret is refused');

  // nothing readable on the server
  const raw = JSON.stringify(await s.db.call({ op: 'query', coll: `pat/${patUid}/c` }));
  assert.ok(!raw.includes('secret-knee-words') && !raw.includes('Omar'), 'stored encrypted');
  assert.ok(calls > 10);
});

test('website sync: recovery code sets a new password; the old one stops working; caregivers work too', async () => {
  __resetMemoryDb();
  const phone = device();
  const a = phone();
  await a.signUp({ role: 'patient', fullName: 'Mona', email: 'mona@example.test', password: 'first-pass-1' });
  const code = await a.createRecoveryCode();
  await a.signOut();
  const b = device()();
  await rejects(b.recoverAccount({ login: 'mona@example.test', recoveryCode: 'WRONG-CODE-0000', newPassword: 'second-pass-2' }), 'invalid_credentials');
  const me = await b.recoverAccount({ login: 'mona@example.test', recoveryCode: code, newPassword: 'second-pass-2' });
  assert.equal(me.profile.fullName, 'Mona');
  const c = device()();
  await rejects(c.signIn({ email: 'mona@example.test', password: 'first-pass-1' }), 'invalid_credentials');
  assert.equal((await c.signIn({ email: 'mona@example.test', password: 'second-pass-2' })).profile.fullName, 'Mona');

  const cg = device()();
  const cgMe = await cg.signUp({ role: 'caregiver', fullName: 'Sara', email: 'sara@example.test', password: 'care-pass-1' });
  await c.connectCaregiver(cgMe.caregiverId!);
  assert.equal((await cg.listCaredPatients())[0].name, 'Mona');
});
