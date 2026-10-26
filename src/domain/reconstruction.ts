// Patient Intent Reconstruction — data model.
// A Reconstruction is the system's provisional understanding of what the
// patient is trying to communicate. Every item records where its value came
// from, what the patient first said, and every change, so that a doctor can
// tell patient facts from system wording and from unresolved uncertainty.

/** Where an item's current value came from. */
export type Source =
  | 'patient_selected'            // tapped / chose it directly
  | 'patient_typed'               // their own words
  | 'patient_answer'              // answered a follow-up question
  | 'patient_confirmed_suggestion'// the system proposed it from their words and they said "yes"
  | 'patient_correction'          // changed it during verification
  | 'none';

export type ItemStatus =
  | 'confirmed'            // patient provided or confirmed it
  | 'unanswered'           // nobody knows yet
  | 'unsure'               // patient said they are not sure
  | 'needs_clarification'  // involved in an unresolved contradiction
  | 'suggested'            // system proposed a value; patient has not confirmed it
  | 'removed';             // patient removed it

export type FieldKey = 'region' | 'sensation' | 'other_sensation' | 'onset' | 'pattern' | 'severity' | 'extent' | 'both_sides' | 'associated' | 'context';

export interface Suggestion {
  value: string;
  /** exact words of the patient the suggestion is based on */
  quote: string;
  by: 'rules' | 'ai';
}

export interface HistoryEntry {
  at: string;
  action: 'captured' | 'suggested' | 'suggestion_accepted' | 'suggestion_rejected' | 'answered' | 'marked_unsure' | 'skipped'
    | 'corrected' | 'removed' | 'restored' | 'clarified';
  from?: string | null;
  to?: string | null;
  by: 'patient' | 'rules' | 'ai' | 'doctor';
  note?: string;
}

export interface ReconItem {
  key: string;
  field: FieldKey;
  label: string;
  value: string | null;
  status: ItemStatus;
  source: Source;
  /** optional items (e.g. "anything else") never count as missing */
  optional?: boolean;
  suggestion?: Suggestion;
  initial: { value: string | null; status: ItemStatus };
  corrected: boolean;
  history: HistoryEntry[];
}

export interface Contradiction {
  id: string;
  description: string;
  keys: string[];
  status: 'open' | 'clarified' | 'unresolved';
  resolution?: string;
}

export interface Reconstruction {
  version: 1;
  createdAt: string;
  items: ReconItem[];
  contradictions: Contradiction[];
  /** question ids already asked (never asked twice) */
  asked: string[];
}

export interface VerificationMetrics {
  initiallyCaptured: number;
  missingAtStart: number;
  missingResolved: number;
  stillMissing: number;
  correctedByPatient: number;
  removedByPatient: number;
  suggestionsOffered: number;
  suggestionsAccepted: number;
  suggestionsRejected: number;
  contradictionsDetected: number;
  contradictionsClarified: number;
  finalConfirmed: number;
}

export type Provenance = 'patient' | 'template_wording' | 'ai_wording' | 'unknown' | 'clinician';

export interface BriefLine { text: string; provenance: Provenance }
export interface BriefSection { id: number; title: string; lines: BriefLine[] }
export interface ClinicalBrief {
  sections: BriefSection[];
  wordedBy: 'rules' | 'ai';
  generatedAt: string;
}

export interface SignalSelection {
  step: string;
  question: string;
  choice: string;
  /** true only when the patient explicitly confirmed this selection */
  confirmed: boolean;
  at: string;
  /** camera mode: confirmed answer, the patient's own "not sure", or no answer */
  status?: 'confirmed' | 'not_sure' | 'unanswered';
  /** how it was given, e.g. "Eyes closed (held) → Yes" */
  via?: string;
}

export interface SignalRecord {
  method: string;
  selections: SignalSelection[];
  wording: string;
  wordingSource: 'template' | 'ai' | 'patient';
  regionIds: string[];
  rejectedWordings: number;
}
