// The patient's consultation as a conversation record.
//
// Every input method (speech, typing, touch choices, the body map) adds
// to the same record. Each fact keeps where it came from:
//   said     — the patient's own words (quote kept)
//   chosen   — the patient picked an option or tapped the body map
//   inferred — an interpretation (by AI or rules) that the patient has not confirmed yet
// `confirmed` becomes true only when the patient explicitly agrees.
// Nothing is invented: what the patient did not tell us stays unknown.

import type { Sensation } from './types';

export type Via = 'voice' | 'text' | 'touch' | 'body_map';
export type Prov = 'said' | 'chosen' | 'inferred';
export type SlotId = 'location' | 'side' | 'sensation' | 'severity' | 'onset' | 'onset_type' | 'pattern' | 'associated';
export type ConsultLang = 'en' | 'ar';

export interface Fact {
  value: string;
  /** what to show/say, in both languages */
  en: string;
  ar: string;
  /** the patient's exact words, when the fact came from words */
  quote?: string;
  prov: Prov;
  by: 'patient' | 'rules' | 'ai';
  via: Via;
  confirmed: boolean;
}

export interface RegionFact { id: string; quote?: string; prov: Prov; by: 'patient' | 'rules' | 'ai'; via: Via; confirmed: boolean }

export interface Complaint {
  id: string;
  /** lexicon concept id ('headache', 'abdominal_pain', 'pain', 'other', …) */
  concept: string;
  en: string;
  ar: string;
  /** the words in which the patient first reported it */
  quote: string;
  via: Via;
  prov: Prov;
  confirmed: boolean;
  regions: RegionFact[];
  facts: Partial<Record<SlotId, Fact>>;
  /** questions the patient answered "not sure" or skipped */
  unknown: SlotId[];
  /** questions already asked (never asked more than twice) */
  asked: SlotId[];
  /** questions put back once because the patient talked about something else */
  reasked?: SlotId[];
  /** reported together with another complaint (e.g. nausea with a headache) */
  with?: string;
}

export interface Correction { complaint: string; field: string; from: string; to: string; quote?: string; by: 'patient' }
export interface Note { text: string; via: Via; kind: 'question' | 'note' | 'feeling' }
export interface Turn { who: 'patient' | 'assistant'; text: string; via?: Via; ai?: boolean }

export type PendingKind = 'opening' | 'slot' | 'confirm' | 'clarify_conflict' | 'clarify_vague' | 'anything_else' | 'review';

export interface Pending {
  kind: PendingKind;
  complaint?: string;
  slot?: SlotId;
  /** for 'confirm' / 'clarify_conflict': the fact in question */
  value?: string;
  other?: string;
  /** spoken question text (for repeat and for the AI) */
  text: string;
  options: { id: string; label: string }[];
  /** asked by the AI (free options) */
  ai?: boolean;
}

export interface ConsultRecord {
  v: 1;
  lang: ConsultLang;
  complaints: Complaint[];
  /** symptoms the patient said they do NOT have (concept ids) */
  denied: string[];
  notes: Note[];
  corrections: Correction[];
  urgent: string[];
  turns: Turn[];
  pending: Pending | null;
  /** consecutive answers that could not be understood (to change approach, never loop) */
  misses: number;
  /** counts for the honest "AI status" line */
  ai: { used: number; failed: number; lastError?: string };
  anythingElseAsked: boolean;
}

export const SENSATION_IDS: Sensation[] = ['pain', 'burning', 'numbness', 'tingling', 'itching', 'swelling', 'weakness', 'other', 'not_sure'];
