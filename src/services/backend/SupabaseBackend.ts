// SupabaseBackend — AccessCare AI on Supabase Auth + Postgres (supabase/schema.sql).
//
// STATUS: implemented against the Supabase REST APIs (GoTrue auth, PostgREST,
// RPC), but NOT yet run against a live project: no Supabase credentials were
// available, and pages running inside Claude cannot reach external servers.
// Used by the standalone web build when these are set at build time:
//   ACCESSCARE_SUPABASE_URL       e.g. https://abcd1234.supabase.co
//   ACCESSCARE_SUPABASE_ANON_KEY  the project's public "anon" key (never the service-role key)
// Authorization is enforced by Row Level Security and the RPC functions in the
// schema; this client only sends the signed-in user's access token.

import { cleanDiaryEntry, type DiaryEntry } from '../../domain/diary';
import { cleanRecord, cleanRecordData, type CareDigest, type CaregiverItem, type CaregiverLink, type PatientRecord, type RecordKind } from '../../domain/care';
import type {
  AuthInfo, Backend, ConsultationView, DiaryInput, DoctorStats, Me, PatientSummary, SignInInput, SignUpInput,
} from './Backend';
import { BackendError } from './Backend';
import type {
  ApprovedSummary, ClarificationAnswer, CommunicationPreferences, Connection, Consultation,
  ConsultationStatus, DoctorNote, DoctorPublicInfo, Message, Role, Sensation, StatusChange, SymptomDetails, AuditEvent, MessageMeta,
} from '../../domain/types';
import { DEFAULT_PREFERENCES, cleanPreferences } from '../../domain/types';
import { DOCTOR_ID_PATTERN, normalizeDoctorId } from '../crypto';
import { cleanAudit, cleanMeta, cleanReconstruction, messageKindFor, readKind, requireValidRx } from './sanitize';
import { cleanReview, newReview, type ClinicalReview } from '../../domain/clinical';
import type { Reconstruction } from '../../domain/reconstruction';

export interface SupabaseConfig { url: string; anonKey: string }
interface AuthSession { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email: string } }
interface ConsRow {
  id: string; patient_id: string; doctor_user_id: string | null; status: ConsultationStatus; region_ids: string[];
  details: { details?: SymptomDetails; answers?: ClarificationAnswer[]; draftSummaryText?: string; approvedDraft?: ApprovedSummary; sensations?: Sensation[]; reconstruction?: Reconstruction; audit?: AuditEvent[] };
  kind?: 'consultation' | 'signal';
  urgent_guidance_shown: boolean; created_at: string; updated_at: string; shared_at: string | null;
  consultation_summaries?: { approved_text: string; report: ApprovedSummary['report']; edited_by_patient: boolean; approved_at: string } | null;
}

const KEY = 'accesscare.supabase.session.v1';
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') as AuthSession | null; } catch { return null; } },
  set: (s: AuthSession) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* */ } },
  del: () => { try { localStorage.removeItem(KEY); } catch { /* */ } },
};
const clip = (s: string | undefined, max: number) => (s ?? '').trim().slice(0, max);

export class SupabaseBackend implements Backend {
  readonly mode = 'supabase' as const;
  readonly persistent = true;
  readonly shared = true;
  private session: AuthSession | null = null;
  private meCache: Me | null = null;

  constructor(private cfg: SupabaseConfig) {}

  // ---------- http ----------
  private async http<T>(path: string, init: RequestInit & { auth?: boolean; prefer?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { apikey: this.cfg.anonKey, 'Content-Type': 'application/json' };
    if (init.auth !== false) {
      const s = await this.fresh();
      headers.Authorization = `Bearer ${s.access_token}`;
    }
    if (init.prefer) headers.Prefer = init.prefer;
    let res: Response;
    try { res = await fetch(this.cfg.url.replace(/\/$/, '') + path, { ...init, headers: { ...headers, ...(init.headers as object) } }); }
    catch { throw new BackendError('network', 'Can’t reach the AccessCare server. Check your connection.'); }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg: string = body?.msg || body?.message || body?.error_description || body?.error || `Request failed (${res.status})`;
      const known: [RegExp, string, string][] = [
        [/invalid login credentials/i, 'invalid_credentials', 'Email or password is incorrect.'],
        [/already registered/i, 'email_taken', 'An account with this email already exists. Try signing in.'],
        [/doctor_not_found/, 'doctor_not_found', 'No doctor was found with this ID. Please check it with your doctor.'],
        [/one_active_doctor|duplicate key/, 'has_doctor', 'You are already connected to a doctor. Disconnect first to connect to a new one.'],
        [/no_doctor/, 'no_doctor', 'You are not connected to a doctor yet.'],
        [/not_found_or_locked/, 'locked', 'This consultation was already shared.'],
        [/forbidden/, 'forbidden', 'You don’t have permission to do this.'],
        [/email not confirmed/i, 'email_unconfirmed', 'Please confirm your email address first (check your inbox).'],
      ];
      const k = known.find(([re]) => re.test(msg));
      throw new BackendError(k?.[1] ?? 'server_error', k?.[2] ?? msg);
    }
    return body as T;
  }
  private rest<T>(path: string, init: RequestInit & { prefer?: string } = {}) { return this.http<T>(`/rest/v1/${path}`, init); }
  private rpc<T>(fn: string, args: object) { return this.rest<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); }

  private async fresh(): Promise<AuthSession> {
    const s = this.session ?? store.get();
    if (!s) throw new BackendError('unauthenticated', 'Please sign in again.');
    if (s.expires_at * 1000 - Date.now() > 60_000) { this.session = s; return s; }
    const r = await this.http<AuthSession & { expires_in: number }>('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, body: JSON.stringify({ refresh_token: s.refresh_token }),
    }).catch(() => { this.session = null; store.del(); throw new BackendError('session_expired', 'Your session expired. Please sign in again.'); });
    const next = { ...r, expires_at: r.expires_at ?? Math.floor(Date.now() / 1000) + r.expires_in };
    this.session = next; store.set(next);
    return next;
  }
  private uid() { if (!this.session) throw new BackendError('unauthenticated', 'Please sign in again.'); return this.session.user.id; }
  private role(): Role { if (!this.meCache) throw new BackendError('unauthenticated', 'Please sign in again.'); return this.meCache.profile.role; }
  private needRole(r: Role) { if (this.role() !== r) throw new BackendError('forbidden', r === 'doctor' ? 'Only doctor accounts can do this.' : 'Only patient accounts can do this.'); }

  // ---------- auth ----------
  async authInfo(): Promise<AuthInfo> { return { kind: 'email-password' }; }

  private async loadMe(): Promise<Me> {
    const uid = this.uid();
    const [p] = await this.rest<{ id: string; role: Role; full_name: string; created_at: string }[]>(`profiles?id=eq.${uid}&select=*`);
    if (!p) throw new BackendError('not_found', 'Account profile not found.');
    const [prefs] = await this.rest<{ prefs: Partial<CommunicationPreferences>; share_with_doctor: boolean }[]>(`communication_preferences?user_id=eq.${uid}&select=*`);
    let doctor: Me['doctor'];
    if (p.role === 'doctor') {
      const [d] = await this.rest<{ doctor_id: string; specialty: string | null; clinic: string | null }[]>(`doctor_profiles?user_id=eq.${uid}&select=*`);
      doctor = { userId: uid, doctorId: d.doctor_id, specialty: d.specialty ?? undefined, clinic: d.clinic ?? undefined };
    }
    this.meCache = {
      profile: { id: uid, role: p.role, fullName: p.full_name, email: this.session!.user.email, createdAt: p.created_at },
      doctor,
      preferences: cleanPreferences({ ...DEFAULT_PREFERENCES, ...(prefs?.prefs ?? {}), shareWithDoctor: prefs?.share_with_doctor ?? true }),
    };
    return this.meCache;
  }

  async signUp(input: SignUpInput): Promise<Me> {
    const email = clip(input.email, 120).toLowerCase();
    if (clip(input.fullName, 80).length < 2) throw new BackendError('invalid_name', 'Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BackendError('invalid_email', 'Please enter a valid email address.');
    if ((input.password ?? '').length < 8) throw new BackendError('weak_password', 'Password must be at least 8 characters.');
    const r = await this.http<Partial<AuthSession> & { expires_in?: number; user?: AuthSession['user'] }>('/auth/v1/signup', {
      method: 'POST', auth: false,
      body: JSON.stringify({ email, password: input.password, data: { role: input.role, full_name: clip(input.fullName, 80), specialty: clip(input.specialty, 60) || null, clinic: clip(input.clinic, 80) || null } }),
    });
    if (!r.access_token) throw new BackendError('email_unconfirmed', 'Account created. Confirm your email address from the message we sent, then sign in.');
    this.session = { access_token: r.access_token, refresh_token: r.refresh_token!, expires_at: r.expires_at ?? Math.floor(Date.now() / 1000) + (r.expires_in ?? 3600), user: r.user! };
    store.set(this.session);
    return this.loadMe();
  }

  async signIn({ email, password }: SignInInput): Promise<Me> {
    const r = await this.http<AuthSession & { expires_in: number }>('/auth/v1/token?grant_type=password', {
      method: 'POST', auth: false, body: JSON.stringify({ email: clip(email, 120).toLowerCase(), password }),
    });
    this.session = { ...r, expires_at: r.expires_at ?? Math.floor(Date.now() / 1000) + r.expires_in };
    store.set(this.session);
    return this.loadMe();
  }

  async signOut() {
    try { if (this.session) await this.http('/auth/v1/logout', { method: 'POST' }); } catch { /* token may already be invalid */ }
    this.session = null; this.meCache = null; store.del();
  }

  async restoreSession(): Promise<Me | null> {
    if (!store.get()) return null;
    try { await this.fresh(); return await this.loadMe(); } catch { store.del(); this.session = null; return null; }
  }

  async requestPasswordReset(email: string) {
    await this.http('/auth/v1/recover', { method: 'POST', auth: false, body: JSON.stringify({ email: clip(email, 120).toLowerCase() }) });
    return { supported: true };
  }

  async deleteAccount(password: string) {
    await this.signIn({ email: this.session!.user.email, password }); // re-authenticate
    await this.http('/functions/v1/delete-account', { method: 'POST', body: '{}' }); // service role lives in the function only
    await this.signOut();
  }

  async updateProfile(patch: { fullName?: string; specialty?: string; clinic?: string }): Promise<Me> {
    const uid = this.uid();
    if (patch.fullName !== undefined) await this.rest(`profiles?id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ full_name: clip(patch.fullName, 80) }) });
    if (this.role() === 'doctor' && (patch.specialty !== undefined || patch.clinic !== undefined)) {
      await this.rest(`doctor_profiles?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ specialty: clip(patch.specialty, 60) || null, clinic: clip(patch.clinic, 80) || null }) });
    }
    return this.loadMe();
  }

  async savePreferences(prefs: CommunicationPreferences) {
    const clean = cleanPreferences(prefs);
    await this.rest(`communication_preferences?user_id=eq.${this.uid()}`, {
      method: 'PATCH', body: JSON.stringify({ prefs: clean, share_with_doctor: clean.shareWithDoctor, updated_at: new Date().toISOString() }),
    });
    if (this.meCache) this.meCache.preferences = clean;
    return clean;
  }

  // ---------- doctor id + connections ----------
  async lookupDoctor(raw: string): Promise<DoctorPublicInfo> {
    this.needRole('patient');
    const id = normalizeDoctorId(raw);
    if (!DOCTOR_ID_PATTERN.test(id)) throw new BackendError('invalid_format', 'That doesn’t look like a Doctor ID. It should look like AC-DOC-7K4P9X.');
    const rows = await this.rpc<{ doctor_id: string; full_name: string; specialty: string | null; clinic: string | null }[]>('lookup_doctor', { p_doctor_id: id });
    if (!rows.length) throw new BackendError('doctor_not_found', 'No doctor was found with this ID. Please check it with your doctor.');
    return { doctorId: rows[0].doctor_id, fullName: rows[0].full_name, specialty: rows[0].specialty ?? undefined, clinic: rows[0].clinic ?? undefined };
  }

  async connectToDoctor(raw: string): Promise<Connection> {
    this.needRole('patient');
    const current = await this.getMyDoctor();
    if (current?.doctorId === normalizeDoctorId(raw)) throw new BackendError('already_connected', 'You are already connected to this doctor.');
    const id = await this.rpc<string>('connect_to_doctor', { p_doctor_id: normalizeDoctorId(raw) });
    return { id, patientId: this.uid(), doctorUserId: '', createdAt: new Date().toISOString(), active: true };
  }

  async disconnectDoctor() {
    this.needRole('patient');
    await this.rest(`patient_doctor_connections?patient_id=eq.${this.uid()}&active=eq.true`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
  }

  private async myDoctorUid(): Promise<string | null> {
    const [c] = await this.rest<{ doctor_user_id: string }[]>(`patient_doctor_connections?patient_id=eq.${this.uid()}&active=eq.true&select=doctor_user_id`);
    return c?.doctor_user_id ?? null;
  }

  private async doctorInfo(uid: string): Promise<DoctorPublicInfo | undefined> {
    const [d] = await this.rest<{ doctor_id: string; specialty: string | null; clinic: string | null }[]>(`doctor_profiles?user_id=eq.${uid}&select=*`);
    const [p] = await this.rest<{ full_name: string }[]>(`profiles?id=eq.${uid}&select=full_name`);
    return d && p ? { doctorId: d.doctor_id, fullName: p.full_name, specialty: d.specialty ?? undefined, clinic: d.clinic ?? undefined } : undefined;
  }

  // symptom diary: table diary_entries (RLS: the patient owns them; the connected doctor reads the ones shared with them)
  async addDiaryEntry(input: DiaryInput): Promise<DiaryEntry> {
    this.needRole('patient');
    const did = input.share ? await this.myDoctorUid() : null;
    const id = crypto.randomUUID();
    const e = cleanDiaryEntry({ ...input, id, at: new Date().toISOString(), sharedWith: did });
    if (!e) throw new BackendError('invalid', 'The diary entry is empty.');
    await this.rest('diary_entries', { method: 'POST', body: JSON.stringify({ id, patient_id: this.uid(), shared_with: did, data: e, at: e.at }) });
    return e;
  }
  async listDiary(patientId?: string): Promise<DiaryEntry[]> {
    const who = this.role() === 'patient' ? this.uid() : (patientId ?? '');
    const rows = await this.rest<{ id: string; data: unknown }[]>(`diary_entries?patient_id=eq.${encodeURIComponent(who)}${this.role() === 'doctor' ? `&shared_with=eq.${this.uid()}` : ''}&order=at.desc&select=id,data`);
    return rows.map((r) => cleanDiaryEntry(r.data)).filter((e): e is DiaryEntry => !!e);
  }
  async deleteDiaryEntry(id: string): Promise<void> {
    this.needRole('patient');
    await this.rest(`diary_entries?id=eq.${encodeURIComponent(id)}&patient_id=eq.${this.uid()}`, { method: 'DELETE' });
  }

  // care records: table patient_records (same RLS as diary_entries; 'card' rows are never shared)
  async addRecord(kind: RecordKind, data: unknown, opts: { share?: boolean; by?: string; id?: string } = {}): Promise<PatientRecord> {
    this.needRole('patient');
    if (!cleanRecordData(kind, data)) throw new BackendError('invalid', 'This record is incomplete.');
    const did = opts.share && kind !== 'card' ? await this.myDoctorUid() : null;
    const id = (opts.id ?? '').replace(/[^\w-]/g, '') || crypto.randomUUID();
    const r = cleanRecord({ id, kind, at: new Date().toISOString(), data, sharedWith: did, by: opts.by ?? '' });
    if (!r) throw new BackendError('invalid', 'This record is incomplete.');
    if (kind === 'card') await this.rest(`patient_records?patient_id=eq.${this.uid()}&kind=eq.card`, { method: 'DELETE' });
    await this.rest('patient_records', { method: 'POST', body: JSON.stringify({ id: r.id, patient_id: this.uid(), kind, shared_with: did, data: r, at: r.at }) });
    return r;
  }
  async listRecords(kind: RecordKind, patientId?: string): Promise<PatientRecord[]> {
    if (this.role() === 'caregiver') throw new BackendError('forbidden', 'Caregivers see the summary the patient shares with them.');
    const who = this.role() === 'patient' ? this.uid() : (patientId ?? '');
    const rows = await this.rest<{ data: unknown }[]>(`patient_records?patient_id=eq.${encodeURIComponent(who)}&kind=eq.${kind}${this.role() === 'doctor' ? `&shared_with=eq.${this.uid()}` : ''}&order=at.desc&select=data`);
    return rows.map((r) => cleanRecord(r.data)).filter((r): r is PatientRecord => !!r && r.kind === kind);
  }
  async deleteRecord(id: string): Promise<void> {
    this.needRole('patient');
    await this.rest(`patient_records?id=eq.${encodeURIComponent(id)}&patient_id=eq.${this.uid()}`, { method: 'DELETE' });
  }

  // caregivers are not available on the Supabase deployment yet (no tables for them): say so instead of pretending
  private noCaregivers(): never { throw new BackendError('unsupported', 'Caregiver accounts are not available on this server yet.'); }
  async lookupCaregiver(_id: string): Promise<{ name: string }> { return this.noCaregivers(); }
  async connectCaregiver(_id: string): Promise<CaregiverLink> { return this.noCaregivers(); }
  async listMyCaregivers(): Promise<CaregiverLink[]> { return []; }
  async removeCaregiver(_id: string): Promise<void> { return this.noCaregivers(); }
  async publishCareDigest(_d: CareDigest): Promise<void> { /* no caregivers on this server */ }
  async pendingCaregiverItems(): Promise<{ item: CaregiverItem; caregiver: CaregiverLink }[]> { return []; }
  async listCaredPatients(): Promise<{ id: string; name: string; digest: CareDigest | null; since: string }[]> { return this.noCaregivers(); }
  async caregiverAdd(_p: string, _i: Omit<CaregiverItem, 'id' | 'at'>): Promise<CaregiverItem> { return this.noCaregivers(); }

  async getMyDoctor() {
    this.needRole('patient');
    const did = await this.myDoctorUid();
    return did ? (await this.doctorInfo(did)) ?? null : null;
  }

  async listMyPatients(): Promise<PatientSummary[]> {
    this.needRole('doctor');
    const conns = await this.rest<{ patient_id: string; created_at: string }[]>(`patient_doctor_connections?doctor_user_id=eq.${this.uid()}&active=eq.true&select=patient_id,created_at`);
    if (!conns.length) return [];
    const ids = conns.map((c) => c.patient_id).join(',');
    const [profiles, prefs, cons] = await Promise.all([
      this.rest<{ id: string; full_name: string; created_at: string }[]>(`profiles?id=in.(${ids})&select=id,full_name,created_at`),
      this.rest<{ user_id: string; prefs: CommunicationPreferences }[]>(`communication_preferences?user_id=in.(${ids})&share_with_doctor=eq.true&select=user_id,prefs`),
      this.rest<{ patient_id: string }[]>(`consultations?doctor_user_id=eq.${this.uid()}&select=patient_id`),
    ]);
    return conns.map((c) => {
      const p = profiles.find((x) => x.id === c.patient_id);
      return {
        profile: { id: c.patient_id, role: 'patient' as const, fullName: p?.full_name ?? 'Patient', email: '', createdAt: p?.created_at ?? '' },
        connectedAt: c.created_at,
        preferences: prefs.find((x) => x.user_id === c.patient_id)?.prefs,
        consultationCount: cons.filter((x) => x.patient_id === c.patient_id).length,
      };
    });
  }

  async disconnectPatient(patientId: string) {
    this.needRole('doctor');
    await this.rest(`patient_doctor_connections?patient_id=eq.${patientId}&doctor_user_id=eq.${this.uid()}&active=eq.true`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
  }

  async doctorStats(): Promise<DoctorStats> {
    const [pats, list] = await Promise.all([this.listMyPatients(), this.listConsultations()]);
    const n = (s: ConsultationStatus) => list.filter((v) => v.consultation.status === s).length;
    return { connectedPatients: pats.length, newCount: n('new'), inReviewCount: n('in_review'), completedCount: n('completed') };
  }

  // ---------- consultations ----------
  private toConsultation(r: ConsRow): Consultation {
    const s = r.consultation_summaries;
    return {
      id: r.id, patientId: r.patient_id, doctorUserId: r.doctor_user_id ?? undefined, status: r.status,
      regionIds: r.region_ids ?? [], sensations: r.details?.sensations ?? [], details: r.details?.details ?? {},
      answers: r.details?.answers ?? [], draftSummaryText: r.details?.draftSummaryText,
      approved: s ? { text: s.approved_text, report: s.report, editedByPatient: s.edited_by_patient, approvedAt: s.approved_at } : r.details?.approvedDraft,
      urgentGuidanceShown: r.urgent_guidance_shown, createdAt: r.created_at, updatedAt: r.updated_at, sharedAt: r.shared_at ?? undefined,
      kind: r.kind ?? 'consultation', reconstruction: r.details?.reconstruction, audit: r.details?.audit,
    };
  }
  private async row(id: string): Promise<ConsRow> {
    const [r] = await this.rest<ConsRow[]>(`consultations?id=eq.${id}&select=*,consultation_summaries(*)`);
    if (!r) throw new BackendError('not_found', 'Consultation not found.');
    return r;
  }
  private async views(rows: ConsRow[]): Promise<ConsultationView[]> {
    const pids = [...new Set(rows.map((r) => r.patient_id))];
    const names = pids.length ? await this.rest<{ id: string; full_name: string }[]>(`profiles?id=in.(${pids.join(',')})&select=id,full_name`) : [];
    const docs = new Map<string, DoctorPublicInfo | undefined>();
    for (const d of new Set(rows.map((r) => r.doctor_user_id).filter(Boolean) as string[])) docs.set(d, await this.doctorInfo(d));
    return rows.map((r) => ({
      consultation: this.toConsultation(r),
      patient: { id: r.patient_id, fullName: names.find((n) => n.id === r.patient_id)?.full_name ?? 'Patient' },
      doctor: r.doctor_user_id ? docs.get(r.doctor_user_id) : undefined,
    }));
  }

  async createConsultation(kind: 'consultation' | 'signal' = 'consultation'): Promise<Consultation> {
    this.needRole('patient');
    const [r] = await this.rest<ConsRow[]>('consultations', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({ patient_id: this.uid(), kind }) });
    return this.toConsultation(r);
  }

  async updateDraft(id: string, patch: { regionIds?: string[]; sensations?: Sensation[]; details?: SymptomDetails; answers?: ClarificationAnswer[]; draftSummaryText?: string; urgentGuidanceShown?: boolean; reconstruction?: Reconstruction; audit?: AuditEvent[] }) {
    this.needRole('patient');
    const r = await this.row(id);
    if (r.status !== 'draft') throw new BackendError('locked', 'This consultation was already shared and can no longer be edited.');
    const details = { ...r.details };
    if (patch.details) details.details = patch.details;
    if (patch.answers) details.answers = patch.answers;
    if (patch.sensations) details.sensations = patch.sensations;
    if (patch.draftSummaryText !== undefined) details.draftSummaryText = patch.draftSummaryText;
    if (patch.reconstruction) details.reconstruction = cleanReconstruction(patch.reconstruction);
    if (patch.audit) details.audit = cleanAudit(patch.audit);
    const body: Record<string, unknown> = { details, updated_at: new Date().toISOString() };
    if (patch.regionIds) body.region_ids = patch.regionIds;
    if (patch.urgentGuidanceShown) body.urgent_guidance_shown = true;
    const [u] = await this.rest<ConsRow[]>(`consultations?id=eq.${id}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(body) });
    if (patch.sensations) {
      await this.rest(`consultation_symptoms?consultation_id=eq.${id}`, { method: 'DELETE' });
      if (patch.sensations.length) await this.rest('consultation_symptoms', { method: 'POST', body: JSON.stringify(patch.sensations.map((s) => ({ consultation_id: id, sensation: s }))) });
    }
    return this.toConsultation(u);
  }

  async approveAndShare(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>) {
    this.needRole('patient');
    if (clip(summary.text, 4000).length < 5) throw new BackendError('invalid', 'The summary is empty. Please review it before sharing.');
    await this.rpc('approve_and_share', { p_consultation: id, p_text: clip(summary.text, 4000), p_report: { ...summary.report, aiConsent: !!this.meCache?.preferences.aiAssist }, p_answers: summary.report.clarifications, p_edited: summary.editedByPatient });
    return this.toConsultation(await this.row(id));
  }

  async saveApprovedWithoutDoctor(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>) {
    const r = await this.row(id);
    const details = { ...r.details, approvedDraft: { ...summary, approvedAt: new Date().toISOString() } };
    await this.rest(`consultations?id=eq.${id}&status=eq.draft`, { method: 'PATCH', body: JSON.stringify({ details }) });
    return this.toConsultation(await this.row(id));
  }

  async cancelConsultation(id: string) {
    this.needRole('patient');
    await this.rest(`consultations?id=eq.${id}&status=eq.draft`, { method: 'DELETE' });
  }

  async listConsultations() {
    const rows = await this.rest<ConsRow[]>('consultations?select=*,consultation_summaries(*)&order=updated_at.desc');
    return this.views(rows);
  }
  async getConsultation(id: string) { return (await this.views([await this.row(id)]))[0]; }

  async setStatus(id: string, status: ConsultationStatus) {
    this.needRole('doctor');
    await this.rpc('set_consultation_status', { p_consultation: id, p_status: status });
    return this.toConsultation(await this.row(id));
  }

  async statusHistory(id: string): Promise<StatusChange[]> {
    const rows = await this.rest<{ id: string; from_status: ConsultationStatus | null; to_status: ConsultationStatus; by_user: string; at: string }[]>(
      `consultation_status_history?consultation_id=eq.${id}&order=at.asc`);
    return rows.map((r) => ({ id: r.id, consultationId: id, from: r.from_status, to: r.to_status, byUserId: r.by_user, at: r.at }));
  }

  async listNotes(consultationId: string): Promise<DoctorNote[]> {
    this.needRole('doctor');
    const rows = await this.rest<{ id: string; body: string; created_at: string }[]>(`doctor_notes?consultation_id=eq.${consultationId}&order=created_at.asc`);
    return rows.map((r) => ({ id: r.id, consultationId, doctorUserId: this.uid(), body: r.body, createdAt: r.created_at }));
  }
  async addNote(consultationId: string, body: string): Promise<DoctorNote> {
    this.needRole('doctor');
    const [r] = await this.rest<{ id: string; created_at: string }[]>('doctor_notes', {
      method: 'POST', prefer: 'return=representation', body: JSON.stringify({ consultation_id: consultationId, doctor_user_id: this.uid(), body: clip(body, 2000) }),
    });
    return { id: r.id, consultationId, doctorUserId: this.uid(), body, createdAt: r.created_at };
  }

  // clinical decision support: table clinical_reviews (RLS: only the doctor who wrote it, and only while they can access the consultation)
  async getClinicalReview(consultationId: string): Promise<ClinicalReview> {
    this.needRole('doctor');
    const rows = await this.rest<{ data: unknown }[]>(`clinical_reviews?consultation_id=eq.${consultationId}&doctor_user_id=eq.${this.uid()}&select=data`);
    return rows[0] ? cleanReview(rows[0].data, consultationId) : newReview(consultationId);
  }
  async saveClinicalReview(consultationId: string, review: ClinicalReview): Promise<ClinicalReview> {
    this.needRole('doctor');
    const clean = { ...cleanReview(review, consultationId), updatedAt: new Date().toISOString() };
    await this.rest('clinical_reviews?on_conflict=consultation_id,doctor_user_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: JSON.stringify({ consultation_id: consultationId, doctor_user_id: this.uid(), data: clean, updated_at: clean.updatedAt }) });
    return clean;
  }

  async listMessages(consultationId: string): Promise<Message[]> {
    const rows = await this.rest<{ id: string; sender_id: string; kind: Message['kind']; body: string; created_at: string; meta: MessageMeta | null }[]>(
      `consultation_messages?consultation_id=eq.${consultationId}&order=created_at.asc`);
    const c = await this.row(consultationId);
    return rows.map((r) => {
      const role: Role = r.sender_id === c.patient_id ? 'patient' : 'doctor';
      const meta = cleanMeta(r.meta ?? undefined, messageKindFor(role, r.kind));
      const kind = readKind(messageKindFor(role, r.kind), meta);
      return { id: r.id, consultationId, senderId: r.sender_id, senderRole: role, body: r.body, kind, createdAt: r.created_at, ...(meta ? { meta } : {}) };
    });
  }
  async sendMessage(consultationId: string, body: string, kindIn: Message['kind'] = 'text', metaIn?: MessageMeta): Promise<Message> {
    const kind = messageKindFor(this.role(), kindIn);
    const meta = cleanMeta(metaIn, kind);
    requireValidRx(kind, meta);
    const [r] = await this.rest<{ id: string; created_at: string }[]>('consultation_messages', {
      method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({ consultation_id: consultationId, sender_id: this.uid(), kind, body: clip(body, 2000), meta: meta ?? null }),
    });
    return { id: r.id, consultationId, senderId: this.uid(), senderRole: this.role(), body, kind, createdAt: r.created_at, ...(meta ? { meta } : {}) };
  }

  async markViewed(consultationId: string) {
    this.needRole('doctor');
    const seen = await this.rest<{ id: string }[]>(`consultation_audit?consultation_id=eq.${consultationId}&action=eq.viewed&actor=eq.${this.uid()}&select=id&limit=1`);
    if (!seen.length) await this.rest('consultation_audit', { method: 'POST', body: JSON.stringify({ consultation_id: consultationId, actor: this.uid(), action: 'viewed' }) });
  }

  /** Polling fallback; Supabase Realtime (websocket) can replace this later. */
  onChange(cb: () => void) {
    const t = setInterval(cb, 20_000);
    return () => clearInterval(t);
  }
}
