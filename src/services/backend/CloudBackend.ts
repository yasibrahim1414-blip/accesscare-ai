// CloudBackend — AccessCare AI on Claude's shared, server-side artifact database.
//
// Identity: the viewer's Claude account (server-verified). One Claude account
// may hold one patient account and one doctor account, each with its own
// AccessCare password that unlocks that account's encryption keys.
//
// Storage layout (paths are enforced by the access rules in cloudDb.ts):
//   data/users/<uid>/<role>                 private account record (only this person can read it)
//   data/users/<uid>/patient/drafts/<cid>   private consultation drafts   (vault-encrypted)
//   data/users/<uid>/doctor/notes/<nid>     private doctor notes          (vault-encrypted)
//   data/users/<uid>/doctor/reviews/<cid>   clinical decision support     (vault-encrypted)
//   doc/<uid>                               public doctor directory entry (written only by that doctor)
//   doc/<uid>/s/<cid>                       consultation status set by the doctor
//   doc/<uid>/m/<mid>                       doctor's messages             (pair-encrypted)
//   doc/<uid>/x/<pid>                       doctor ended a connection
//   pat/<uid>                               patient's public key + current connection (written only by that patient)
//   pat/<uid>/c/<cid>                       shared consultation           (pair-encrypted + vault copy)
//   pat/<uid>/m/<mid>                       patient's messages            (pair-encrypted)
//   pat/<uid>/d/<id>                        symptom diary entries         (vault copy + pair copy when shared)
//   pat/<uid>/r/<id>                        care records: doses, photos, emergency card (vault copy + pair copy when shared; the card is never shared)
//   pat/<uid>/g/<cguid>                     a linked caregiver's care digest (caregiver-pair-encrypted)
//   cg/<uid>                                public caregiver directory entry (written only by that caregiver)
//   cg/<uid>/o/<id>                         check-ins a caregiver recorded for a patient (caregiver-pair-encrypted)
// Other signed-in users of the app can see that encrypted records exist (who is
// connected to which doctor, timestamps, status) but cannot read their content.

import type {
  AuthInfo, Backend, ConsultationView, DiaryInput, DoctorStats, Me, PatientSummary, SignInInput, SignUpInput,
} from './Backend';
import { BackendError } from './Backend';
import type {
  ApprovedSummary, ClarificationAnswer, CommunicationPreferences, Connection, Consultation,
  ConsultationStatus, DoctorNote, DoctorPublicInfo, Message, Role, Sensation, StatusChange, SymptomDetails, AuditEvent, MessageMeta,
} from '../../domain/types';
import { DEFAULT_PREFERENCES, cleanPreferences } from '../../domain/types';
import { REGION_BY_ID } from '../../domain/bodyRegions';
import { DOCTOR_ID_PATTERN, generateDoctorId, normalizeDoctorId, randomId, generatePatientId, generateRecoveryCode, normalizeRecoveryCode } from '../crypto';
import type { CloudDb, CloudUser, DbErr, DocSnap, Unsub } from './cloudDb';
import { cleanAudit, cleanMeta, cleanReconstruction, messageKindFor, readKind, requireValidRx } from './sanitize';
import { cleanReview, newReview, type ClinicalReview } from '../../domain/clinical';
import type { Reconstruction } from '../../domain/reconstruction';
import { cleanDiaryEntry, type DiaryEntry } from '../../domain/diary';
import {
  CAREGIVER_ID_PATTERN, cleanCaregiverItem, cleanDigest, cleanRecord, cleanRecordData, generateCaregiverId, normalizeCaregiverId,
  type CareDigest, type CaregiverItem, type CaregiverLink, type PatientRecord, type RecordKind,
} from '../../domain/care';
import {
  type KeyPairRecord, type Sealed, type WrappedVault, exportVault, importVault, newKeyPair, newVault,
  open, openPrivateKey, pairKey, seal, unwrapVault, wrapVault,
} from './cloudCrypto';

const SESSION_KEY = 'accesscare.cloud.session.v1';
const SENSATIONS: Sensation[] = ['pain', 'numbness', 'burning', 'itching', 'swelling', 'weakness', 'tingling', 'other', 'not_sure'];
const now = () => new Date().toISOString();
const clip = (s: string | undefined, max: number) => (s ?? '').trim().slice(0, max);

interface AcctDoc {
  v: 1; role: Role; createdAt: string; vault: WrappedVault; keys: KeyPairRecord; sealedProfile: Sealed; doctorId?: string; caregiverId?: string;
  /** patients: readable identifier (not a credential) */
  patientCode?: string;
  /** the same vault key wrapped with a one-time recovery code */
  recovery?: WrappedVault | null;
}
interface PrivateProfile { fullName: string; specialty?: string; clinic?: string; prefs: CommunicationPreferences }
interface DoctorDoc { v: 1; doctorId: string; name: string; specialty?: string; clinic?: string; pub: JsonWebKey; since: string }
interface PatientDoc { v: 1; pub: JsonWebKey; doctorUid: string | null; linkActive: boolean; linkSince: string | null; sealedLink: Sealed | null; cgUids?: string[] }
interface CaregiverDoc { v: 1; caregiverId: string; name: string; pub: JsonWebKey; since: string }
interface RecordDoc { kind: RecordKind; at: string; doctorUid: string | null; sealed: Sealed | null; sealedSelf: Sealed }
interface CareLinkDoc { since: string; at: string; sealedName: Sealed; sealedDigest: Sealed | null }
interface OutboxDoc { puid: string; at: string; sealed: Sealed }
interface LinkPayload { fullName: string; prefs: CommunicationPreferences | null }
interface SharedConsultDoc { cid: string; doctorUid: string | null; sharedAt: string; createdAt: string; sealed: Sealed | null; sealedSelf: Sealed }
interface StatusDoc { patientUid: string; status: ConsultationStatus; history: { from: ConsultationStatus; to: ConsultationStatus; at: string }[]; updatedAt: string; viewedAt?: string }
interface MsgDoc { cid: string; pid: string; at: string; sealed: Sealed }
interface DiaryDoc { at: string; doctorUid: string | null; sealed: Sealed | null; sealedSelf: Sealed }
interface PatientCopy { consultation: Consultation; doctor: DoctorPublicInfo }

interface Session {
  uid: string; role: Role; vault: CryptoKey; priv: CryptoKey; pub: JsonWebKey; acct: AcctDoc; profile: PrivateProfile;
}

/** In-memory fallback when browser storage is blocked. */
const mem = new Map<string, string>();
export interface SessionStore { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void }
const browserStore: SessionStore = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { mem.set(k, v); } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { mem.delete(k); } },
};

const friendly = (e: unknown): never => {
  if (e instanceof BackendError) throw e;
  const d = e as DbErr;
  if (d && typeof d.code === 'string') {
    const msg: Record<string, string> = {
      invalid_argument: 'The cloud database refused this change. Your access level may be view-only — ask the owner to share AccessCare AI with you as a Contributor.',
      resource_exhausted: 'Too many requests at once. Please wait a moment and try again.',
      quota_exceeded: 'The shared database is full. Old consultations need to be deleted before new ones can be saved.',
      unavailable: 'The cloud database is temporarily unreachable. Check your connection and try again.',
      revoked: 'Your access to AccessCare AI was changed. Reload the page.',
    };
    throw new BackendError(`cloud_${d.code}`, msg[d.code] ?? 'The cloud database is unavailable right now.');
  }
  throw new BackendError('cloud_error', (e as Error)?.message || 'Something went wrong with the cloud database.');
};

export class CloudBackend implements Backend {
  readonly mode = 'claude-cloud' as const;
  readonly persistent = true;
  readonly shared = true;
  private s: Session | null = null;
  private pairCache = new Map<string, CryptoKey>();
  private doctorCache = new Map<string, DoctorDoc>(); // by doctor uid

  private ls: SessionStore;
  constructor(private db: CloudDb, private user: CloudUser, opts: { iterations?: number; sessionStore?: SessionStore } = {}) {
    this.iterations = opts.iterations;
    this.ls = opts.sessionStore ?? browserStore;
  }
  private iterations?: number;

  // ---------- helpers ----------
  private async uid(): Promise<string> {
    const id = await this.user.id();
    if (!id) throw new BackendError('no_identity', 'Sign in to Claude to use your AccessCare AI account.');
    return id;
  }
  private acctRef(uid: string, role: Role) { return this.db.doc(`data/users/${uid}/${role}`); }
  private need(role?: Role): Session {
    if (!this.s) throw new BackendError('unauthenticated', 'Please sign in again.');
    if (role && this.s.role !== role) {
      throw new BackendError('forbidden', role === 'doctor' ? 'Only doctor accounts can do this.' : role === 'caregiver' ? 'Only caregiver accounts can do this.' : 'Only patient accounts can do this.');
    }
    return this.s;
  }
  private pid(s: Session) { return `p_${s.uid}`; }
  private did(s: Session) { return `d_${s.uid}`; }
  private async get<T>(path: string): Promise<T | null> {
    try { const snap = await this.db.doc(path).get(); return snap.exists ? (snap.data() as T) : null; } catch (e) { return friendly(e); }
  }
  private async put(path: string, data: object) { try { await this.db.doc(path).set(data as Record<string, unknown>); } catch (e) { friendly(e); } }
  private async patch(path: string, data: object) { try { await this.db.doc(path).update(data as Record<string, unknown>); } catch (e) { friendly(e); } }
  private async del(path: string) { try { await this.db.doc(path).delete(); } catch (e) { friendly(e); } }
  private async query(coll: string, where: [string, string, unknown][] = []): Promise<DocSnap[]> {
    try {
      let q = this.db.collection(coll) as unknown as import('./cloudDb').Query;
      for (const [f, op, v] of where) q = q.where(f, op, v);
      return (await q.limit(500).get()).docs.filter((d) => d.exists);
    } catch (e) { return friendly(e); }
  }

  private async doctorDoc(uid: string, fresh = false): Promise<DoctorDoc | null> {
    if (!fresh && this.doctorCache.has(uid)) return this.doctorCache.get(uid)!;
    const d = await this.get<DoctorDoc>(`doc/${uid}`);
    if (d) this.doctorCache.set(uid, d); else this.doctorCache.delete(uid);
    return d;
  }
  private publicInfo(d: DoctorDoc): DoctorPublicInfo {
    return { doctorId: d.doctorId, fullName: d.name, specialty: d.specialty, clinic: d.clinic };
  }

  private async pair(patientUid: string, doctorUid: string): Promise<CryptoKey> {
    const s = this.need();
    const k = `${patientUid}|${doctorUid}`;
    if (this.pairCache.has(k)) return this.pairCache.get(k)!;
    let theirPub: JsonWebKey | undefined;
    if (s.role === 'patient') theirPub = (await this.doctorDoc(doctorUid))?.pub;
    else theirPub = (await this.get<PatientDoc>(`pat/${patientUid}`))?.pub;
    if (!theirPub) throw new BackendError('peer_missing', 'The other account no longer exists.');
    const key = await pairKey(s.priv, theirPub, patientUid, doctorUid);
    this.pairCache.set(k, key);
    return key;
  }

  /** key shared by a patient and a caregiver (separate from any doctor pairing) */
  private async cgPair(patientUid: string, cgUid: string): Promise<CryptoKey> {
    const s = this.need();
    const k = `cg|${patientUid}|${cgUid}`;
    if (this.pairCache.has(k)) return this.pairCache.get(k)!;
    const theirPub = s.role === 'patient' ? (await this.get<CaregiverDoc>(`cg/${cgUid}`))?.pub : (await this.get<PatientDoc>(`pat/${patientUid}`))?.pub;
    if (!theirPub) throw new BackendError('peer_missing', 'The other account no longer exists.');
    const key = await pairKey(s.priv, theirPub, patientUid, `cg:${cgUid}`);
    this.pairCache.set(k, key);
    return key;
  }

  private me(s: Session): Me {
    return {
      ...(s.role === 'caregiver' ? { caregiverId: s.acct.caregiverId } : {}),
      profile: { id: s.role === 'patient' ? this.pid(s) : s.role === 'caregiver' ? `c_${s.uid}` : this.did(s), role: s.role, fullName: s.profile.fullName, email: '', createdAt: s.acct.createdAt, ...(s.acct.patientCode ? { patientCode: s.acct.patientCode } : {}) },
      doctor: s.role === 'doctor' ? { userId: this.did(s), doctorId: s.acct.doctorId!, specialty: s.profile.specialty, clinic: s.profile.clinic } : undefined,
      preferences: cleanPreferences(s.profile.prefs),
    };
  }

  private async unlock(uid: string, role: Role, acct: AcctDoc, vault: CryptoKey): Promise<Session> {
    const priv = await openPrivateKey(vault, acct.keys);
    const profile = await open<PrivateProfile>(vault, acct.sealedProfile, 'profile');
    return { uid, role, vault, priv, pub: acct.keys.pub, acct, profile };
  }

  private async persistSession(s: Session) {
    this.ls.set(SESSION_KEY, JSON.stringify({ uid: s.uid, role: s.role, vault: await exportVault(s.vault) }));
  }

  // ---------- auth ----------
  async authInfo(): Promise<AuthInfo> {
    const me = await this.user.me();
    if (!me.id) return { kind: 'claude-account', identityName: '', existingRoles: [] };
    const roles: Role[] = [];
    for (const r of ['patient', 'doctor', 'caregiver'] as Role[]) if (await this.get(`data/users/${me.id}/${r}`)) roles.push(r);
    return { kind: 'claude-account', identityName: me.name, existingRoles: roles };
  }

  async signUp(input: SignUpInput): Promise<Me> {
    const uid = await this.uid();
    const fullName = clip(input.fullName, 80);
    if (input.role !== 'patient' && input.role !== 'doctor' && input.role !== 'caregiver') throw new BackendError('invalid', 'Choose Patient, Doctor or Caregiver.');
    if (fullName.length < 2) throw new BackendError('invalid_name', 'Please enter your full name.');
    if ((input.password ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    if (await this.get(`data/users/${uid}/${input.role}`)) {
      throw new BackendError('email_taken', `Your Claude account already has an AccessCare ${input.role} account. Sign in instead.`);
    }
    const vault = await newVault();
    const wrapped = await wrapVault(vault, input.password, this.iterations);
    const { rec, priv, pub } = await newKeyPair(vault);
    const profile: PrivateProfile = {
      fullName, prefs: { ...DEFAULT_PREFERENCES },
      specialty: clip(input.specialty, 60) || undefined, clinic: clip(input.clinic, 80) || undefined,
    };
    const acct: AcctDoc = { v: 1, role: input.role, createdAt: now(), vault: wrapped, keys: rec, sealedProfile: await seal(vault, profile, 'profile') };

    if (input.role === 'doctor') {
      let doctorId = '';
      for (let i = 0; i < 20 && !doctorId; i++) {
        const candidate = generateDoctorId();
        if ((await this.query('doc', [['doctorId', '==', candidate]])).length === 0) doctorId = candidate;
      }
      if (!doctorId) throw new BackendError('id_generation', 'Could not generate a Doctor ID. Please retry.');
      acct.doctorId = doctorId;
      await this.put(`doc/${uid}`, {
        v: 1, doctorId, name: fullName, specialty: profile.specialty ?? null, clinic: profile.clinic ?? null, pub, since: now(),
      });
    } else if (input.role === 'caregiver') {
      let caregiverId = '';
      for (let i = 0; i < 20 && !caregiverId; i++) {
        const candidate = generateCaregiverId();
        if ((await this.query('cg', [['caregiverId', '==', candidate]])).length === 0) caregiverId = candidate;
      }
      if (!caregiverId) throw new BackendError('id_generation', 'Could not generate a Caregiver ID. Please retry.');
      acct.caregiverId = caregiverId;
      const cgDoc: CaregiverDoc = { v: 1, caregiverId, name: fullName, pub, since: now() };
      await this.put(`cg/${uid}`, cgDoc);
    } else {
      acct.patientCode = generatePatientId();
      await this.put(`pat/${uid}`, { v: 1, pub, doctorUid: null, linkActive: false, linkSince: null, sealedLink: null });
    }
    await this.put(`data/users/${uid}/${input.role}`, acct);
    this.s = { uid, role: input.role, vault, priv, pub, acct, profile };
    this.pairCache.clear();
    await this.persistSession(this.s);
    return this.me(this.s);
  }

  async signIn({ role, password }: SignInInput): Promise<Me> {
    const uid = await this.uid();
    if (role !== 'patient' && role !== 'doctor' && role !== 'caregiver') throw new BackendError('invalid', 'Choose which account to sign in to.');
    const acct = await this.get<AcctDoc>(`data/users/${uid}/${role}`);
    if (!acct) throw new BackendError('invalid_credentials', `There is no AccessCare ${role} account on this Claude account yet. Create one first.`);
    let vault: CryptoKey;
    try { vault = await unwrapVault(acct.vault, password ?? ''); }
    catch { throw new BackendError('invalid_credentials', 'That password is incorrect.'); }
    this.s = await this.unlock(uid, role, acct, vault);
    this.pairCache.clear();
    await this.persistSession(this.s);
    return this.me(this.s);
  }

  async createRecoveryCode(): Promise<string> {
    const s = this.need();
    const code = generateRecoveryCode();
    const recovery = await wrapVault(s.vault, code, this.iterations);
    await this.patch(`data/users/${s.uid}/${s.role}`, { recovery });
    s.acct = { ...s.acct, recovery };
    return code;
  }

  /** The recovery code unwraps the same account key, so encrypted data survives a password reset. */
  async recoverAccount({ role, recoveryCode, newPassword }: { role?: Role; recoveryCode: string; newPassword: string }): Promise<Me> {
    const uid = await this.uid();
    if (role !== 'patient' && role !== 'doctor' && role !== 'caregiver') throw new BackendError('invalid', 'Choose which account to recover.');
    if ((newPassword ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    const acct = await this.get<AcctDoc>(`data/users/${uid}/${role}`);
    if (!acct?.recovery) throw new BackendError('invalid_credentials', 'That recovery code is not correct.');
    let vault: CryptoKey;
    try { vault = await unwrapVault(acct.recovery, normalizeRecoveryCode(recoveryCode)); }
    catch { throw new BackendError('invalid_credentials', 'That recovery code is not correct.'); }
    const next: AcctDoc = { ...acct, vault: await wrapVault(vault, newPassword, this.iterations), recovery: null }; // single use
    await this.put(`data/users/${uid}/${role}`, next);
    this.s = await this.unlock(uid, role, next, vault);
    this.pairCache.clear();
    await this.persistSession(this.s);
    return this.me(this.s);
  }

  async signOut() {
    this.s = null;
    this.pairCache.clear();
    this.doctorCache.clear();
    this.ls.del(SESSION_KEY);
  }

  async restoreSession(): Promise<Me | null> {
    const raw = this.ls.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as { uid: string; role: Role; vault: string };
      const uid = await this.user.id();
      if (!uid || uid !== saved.uid) { this.ls.del(SESSION_KEY); return null; } // a different Claude account is signed in
      const acct = await this.get<AcctDoc>(`data/users/${uid}/${saved.role}`);
      if (!acct) { this.ls.del(SESSION_KEY); return null; }
      this.s = await this.unlock(uid, saved.role, acct, await importVault(saved.vault));
      return this.me(this.s);
    } catch (e) {
      if (e instanceof BackendError && e.code.startsWith('cloud_unavailable')) throw e;
      // a network hiccup (or the page closing mid-request) must not log the person out: keep the session for next time
      if (e instanceof TypeError || /fetch|network|load failed|abort/i.test((e as Error)?.message ?? '')) throw e;
      this.ls.del(SESSION_KEY);
      return null;
    }
  }

  async requestPasswordReset(): Promise<{ supported: boolean }> {
    // The password encrypts the account's keys, so it cannot be reset without losing the encrypted data.
    return { supported: false };
  }

  async deleteAccount(password: string): Promise<void> {
    const s = this.need();
    try { await unwrapVault(s.acct.vault, password ?? ''); } catch { throw new BackendError('invalid_credentials', 'Password is incorrect.'); }
    const { uid } = s;
    if (s.role === 'patient') {
      for (const d of await this.query(`data/users/${uid}/patient/drafts`)) await this.del(`data/users/${uid}/patient/drafts/${d.id}`);
      for (const d of await this.query(`pat/${uid}/c`)) await this.del(`pat/${uid}/c/${d.id}`);
      for (const d of await this.query(`pat/${uid}/m`)) await this.del(`pat/${uid}/m/${d.id}`);
      for (const d of await this.query(`pat/${uid}/d`)) await this.del(`pat/${uid}/d/${d.id}`);
      for (const d of await this.query(`pat/${uid}/r`)) await this.del(`pat/${uid}/r/${d.id}`);
      for (const d of await this.query(`pat/${uid}/g`)) await this.del(`pat/${uid}/g/${d.id}`);
      await this.del(`pat/${uid}`);
    } else if (s.role === 'caregiver') {
      for (const d of await this.query(`cg/${uid}/o`)) await this.del(`cg/${uid}/o/${d.id}`);
      await this.del(`cg/${uid}`);
    } else {
      for (const sub of ['s', 'm', 'x']) for (const d of await this.query(`doc/${uid}/${sub}`)) await this.del(`doc/${uid}/${sub}/${d.id}`);
      for (const d of await this.query(`data/users/${uid}/doctor/notes`)) await this.del(`data/users/${uid}/doctor/notes/${d.id}`);
      for (const d of await this.query(`data/users/${uid}/doctor/reviews`)) await this.del(`data/users/${uid}/doctor/reviews/${d.id}`);
      await this.del(`doc/${uid}`);
    }
    await this.del(`data/users/${uid}/${s.role}`);
    await this.signOut();
  }

  private async saveProfile(s: Session, profile: PrivateProfile) {
    const sealedProfile = await seal(s.vault, profile, 'profile');
    await this.patch(`data/users/${s.uid}/${s.role}`, { sealedProfile });
    s.profile = profile;
    s.acct = { ...s.acct, sealedProfile };
    if (s.role === 'patient') await this.refreshLink(s);
  }

  private async refreshLink(s: Session) {
    const pd = await this.get<PatientDoc>(`pat/${s.uid}`);
    if (!pd?.linkActive || !pd.doctorUid) return;
    const payload: LinkPayload = { fullName: s.profile.fullName, prefs: s.profile.prefs.shareWithDoctor ? s.profile.prefs : null };
    await this.patch(`pat/${s.uid}`, { sealedLink: await seal(await this.pair(s.uid, pd.doctorUid), payload, 'link') });
  }

  async updateProfile(patch: { fullName?: string; specialty?: string; clinic?: string }): Promise<Me> {
    const s = this.need();
    const p = { ...s.profile };
    if (patch.fullName !== undefined) {
      const n = clip(patch.fullName, 80);
      if (n.length < 2) throw new BackendError('invalid_name', 'Please enter your full name.');
      p.fullName = n;
    }
    if (s.role === 'doctor') {
      if (patch.specialty !== undefined) p.specialty = clip(patch.specialty, 60) || undefined;
      if (patch.clinic !== undefined) p.clinic = clip(patch.clinic, 80) || undefined;
      await this.patch(`doc/${s.uid}`, { name: p.fullName, specialty: p.specialty ?? null, clinic: p.clinic ?? null });
      this.doctorCache.delete(s.uid);
    }
    await this.saveProfile(s, p);
    return this.me(s);
  }

  async savePreferences(prefs: CommunicationPreferences): Promise<CommunicationPreferences> {
    const s = this.need();
    const clean = cleanPreferences(prefs);
    await this.saveProfile(s, { ...s.profile, prefs: clean });
    return clean;
  }

  // ---------- doctor id + connections ----------
  private async findDoctor(raw: string): Promise<{ uid: string; doc: DoctorDoc }> {
    const id = normalizeDoctorId(raw);
    if (!DOCTOR_ID_PATTERN.test(id)) {
      throw new BackendError('invalid_format', 'That doesn’t look like a Doctor ID. It should look like AC-DOC-7K4P9X.');
    }
    const hits = (await this.query('doc', [['doctorId', '==', id]]))
      .map((d) => ({ uid: d.id, doc: d.data() as unknown as DoctorDoc }))
      .filter((h) => h.doc && typeof h.doc.name === 'string' && h.doc.pub);
    if (hits.length === 0) throw new BackendError('doctor_not_found', 'No doctor was found with this ID. Please check it with your doctor.');
    if (hits.length > 1) throw new BackendError('doctor_conflict', 'More than one account claims this Doctor ID. Please confirm the ID with your doctor.');
    this.doctorCache.set(hits[0].uid, hits[0].doc);
    return hits[0];
  }

  async lookupDoctor(raw: string): Promise<DoctorPublicInfo> {
    this.need('patient');
    return this.publicInfo((await this.findDoctor(raw)).doc);
  }

  /** Returns the patient's active doctor uid, cleaning up if the doctor ended the connection. */
  private async activeDoctorUid(s: Session): Promise<string | null> {
    const pd = await this.get<PatientDoc>(`pat/${s.uid}`);
    if (!pd?.linkActive || !pd.doctorUid) return null;
    const ended = await this.get<{ since: string }>(`doc/${pd.doctorUid}/x/${s.uid}`);
    const exists = await this.doctorDoc(pd.doctorUid, true);
    if ((ended && ended.since === pd.linkSince) || !exists) {
      await this.revokeShared(s);
      await this.patch(`pat/${s.uid}`, { doctorUid: null, linkActive: false, linkSince: null, sealedLink: null });
      return null;
    }
    return pd.doctorUid;
  }

  async connectToDoctor(raw: string): Promise<Connection> {
    const s = this.need('patient');
    const { uid: doctorUid } = await this.findDoctor(raw);
    const current = await this.activeDoctorUid(s);
    if (current === doctorUid) throw new BackendError('already_connected', 'You are already connected to this doctor.');
    if (current) throw new BackendError('has_doctor', 'You are already connected to a doctor. Disconnect first to connect to a new one.');
    const since = now();
    const payload: LinkPayload = { fullName: s.profile.fullName, prefs: s.profile.prefs.shareWithDoctor ? s.profile.prefs : null };
    const sealedLink = await seal(await this.pair(s.uid, doctorUid), payload, 'link');
    await this.patch(`pat/${s.uid}`, { doctorUid, linkActive: true, linkSince: since, sealedLink });
    return { id: `cn_${s.uid}_${since}`, patientId: this.pid(s), doctorUserId: `d_${doctorUid}`, createdAt: since, active: true };
  }

  /** Removes the doctor-readable copy of every shared consultation (the patient keeps their own copy). */
  private async revokeShared(s: Session) {
    for (const d of await this.query(`pat/${s.uid}/c`)) {
      const c = d.data() as unknown as SharedConsultDoc;
      if (c.sealed) await this.patch(`pat/${s.uid}/c/${d.id}`, { sealed: null, doctorUid: null });
    }
    for (const d of await this.query(`pat/${s.uid}/d`)) {
      if ((d.data() as unknown as DiaryDoc).sealed) await this.patch(`pat/${s.uid}/d/${d.id}`, { sealed: null, doctorUid: null });
    }
    for (const d of await this.query(`pat/${s.uid}/r`)) {
      if ((d.data() as unknown as RecordDoc).sealed) await this.patch(`pat/${s.uid}/r/${d.id}`, { sealed: null, doctorUid: null });
    }
  }

  async disconnectDoctor() {
    const s = this.need('patient');
    await this.revokeShared(s);
    await this.patch(`pat/${s.uid}`, { doctorUid: null, linkActive: false, linkSince: null, sealedLink: null });
  }

  async getMyDoctor(): Promise<DoctorPublicInfo | null> {
    const s = this.need('patient');
    const did = await this.activeDoctorUid(s);
    if (!did) return null;
    const d = await this.doctorDoc(did);
    return d ? this.publicInfo(d) : null;
  }

  private async linkedPatients(s: Session): Promise<{ uid: string; doc: PatientDoc; link: LinkPayload }[]> {
    const rows = await this.query('pat', [['doctorUid', '==', s.uid], ['linkActive', '==', true]]);
    const out: { uid: string; doc: PatientDoc; link: LinkPayload }[] = [];
    for (const r of rows) {
      const doc = r.data() as unknown as PatientDoc;
      if (!doc.sealedLink || !doc.pub) continue;
      const ended = await this.get<{ since: string }>(`doc/${s.uid}/x/${r.id}`);
      if (ended && ended.since === doc.linkSince) continue;
      try {
        const link = await open<LinkPayload>(await this.pair(r.id, s.uid), doc.sealedLink, 'link');
        out.push({ uid: r.id, doc, link });
      } catch { /* not decryptable by this doctor: not a real connection */ }
    }
    return out;
  }

  async listMyPatients(): Promise<PatientSummary[]> {
    const s = this.need('doctor');
    const pats = await this.linkedPatients(s);
    const out: PatientSummary[] = [];
    for (const p of pats) {
      const shared = (await this.query(`pat/${p.uid}/c`, [['doctorUid', '==', s.uid]])).filter((d) => (d.data() as unknown as SharedConsultDoc).sealed);
      out.push({
        profile: { id: `p_${p.uid}`, role: 'patient', fullName: p.link.fullName, email: '', createdAt: p.doc.linkSince ?? '' },
        connectedAt: p.doc.linkSince ?? '',
        preferences: p.link.prefs ?? undefined,
        consultationCount: shared.length,
      });
    }
    return out;
  }

  async disconnectPatient(patientId: string) {
    const s = this.need('doctor');
    const puid = patientId.replace(/^p_/, '');
    const p = (await this.linkedPatients(s)).find((x) => x.uid === puid);
    if (!p) throw new BackendError('not_found', 'This patient is not connected to you.');
    await this.put(`doc/${s.uid}/x/${puid}`, { since: p.doc.linkSince, at: now() });
  }

  async doctorStats(): Promise<DoctorStats> {
    this.need('doctor');
    const [pats, list] = await Promise.all([this.listMyPatients(), this.listConsultations()]);
    return {
      connectedPatients: pats.length,
      newCount: list.filter((v) => v.consultation.status === 'new').length,
      inReviewCount: list.filter((v) => v.consultation.status === 'in_review').length,
      completedCount: list.filter((v) => v.consultation.status === 'completed').length,
    };
  }

  // ---------- consultations ----------
  private draftPath(s: Session, id: string) { return `data/users/${s.uid}/patient/drafts/${id}`; }

  private async readDraft(s: Session, id: string): Promise<Consultation | null> {
    const d = await this.get<{ sealed: Sealed }>(this.draftPath(s, id));
    return d ? open<Consultation>(s.vault, d.sealed, 'draft') : null;
  }
  private async writeDraft(s: Session, c: Consultation) {
    await this.put(this.draftPath(s, c.id), { cid: c.id, updatedAt: c.updatedAt, sealed: await seal(s.vault, c, 'draft') });
  }

  async createConsultation(kind: 'consultation' | 'signal' = 'consultation'): Promise<Consultation> {
    const s = this.need('patient');
    const c: Consultation = {
      id: randomId('cs_'), patientId: this.pid(s), status: 'draft', regionIds: [], sensations: [],
      details: {}, answers: [], urgentGuidanceShown: false, createdAt: now(), updatedAt: now(),
      kind: kind === 'signal' ? 'signal' : 'consultation', audit: [{ at: now(), by: 'patient', action: 'created' }],
    };
    await this.writeDraft(s, c);
    return c;
  }

  async updateDraft(id: string, patch: {
    regionIds?: string[]; sensations?: Sensation[]; details?: SymptomDetails;
    answers?: ClarificationAnswer[]; draftSummaryText?: string; urgentGuidanceShown?: boolean;
    reconstruction?: Reconstruction; audit?: AuditEvent[];
  }): Promise<Consultation> {
    const s = this.need('patient');
    const c = await this.readDraft(s, id);
    if (!c) {
      if (await this.get(`pat/${s.uid}/c/${id}`)) throw new BackendError('locked', 'This consultation was already shared and can no longer be edited.');
      throw new BackendError('not_found', 'Consultation not found.');
    }
    if (patch.regionIds) c.regionIds = [...new Set(patch.regionIds.filter((r) => REGION_BY_ID[r]))];
    if (patch.sensations) c.sensations = [...new Set(patch.sensations.filter((x) => SENSATIONS.includes(x)))];
    if (patch.details) {
      const d = patch.details;
      const sev = d.severity === undefined ? undefined : Math.round(Number(d.severity));
      c.details = {
        severity: sev !== undefined && sev >= 1 && sev <= 10 ? sev : undefined,
        onset: clip(d.onset, 60) || undefined, duration: clip(d.duration, 60) || undefined,
        pattern: d.pattern === 'constant' || d.pattern === 'comes_and_goes' ? d.pattern : undefined,
        description: clip(d.description, 1000) || undefined, otherSensation: clip(d.otherSensation, 120) || undefined,
      };
    }
    if (patch.answers) c.answers = patch.answers.slice(0, 30).map((a) => ({ ...a, value: a.value ? clip(a.value, 300) : undefined }));
    if (patch.draftSummaryText !== undefined) c.draftSummaryText = clip(patch.draftSummaryText, 4000);
    if (patch.urgentGuidanceShown) c.urgentGuidanceShown = true;
    if (patch.reconstruction) c.reconstruction = cleanReconstruction(patch.reconstruction);
    if (patch.audit) c.audit = cleanAudit(patch.audit);
    c.updatedAt = now();
    await this.writeDraft(s, JSON.parse(JSON.stringify(c)));
    return c;
  }

  private validSummary(summary: Omit<ApprovedSummary, 'approvedAt'>): ApprovedSummary {
    const text = clip(summary.text, 4000);
    if (text.length < 5) throw new BackendError('invalid', 'The summary is empty. Please review it before sharing.');
    return JSON.parse(JSON.stringify({ ...summary, text, approvedAt: now() }));
  }

  async approveAndShare(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation> {
    const s = this.need('patient');
    const c = await this.readDraft(s, id);
    if (!c) throw new BackendError('locked', 'This consultation was already shared.');
    const did = await this.activeDoctorUid(s);
    if (!did) throw new BackendError('no_doctor', 'You are not connected to a doctor yet. Save it, then connect a doctor to send it.');
    const doctor = await this.doctorDoc(did);
    const audit = [...(c.audit ?? []), { at: now(), by: 'patient' as const, action: 'approved' }, { at: now(), by: 'patient' as const, action: 'shared', detail: doctor?.name }];
    const approved = this.validSummary(summary);
    approved.report.aiConsent = !!s.profile.prefs.aiAssist;
    const shared: Consultation = { ...c, approved, doctorUserId: `d_${did}`, sharedAt: now(), status: 'new', updatedAt: now(), audit: cleanAudit(audit) };
    const copy: PatientCopy = { consultation: shared, doctor: this.publicInfo(doctor!) };
    const doc: SharedConsultDoc = {
      cid: id, doctorUid: did, sharedAt: shared.sharedAt!, createdAt: c.createdAt,
      sealed: await seal(await this.pair(s.uid, did), shared, `c:${id}`),
      sealedSelf: await seal(s.vault, copy, `c:${id}`),
    };
    await this.put(`pat/${s.uid}/c/${id}`, doc);
    await this.del(this.draftPath(s, id));
    return shared;
  }

  async saveApprovedWithoutDoctor(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation> {
    const s = this.need('patient');
    const c = await this.readDraft(s, id);
    if (!c) throw new BackendError('locked', 'This consultation was already shared.');
    c.approved = this.validSummary(summary);
    c.updatedAt = now();
    await this.writeDraft(s, c);
    return c;
  }

  async cancelConsultation(id: string) {
    const s = this.need('patient');
    if (!(await this.readDraft(s, id))) throw new BackendError('locked', 'Shared consultations can’t be cancelled here. Message your doctor instead.');
    await this.del(this.draftPath(s, id));
  }

  private async statusOf(doctorUid: string, cid: string): Promise<StatusDoc | null> {
    return this.get<StatusDoc>(`doc/${doctorUid}/s/${cid}`);
  }

  /** Patient: own drafts + own shared consultations. Doctor: shared consultations of connected patients. */
  async listConsultations(): Promise<ConsultationView[]> {
    const s = this.need();
    const out: ConsultationView[] = [];
    if (s.role === 'patient') {
      for (const d of await this.query(`data/users/${s.uid}/patient/drafts`)) {
        try {
          const c = await open<Consultation>(s.vault, (d.data() as { sealed: Sealed }).sealed, 'draft');
          out.push({ consultation: c, patient: { id: this.pid(s), fullName: s.profile.fullName } });
        } catch { /* unreadable draft */ }
      }
      for (const d of await this.query(`pat/${s.uid}/c`)) {
        try { out.push(await this.patientShared(s, d.data() as unknown as SharedConsultDoc)); } catch { /* skip */ }
      }
    } else {
      for (const p of await this.linkedPatients(s)) {
        for (const d of await this.query(`pat/${p.uid}/c`, [['doctorUid', '==', s.uid]])) {
          const v = await this.doctorShared(s, p.uid, p.link.fullName, d.data() as unknown as SharedConsultDoc);
          if (v) out.push(v);
        }
      }
    }
    return out.sort((a, b) => b.consultation.updatedAt.localeCompare(a.consultation.updatedAt));
  }

  private async patientShared(s: Session, doc: SharedConsultDoc): Promise<ConsultationView> {
    const copy = await open<PatientCopy>(s.vault, doc.sealedSelf, `c:${doc.cid}`);
    const did = copy.consultation.doctorUserId!.replace(/^d_/, '');
    const st = await this.statusOf(did, doc.cid);
    const c = { ...copy.consultation };
    if (st && st.patientUid === s.uid) { c.status = st.status; c.updatedAt = st.updatedAt > c.updatedAt ? st.updatedAt : c.updatedAt; }
    return { consultation: c, patient: { id: this.pid(s), fullName: s.profile.fullName }, doctor: copy.doctor, viewedAt: st?.patientUid === s.uid ? st.viewedAt : undefined };
  }

  private async doctorShared(s: Session, puid: string, name: string, doc: SharedConsultDoc): Promise<ConsultationView | null> {
    if (!doc.sealed || doc.doctorUid !== s.uid) return null;
    try {
      const c = await open<Consultation>(await this.pair(puid, s.uid), doc.sealed, `c:${doc.cid}`);
      if (c.patientId !== `p_${puid}` || c.doctorUserId !== this.did(s)) return null; // must match where it is stored
      const st = await this.statusOf(s.uid, doc.cid);
      if (st) { c.status = st.status; c.updatedAt = st.updatedAt; }
      return { viewedAt: st?.viewedAt, consultation: c, patient: { id: `p_${puid}`, fullName: name }, doctor: { doctorId: s.acct.doctorId!, fullName: s.profile.fullName } };
    } catch { return null; }
  }

  async getConsultation(id: string): Promise<ConsultationView> {
    const s = this.need();
    if (s.role === 'patient') {
      const d = await this.readDraft(s, id);
      if (d) return { consultation: d, patient: { id: this.pid(s), fullName: s.profile.fullName } };
      const sh = await this.get<SharedConsultDoc>(`pat/${s.uid}/c/${id}`);
      if (sh) return this.patientShared(s, sh);
    } else {
      for (const p of await this.linkedPatients(s)) {
        const sh = await this.get<SharedConsultDoc>(`pat/${p.uid}/c/${id}`);
        if (sh) { const v = await this.doctorShared(s, p.uid, p.link.fullName, sh); if (v) return v; }
      }
    }
    throw new BackendError('not_found', 'Consultation not found.');
  }

  async setStatus(id: string, status: ConsultationStatus): Promise<Consultation> {
    const s = this.need('doctor');
    if (!['new', 'in_review', 'completed'].includes(status)) throw new BackendError('invalid', 'Invalid status.');
    const v = await this.getConsultation(id);
    const puid = v.patient.id.replace(/^p_/, '');
    const prev = await this.statusOf(s.uid, id);
    const from = prev?.status ?? 'new';
    if (from !== status) {
      const history = [...(prev?.history ?? []), { from, to: status, at: now() }].slice(-50);
      await this.put(`doc/${s.uid}/s/${id}`, { patientUid: puid, status, history, updatedAt: now(), viewedAt: prev?.viewedAt ?? now() });
    }
    return { ...v.consultation, status };
  }

  async statusHistory(id: string): Promise<StatusChange[]> {
    const v = await this.getConsultation(id);
    const c = v.consultation;
    const out: StatusChange[] = [{ id: 'h0', consultationId: id, from: null, to: 'draft', byUserId: c.patientId, at: c.createdAt }];
    if (c.sharedAt) out.push({ id: 'h1', consultationId: id, from: 'draft', to: 'new', byUserId: c.patientId, at: c.sharedAt });
    const did = c.doctorUserId?.replace(/^d_/, '');
    if (did) {
      const st = await this.statusOf(did, id);
      st?.history.forEach((h, i) => out.push({ id: `h${i + 2}`, consultationId: id, from: h.from, to: h.to, byUserId: c.doctorUserId!, at: h.at }));
    }
    return out;
  }

  // ---------- doctor notes (private, encrypted with the doctor's vault) ----------
  async listNotes(consultationId: string): Promise<DoctorNote[]> {
    const s = this.need('doctor');
    await this.getConsultation(consultationId);
    const out: DoctorNote[] = [];
    for (const d of await this.query(`data/users/${s.uid}/doctor/notes`, [['cid', '==', consultationId]])) {
      const row = d.data() as { cid: string; at: string; sealed: Sealed };
      try { out.push({ id: d.id, consultationId, doctorUserId: this.did(s), body: await open<string>(s.vault, row.sealed, 'note'), createdAt: row.at }); } catch { /* skip */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addNote(consultationId: string, body: string): Promise<DoctorNote> {
    const s = this.need('doctor');
    const text = clip(body, 2000);
    if (!text) throw new BackendError('invalid', 'Note is empty.');
    await this.getConsultation(consultationId);
    const id = randomId('nt_');
    const at = now();
    await this.put(`data/users/${s.uid}/doctor/notes/${id}`, { cid: consultationId, at, sealed: await seal(s.vault, text, 'note') });
    return { id, consultationId, doctorUserId: this.did(s), body: text, createdAt: at };
  }

  // ---------- clinical decision support (private to the doctor, encrypted with the doctor's vault) ----------
  async getClinicalReview(consultationId: string): Promise<ClinicalReview> {
    const s = this.need('doctor');
    await this.getConsultation(consultationId);
    const d = await this.get(`data/users/${s.uid}/doctor/reviews/${consultationId}`);
    if (!d) return newReview(consultationId);
    try { return cleanReview(await open<unknown>(s.vault, (d as { sealed: Sealed }).sealed, `review:${consultationId}`), consultationId); }
    catch { return newReview(consultationId); }
  }
  async saveClinicalReview(consultationId: string, review: ClinicalReview): Promise<ClinicalReview> {
    const s = this.need('doctor');
    await this.getConsultation(consultationId);
    const clean = { ...cleanReview(review, consultationId), updatedAt: now() };
    await this.put(`data/users/${s.uid}/doctor/reviews/${consultationId}`, { cid: consultationId, at: clean.updatedAt, sealed: await seal(s.vault, clean, `review:${consultationId}`) });
    return clean;
  }

  // ---------- symptom diary ----------
  async addDiaryEntry(input: DiaryInput): Promise<DiaryEntry> {
    const s = this.need('patient');
    const did = input.share ? await this.activeDoctorUid(s) : null;
    const e = cleanDiaryEntry({ ...input, id: (input.importId ?? '').replace(/[^\w-]/g, '') || randomId('dy_'), at: now(), sharedWith: did ? `d_${did}` : null });
    if (!e) throw new BackendError('invalid', 'The diary entry is empty.');
    const doc: DiaryDoc = {
      at: e.at, doctorUid: did,
      sealed: did ? await seal(await this.pair(s.uid, did), e, `diary:${e.id}`) : null,
      sealedSelf: await seal(s.vault, e, `diary:${e.id}`),
    };
    await this.put(`pat/${s.uid}/d/${e.id}`, doc);
    return e;
  }

  async listDiary(patientId?: string): Promise<DiaryEntry[]> {
    const s = this.need();
    const out: DiaryEntry[] = [];
    if (s.role === 'patient') {
      for (const d of await this.query(`pat/${s.uid}/d`)) {
        try { const e = cleanDiaryEntry(await open(s.vault, (d.data() as unknown as DiaryDoc).sealedSelf, `diary:${d.id}`)); if (e) out.push(e); } catch { /* unreadable */ }
      }
    } else {
      const puid = (patientId ?? '').replace(/^p_/, '');
      if (!(await this.linkedPatients(s)).some((p) => p.uid === puid)) throw new BackendError('not_found', 'This patient is not connected to you.');
      const key = await this.pair(puid, s.uid);
      for (const d of await this.query(`pat/${puid}/d`, [['doctorUid', '==', s.uid]])) {
        const doc = d.data() as unknown as DiaryDoc;
        if (!doc.sealed) continue;
        try { const e = cleanDiaryEntry(await open(key, doc.sealed, `diary:${d.id}`)); if (e && e.id === d.id) out.push(e); } catch { /* forged or unreadable */ }
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async deleteDiaryEntry(id: string): Promise<void> {
    const s = this.need('patient');
    await this.del(`pat/${s.uid}/d/${id.replace(/[^\w-]/g, '')}`);
  }

  // ---------- care records ----------
  async addRecord(kind: RecordKind, data: unknown, opts: { share?: boolean; by?: string; id?: string } = {}): Promise<PatientRecord> {
    const s = this.need('patient');
    if (!cleanRecordData(kind, data)) throw new BackendError('invalid', 'This record is incomplete.');
    const did = opts.share && kind !== 'card' ? await this.activeDoctorUid(s) : null;
    const id = (opts.id ?? '').replace(/[^\w-]/g, '') || randomId(`${kind[0]}r_`);
    const r = cleanRecord({ id, kind, at: now(), data, sharedWith: did ? `d_${did}` : null, by: opts.by ?? '' });
    if (!r) throw new BackendError('invalid', 'This record is incomplete.');
    if (kind === 'card') for (const d of await this.query(`pat/${s.uid}/r`, [['kind', '==', 'card']])) if (d.id !== r.id) await this.del(`pat/${s.uid}/r/${d.id}`);
    const doc: RecordDoc = {
      kind, at: r.at, doctorUid: did,
      sealed: did ? await seal(await this.pair(s.uid, did), r, `rec:${r.id}`) : null,
      sealedSelf: await seal(s.vault, r, `rec:${r.id}`),
    };
    await this.put(`pat/${s.uid}/r/${r.id}`, doc);
    return r;
  }

  async listRecords(kind: RecordKind, patientId?: string): Promise<PatientRecord[]> {
    const s = this.need();
    const out: PatientRecord[] = [];
    if (s.role === 'patient') {
      for (const d of await this.query(`pat/${s.uid}/r`, [['kind', '==', kind]])) {
        try { const r = cleanRecord(await open(s.vault, (d.data() as unknown as RecordDoc).sealedSelf, `rec:${d.id}`)); if (r && r.kind === kind) out.push(r); } catch { /* unreadable */ }
      }
    } else if (s.role === 'doctor') {
      const puid = (patientId ?? '').replace(/^p_/, '');
      if (kind === 'card' || !(await this.linkedPatients(s)).some((p) => p.uid === puid)) throw new BackendError('not_found', 'This patient is not connected to you.');
      const key = await this.pair(puid, s.uid);
      for (const d of await this.query(`pat/${puid}/r`, [['doctorUid', '==', s.uid]])) {
        const doc = d.data() as unknown as RecordDoc;
        if (!doc.sealed || doc.kind !== kind) continue;
        try { const r = cleanRecord(await open(key, doc.sealed, `rec:${d.id}`)); if (r && r.id === d.id && r.kind === kind) out.push(r); } catch { /* forged or unreadable */ }
      }
    } else throw new BackendError('forbidden', 'Caregivers see the summary the patient shares with them.');
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async deleteRecord(id: string): Promise<void> {
    const s = this.need('patient');
    await this.del(`pat/${s.uid}/r/${id.replace(/[^\w-]/g, '')}`);
  }

  // ---------- caregivers ----------
  private async findCaregiver(raw: string): Promise<{ uid: string; doc: CaregiverDoc }> {
    const code = normalizeCaregiverId(raw);
    if (!CAREGIVER_ID_PATTERN.test(code)) throw new BackendError('invalid_caregiver_id', 'A Caregiver ID looks like CG-ABCD-2345.');
    const rows = await this.query('cg', [['caregiverId', '==', code]]);
    const r = rows[0];
    if (!r) throw new BackendError('caregiver_not_found', 'No caregiver has this ID. Check it with them.');
    return { uid: r.id, doc: r.data() as unknown as CaregiverDoc };
  }
  private async myCgUids(s: Session): Promise<string[]> {
    const p = await this.get<PatientDoc>(`pat/${s.uid}`);
    return Array.isArray(p?.cgUids) ? p!.cgUids!.filter((x) => typeof x === 'string') : [];
  }
  async lookupCaregiver(raw: string): Promise<{ name: string }> {
    this.need('patient');
    return { name: (await this.findCaregiver(raw)).doc.name };
  }
  async connectCaregiver(raw: string): Promise<CaregiverLink> {
    const s = this.need('patient');
    const { uid, doc } = await this.findCaregiver(raw);
    const list = await this.myCgUids(s);
    if (!list.includes(uid) && list.length >= 3) throw new BackendError('too_many', 'You can link up to 3 caregivers.');
    const since = now();
    const key = await this.cgPair(s.uid, uid);
    const link: CareLinkDoc = { since, at: since, sealedName: await seal(key, { name: s.profile.fullName }, 'cgname'), sealedDigest: null };
    await this.put(`pat/${s.uid}/g/${uid}`, link);
    if (!list.includes(uid)) await this.patch(`pat/${s.uid}`, { cgUids: [...list, uid] });
    return { id: `c_${uid}`, name: doc.name, caregiverId: doc.caregiverId, since };
  }
  async listMyCaregivers(): Promise<CaregiverLink[]> {
    const s = this.need('patient');
    const out: CaregiverLink[] = [];
    for (const uid of await this.myCgUids(s)) {
      const d = await this.get<CaregiverDoc>(`cg/${uid}`);
      const l = await this.get<CareLinkDoc>(`pat/${s.uid}/g/${uid}`);
      if (d && l) out.push({ id: `c_${uid}`, name: d.name, caregiverId: d.caregiverId, since: l.since });
    }
    return out;
  }
  async removeCaregiver(id: string): Promise<void> {
    const s = this.need('patient');
    const uid = id.replace(/^c_/, '');
    await this.del(`pat/${s.uid}/g/${uid}`);
    await this.patch(`pat/${s.uid}`, { cgUids: (await this.myCgUids(s)).filter((x) => x !== uid) });
  }
  async publishCareDigest(digest: CareDigest): Promise<void> {
    const s = this.need('patient');
    const d = cleanDigest(digest);
    for (const uid of await this.myCgUids(s)) {
      const l = await this.get<CareLinkDoc>(`pat/${s.uid}/g/${uid}`);
      if (!l) continue;
      try { await this.patch(`pat/${s.uid}/g/${uid}`, { at: now(), sealedDigest: d ? await seal(await this.cgPair(s.uid, uid), d, 'digest') : null }); } catch { /* caregiver account removed */ }
    }
  }
  async pendingCaregiverItems(): Promise<{ item: CaregiverItem; caregiver: CaregiverLink }[]> {
    const s = this.need('patient');
    const have = new Set<string>([...(await this.query(`pat/${s.uid}/r`)).map((d) => d.id), ...(await this.query(`pat/${s.uid}/d`)).map((d) => d.id)]);
    const out: { item: CaregiverItem; caregiver: CaregiverLink }[] = [];
    for (const link of await this.listMyCaregivers()) {
      const uid = link.id.replace(/^c_/, '');
      let key: CryptoKey;
      try { key = await this.cgPair(s.uid, uid); } catch { continue; }
      for (const d of await this.query(`cg/${uid}/o`, [['puid', '==', s.uid]])) {
        if (have.has(d.id)) continue;
        try { const it = cleanCaregiverItem(await open(key, (d.data() as unknown as OutboxDoc).sealed, `cgitem:${d.id}`)); if (it && it.id === d.id) out.push({ item: it, caregiver: link }); } catch { /* forged or unreadable */ }
      }
    }
    return out.sort((a, b) => a.item.at.localeCompare(b.item.at));
  }
  async listCaredPatients(): Promise<{ id: string; name: string; digest: CareDigest | null; since: string }[]> {
    const s = this.need('caregiver');
    const out: { id: string; name: string; digest: CareDigest | null; since: string }[] = [];
    for (const r of await this.query('pat', [['cgUids', 'array-contains', s.uid]])) {
      const l = await this.get<CareLinkDoc>(`pat/${r.id}/g/${s.uid}`);
      if (!l) continue;
      try {
        const key = await this.cgPair(r.id, s.uid);
        const { name } = await open<{ name: string }>(key, l.sealedName, 'cgname');
        const digest = l.sealedDigest ? cleanDigest(await open(key, l.sealedDigest, 'digest')) : null;
        out.push({ id: `p_${r.id}`, name: String(name ?? 'Patient').slice(0, 80), digest, since: l.since });
      } catch { /* not decryptable: not a real link */ }
    }
    return out;
  }
  async caregiverAdd(patientId: string, input: Omit<CaregiverItem, 'id' | 'at'>): Promise<CaregiverItem> {
    const s = this.need('caregiver');
    const puid = patientId.replace(/^p_/, '');
    const p = await this.get<PatientDoc>(`pat/${puid}`);
    if (!p?.cgUids?.includes(s.uid) || !(await this.get<CareLinkDoc>(`pat/${puid}/g/${s.uid}`))) throw new BackendError('not_found', 'This person has not linked you as their caregiver.');
    const item = cleanCaregiverItem({ ...input, id: randomId('cg_'), at: now() });
    if (!item) throw new BackendError('invalid', 'This check-in is incomplete.');
    const doc: OutboxDoc = { puid, at: item.at, sealed: await seal(await this.cgPair(puid, s.uid), item, `cgitem:${item.id}`) };
    await this.put(`cg/${s.uid}/o/${item.id}`, doc);
    return item;
  }

  // ---------- messaging (pair-encrypted, each side writes only its own) ----------
  async listMessages(consultationId: string): Promise<Message[]> {
    const s = this.need();
    const v = await this.getConsultation(consultationId);
    if (v.consultation.status === 'draft') return [];
    const puid = v.patient.id.replace(/^p_/, '');
    const did = v.consultation.doctorUserId?.replace(/^d_/, '');
    if (!did) return [];
    const key = await this.pair(puid, did);
    const rows: { doc: MsgDoc; id: string; role: Role }[] = [];
    for (const d of await this.query(`pat/${puid}/m`, [['cid', '==', consultationId]])) rows.push({ doc: d.data() as unknown as MsgDoc, id: d.id, role: 'patient' });
    for (const d of await this.query(`doc/${did}/m`, [['cid', '==', consultationId], ['pid', '==', puid]])) rows.push({ doc: d.data() as unknown as MsgDoc, id: d.id, role: 'doctor' });
    const out: Message[] = [];
    for (const r of rows) {
      try {
        const m = await open<{ body: string; kind: Message['kind']; meta?: MessageMeta }>(key, r.doc.sealed, `m:${consultationId}:${r.role}`);
        const meta = cleanMeta(m.meta, messageKindFor(r.role, m.kind));
        const kind = readKind(messageKindFor(r.role, m.kind), meta);
        out.push({
          id: r.id, consultationId, senderId: r.role === 'patient' ? `p_${puid}` : `d_${did}`, senderRole: r.role,
          body: m.body, kind, createdAt: r.doc.at, ...(meta ? { meta } : {}),
        });
      } catch { /* forged or unreadable message: ignored */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendMessage(consultationId: string, body: string, kindIn: Message['kind'] = 'text', metaIn?: MessageMeta): Promise<Message> {
    const s = this.need();
    const text = clip(body, 2000);
    if (!text) throw new BackendError('invalid', 'Message is empty.');
    const kind = messageKindFor(s.role, kindIn);
    const meta = cleanMeta(metaIn, kind);
    requireValidRx(kind, meta);
    const v = await this.getConsultation(consultationId);
    if (v.consultation.status === 'draft') throw new BackendError('not_shared', 'Share this consultation with your doctor before messaging.');
    const puid = v.patient.id.replace(/^p_/, '');
    const did = v.consultation.doctorUserId!.replace(/^d_/, '');
    if (s.role === 'patient' && (await this.activeDoctorUid(s)) !== did) {
      throw new BackendError('not_connected', 'You are no longer connected to this doctor.');
    }
    const id = randomId('ms_');
    const at = now();
    const sealed = await seal(await this.pair(puid, did), { body: text, kind, ...(meta ? { meta } : {}) }, `m:${consultationId}:${s.role}`);
    const path = s.role === 'patient' ? `pat/${s.uid}/m/${id}` : `doc/${s.uid}/m/${id}`;
    await this.put(path, { cid: consultationId, pid: puid, at, sealed });
    return { id, consultationId, senderId: s.role === 'patient' ? this.pid(s) : this.did(s), senderRole: s.role, body: text, kind, createdAt: at, ...(meta ? { meta } : {}) };
  }

  /** Doctor opened a shared consultation: recorded once per status document (audit). */
  async markViewed(consultationId: string): Promise<void> {
    const s = this.need('doctor');
    const v = await this.getConsultation(consultationId);
    const prev = await this.statusOf(s.uid, consultationId);
    if (prev?.viewedAt) return;
    const puid = v.patient.id.replace(/^p_/, '');
    await this.put(`doc/${s.uid}/s/${consultationId}`, prev ? { ...prev, viewedAt: now() } : { patientUid: puid, status: 'new', history: [], updatedAt: v.consultation.sharedAt ?? now(), viewedAt: now() });
  }

  // ---------- live updates ----------
  onChange(cb: () => void): () => void {
    const s = this.s;
    if (!s) return () => {};
    const subs: Unsub[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => { clearTimeout(timer); timer = setTimeout(cb, 250); };
    const watch = (sub: () => Unsub) => { try { subs.push(sub()); } catch { /* ignore */ } };
    // skip each subscription's first delivery (it is the current state)
    const skipFirst = <T,>(fn: (x: T) => void) => { let first = true; return (x: T) => { if (first) { first = false; return; } fn(x); }; };
    const onErr = () => {};
    let inner: Unsub[] = [];
    const resetInner = () => { inner.forEach((u) => u()); inner = []; };

    if (s.role === 'patient') {
      const follow = (did: string | null) => {
        resetInner();
        if (!did) return;
        const add = (u: () => Unsub) => { try { inner.push(u()); } catch { /* ignore */ } };
        add(() => this.db.collection(`doc/${did}/s`).where('patientUid', '==', s.uid).onSnapshot(skipFirst(fire), onErr));
        add(() => this.db.collection(`doc/${did}/m`).where('pid', '==', s.uid).onSnapshot(skipFirst(fire), onErr));
        add(() => this.db.doc(`doc/${did}/x/${s.uid}`).onSnapshot(skipFirst(fire), onErr));
      };
      let lastDid: string | null | undefined;
      watch(() => this.db.doc(`pat/${s.uid}`).onSnapshot((snap) => {
        const d = snap.exists ? (snap.data() as unknown as PatientDoc) : null;
        const did = d?.linkActive ? d.doctorUid : null;
        if (lastDid !== undefined && did !== lastDid) fire();
        if (did !== lastDid) follow(did);
        lastDid = did;
      }, onErr));
    } else {
      let key = '';
      watch(() => this.db.collection('pat').where('doctorUid', '==', s.uid).onSnapshot((snap) => {
        const ids = snap.docs.map((d) => d.id).sort();
        const k = ids.join(',');
        if (key && snap.docs.length >= 0) fire();
        if (k !== key) {
          resetInner();
          for (const pid of ids.slice(0, 30)) {
            try { inner.push(this.db.collection(`pat/${pid}/c`).where('doctorUid', '==', s.uid).onSnapshot(skipFirst(fire), onErr)); } catch { /* */ }
            try { inner.push(this.db.collection(`pat/${pid}/m`).onSnapshot(skipFirst(fire), onErr)); } catch { /* */ }
            try { inner.push(this.db.collection(`pat/${pid}/d`).where('doctorUid', '==', s.uid).onSnapshot(skipFirst(fire), onErr)); } catch { /* */ }
          }
        }
        key = k || 'none';
      }, onErr));
    }
    return () => { clearTimeout(timer); subs.forEach((u) => u()); resetInner(); };
  }
}
