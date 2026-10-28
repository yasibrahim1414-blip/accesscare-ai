// Backend contract used by every screen. Implementations:
//  - CloudBackend: Claude's shared artifact database (server-side, synced across
//    devices, signed in with the viewer's Claude account, end-to-end encrypted
//    between patient and doctor). Used when the app runs inside Claude.
//  - SupabaseBackend: Supabase Auth + Postgres with RLS (supabase/schema.sql),
//    for a deployment outside Claude. Requires SUPABASE_URL / SUPABASE_ANON_KEY.
//  - LocalDemoBackend: offline single-device fallback, clearly labeled.
// Screens never pass "who am I" — the backend derives it from the session,
// the same way RLS derives it from auth.uid().

import type { DiaryEntry } from '../../domain/diary';
import type { CareDigest, CaregiverItem, CaregiverLink, PatientRecord, RecordKind } from '../../domain/care';
import type {
  ApprovedSummary, ClarificationAnswer, CommunicationPreferences, Connection, Consultation,
  ConsultationStatus, DoctorNote, DoctorProfile, DoctorPublicInfo, Message, Profile, Role,
  Sensation, StatusChange, SymptomDetails, AuditEvent, MessageMeta,
} from '../../domain/types';
import type { Reconstruction } from '../../domain/reconstruction';
import type { ClinicalReview } from '../../domain/clinical';

export class BackendError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface SignUpInput {
  role: Role;
  fullName: string;
  /** required for email/password backends; ignored when the login is the Claude account */
  email?: string;
  password: string;
  specialty?: string;
  clinic?: string;
  /** set by the website's server backend so the Patient ID it logs in with is the one stored */
  patientCode?: string;
}

export interface Me {
  profile: Profile;
  doctor?: DoctorProfile;
  /** caregivers: the ID they give to the patient they help */
  caregiverId?: string;
  preferences: CommunicationPreferences;
}

export interface PatientSummary {
  profile: Profile;
  connectedAt: string;
  preferences?: CommunicationPreferences; // only when the patient shares them
  consultationCount: number;
}

export interface DoctorStats {
  connectedPatients: number;
  newCount: number;
  inReviewCount: number;
  completedCount: number;
}

/** What the patient approves for a diary entry; `share` sends it to the connected doctor. */
export type DiaryInput = Omit<DiaryEntry, 'id' | 'at' | 'sharedWith'> & { share: boolean; /** keeps the id of a caregiver's note when it is imported */ importId?: string };

export interface ConsultationView {
  consultation: Consultation;
  /** when the doctor last opened it (audit) */
  viewedAt?: string;
  patient: Pick<Profile, 'id' | 'fullName'>;
  doctor?: DoctorPublicInfo;
}

export interface SignInInput { email?: string; role?: Role; password: string }

/** How this backend identifies people. */
export interface AuthInfo {
  kind: 'email-password' | 'claude-account';
  /** for claude-account: the signed-in Claude user's display name ("" if unknown) */
  identityName?: string;
  /** for claude-account: AccessCare accounts that already exist on this identity */
  existingRoles?: Role[];
}

export interface Backend {
  readonly mode: 'local-demo' | 'supabase' | 'claude-cloud' | 'server';
  readonly persistent: boolean;
  /** true only when data really syncs between devices through a server */
  readonly shared: boolean;

  // auth
  authInfo(): Promise<AuthInfo>;
  signUp(input: SignUpInput): Promise<Me>;
  signIn(input: SignInInput): Promise<Me>;
  signOut(): Promise<void>;
  restoreSession(): Promise<Me | null>;
  requestPasswordReset(email: string): Promise<{ supported: boolean }>;
  deleteAccount(password: string): Promise<void>;
  updateProfile(patch: { fullName?: string; specialty?: string; clinic?: string }): Promise<Me>;

  /**
   * Recovery: a one-time code that can set a new password. Returns the new code
   * (shown/read once; only a hash or a wrapped key is stored). Optional per backend.
   */
  createRecoveryCode?(): Promise<string>;
  recoverAccount?(input: { login?: string; role?: Role; recoveryCode: string; newPassword: string }): Promise<Me>;

  // preferences
  savePreferences(prefs: CommunicationPreferences): Promise<CommunicationPreferences>;

  // doctor id + connections
  lookupDoctor(doctorId: string): Promise<DoctorPublicInfo>;
  connectToDoctor(doctorId: string): Promise<Connection>;
  disconnectDoctor(): Promise<void>;
  getMyDoctor(): Promise<DoctorPublicInfo | null>;
  listMyPatients(): Promise<PatientSummary[]>;
  disconnectPatient(patientId: string): Promise<void>;
  doctorStats(): Promise<DoctorStats>;

  // consultations
  createConsultation(kind?: 'consultation' | 'signal'): Promise<Consultation>;
  updateDraft(id: string, patch: {
    regionIds?: string[]; sensations?: Sensation[]; details?: SymptomDetails;
    answers?: ClarificationAnswer[]; draftSummaryText?: string; urgentGuidanceShown?: boolean;
    reconstruction?: Reconstruction; audit?: AuditEvent[];
  }): Promise<Consultation>;
  approveAndShare(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation>;
  saveApprovedWithoutDoctor(id: string, summary: Omit<ApprovedSummary, 'approvedAt'>): Promise<Consultation>;
  cancelConsultation(id: string): Promise<void>;
  listConsultations(): Promise<ConsultationView[]>;
  getConsultation(id: string): Promise<ConsultationView>;
  setStatus(id: string, status: ConsultationStatus): Promise<Consultation>;
  statusHistory(id: string): Promise<StatusChange[]>;

  // symptom diary: the patient writes; the connected doctor reads only the entries the patient shared with them
  addDiaryEntry(entry: DiaryInput): Promise<DiaryEntry>;
  /** patient: their own entries; doctor: entries a connected patient shared with them (patientId required) */
  listDiary(patientId?: string): Promise<DiaryEntry[]>;
  deleteDiaryEntry(id: string): Promise<void>;

  // care records (medicine check-ins, photos, emergency card): same sharing rules as the diary; 'card' is never shared
  addRecord(kind: RecordKind, data: unknown, opts?: { share?: boolean; by?: string; id?: string }): Promise<PatientRecord>;
  listRecords(kind: RecordKind, patientId?: string): Promise<PatientRecord[]>;
  deleteRecord(id: string): Promise<void>;

  // caregivers — the patient links a caregiver by the caregiver's ID (the patient decides; an ID alone gives no access)
  lookupCaregiver(caregiverId: string): Promise<{ name: string }>;
  connectCaregiver(caregiverId: string): Promise<CaregiverLink>;
  listMyCaregivers(): Promise<CaregiverLink[]>;
  removeCaregiver(id: string): Promise<void>;
  /** patient: the encrypted summary each linked caregiver can read */
  publishCareDigest(digest: CareDigest): Promise<void>;
  /** patient: check-ins caregivers recorded, not yet in the patient's records */
  pendingCaregiverItems(): Promise<{ item: CaregiverItem; caregiver: CaregiverLink }[]>;
  /** caregiver: the patients who linked them, with the latest digest */
  listCaredPatients(): Promise<{ id: string; name: string; digest: CareDigest | null; since: string }[]>;
  /** caregiver: record a check-in for a patient they help */
  caregiverAdd(patientId: string, item: Omit<CaregiverItem, 'id' | 'at'>): Promise<CaregiverItem>;

  // notes (doctor only, never visible to patients)
  listNotes(consultationId: string): Promise<DoctorNote[]>;
  addNote(consultationId: string, body: string): Promise<DoctorNote>;

  // clinical decision support (doctor only; private to the doctor, never shown to the patient)
  getClinicalReview(consultationId: string): Promise<ClinicalReview>;
  saveClinicalReview(consultationId: string, review: ClinicalReview): Promise<ClinicalReview>;

  // messaging
  listMessages(consultationId: string): Promise<Message[]>;
  sendMessage(consultationId: string, body: string, kind?: Message['kind'], meta?: MessageMeta): Promise<Message>;
  /** doctor opened a shared consultation (audit; patient can see when it was seen) */
  markViewed?(consultationId: string): Promise<void>;

  /** live updates from other devices; returns an unsubscribe function */
  onChange?(cb: () => void): () => void;

  // demo only
  resetDemoData?(): Promise<void>;
  seedDemo?(): Promise<{ doctorEmail: string; patientEmail: string; password: string; doctorId: string }>;
}
