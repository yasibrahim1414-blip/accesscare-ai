// AccessCare AI — Clinical Intelligence Engine: data model.
//
// Decision support for a licensed doctor reviewing a report the patient has
// approved and sent. Every observation points to the facts it is based on
// (CaseFact ids). Facts come only from the patient's report, answers the
// patient approved after sending, or what the doctor documented. Nothing here
// is a diagnosis, and nothing is clinically validated.

export type FactStatus = 'confirmed' | 'unsure' | 'interpretation' | 'denied';
export type FactSource =
  | 'patient_words'      // the patient's own words (quote kept)
  | 'patient_choice'     // picked an option / answered a question
  | 'body_map'           // tapped the body map
  | 'silent_signal'      // Silent Signal selection (pictures, switch, signs)
  | 'clarification'      // answered the doctor's question after sending (patient-approved)
  | 'clinician'          // documented by the doctor
  | 'system';            // app event (e.g. emergency guidance shown)

export interface CaseFact {
  id: string;            // F1, F2, …
  label: string;         // "Headache", "How it started", "Allergies"
  value: string;         // "sudden", "Patient said: …"
  status: FactStatus;
  source: FactSource;
  quote?: string;
  /** lexicon concept id when the fact is a symptom (or an attribute of one) */
  concept?: string;
  /** attribute name for symptom attributes: onset, onset_type, severity, pattern, location, side, sensation */
  attr?: string;
}

export type WarningLevel = 'emergency' | 'urgent' | 'info';

export interface ClinicalWarning {
  id: string;            // rule id
  level: WarningLevel;
  title: string;
  /** why the rule fired, in plain words */
  why: string;
  /** fact ids that triggered it */
  evidence: string[];
  action: string;
  refs: string[];        // reference catalog ids
  by: 'rules' | 'ai';
}

export type MissingStatus = 'missing' | 'unsure' | 'asked' | 'answered';

export interface MissingItem {
  id: string;            // stable: "<concept>:<topic>" or "doc:<field>"
  topic: string;
  /** why it could change the assessment */
  why: string;
  importance: 'high' | 'medium';
  /** for: which complaint, or 'treatment' for medication safety */
  for: string;
  status: MissingStatus;
  /** wording for the patient, and an accessible answer format */
  question: string;
  format: 'yes_no' | 'choice' | 'text';
  options?: string[];
  refs: string[];
}

export interface ClinicalConflict {
  id: string;
  description: string;
  evidence: string[];
  status: 'open' | 'clarified' | 'unresolved';
}

export interface Consideration {
  id: string;
  title: string;
  /** fact ids that support it (required) */
  supporting: string[];
  /** fact ids that argue against it (optional) */
  against: string[];
  missing: string[];
  uncertainty: string;
  refs: string[];
  by: 'ai';
}

export interface NextStep {
  id: string;
  kind: 'question' | 'examination' | 'investigation' | 'referral' | 'other';
  text: string;
  why: string;
  supporting: string[];
  refs: string[];
  by: 'rules' | 'ai';
}

export type AIRun = { status: 'not_requested' | 'used' | 'not_consented' | 'unavailable' | 'failed'; error?: string; at?: string; rejected?: number };

export interface ClinicalAnalysis {
  v: 1;
  generatedAt: string;
  facts: CaseFact[];
  warnings: ClinicalWarning[];
  missing: MissingItem[];
  conflicts: ClinicalConflict[];
  considerations: Consideration[];
  nextSteps: NextStep[];
  limitations: string[];
  ai: AIRun;
}

/** What the doctor documented (never guessed). 'unknown' is a real answer: not known yet. */
export interface Documented {
  age: string;                                   // years, '' = unknown
  sex: 'female' | 'male' | 'other' | 'unknown';
  pregnancy: 'yes' | 'no' | 'not_applicable' | 'unknown';
  allergies: { status: 'none_known' | 'listed' | 'unknown'; items: string[] };
  medications: { status: 'none' | 'listed' | 'unknown'; items: string[] };
  conditions: string;                            // free text, '' = none documented
  kidney: 'normal' | 'impaired' | 'unknown';
  liver: 'normal' | 'impaired' | 'unknown';
  updatedAt?: string;
}

export const EMPTY_DOCUMENTED: Documented = {
  age: '', sex: 'unknown', pregnancy: 'unknown', allergies: { status: 'unknown', items: [] }, medications: { status: 'unknown', items: [] },
  conditions: '', kidney: 'unknown', liver: 'unknown',
};

export type DecisionStatus = 'accepted' | 'rejected' | 'needs_assessment';
export interface Decision { status: DecisionStatus; at: string; note?: string }

export interface LabelMention { term: string; section: string; excerpt: string }

/** Facts from an FDA drug label (openFDA), never AI text. */
export interface LabelInfo {
  setId: string;
  title: string;               // generic (brand)
  productType: string;
  effective: string;           // label effective date (YYYYMMDD)
  url: string;                 // DailyMed page for this label
  indications?: string;
  boxedWarning?: string;
  contraindications?: string;
  warnings?: string;
  /** label text that mentions a documented allergy / current medicine / patient factor */
  allergyMentions: LabelMention[];
  interactionMentions: LabelMention[];
  factorNotes: LabelMention[];
}

export interface MedOption {
  id: string;
  generic: string;
  reason: string;              // AI: why a doctor might consider it
  supporting: string[];        // fact ids
  checks: string[];            // AI: what to check before prescribing
  verification: 'label_found' | 'label_not_found' | 'source_unavailable';
  label?: LabelInfo;
  by: 'ai';
}

export interface MedSuggestions {
  generatedAt: string;
  status: 'ok' | 'withheld' | 'unavailable' | 'failed';
  /** why options were withheld or unavailable */
  reasons: string[];
  options: MedOption[];
  /** options the AI proposed that could not be checked against a label (named, not shown as options) */
  unverified: string[];
  source: string;              // "openFDA drug labeling (FDA)"
}

export type RxStatus = 'draft' | 'approved' | 'sent' | 'cancelled';
export interface Prescription {
  id: string;
  status: RxStatus;
  medication: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  instructions: string;
  /** medication option it started from, if any (the doctor may change everything) */
  fromOption?: string;
  labelUrl?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  sentAt?: string;
  messageId?: string;
}

export interface ReviewLog { at: string; action: string; detail?: string }

/** The doctor's private record for one consultation (stored encrypted / under RLS, never shown to the patient). */
export interface ClinicalReview {
  v: 1;
  consultationId: string;
  analysis?: ClinicalAnalysis;
  documented: Documented;
  decisions: Record<string, Decision>;
  meds?: MedSuggestions;
  prescriptions: Prescription[];
  log: ReviewLog[];
  updatedAt: string;
}

export const newReview = (consultationId: string): ClinicalReview => ({
  v: 1, consultationId, documented: JSON.parse(JSON.stringify(EMPTY_DOCUMENTED)), decisions: {}, prescriptions: [], log: [], updatedAt: new Date().toISOString(),
});

/** What travels to the patient inside a prescription message (doctor-approved only). */
export interface RxMeta {
  id: string;
  medication: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  instructions: string;
  approvedAt: string;
  approvedBy: string;
  labelUrl?: string;
}

// ---------------------------------------------------------------- validation
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt);
const strList = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => s(x, max)).filter(Boolean).slice(0, n) : []);

export function cleanDocumented(d: Partial<Documented> | undefined): Documented {
  const x = d ?? {};
  const age = s(x.age, 3).replace(/[^0-9]/g, '');
  return {
    age: age && Number(age) <= 125 ? age : '',
    sex: oneOf(x.sex, ['female', 'male', 'other', 'unknown'] as const, 'unknown'),
    pregnancy: oneOf(x.pregnancy, ['yes', 'no', 'not_applicable', 'unknown'] as const, 'unknown'),
    allergies: { status: oneOf(x.allergies?.status, ['none_known', 'listed', 'unknown'] as const, 'unknown'), items: strList(x.allergies?.items, 12, 60) },
    medications: { status: oneOf(x.medications?.status, ['none', 'listed', 'unknown'] as const, 'unknown'), items: strList(x.medications?.items, 20, 80) },
    conditions: s(x.conditions, 500),
    kidney: oneOf(x.kidney, ['normal', 'impaired', 'unknown'] as const, 'unknown'),
    liver: oneOf(x.liver, ['normal', 'impaired', 'unknown'] as const, 'unknown'),
    ...(x.updatedAt ? { updatedAt: s(x.updatedAt, 40) } : {}),
  };
}

export function cleanRxMeta(r: Partial<RxMeta> | undefined): RxMeta | undefined {
  if (!r) return undefined;
  const out: RxMeta = {
    id: s(r.id, 40), medication: s(r.medication, 120), dose: s(r.dose, 120), route: s(r.route, 60), frequency: s(r.frequency, 120),
    duration: s(r.duration, 120), instructions: s(r.instructions, 800), approvedAt: s(r.approvedAt, 40), approvedBy: s(r.approvedBy, 120),
    ...(r.labelUrl && /^https:\/\/dailymed\.nlm\.nih\.gov\//.test(r.labelUrl) ? { labelUrl: s(r.labelUrl, 200) } : {}),
  };
  // a prescription message without the doctor's approval is not a prescription
  if (!out.id || !out.medication || !out.dose || !out.approvedAt || !out.approvedBy) return undefined;
  return out;
}

/** Bounds a stored review (from any backend) before it is used. */
export function cleanReview(r: unknown, consultationId: string): ClinicalReview {
  const x = (r && typeof r === 'object' ? r : {}) as Partial<ClinicalReview>;
  const json = JSON.stringify(x);
  if (json.length > 400_000) return newReview(consultationId);
  const decisions: Record<string, Decision> = {};
  for (const [k, v] of Object.entries(x.decisions ?? {}).slice(0, 200)) {
    if (v && ['accepted', 'rejected', 'needs_assessment'].includes(v.status)) decisions[s(k, 80)] = { status: v.status, at: s(v.at, 40), ...(v.note ? { note: s(v.note, 300) } : {}) };
  }
  const rx = Array.isArray(x.prescriptions) ? x.prescriptions.slice(0, 30).map((p) => ({
    id: s(p.id, 40), status: oneOf(p.status, ['draft', 'approved', 'sent', 'cancelled'] as const, 'draft'),
    medication: s(p.medication, 120), dose: s(p.dose, 120), route: s(p.route, 60), frequency: s(p.frequency, 120), duration: s(p.duration, 120),
    instructions: s(p.instructions, 800), ...(p.fromOption ? { fromOption: s(p.fromOption, 40) } : {}), ...(p.labelUrl ? { labelUrl: s(p.labelUrl, 200) } : {}),
    createdAt: s(p.createdAt, 40), updatedAt: s(p.updatedAt, 40),
    ...(p.approvedAt ? { approvedAt: s(p.approvedAt, 40) } : {}), ...(p.approvedBy ? { approvedBy: s(p.approvedBy, 120) } : {}),
    ...(p.sentAt ? { sentAt: s(p.sentAt, 40) } : {}), ...(p.messageId ? { messageId: s(p.messageId, 80) } : {}),
  })).filter((p) => p.id) : [];
  return {
    v: 1, consultationId,
    ...(x.analysis && typeof x.analysis === 'object' && Array.isArray(x.analysis.facts) ? { analysis: x.analysis } : {}),
    documented: cleanDocumented(x.documented),
    decisions,
    ...(x.meds && typeof x.meds === 'object' && Array.isArray(x.meds.options) ? { meds: x.meds } : {}),
    prescriptions: rx,
    log: Array.isArray(x.log) ? x.log.slice(-200).map((l) => ({ at: s(l.at, 40), action: s(l.action, 60), ...(l.detail ? { detail: s(l.detail, 300) } : {}) })) : [],
    updatedAt: s(x.updatedAt, 40) || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- follow-up after treatment
export type FollowLang = 'en' | 'ar';
export const SIDE_EFFECTS: { id: string; en: string; ar: string }[] = [
  { id: 'swelling', en: 'Swelling of the lips, face, tongue or throat', ar: 'تورم في الشفايف أو الوش أو اللسان أو الزور' },
  { id: 'breathing', en: 'Trouble breathing or a tight throat', ar: 'صعوبة في التنفس أو زوري مقفول' },
  { id: 'rash', en: 'Rash or itchy skin', ar: 'طفح أو هرش في الجلد' },
  { id: 'stomach', en: 'Stomach upset, nausea or diarrhea', ar: 'تعب في المعدة أو غثيان أو إسهال' },
  { id: 'dizzy', en: 'Dizziness or feeling faint', ar: 'دوخة أو إحساس إني هيغمى عليا' },
  { id: 'sleepy', en: 'Very sleepy or tired', ar: 'نعسان أو تعبان جداً' },
  { id: 'other', en: 'Something else', ar: 'حاجة تانية' },
];
export interface FollowUpMeta {
  id: string;
  /** when the patient is asked (ISO); before that the patient only sees that it is coming */
  dueAt: string;
  askedBy: string;
  /** the prescription it follows, if any */
  rxId?: string;
  medication?: string;
}
export interface FollowUpAnswer {
  replyTo: string;
  feeling: 'better' | 'same' | 'worse' | 'not_sure';
  /** SIDE_EFFECTS ids, or ['none'], or ['not_sure'] */
  sideEffects: string[];
  adherence: 'yes' | 'sometimes' | 'no' | 'not_sure' | 'not_asked';
  other?: string;
  approvedByPatient: true;
}
export interface VisitSummaryMeta {
  id: string;
  text: string;
  /** who wrote the final wording: the doctor, or AI wording the doctor reviewed and approved */
  source: 'doctor' | 'ai_reviewed';
  approvedBy: string;
  approvedAt: string;
}

export function cleanFollowUp(f: Partial<FollowUpMeta> | undefined): FollowUpMeta | undefined {
  if (!f) return undefined;
  const out: FollowUpMeta = { id: s(f.id, 40), dueAt: s(f.dueAt, 40), askedBy: s(f.askedBy, 120),
    ...(f.rxId ? { rxId: s(f.rxId, 40) } : {}), ...(f.medication ? { medication: s(f.medication, 120) } : {}) };
  return out.id && out.askedBy && !Number.isNaN(Date.parse(out.dueAt)) ? out : undefined;
}
export function cleanFollowUpAnswer(a: Partial<FollowUpAnswer> | undefined): FollowUpAnswer | undefined {
  if (!a || a.approvedByPatient !== true) return undefined;
  const ids = new Set([...SIDE_EFFECTS.map((x) => x.id), 'none', 'not_sure']);
  const se = Array.isArray(a.sideEffects) ? [...new Set(a.sideEffects.filter((x): x is string => typeof x === 'string' && ids.has(x)))].slice(0, 8) : [];
  const out: FollowUpAnswer = {
    replyTo: s(a.replyTo, 80), feeling: oneOf(a.feeling, ['better', 'same', 'worse', 'not_sure'] as const, 'not_sure'),
    sideEffects: se.length ? se : ['not_sure'], adherence: oneOf(a.adherence, ['yes', 'sometimes', 'no', 'not_sure', 'not_asked'] as const, 'not_sure'),
    ...(a.other ? { other: s(a.other, 500) } : {}), approvedByPatient: true,
  };
  return out.replyTo ? out : undefined;
}
export function cleanVisitSummary(v: Partial<VisitSummaryMeta> | undefined): VisitSummaryMeta | undefined {
  if (!v) return undefined;
  const out: VisitSummaryMeta = { id: s(v.id, 40), text: s(v.text, 1800), source: v.source === 'ai_reviewed' ? 'ai_reviewed' : 'doctor', approvedBy: s(v.approvedBy, 120), approvedAt: s(v.approvedAt, 40) };
  return out.id && out.text && out.approvedBy && out.approvedAt ? out : undefined;
}

/** Deterministic flags on a follow-up answer (NHS anaphylaxis page for allergic-reaction signs). */
export function followUpFlags(a: FollowUpAnswer): { level: 'emergency' | 'urgent' | 'info'; text: string; refs: string[] }[] {
  const out: { level: 'emergency' | 'urgent' | 'info'; text: string; refs: string[] }[] = [];
  if (a.sideEffects.includes('swelling') || a.sideEffects.includes('breathing')) out.push({ level: 'emergency', text: 'Possible severe allergic reaction (swelling of lips/face/tongue/throat or trouble breathing). Call the emergency number now.', refs: ['nhs_anaphylaxis'] });
  if (a.sideEffects.includes('rash')) out.push({ level: 'urgent', text: 'New rash or itchy skin after the medicine.', refs: ['nhs_anaphylaxis'] });
  if (a.feeling === 'worse') out.push({ level: 'urgent', text: 'The patient feels worse.', refs: [] });
  if (a.sideEffects.some((x) => ['stomach', 'dizzy', 'sleepy', 'other'].includes(x))) out.push({ level: 'info', text: 'Side effects reported.', refs: [] });
  if (a.adherence === 'no' || a.adherence === 'sometimes') out.push({ level: 'info', text: a.adherence === 'no' ? 'Not taking the medicine.' : 'Taking the medicine only sometimes.', refs: [] });
  return out;
}
