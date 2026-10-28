// WebSyncBackend — the website's shared, cross-device storage.
//
// It is the same end-to-end encrypted CloudBackend that runs inside Claude, with
// its database calls sent to the AccessCare worker (server/cloudflare-worker.mjs,
// route /db, Cloudflare D1). Instead of a Claude account, the person's identity
// comes from their login (email or Patient ID) and password:
//   uid    = SHA-256("accesscare/uid/v1:" + login) — the same on every device
//   secret = PBKDF2(password, uid)                 — proves it is them; the server keeps only its hash
// The server stores only records the app already encrypted, and lets each account
// write only its own paths (the same rules as inside Claude).

import type { AuthInfo, Backend, Me, SignInInput, SignUpInput } from './Backend';
import { BackendError } from './Backend';
import type { CloudDb, CloudUser, CollRef, DbErr, DocRef, DocSnap, Query, QuerySnap, Unsub } from './cloudDb';
import { CloudBackend, type SessionStore } from './CloudBackend';
import type { Role } from '../../domain/types';
import { generatePatientId, normalizePatientId, normalizeRecoveryCode } from '../crypto';

const IDENT_KEY = 'accesscare.web.identity.v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES: Role[] = ['patient', 'doctor', 'caregiver'];

export interface Identity { uid: string; secret: string; login: string }

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The login as typed → its normal form (email lower-cased, or AC-PAT-XXXXXX). */
export function normalizeLogin(raw: string): string {
  const t = (raw ?? '').trim();
  if (/^ac-?pat/i.test(t.replace(/\s/g, ''))) return normalizePatientId(t);
  return t.toLowerCase();
}
export async function uidFor(login: string): Promise<string> {
  return 'w' + hex(await crypto.subtle.digest('SHA-256', enc.encode(`accesscare/uid/v1:${normalizeLogin(login)}`))).slice(0, 30);
}
export async function secretFor(uid: string, password: string, purpose: 'login' | 'recovery' = 'login', iterations = 150_000): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`accesscare/auth/v1:${purpose}:${uid}`), iterations }, key, 256);
  return b64u(bits);
}

// ---------------------------------------------------------------- the database over HTTP
type Listener = { key: () => Promise<string>; run: () => Promise<void> };

export class WebDb implements CloudDb {
  ident: Identity | null = null;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeq = -1;
  constructor(private endpoint: string, private pollMs = 4000) {}

  async call<T>(body: Record<string, unknown>, auth: Identity | null = this.ident): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.endpoint.replace(/\/+$/, '')}/db`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-ac-auth': `${auth.uid}.${auth.secret}` } : {}) }, body: JSON.stringify(body) });
    } catch { throw { code: 'unavailable', message: 'The AccessCare server could not be reached.' } satisfies DbErr; }
    const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string } & T;
    if (!r.ok) {
      const code = r.status === 401 ? 'unauthenticated' : r.status === 409 ? 'taken' : r.status === 413 ? 'invalid_argument' : r.status === 501 ? 'not_configured' : (data.error ?? 'unavailable');
      throw { code, message: data.message ?? data.error ?? `server error ${r.status}` } satisfies DbErr;
    }
    return data;
  }

  private snap(path: string, data: Record<string, unknown> | null): DocSnap {
    const id = path.split('/').pop()!;
    const body = data ? Object.freeze(data) : undefined;
    return { id, exists: !!data, data: () => body };
  }

  private watch(l: Listener): Unsub {
    this.listeners.add(l);
    void l.run();
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.pollMs);
    return () => { this.listeners.delete(l); if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = null; } };
  }
  private async tick() {
    if (!this.ident || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    try {
      const { seq } = await this.call<{ seq: number }>({ op: 'seq' });
      if (seq === this.lastSeq) return;
      this.lastSeq = seq;
      for (const l of [...this.listeners]) void l.run();
    } catch { /* offline: try again on the next tick */ }
  }

  doc(path: string): DocRef {
    const self = this;
    const get = async () => self.snap(path, (await self.call<{ data: Record<string, unknown> | null }>({ op: 'get', path })).data);
    return {
      id: path.split('/').pop()!, path, get,
      set: async (data) => { await self.call({ op: 'set', path, data }); },
      update: async (data) => { await self.call({ op: 'update', path, data }); },
      delete: async () => { await self.call({ op: 'delete', path }); },
      onSnapshot(next, error) {
        let last = '';
        return self.watch({ key: async () => '', run: async () => { try { const s = await get(); const k = JSON.stringify([s.exists, s.data()]); if (k !== last) { last = k; next(s); } } catch (e) { error?.(e as DbErr); } } });
      },
      collection: (sub) => self.collection(`${path}/${sub}`),
    };
  }

  private query(coll: string, where: [string, string, unknown][], limit: number): Query {
    const self = this;
    const get = async (): Promise<QuerySnap> => {
      const r = await self.call<{ docs: { id: string; data: Record<string, unknown> }[] }>({ op: 'query', coll, where, limit });
      const docs = r.docs.map((d) => self.snap(`${coll}/${d.id}`, d.data));
      return { docs, size: docs.length, empty: docs.length === 0 };
    };
    return {
      where: (f, op, v) => self.query(coll, [...where, [f, op, v]], limit),
      orderBy: () => self.query(coll, where, limit),
      limit: (n) => self.query(coll, where, n),
      get,
      onSnapshot(next, error) {
        let last = '';
        return self.watch({ key: async () => '', run: async () => { try { const s = await get(); const k = JSON.stringify(s.docs.map((d) => [d.id, d.data()])); if (k !== last) { last = k; next(s); } } catch (e) { error?.(e as DbErr); } } });
      },
    };
  }

  collection(path: string): CollRef {
    return Object.assign(this.query(path, [], 500), { path, doc: (id?: string) => this.doc(`${path}/${id ?? crypto.randomUUID().replace(/-/g, '')}`) });
  }
}

class WebUser implements CloudUser {
  constructor(private db: WebDb) {}
  async id() { return this.db.ident?.uid ?? null; }
  async me() { return { id: this.db.ident?.uid ?? null, name: '' }; }
  async can() { return true; }
}

// ---------------------------------------------------------------- the backend
const identityStore = {
  get(): Identity | null { try { const v = JSON.parse(localStorage.getItem(IDENT_KEY) || 'null'); return v && typeof v.uid === 'string' && typeof v.secret === 'string' ? v : null; } catch { return null; } },
  set(v: Identity | null) { try { if (v) localStorage.setItem(IDENT_KEY, JSON.stringify(v)); else localStorage.removeItem(IDENT_KEY); } catch { /* storage blocked: stays signed in for this page only */ } },
};

export class WebSyncBackend implements Backend {
  readonly mode = 'server' as const;
  readonly persistent = true;
  readonly shared = true;
  readonly db: WebDb;
  private inner: CloudBackend;

  constructor(endpoint: string, opts: { iterations?: number; sessionStore?: SessionStore; pollMs?: number; identity?: { get(): Identity | null; set(v: Identity | null): void } } = {}) {
    this.db = new WebDb(endpoint, opts.pollMs);
    this.inner = new CloudBackend(this.db, new WebUser(this.db), { iterations: opts.iterations, sessionStore: opts.sessionStore });
    this.iterations = opts.iterations;
    this.ids = opts.identity ?? identityStore;
    const saved = this.ids.get();
    if (saved) this.db.ident = saved;
  }
  private iterations?: number;
  private ids: { get(): Identity | null; set(v: Identity | null): void };

  private async rolesOf(): Promise<Role[]> {
    const out: Role[] = [];
    for (const r of ROLES) {
      try { if ((await this.db.call<{ data: unknown }>({ op: 'get', path: `data/users/${this.db.ident!.uid}/${r}` })).data) out.push(r); }
      catch (e) { if ((e as DbErr).code === 'unauthenticated') throw new BackendError('invalid_credentials', 'Email / Patient ID or password is incorrect.'); throw new BackendError('cloud_unavailable', (e as DbErr).message || 'The AccessCare server could not be reached.'); }
    }
    return out;
  }
  private setIdent(v: Identity | null) { this.db.ident = v; this.ids.set(v); }

  async authInfo(): Promise<AuthInfo> { return { kind: 'email-password' }; }

  async signUp(input: SignUpInput): Promise<Me> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw new BackendError('invalid_email', 'Please enter a valid email address.');
    if (!email && input.role !== 'patient') throw new BackendError('invalid_email', 'Please enter your email address.');
    if ((input.password ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    const patientCode = input.role === 'patient' && !email ? generatePatientId() : undefined;
    const login = email || patientCode!;
    const uid = await uidFor(login);
    const secret = await secretFor(uid, input.password, 'login', this.iterations);
    try { await this.db.call({ op: 'register', uid, secret }, null); }
    catch (e) {
      const code = (e as DbErr).code;
      if (code === 'taken') throw new BackendError('email_taken', 'An account with this email already exists. Try logging in.');
      throw new BackendError('cloud_unavailable', (e as DbErr).message || 'The AccessCare server could not be reached.');
    }
    const prev = this.db.ident;
    this.setIdent({ uid, secret, login });
    try {
      const me = await this.inner.signUp({ ...input, ...(patientCode ? { patientCode } : {}) });
      return { ...me, profile: { ...me.profile, email } };
    } catch (e) {
      // the account record could not be written: free the login again so it can be retried
      try { await this.db.call({ op: 'auth-delete' }); } catch { /* */ }
      this.setIdent(prev);
      throw e;
    }
  }

  async signIn({ email, password }: SignInInput): Promise<Me> {
    const login = normalizeLogin(email ?? '');
    if (!login) throw new BackendError('invalid_credentials', 'Enter your email or Patient ID.');
    const uid = await uidFor(login);
    const ident = { uid, secret: await secretFor(uid, password ?? '', 'login', this.iterations), login };
    const prev = this.db.ident;
    this.db.ident = ident;
    try {
      const roles = await this.rolesOf();
      if (!roles.length) throw new BackendError('invalid_credentials', 'Email / Patient ID or password is incorrect.');
      const me = await this.inner.signIn({ role: roles[0], password });
      this.setIdent(ident);
      return { ...me, profile: { ...me.profile, email: login.includes('@') ? login : '' } };
    } catch (e) { this.db.ident = prev; throw e; }
  }

  async signOut() { await this.inner.signOut(); this.setIdent(null); }

  async restoreSession(): Promise<Me | null> {
    if (!this.db.ident) return null;
    const me = await this.inner.restoreSession();
    if (!me) return null;
    const login = this.db.ident.login;
    return { ...me, profile: { ...me.profile, email: login.includes('@') ? login : '' } };
  }

  async requestPasswordReset() { return { supported: false }; }

  async deleteAccount(password: string) {
    await this.inner.deleteAccount(password);
    try { await this.db.call({ op: 'auth-delete' }); } catch { /* the records are gone; the login stays reserved */ }
    this.setIdent(null);
  }

  async createRecoveryCode(): Promise<string> {
    const code = await this.inner.createRecoveryCode();
    const verifier = await secretFor(this.db.ident!.uid, normalizeRecoveryCode(code), 'recovery', this.iterations);
    await this.db.call({ op: 'auth-recovery', verifier });
    return code;
  }

  async recoverAccount({ login, recoveryCode, newPassword }: { login?: string; role?: Role; recoveryCode: string; newPassword: string }): Promise<Me> {
    const norm = normalizeLogin(login ?? '');
    if (!norm) throw new BackendError('invalid_credentials', 'Enter your email or Patient ID.');
    if ((newPassword ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    const uid = await uidFor(norm);
    const rec = { uid, secret: await secretFor(uid, normalizeRecoveryCode(recoveryCode), 'recovery', this.iterations), login: norm };
    this.db.ident = rec;
    try {
      const roles = await this.rolesOf();
      if (!roles.length) throw new BackendError('invalid_credentials', 'That recovery code is not correct.');
      const me = await this.inner.recoverAccount({ role: roles[0], recoveryCode, newPassword });
      const secret = await secretFor(uid, newPassword, 'login', this.iterations);
      await this.db.call({ op: 'auth-set', secret });
      this.setIdent({ uid, secret, login: norm });
      return me;
    } catch (e) {
      this.db.ident = null;
      if (e instanceof BackendError && e.code === 'invalid_credentials') throw new BackendError('invalid_credentials', 'That recovery code is not correct.');
      throw e;
    }
  }

  // everything else is the encrypted cloud backend, unchanged
  updateProfile = (p: Parameters<Backend['updateProfile']>[0]) => this.inner.updateProfile(p);
  savePreferences = (p: Parameters<Backend['savePreferences']>[0]) => this.inner.savePreferences(p);
  lookupDoctor = (id: string) => this.inner.lookupDoctor(id);
  connectToDoctor = (id: string) => this.inner.connectToDoctor(id);
  disconnectDoctor = () => this.inner.disconnectDoctor();
  getMyDoctor = () => this.inner.getMyDoctor();
  listMyPatients = () => this.inner.listMyPatients();
  disconnectPatient = (id: string) => this.inner.disconnectPatient(id);
  doctorStats = () => this.inner.doctorStats();
  createConsultation: Backend['createConsultation'] = (k) => this.inner.createConsultation(k);
  updateDraft: Backend['updateDraft'] = (id, p) => this.inner.updateDraft(id, p);
  approveAndShare: Backend['approveAndShare'] = (id, s) => this.inner.approveAndShare(id, s);
  saveApprovedWithoutDoctor: Backend['saveApprovedWithoutDoctor'] = (id, s) => this.inner.saveApprovedWithoutDoctor(id, s);
  cancelConsultation: Backend['cancelConsultation'] = (id) => this.inner.cancelConsultation(id);
  listConsultations: Backend['listConsultations'] = () => this.inner.listConsultations();
  getConsultation: Backend['getConsultation'] = (id) => this.inner.getConsultation(id);
  setStatus: Backend['setStatus'] = (id, s) => this.inner.setStatus(id, s);
  statusHistory: Backend['statusHistory'] = (id) => this.inner.statusHistory(id);
  addDiaryEntry: Backend['addDiaryEntry'] = (e) => this.inner.addDiaryEntry(e);
  listDiary: Backend['listDiary'] = (p) => this.inner.listDiary(p);
  deleteDiaryEntry: Backend['deleteDiaryEntry'] = (id) => this.inner.deleteDiaryEntry(id);
  addRecord: Backend['addRecord'] = (k, d, o) => this.inner.addRecord(k, d, o);
  listRecords: Backend['listRecords'] = (k, p) => this.inner.listRecords(k, p);
  deleteRecord: Backend['deleteRecord'] = (id) => this.inner.deleteRecord(id);
  lookupCaregiver: Backend['lookupCaregiver'] = (id) => this.inner.lookupCaregiver(id);
  connectCaregiver: Backend['connectCaregiver'] = (id) => this.inner.connectCaregiver(id);
  listMyCaregivers: Backend['listMyCaregivers'] = () => this.inner.listMyCaregivers();
  removeCaregiver: Backend['removeCaregiver'] = (id) => this.inner.removeCaregiver(id);
  publishCareDigest: Backend['publishCareDigest'] = (d) => this.inner.publishCareDigest(d);
  pendingCaregiverItems: Backend['pendingCaregiverItems'] = () => this.inner.pendingCaregiverItems();
  listCaredPatients: Backend['listCaredPatients'] = () => this.inner.listCaredPatients();
  caregiverAdd: Backend['caregiverAdd'] = (p, i) => this.inner.caregiverAdd(p, i);
  listNotes: Backend['listNotes'] = (c) => this.inner.listNotes(c);
  addNote: Backend['addNote'] = (c, b) => this.inner.addNote(c, b);
  getClinicalReview: Backend['getClinicalReview'] = (c) => this.inner.getClinicalReview(c);
  saveClinicalReview: Backend['saveClinicalReview'] = (c, r) => this.inner.saveClinicalReview(c, r);
  listMessages: Backend['listMessages'] = (c) => this.inner.listMessages(c);
  sendMessage: Backend['sendMessage'] = (c, b, k, m) => this.inner.sendMessage(c, b, k, m);
  markViewed = (c: string) => this.inner.markViewed(c);
  onChange = (cb: () => void) => this.inner.onChange(cb);
}
