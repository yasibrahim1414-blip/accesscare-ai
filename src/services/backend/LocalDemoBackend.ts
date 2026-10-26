// LocalDemoBackend — single-device demonstration backend.
//
// IMPORTANT: this is NOT production-secure. It runs inside the app, so a
// determined user with developer tools could edit stored data. It exists so
// the full patient → doctor workflow can be tried on one device. It does:
//   * hash passwords with PBKDF2-SHA256 + per-user salt (never plain text)
//   * derive the acting user from the session, never from screen input
//   * apply the same authorization rules the Supabase RLS policies enforce
// It does NOT sync between devices. Patient and doctor take turns signing in
// on the same device (the "Switch account" shortcut makes this quick).

import type {
  AuthInfo, Backend, ConsultationView, DiaryInput, DoctorStats, Me, PatientSummary, SignInInput, SignUpInput,
} from './Backend';
import { BackendError } from './Backend';
import type {
  ApprovedSummary, ClarificationAnswer, CommunicationPreferences, Connection, Consultation,
  ConsultationStatus, DoctorNote, DoctorProfile, DoctorPublicInfo, Message, Profile, Role,
  Sensation, Session, StatusChange, SymptomDetails, AuditEvent, MessageMeta,
} from '../../domain/types';
import { DEFAULT_PREFERENCES, cleanPreferences } from '../../domain/types';
import { REGION_BY_ID } from '../../domain/bodyRegions';
import type { KeyValueStore } from '../storage';
import { cleanAudit, cleanMeta, cleanReconstruction, messageKindFor, readKind, requireValidRx } from './sanitize';
import { cleanReview, newReview, type ClinicalReview } from '../../domain/clinical';
import type { Reconstruction } from '../../domain/reconstruction';
import { cleanDiaryEntry, type DiaryEntry } from '../../domain/diary';
import {
  CAREGIVER_ID_PATTERN, cleanCaregiverItem, cleanDigest, cleanRecord, cleanRecordData, generateCaregiverId, normalizeCaregiverId,
  type CareDigest, type CaregiverItem, type CaregiverLink, type PatientRecord, type RecordKind,
} from '../../domain/care';
import {
  DOCTOR_ID_PATTERN, PBKDF2_ITERATIONS, generateDoctorId, hashPassword, normalizeDoctorId,
  randomId, randomSalt, safeEqual, generatePatientId, normalizePatientId, generateRecoveryCode, normalizeRecoveryCode,
} from '../crypto';

interface Credential { userId: string; email: string; salt: string; hash: string; iterations: number; recovery?: { salt: string; hash: string } }

interface DB {
  version: 1;
  credentials: Credential[];
  profiles: Profile[];
  doctorProfiles: DoctorProfile[];
  preferences: Record<string, CommunicationPreferences>;
  connections: Connection[];
  consultations: Consultation[];
  statusHistory: StatusChange[];
  messages: Message[];
  notes: DoctorNote[];
  /** doctor-private clinical reviews, key `<doctorUserId>:<consultationId>` */
  reviews?: Record<string, ClinicalReview>;
  demoUserIds: string[];
  views?: Record<string, string>;
  diary?: (DiaryEntry & { patientId: string })[];
  records?: (PatientRecord & { patientId: string })[];
  caregivers?: { userId: string; caregiverId: string }[];
  careLinks?: { patientId: string; caregiverUserId: string; since: string; active: boolean; digest: CareDigest | null }[];
  careOutbox?: (CaregiverItem & { patientId: string; caregiverUserId: string })[];
}

const DB_KEY = 'accesscare.db.v1';
const SESSION_KEY = 'accesscare.session.v1';
const SESSION_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SENSATIONS: Sensation[] = ['pain', 'numbness', 'burning', 'itching', 'swelling', 'weakness', 'tingling', 'other', 'not_sure'];
const DOCTOR_SETTABLE: ConsultationStatus[] = ['new', 'in_review', 'completed'];

const emptyDb = (): DB => ({
  version: 1, credentials: [], profiles: [], doctorProfiles: [], preferences: {},
  connections: [], consultations: [], statusHistory: [], messages: [], notes: [], demoUserIds: [],
});

const now = () => new Date().toISOString();
const clip = (s: string | undefined, max: number) => (s ?? '').trim().slice(0, max);

export class LocalDemoBackend implements Backend {
  readonly mode = 'local-demo' as const;
  readonly shared = false;
  private session: Session | null = null;

  async authInfo(): Promise<AuthInfo> { return { kind: 'email-password' }; }

  constructor(private store: KeyValueStore, private iterations = PBKDF2_ITERATIONS) {}

  get persistent() { return this.store.persistent; }

  // ---------- storage ----------
  private load(): DB {
    const raw = this.store.get(DB_KEY);
    if (!raw) return emptyDb();
    try {
      const parsed = JSON.parse(raw) as DB;
      return parsed && parsed.version === 1 ? { ...emptyDb(), ...parsed } : emptyDb();
    } catch { return emptyDb(); }
  }
  private save(db: DB) { this.store.set(DB_KEY, JSON.stringify(db)); }
  private tx<T>(fn: (db: DB) => T): T {
    const db = this.load();
    const result = fn(db);
    this.save(db);
    return result;
  }

  // ---------- session helpers ----------
  private requireSession(role?: Role): Session {
    if (!this.session) throw new BackendError('unauthenticated', 'Please sign in again.');
    if (new Date(this.session.expiresAt) < new Date()) {
      this.session = null;
      this.store.remove(SESSION_KEY);
      throw new BackendError('session_expired', 'Your session expired. Please sign in again.');
    }
    if (role && this.session.role !== role) {
      throw new BackendError('forbidden', role === 'doctor'
        ? 'Only doctor accounts can do this.' : role === 'caregiver' ? 'Only caregiver accounts can do this.' : 'Only patient accounts can do this.');
    }
    return this.session;
  }

  private startSession(userId: string, role: Role) {
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    this.session = { userId, role, expiresAt: expires };
    this.store.set(SESSION_KEY, JSON.stringify(this.session));
  }

  private me(db: DB, userId: string): Me {
    const profile = db.profiles.find((p) => p.id === userId);
    if (!profile) throw new BackendError('not_found', 'Account not found.');
    return {
      profile,
      doctor: db.doctorProfiles.find((d) => d.userId === userId),
      ...(profile.role === 'caregiver' ? { caregiverId: db.caregivers?.find((c) => c.userId === userId)?.caregiverId } : {}),
      preferences: cleanPreferences(db.preferences[userId]),
    };
  }

  private activeConnection(db: DB, patientId: string): Connection | undefined {
    return db.connections.find((c) => c.patientId === patientId && c.active);
  }

  private publicDoctor(db: DB, doctorUserId: string): DoctorPublicInfo | undefined {
    const d = db.doctorProfiles.find((x) => x.userId === doctorUserId);
    const p = db.profiles.find((x) => x.id === doctorUserId);
    if (!d || !p) return undefined;
    return { doctorId: d.doctorId, fullName: p.fullName, specialty: d.specialty, clinic: d.clinic };
  }

  /** Mirrors the RLS rule: patient owns it, or it was shared with the doctor while connected. */
  private canAccess(db: DB, s: Session, c: Consultation): boolean {
    if (s.role === 'patient') return c.patientId === s.userId;
    if (c.doctorUserId !== s.userId || c.status === 'draft') return false;
    const conn = this.activeConnection(db, c.patientId);
    return !!conn && conn.doctorUserId === s.userId;
  }

  private getAccessible(db: DB, s: Session, id: string): Consultation {
    const c = db.consultations.find((x) => x.id === id);
    if (!c || !this.canAccess(db, s, c)) {
      // same error for "missing" and "not yours" so IDs can't be probed
      throw new BackendError('not_found', 'Consultation not found.');
    }
    return c;
  }

  private view(db: DB, c: Consultation): ConsultationView {
    const p = db.profiles.find((x) => x.id === c.patientId);
    return {
      consultation: c, viewedAt: db.views?.[c.id],
      patient: { id: c.patientId, fullName: p?.fullName ?? 'Deleted patient' },
      doctor: c.doctorUserId ? this.publicDoctor(db, c.doctorUserId) : undefined,
    };
  }

  private logStatus(db: DB, c: Consultation, to: ConsultationStatus, by: string) {
    db.statusHistory.push({ id: randomId('st_'), consultationId: c.id, from: c.status, to, byUserId: by, at: now() });
    c.status = to;
    c.updatedAt = now();
  }

  // ---------- auth ----------
  async signUp(input: SignUpInput): Promise<Me> {
    const fullName = clip(input.fullName, 80);
    let email = clip(input.email, 120).toLowerCase();
    if (input.role !== 'patient' && input.role !== 'doctor' && input.role !== 'caregiver') throw new BackendError('invalid', 'Choose Patient, Doctor or Caregiver.');
    if (fullName.length < 2) throw new BackendError('invalid_name', 'Please enter your full name.');
    // patients may sign up without an email: they then sign in with their Patient ID + password
    let patientCode: string | undefined;
    if (input.role === 'patient') {
      const taken = new Set(this.load().profiles.map((p) => p.patientCode));
      do { patientCode = generatePatientId(); } while (taken.has(patientCode));
      if (!email) email = patientCode.toLowerCase();
    }
    if (!EMAIL_RE.test(email) && email !== patientCode?.toLowerCase()) throw new BackendError('invalid_email', 'Please enter a valid email address.');
    if ((input.password ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    if (this.load().credentials.some((c) => c.email === email)) {
      throw new BackendError('email_taken', 'An account with this email already exists. Try signing in.');
    }
    const salt = randomSalt();
    const hash = await hashPassword(input.password, salt, this.iterations);
    const userId = randomId('u_');
    const me = this.tx((db) => {
      if (db.credentials.some((c) => c.email === email)) throw new BackendError('email_taken', 'An account with this email already exists.');
      db.credentials.push({ userId, email, salt, hash, iterations: this.iterations });
      db.profiles.push({ id: userId, role: input.role, fullName, email: email === patientCode?.toLowerCase() ? '' : email, createdAt: now(), ...(patientCode ? { patientCode } : {}) });
      db.preferences[userId] = { ...DEFAULT_PREFERENCES };
      if (input.role === 'caregiver') {
        db.caregivers = db.caregivers ?? [];
        let id = generateCaregiverId();
        while (db.caregivers.some((c) => c.caregiverId === id)) id = generateCaregiverId();
        db.caregivers.push({ userId, caregiverId: id });
      }
      if (input.role === 'doctor') {
        let doctorId = generateDoctorId();
        let guard = 0;
        while (db.doctorProfiles.some((d) => d.doctorId === doctorId)) {
          if (++guard > 50) throw new BackendError('id_generation', 'Could not generate a Doctor ID. Please retry.');
          doctorId = generateDoctorId();
        }
        db.doctorProfiles.push({
          userId, doctorId, specialty: clip(input.specialty, 60) || undefined, clinic: clip(input.clinic, 80) || undefined,
        });
      }
      return this.me(db, userId);
    });
    this.startSession(userId, input.role);
    return me;
  }

  async signIn({ email: emailRaw, password }: SignInInput): Promise<Me> {
    const db = this.load();
    const cred = this.findCred(db, emailRaw);
    // hash even when the account is missing so timing doesn't reveal accounts
    const hash = await hashPassword(password ?? '', cred?.salt ?? 'no-account-salt', cred?.iterations ?? this.iterations);
    if (!cred || !safeEqual(hash, cred.hash)) {
      throw new BackendError('invalid_credentials', 'Email or password is incorrect.');
    }
    const me = this.me(db, cred.userId);
    this.startSession(cred.userId, me.profile.role);
    return me;
  }

  /** login identifier: email, or the Patient ID for accounts created without one */
  private findCred(db: DB, loginRaw?: string): Credential | undefined {
    const login = clip(loginRaw, 120).toLowerCase();
    const byEmail = db.credentials.find((c) => c.email === login);
    if (byEmail) return byEmail;
    if (/^ac-?pat/i.test(login.replace(/\s/g, ''))) {
      const code = normalizePatientId(login);
      const p = db.profiles.find((x) => x.patientCode === code);
      return p ? db.credentials.find((c) => c.userId === p.id) : undefined;
    }
    return undefined;
  }

  async createRecoveryCode(): Promise<string> {
    const s = this.requireSession();
    const code = generateRecoveryCode();
    const salt = randomSalt();
    const hash = await hashPassword(code, salt, this.iterations);
    this.tx((db) => { const c = db.credentials.find((x) => x.userId === s.userId); if (c) c.recovery = { salt, hash }; });
    return code;
  }

  async recoverAccount(input: { login?: string; recoveryCode: string; newPassword: string }): Promise<Me> {
    if ((input.newPassword ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    const db = this.load();
    const cred = this.findCred(db, input.login);
    const code = normalizeRecoveryCode(input.recoveryCode ?? '');
    const h = await hashPassword(code, cred?.recovery?.salt ?? 'no-recovery-salt', this.iterations);
    if (!cred?.recovery || !safeEqual(h, cred.recovery.hash)) throw new BackendError('invalid_credentials', 'That Patient ID, email or recovery code is not correct.');
    const salt = randomSalt();
    const hash = await hashPassword(input.newPassword, salt, this.iterations);
    // the recovery code is single-use
    this.tx((d) => { const c = d.credentials.find((x) => x.userId === cred.userId)!; c.salt = salt; c.hash = hash; c.iterations = this.iterations; delete c.recovery; });
    const me = this.me(this.load(), cred.userId);
    this.startSession(cred.userId, me.profile.role);
    return me;
  }

  async signOut() {
    this.session = null;
    this.store.remove(SESSION_KEY);
  }

  async restoreSession(): Promise<Me | null> {
    const raw = this.store.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as Session;
      if (new Date(s.expiresAt) < new Date()) { this.store.remove(SESSION_KEY); return null; }
      const db = this.load();
      const profile = db.profiles.find((p) => p.id === s.userId);
      if (!profile) { this.store.remove(SESSION_KEY); return null; }
      // role always comes from the stored profile, not the session blob
      this.session = { ...s, role: profile.role };
      return this.me(db, s.userId);
    } catch { this.store.remove(SESSION_KEY); return null; }
  }

  async requestPasswordReset(): Promise<{ supported: boolean }> {
    return { supported: false }; // needs an email-capable auth provider (Supabase)
  }

  async deleteAccount(password: string): Promise<void> {
    const s = this.requireSession();
    const db = this.load();
    const cred = db.credentials.find((c) => c.userId === s.userId);
    if (!cred) throw new BackendError('not_found', 'Account not found.');
    const hash = await hashPassword(password ?? '', cred.salt, cred.iterations);
    if (!safeEqual(hash, cred.hash)) throw new BackendError('invalid_credentials', 'Password is incorrect.');
    this.tx((d) => {
      const uid = s.userId;
      d.credentials = d.credentials.filter((c) => c.userId !== uid);
      d.profiles = d.profiles.filter((p) => p.id !== uid);
      delete d.preferences[uid];
      if (s.role === 'patient') {
        const mine = new Set(d.consultations.filter((c) => c.patientId === uid).map((c) => c.id));
        d.consultations = d.consultations.filter((c) => !mine.has(c.id));
        d.messages = d.messages.filter((m) => !mine.has(m.consultationId));
        d.notes = d.notes.filter((n) => !mine.has(n.consultationId));
        if (d.reviews) for (const k of Object.keys(d.reviews)) if (mine.has(k.split(':').slice(1).join(':'))) delete d.reviews[k];
        d.statusHistory = d.statusHistory.filter((h) => !mine.has(h.consultationId));
        d.diary = (d.diary ?? []).filter((e) => e.patientId !== uid);
        d.records = (d.records ?? []).filter((e) => e.patientId !== uid);
        d.careLinks = (d.careLinks ?? []).filter((l) => l.patientId !== uid);
        d.careOutbox = (d.careOutbox ?? []).filter((l) => l.patientId !== uid);
        d.connections = d.connections.filter((c) => c.patientId !== uid);
      } else if (s.role === 'caregiver') {
        d.caregivers = (d.caregivers ?? []).filter((c) => c.userId !== uid);
        d.careLinks = (d.careLinks ?? []).filter((l) => l.caregiverUserId !== uid);
        d.careOutbox = (d.careOutbox ?? []).filter((l) => l.caregiverUserId !== uid);
      } else {
        d.doctorProfiles = d.doctorProfiles.filter((x) => x.userId !== uid);
        d.notes = d.notes.filter((n) => n.doctorUserId !== uid);
        if (d.reviews) for (const k of Object.keys(d.reviews)) if (k.startsWith(`${uid}:`)) delete d.reviews[k];
        d.connections.forEach((c) => { if (c.doctorUserId === uid) c.active = false; });
      }
      d.demoUserIds = d.demoUserIds.filter((x) => x !== uid);
    });
    await this.signOut();
  }

  async updateProfile(patch: { fullName?: string; specialty?: string; clinic?: string }): Promise<Me> {
    const s = this.requireSession();
    return this.tx((db) => {
      const p = db.profiles.find((x) => x.id === s.userId)!;
      if (patch.fullName !== undefined) {
        const n = clip(patch.fullName, 80);
        if (n.length < 2) throw new BackendError('invalid_name', 'Please enter your full name.');
        p.fullName = n;
      }
      if (s.role === 'doctor') {
        const d = db.doctorProfiles.find((x) => x.userId === s.userId)!;
        if (patch.specialty !== undefined) d.specialty = clip(patch.specialty, 60) || undefined;
        if (patch.clinic !== undefined) d.clinic = clip(patch.clinic, 80) || undefined;
        // doctorId is intentionally not editable
      }
      return this.me(db, s.userId);
    });
  }

  async savePreferences(prefs: CommunicationPreferences): Promise<CommunicationPreferences> {
    const s = this.requireSession();
    const clean = cleanPreferences(prefs);
    return this.tx((db) => { db.preferences[s.userId] = clean; return clean; });
  }

  // ---------- doctor id + connections ----------
  async lookupDoctor(raw: string): Promise<DoctorPublicInfo> {
    this.requireSession('patient');
    const id = normalizeDoctorId(raw);
    if (!DOCTOR_ID_PATTERN.test(id)) {
      throw new BackendError('invalid_format', 'That doesn’t look like a Doctor ID. It should look like AC-DOC-7K4P9X.');
    }
    const db = this.load();
    const d = db.doctorProfiles.find((x) => x.doctorId === id);
    if (!d) throw new BackendError('doctor_not_found', 'No doctor was found with this ID. Please check it with your doctor.');
    return this.publicDoctor(db, d.userId)!;
  }

  async connectToDoctor(raw: string): Promise<Connection> {
    const s = this.requireSession('patient');
    const id = normalizeDoctorId(raw);
    return this.tx((db) => {
      const d = db.doctorProfiles.find((x) => x.doctorId === id);
      if (!d) throw new BackendError('doctor_not_found', 'No doctor was found with this ID.');
      const existing = this.activeConnection(db, s.userId);
      if (existing && existing.doctorUserId === d.userId) {
        throw new BackendError('already_connected', 'You are already connected to this doctor.');
      }
      if (existing) {
        throw new BackendError('has_doctor', 'You are already connected to a doctor. Disconnect first to connect to a new one.');
      }
      const conn: Connection = { id: randomId('cn_'), patientId: s.userId, doctorUserId: d.userId, createdAt: now(), active: true };
      db.connections.push(conn);
      return conn;
    });
  }

  async disconnectDoctor() {
    const s = this.requireSession('patient');
    this.tx((db) => { db.connections.forEach((c) => { if (c.patientId === s.userId) c.active = false; }); });
  }

  async getMyDoctor(): Promise<DoctorPublicInfo | null> {
    const s = this.requireSession('patient');
    const db = this.load();
    const c = this.activeConnection(db, s.userId);
    return c ? this.publicDoctor(db, c.doctorUserId) ?? null : null;
  }

  async listMyPatients(): Promise<PatientSummary[]> {
    const s = this.requireSession('doctor');
    const db = this.load();
    return db.connections
      .filter((c) => c.doctorUserId === s.userId && c.active)
      .map((c) => {
        const profile = db.profiles.find((p) => p.id === c.patientId);
        if (!profile) return null;
        const prefs = db.preferences[c.patientId];
        return {
          profile: { ...profile, email: '' }, // doctors don't need the patient's login email
          connectedAt: c.createdAt,
          preferences: prefs?.shareWithDoctor ? prefs : undefined,
          consultationCount: db.consultations.filter((x) => x.patientId === c.patientId && x.doctorUserId === s.userId && x.status !== 'draft').length,
        } as PatientSummary;
      })
      .filter((x): x is PatientSummary => !!x);
  }

  async disconnectPatient(patientId: string) {
    const s = this.requireSession('doctor');
    this.tx((db) => {
      const c = db.connections.find((x) => x.patientId === patientId && x.doctorUserId === s.userId && x.active);
      if (!c) throw new BackendError('not_found', 'This patient is not connected to you.');
      c.active = false;
    });
  }

  async doctorStats(): Promise<DoctorStats> {
    const s = this.requireSession('doctor');
    const db = this.load();
    const mine = db.consultations.filter((c) => this.canAccess(db, s, c));
    return {
      connectedPatients: db.connections.filter((c) => c.doctorUserId === s.userId && c.active).length,
      newCount: mine.filter((c) => c.status === 'new').length,
      inReviewCount: mine.filter((c) => c.status === 'in_review').length,
      completedCount: mine.filter((c) => c.status === 'completed').length,
    };
  }

  // ---------- consultations ----------
  async createConsultation(kind: 'consultation' | 'signal' = 'consultation'): Promise<Consultation> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const c: Consultation = {
        id: randomId('cs_'), patientId: s.userId, status: 'draft', regionIds: [], sensations: [],
        details: {}, answers: [], urgentGuidanceShown: false, createdAt: now(), updatedAt: now(),
        kind: kind === 'signal' ? 'signal' : 'consultation', audit: [{ at: now(), by: 'patient', action: 'created' }],
      };
      db.consultations.push(c);
      db.statusHistory.push({ id: randomId('st_'), consultationId: c.id, from: null, to: 'draft', byUserId: s.userId, at: now() });
      return c;
    });
  }

  async updateDraft(id: string, patch: {
    regionIds?: string[]; sensations?: Sensation[]; details?: SymptomDetails;
    answers?: ClarificationAnswer[]; draftSummaryText?: string; urgentGuidanceShown?: boolean;
    reconstruction?: Reconstruction; audit?: AuditEvent[];
  }): Promise<Consultation> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const c = this.getAccessible(db, s, id);
      if (c.status !== 'draft') throw new BackendError('locked', 'This consultation was already shared and can no longer be edited.');
      if (patch.regionIds) c.regionIds = [...new Set(patch.regionIds.filter((r) => REGION_BY_ID[r]))];
      if (patch.sensations) c.sensations = [...new Set(patch.sensations.filter((x) => SENSATIONS.includes(x)))];
      if (patch.details) {
        const d = patch.details;
        const sev = d.severity === undefined ? undefined : Math.round(Number(d.severity));
        c.details = {
          severity: sev !== undefined && sev >= 1 && sev <= 10 ? sev : undefined,
          onset: clip(d.onset, 60) || undefined,
          duration: clip(d.duration, 60) || undefined,
          pattern: d.pattern === 'constant' || d.pattern === 'comes_and_goes' ? d.pattern : undefined,
          description: clip(d.description, 1000) || undefined,
          otherSensation: clip(d.otherSensation, 120) || undefined,
        };
      }
      if (patch.answers) c.answers = patch.answers.slice(0, 30).map((a) => ({ ...a, value: a.value ? clip(a.value, 300) : undefined }));
      if (patch.draftSummaryText !== undefined) c.draftSummaryText = clip(patch.draftSummaryText, 4000);
      if (patch.urgentGuidanceShown) c.urgentGuidanceShown = true;
      if (patch.reconstruction) c.reconstruction = cleanReconstruction(patch.reconstruction);
      if (patch.audit) c.audit = cleanAudit(patch.audit);
      c.updatedAt = now();
      return c;
    });
  }

  private validateSummary(summary: Omit<ApprovedSummary, 'approvedAt'>) {
    const text = clip(summary.text, 4000);
    if (text.length < 5) throw new BackendError('invalid', 'The summary is empty. Please review it before sharing.');
    return { ...summary, text, approvedAt: now() };
  }

  async approveAndShare(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const c = this.getAccessible(db, s, id);
      if (c.status !== 'draft') throw new BackendError('locked', 'This consultation was already shared.');
      const conn = this.activeConnection(db, s.userId);
      if (!conn) throw new BackendError('no_doctor', 'You are not connected to a doctor yet. Save it, then connect a doctor to send it.');
      c.approved = this.validateSummary(summary);
      c.approved.report.aiConsent = !!cleanPreferences(db.preferences[s.userId]).aiAssist;
      c.doctorUserId = conn.doctorUserId; // always the patient's real connection, never client-supplied
      c.audit = cleanAudit([...(c.audit ?? []), { at: now(), by: 'patient', action: 'approved' }, { at: now(), by: 'patient', action: 'shared' }]);
      c.sharedAt = now();
      this.logStatus(db, c, 'new', s.userId);
      return c;
    });
  }

  async saveApprovedWithoutDoctor(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const c = this.getAccessible(db, s, id);
      if (c.status !== 'draft') throw new BackendError('locked', 'This consultation was already shared.');
      c.approved = this.validateSummary(summary);
      c.updatedAt = now();
      return c;
    });
  }

  async cancelConsultation(id: string) {
    const s = this.requireSession('patient');
    this.tx((db) => {
      const c = this.getAccessible(db, s, id);
      if (c.status !== 'draft') throw new BackendError('locked', 'Shared consultations can’t be cancelled here. Message your doctor instead.');
      db.consultations = db.consultations.filter((x) => x.id !== id);
      db.statusHistory = db.statusHistory.filter((h) => h.consultationId !== id);
    });
  }

  async listConsultations(): Promise<ConsultationView[]> {
    const s = this.requireSession();
    const db = this.load();
    return db.consultations
      .filter((c) => this.canAccess(db, s, c))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => this.view(db, c));
  }

  async getConsultation(id: string): Promise<ConsultationView> {
    const s = this.requireSession();
    const db = this.load();
    return this.view(db, this.getAccessible(db, s, id));
  }

  async setStatus(id: string, status: ConsultationStatus): Promise<Consultation> {
    const s = this.requireSession('doctor');
    if (!DOCTOR_SETTABLE.includes(status)) throw new BackendError('invalid', 'Invalid status.');
    return this.tx((db) => {
      const c = this.getAccessible(db, s, id);
      if (c.status !== status) this.logStatus(db, c, status, s.userId);
      return c;
    });
  }

  async statusHistory(id: string): Promise<StatusChange[]> {
    const s = this.requireSession();
    const db = this.load();
    this.getAccessible(db, s, id);
    return db.statusHistory.filter((h) => h.consultationId === id).sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---------- clinical decision support (doctor-private) ----------
  async getClinicalReview(consultationId: string): Promise<ClinicalReview> {
    const s = this.requireSession('doctor');
    const db = this.load();
    this.getAccessible(db, s, consultationId);
    const r = db.reviews?.[`${s.userId}:${consultationId}`];
    return r ? cleanReview(r, consultationId) : newReview(consultationId);
  }
  async saveClinicalReview(consultationId: string, review: ClinicalReview): Promise<ClinicalReview> {
    const s = this.requireSession('doctor');
    const clean = { ...cleanReview(review, consultationId), updatedAt: now() };
    return this.tx((db) => {
      this.getAccessible(db, s, consultationId);
      db.reviews = db.reviews ?? {};
      db.reviews[`${s.userId}:${consultationId}`] = clean;
      return clean;
    });
  }

  // ---------- doctor notes ----------
  async listNotes(consultationId: string): Promise<DoctorNote[]> {
    const s = this.requireSession('doctor');
    const db = this.load();
    this.getAccessible(db, s, consultationId);
    return db.notes.filter((n) => n.consultationId === consultationId && n.doctorUserId === s.userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addNote(consultationId: string, body: string): Promise<DoctorNote> {
    const s = this.requireSession('doctor');
    const text = clip(body, 2000);
    if (!text) throw new BackendError('invalid', 'Note is empty.');
    return this.tx((db) => {
      this.getAccessible(db, s, consultationId);
      const n: DoctorNote = { id: randomId('nt_'), consultationId, doctorUserId: s.userId, body: text, createdAt: now() };
      db.notes.push(n);
      return n;
    });
  }

  // ---------- messaging ----------
  async listMessages(consultationId: string): Promise<Message[]> {
    const s = this.requireSession();
    const db = this.load();
    this.getAccessible(db, s, consultationId);
    return db.messages.filter((m) => m.consultationId === consultationId).map((m) => ({ ...m, kind: readKind(m.kind, m.meta) })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendMessage(consultationId: string, body: string, kindIn: Message['kind'] = 'text', metaIn?: MessageMeta): Promise<Message> {
    const s = this.requireSession();
    const text = clip(body, 2000);
    if (!text) throw new BackendError('invalid', 'Message is empty.');
    const kind = messageKindFor(s.role, kindIn);
    const meta = cleanMeta(metaIn, kind);
    requireValidRx(kind, meta);
    return this.tx((db) => {
      const c = this.getAccessible(db, s, consultationId);
      if (c.status === 'draft') throw new BackendError('not_shared', 'Share this consultation with your doctor before messaging.');
      if (s.role === 'patient') {
        const conn = this.activeConnection(db, s.userId);
        if (!conn || conn.doctorUserId !== c.doctorUserId) {
          throw new BackendError('not_connected', 'You are no longer connected to this doctor.');
        }
      }
      const m: Message = { id: randomId('ms_'), consultationId, senderId: s.userId, senderRole: s.role, body: text, kind, createdAt: now(), ...(meta ? { meta } : {}) };
      db.messages.push(m);
      return m;
    });
  }

  async markViewed(consultationId: string) {
    const s = this.requireSession('doctor');
    this.tx((db) => {
      this.getAccessible(db, s, consultationId);
      db.views = db.views ?? {};
      if (!db.views[consultationId]) db.views[consultationId] = now();
    });
  }

  // ---------- demo ----------
  // ---------- symptom diary ----------
  async addDiaryEntry(input: DiaryInput): Promise<DiaryEntry> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const conn = input.share ? this.activeConnection(db, s.userId) : undefined;
      const e = cleanDiaryEntry({ ...input, id: (input.importId ?? '').replace(/[^\w-]/g, '') || randomId('dy_'), at: now(), sharedWith: conn?.doctorUserId ?? null });
      if (!e) throw new BackendError('invalid', 'The diary entry is empty.');
      db.diary = [...(db.diary ?? []), { ...e, patientId: s.userId }].slice(-2000);
      return e;
    });
  }
  async listDiary(patientId?: string): Promise<DiaryEntry[]> {
    const s = this.requireSession();
    const db = this.load();
    const all = db.diary ?? [];
    let rows: (DiaryEntry & { patientId: string })[];
    if (s.role === 'patient') rows = all.filter((e) => e.patientId === s.userId);
    else {
      const conn = patientId ? this.activeConnection(db, patientId) : undefined;
      if (!conn || conn.doctorUserId !== s.userId) throw new BackendError('not_found', 'This patient is not connected to you.');
      rows = all.filter((e) => e.patientId === patientId && e.sharedWith === s.userId);
    }
    return rows.map(({ patientId: _p, ...e }) => e).sort((a, b) => b.at.localeCompare(a.at));
  }
  async deleteDiaryEntry(id: string): Promise<void> {
    const s = this.requireSession('patient');
    this.tx((db) => { db.diary = (db.diary ?? []).filter((e) => !(e.id === id && e.patientId === s.userId)); });
  }

  // ---------- care records ----------
  async addRecord(kind: RecordKind, data: unknown, opts: { share?: boolean; by?: string; id?: string } = {}): Promise<PatientRecord> {
    const s = this.requireSession('patient');
    if (!cleanRecordData(kind, data)) throw new BackendError('invalid', 'This record is incomplete.');
    return this.tx((db) => {
      const conn = opts.share && kind !== 'card' ? this.activeConnection(db, s.userId) : undefined;
      const id = (opts.id ?? '').replace(/[^\w-]/g, '') || randomId(`${kind[0]}r_`);
      const r = cleanRecord({ id, kind, at: now(), data, sharedWith: conn?.doctorUserId ?? null, by: opts.by ?? '' });
      if (!r) throw new BackendError('invalid', 'This record is incomplete.');
      let rows = (db.records ?? []).filter((x) => !(x.patientId === s.userId && x.id === r.id));
      if (kind === 'card') rows = rows.filter((x) => !(x.patientId === s.userId && x.kind === 'card'));
      const photos = rows.filter((x) => x.patientId === s.userId && x.kind === 'photo');
      if (kind === 'photo' && photos.length >= 30) throw new BackendError('too_many', 'This offline demo keeps up to 30 photos. Delete an older one first.');
      db.records = [...rows, { ...r, patientId: s.userId }].slice(-3000);
      return r;
    });
  }
  async listRecords(kind: RecordKind, patientId?: string): Promise<PatientRecord[]> {
    const s = this.requireSession();
    const db = this.load();
    const all = (db.records ?? []).filter((r) => r.kind === kind);
    let rows: (PatientRecord & { patientId: string })[];
    if (s.role === 'patient') rows = all.filter((r) => r.patientId === s.userId);
    else if (s.role === 'doctor') {
      const conn = patientId ? this.activeConnection(db, patientId) : undefined;
      if (!conn || conn.doctorUserId !== s.userId || kind === 'card') throw new BackendError('not_found', 'This patient is not connected to you.');
      rows = all.filter((r) => r.patientId === patientId && r.sharedWith === s.userId);
    } else throw new BackendError('forbidden', 'Caregivers see the summary the patient shares with them.');
    return rows.map(({ patientId: _p, ...r }) => r).sort((a, b) => b.at.localeCompare(a.at));
  }
  async deleteRecord(id: string): Promise<void> {
    const s = this.requireSession('patient');
    this.tx((db) => { db.records = (db.records ?? []).filter((r) => !(r.id === id && r.patientId === s.userId)); });
  }

  // ---------- caregivers ----------
  private caregiverByCode(db: DB, raw: string) {
    const code = normalizeCaregiverId(raw);
    if (!CAREGIVER_ID_PATTERN.test(code)) throw new BackendError('invalid_caregiver_id', 'A Caregiver ID looks like CG-ABCD-2345.');
    const c = (db.caregivers ?? []).find((x) => x.caregiverId === code);
    const p = c && db.profiles.find((x) => x.id === c.userId);
    if (!c || !p) throw new BackendError('caregiver_not_found', 'No caregiver has this ID. Check it with them.');
    return { c, p };
  }
  private link(db: DB, l: { caregiverUserId: string; since: string }): CaregiverLink {
    const c = (db.caregivers ?? []).find((x) => x.userId === l.caregiverUserId);
    const p = db.profiles.find((x) => x.id === l.caregiverUserId);
    return { id: l.caregiverUserId, name: p?.fullName ?? 'Caregiver', caregiverId: c?.caregiverId ?? '', since: l.since };
  }
  async lookupCaregiver(raw: string): Promise<{ name: string }> {
    this.requireSession('patient');
    return { name: this.caregiverByCode(this.load(), raw).p.fullName };
  }
  async connectCaregiver(raw: string): Promise<CaregiverLink> {
    const s = this.requireSession('patient');
    return this.tx((db) => {
      const { c } = this.caregiverByCode(db, raw);
      db.careLinks = db.careLinks ?? [];
      const mine = db.careLinks.filter((l) => l.patientId === s.userId && l.active);
      if (mine.some((l) => l.caregiverUserId === c.userId)) return this.link(db, mine.find((l) => l.caregiverUserId === c.userId)!);
      if (mine.length >= 3) throw new BackendError('too_many', 'You can link up to 3 caregivers.');
      const l = { patientId: s.userId, caregiverUserId: c.userId, since: now(), active: true, digest: null };
      db.careLinks.push(l);
      return this.link(db, l);
    });
  }
  async listMyCaregivers(): Promise<CaregiverLink[]> {
    const s = this.requireSession('patient');
    const db = this.load();
    return (db.careLinks ?? []).filter((l) => l.patientId === s.userId && l.active).map((l) => this.link(db, l));
  }
  async removeCaregiver(id: string): Promise<void> {
    const s = this.requireSession('patient');
    this.tx((db) => {
      db.careLinks = (db.careLinks ?? []).filter((l) => !(l.patientId === s.userId && l.caregiverUserId === id));
      db.careOutbox = (db.careOutbox ?? []).filter((o) => !(o.patientId === s.userId && o.caregiverUserId === id));
    });
  }
  async publishCareDigest(digest: CareDigest): Promise<void> {
    const s = this.requireSession('patient');
    const d = cleanDigest(digest);
    this.tx((db) => { for (const l of db.careLinks ?? []) if (l.patientId === s.userId && l.active) l.digest = d; });
  }
  async pendingCaregiverItems(): Promise<{ item: CaregiverItem; caregiver: CaregiverLink }[]> {
    const s = this.requireSession('patient');
    const db = this.load();
    const active = new Set((db.careLinks ?? []).filter((l) => l.patientId === s.userId && l.active).map((l) => l.caregiverUserId));
    const have = new Set([...(db.records ?? []).filter((r) => r.patientId === s.userId).map((r) => r.id), ...(db.diary ?? []).filter((e) => e.patientId === s.userId).map((e) => e.id)]);
    return (db.careOutbox ?? []).filter((o) => o.patientId === s.userId && active.has(o.caregiverUserId) && !have.has(o.id))
      .map((o) => ({ item: cleanCaregiverItem(o)!, caregiver: this.link(db, db.careLinks!.find((l) => l.patientId === s.userId && l.caregiverUserId === o.caregiverUserId)!) }))
      .filter((x) => !!x.item);
  }
  async listCaredPatients(): Promise<{ id: string; name: string; digest: CareDigest | null; since: string }[]> {
    const s = this.requireSession('caregiver');
    const db = this.load();
    return (db.careLinks ?? []).filter((l) => l.caregiverUserId === s.userId && l.active).map((l) => ({
      id: l.patientId, name: db.profiles.find((p) => p.id === l.patientId)?.fullName ?? 'Patient', digest: l.digest ? cleanDigest(l.digest) : null, since: l.since,
    }));
  }
  async caregiverAdd(patientId: string, input: Omit<CaregiverItem, 'id' | 'at'>): Promise<CaregiverItem> {
    const s = this.requireSession('caregiver');
    return this.tx((db) => {
      if (!(db.careLinks ?? []).some((l) => l.caregiverUserId === s.userId && l.patientId === patientId && l.active)) throw new BackendError('not_found', 'This person has not linked you as their caregiver.');
      const item = cleanCaregiverItem({ ...input, id: randomId('cg_'), at: now() });
      if (!item) throw new BackendError('invalid', 'This check-in is incomplete.');
      db.careOutbox = [...(db.careOutbox ?? []), { ...item, patientId, caregiverUserId: s.userId }].slice(-2000);
      return item;
    });
  }

  async resetDemoData() {
    this.store.remove(DB_KEY);
    this.store.remove(SESSION_KEY);
    this.session = null;
  }

  /** Creates labeled demo accounts (idempotent). Signs nobody in. */
  async seedDemo() {
    const password = 'demo-pass-123';
    const doctorEmail = 'doctor.demo@accesscare.demo';
    const patientEmail = 'patient.demo@accesscare.demo';
    const db = this.load();
    if (!db.credentials.some((c) => c.email === doctorEmail)) {
      const me = await this.signUp({ role: 'doctor', fullName: 'Dr. Sara Demo', email: doctorEmail, password, specialty: 'Family Medicine (demo)', clinic: 'AccessCare Demo Clinic' });
      this.tx((d) => { d.demoUserIds.push(me.profile.id); });
      await this.signOut();
    }
    if (!this.load().credentials.some((c) => c.email === patientEmail)) {
      const me = await this.signUp({ role: 'patient', fullName: 'Omar Demo', email: patientEmail, password });
      this.tx((d) => { d.demoUserIds.push(me.profile.id); });
      await this.signOut();
    }
    const after = this.load();
    const docUser = after.credentials.find((c) => c.email === doctorEmail)!;
    const doctorId = after.doctorProfiles.find((d) => d.userId === docUser.userId)!.doctorId;
    return { doctorEmail, patientEmail, password, doctorId };
  }

  isDemoUser(userId: string) { return this.load().demoUserIds.includes(userId); }
}
