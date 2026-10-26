// Core typed data model for AccessCare AI.
// Mirrors the Supabase schema in supabase/schema.sql so the demo backend
// can be swapped for the production backend without touching screens.

import { cleanCameraPrefs, type CameraSignalPrefs } from './camera';
import { cleanBlindPrefs, type BlindPrefs } from './voice';

export type Role = 'patient' | 'doctor' | 'caregiver';

export interface Profile {
  id: string;
  role: Role;
  fullName: string;
  email: string;
  createdAt: string;
  /** patients: a readable identifier (AC-PAT-XXXXXX); never a credential */
  patientCode?: string;
}

export interface DoctorProfile {
  userId: string;
  doctorId: string; // e.g. AC-DOC-7K4P9X — an identifier, never a credential
  specialty?: string;
  clinic?: string;
}

/** What a patient may see about a doctor before connecting. */
export interface DoctorPublicInfo {
  doctorId: string;
  fullName: string;
  specialty?: string;
  clinic?: string;
}

export interface CommunicationPreferences {
  simpleText: boolean;
  largeButtons: boolean;
  yesNoQuestions: boolean;
  multipleChoice: boolean;
  shortSentences: boolean;
  visualOptions: boolean;
  textToSpeech: boolean;
  speechInput: boolean;
  reducedMotion: boolean;
  largerText: boolean;
  shareWithDoctor: boolean;
  /** explicit consent to send report contents (never name or account) to Claude for wording and suggestions */
  aiAssist: boolean;
  /** relaxed = longer pauses, slower scanning, no auto-advance */
  relaxedPace: boolean;
  /** onboarding questions were answered */
  onboarded?: boolean;
  /** Silent Signal setup; communication preferences, not medical history */
  signal?: SignalPrefs;
  /** Blind Access & Voice Companion settings */
  blind?: BlindPrefs;
}

export type SignalMethod = 'large_buttons' | 'switch_scan' | 'yes_no' | 'symbols' | 'speech';

export interface SignalCalibration {
  method: SignalMethod;
  at: string;
  attempts: number;
  correct: number;
  /** selections the patient said were registered wrongly */
  misregistered: number;
  ambiguous: number;
  passed: boolean;
}

export interface SignalPrefs {
  method: SignalMethod;
  /** each selection must be confirmed before it counts */
  confirmEachSelection: boolean;
  /** switch scanning step, milliseconds */
  scanMs: number;
  speakSelections: boolean;
  calibration?: SignalCalibration;
  /** camera sign-language mode: sign → command mapping and practice results only, never images */
  camera?: CameraSignalPrefs;
}

export const DEFAULT_SIGNAL: SignalPrefs = { method: 'large_buttons', confirmEachSelection: true, scanMs: 1500, speakSelections: false };

export const DEFAULT_PREFERENCES: CommunicationPreferences = {
  simpleText: false,
  largeButtons: false,
  yesNoQuestions: true,
  multipleChoice: true,
  shortSentences: false,
  visualOptions: true,
  textToSpeech: false,
  speechInput: false,
  reducedMotion: false,
  largerText: false,
  shareWithDoctor: true,
  aiAssist: false,
  relaxedPace: false,
};

/** Validates preferences from any source (backends call this before saving). */
export function cleanPreferences(p: Partial<CommunicationPreferences> | undefined): CommunicationPreferences {
  const out = { ...DEFAULT_PREFERENCES } as CommunicationPreferences;
  const bools: (keyof CommunicationPreferences)[] = ['simpleText', 'largeButtons', 'yesNoQuestions', 'multipleChoice', 'shortSentences', 'visualOptions',
    'textToSpeech', 'speechInput', 'reducedMotion', 'largerText', 'shareWithDoctor', 'aiAssist', 'relaxedPace', 'onboarded'];
  for (const k of bools) if (p && p[k] !== undefined) (out as unknown as Record<string, boolean>)[k] = !!p[k];
  const s = p?.signal;
  if (s && typeof s === 'object') {
    const methods: SignalMethod[] = ['large_buttons', 'switch_scan', 'yes_no', 'symbols', 'speech'];
    const c = s.calibration;
    out.signal = {
      method: methods.includes(s.method) ? s.method : 'large_buttons',
      confirmEachSelection: s.confirmEachSelection !== false,
      scanMs: Math.min(4000, Math.max(600, Math.round(Number(s.scanMs) || 1500))),
      speakSelections: !!s.speakSelections,
      calibration: c && methods.includes(c.method) ? {
        method: c.method, at: String(c.at).slice(0, 40),
        attempts: Math.max(0, Math.round(Number(c.attempts) || 0)), correct: Math.max(0, Math.round(Number(c.correct) || 0)),
        misregistered: Math.max(0, Math.round(Number(c.misregistered) || 0)), ambiguous: Math.max(0, Math.round(Number(c.ambiguous) || 0)),
        passed: !!c.passed,
      } : undefined,
      camera: cleanCameraPrefs(s.camera),
    };
    if (!out.signal.camera) delete out.signal.camera;
  }
  const blind = cleanBlindPrefs(p?.blind);
  if (blind) out.blind = blind;
  return out;
}

export interface Connection {
  id: string;
  patientId: string;
  doctorUserId: string;
  createdAt: string;
  active: boolean;
}

export type Sensation =
  | 'pain' | 'numbness' | 'burning' | 'itching' | 'swelling'
  | 'weakness' | 'tingling' | 'other' | 'not_sure';

export type Pattern = 'constant' | 'comes_and_goes';

/** Patient-entered details. Every field is optional by design. */
export interface SymptomDetails {
  severity?: number; // 1-10
  onset?: string; // chosen option label
  duration?: string;
  pattern?: Pattern;
  description?: string;
  otherSensation?: string;
}

export type AnswerStatus = 'answered' | 'unsure' | 'skipped';

export interface ClarificationAnswer {
  questionId: string;
  question: string;
  status: AnswerStatus;
  value?: string;
}

export type FieldStatus = 'confirmed' | 'unanswered' | 'unsure' | 'needs_clarification';

export interface ReportField {
  label: string;
  value: string;
  status: FieldStatus;
}

export interface StructuredReport {
  regions: string[]; // region labels
  sensations: string[];
  fields: ReportField[];
  clarifications: ClarificationAnswer[];
  flags: string[]; // possible inconsistencies the patient was asked about
  generatedBy: 'demo-rules' | 'ai-provider';
  /** Intent Reconstruction snapshot at approval (items, provenance, corrections) */
  reconstruction?: import('./reconstruction').Reconstruction;
  /** AI clinical brief the patient approved */
  brief?: import('./reconstruction').ClinicalBrief;
  metrics?: import('./reconstruction').VerificationMetrics;
  /** Silent Signal sessions: the patient's confirmed selections */
  signal?: import('./reconstruction').SignalRecord;
  /** the patient's AI-assistance consent at the moment they sent it (set by the backend, never by the screen) */
  aiConsent?: boolean;
}

export type ConsultationStatus = 'draft' | 'new' | 'in_review' | 'completed' | 'cancelled';

export interface ApprovedSummary {
  text: string; // exact text the patient approved
  report: StructuredReport; // structured snapshot at approval time
  editedByPatient: boolean;
  approvedAt: string;
}

export interface Consultation {
  id: string;
  patientId: string;
  doctorUserId?: string; // set only when shared with a connected doctor
  status: ConsultationStatus;
  regionIds: string[];
  sensations: Sensation[];
  details: SymptomDetails;
  answers: ClarificationAnswer[];
  draftSummaryText?: string;
  approved?: ApprovedSummary;
  urgentGuidanceShown: boolean;
  createdAt: string;
  updatedAt: string;
  sharedAt?: string;
  /** 'signal' = created in Silent Signal AI */
  kind?: 'consultation' | 'signal';
  /** working Intent Reconstruction state while drafting */
  reconstruction?: import('./reconstruction').Reconstruction;
  /** patient-side audit trail (created, captured, corrected, approved, shared) */
  audit?: AuditEvent[];
}

export interface AuditEvent { at: string; by: Role | 'system'; action: string; detail?: string }

export interface StatusChange {
  id: string;
  consultationId: string;
  from: ConsultationStatus | null;
  to: ConsultationStatus;
  byUserId: string;
  at: string;
}

export interface Message {
  id: string;
  consultationId: string;
  senderId: string;
  senderRole: Role;
  body: string;
  /** doctors can ask Yes/No questions the patient answers with one tap */
  kind: 'text' | 'yes_no_question' | 'clarification' | 'clarification_answer' | 'prescription' | 'followup' | 'followup_answer' | 'visit_summary' | 'body_probe' | 'body_probe_answer' | 'teachback';
  createdAt: string;
  meta?: MessageMeta;
}

export type ClarificationFormat = 'yes_no' | 'choice' | 'text' | 'symbols';

/** Structured data carried by clarification requests and answers. */
export interface MessageMeta {
  /** report item this is about (Intent Reconstruction key), if any */
  itemKey?: string;
  itemLabel?: string;
  format?: ClarificationFormat;
  options?: string[];
  /** id of the clarification request this answers */
  replyTo?: string;
  /** exactly what the patient selected or typed */
  raw?: string;
  /** who produced the wording in `body` */
  wordingSource?: 'patient' | 'template' | 'ai';
  approvedByPatient?: boolean;
  /** prescription messages: the doctor-approved prescription */
  rx?: import('./clinical').RxMeta;
  /** follow-up after treatment (doctor → patient) and the patient's approved answer */
  followup?: import('./clinical').FollowUpMeta;
  followupAnswer?: import('./clinical').FollowUpAnswer;
  /** the doctor's approved explanation of the visit for the patient */
  summary?: import('./clinical').VisitSummaryMeta;
  /** "Here?": the doctor points at a body area, the patient answers */
  probe?: import('./interact').ProbeMeta;
  probeAnswer?: import('./interact').ProbeAnswer;
  /** the patient's explanation of the plan, checked against what the doctor wrote */
  teachback?: import('./interact').TeachBack;
}

export interface DoctorNote {
  id: string;
  consultationId: string;
  doctorUserId: string;
  body: string;
  createdAt: string;
}

export interface Session {
  userId: string;
  role: Role;
  expiresAt: string;
}

export const SENSATION_LABELS: Record<Sensation, string> = {
  pain: 'Pain',
  numbness: 'Numbness',
  burning: 'Burning',
  itching: 'Itching',
  swelling: 'Swelling',
  weakness: 'Weakness',
  tingling: 'Tingling',
  other: 'Other',
  not_sure: 'Not sure',
};

export const STATUS_LABELS: Record<ConsultationStatus, string> = {
  draft: 'Draft — not sent',
  new: 'New',
  in_review: 'In Review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
