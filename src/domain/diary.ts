// Symptom diary: a short daily check-in the patient writes or says in their own
// words. Each entry keeps the exact words, what was understood from them (each
// item marked as the patient's words / chosen / an interpretation the patient
// confirmed), and whether the patient chose to share it with their doctor.

export type Trend = 'better' | 'same' | 'worse';
export type DiaryVia = 'voice' | 'text' | 'touch';

export interface DiaryItem {
  /** lexicon concept id ('headache', 'pain', 'other', …) */
  concept: string;
  en: string;
  ar: string;
  /** 0–10, or null when the patient did not say */
  severity: number | null;
  trend: Trend | null;
  /** the words this came from ('' when chosen on screen) */
  quote: string;
  /** said: in the patient's words; chosen: picked on screen; interpretation: read from the words and confirmed by the patient */
  prov: 'said' | 'chosen' | 'interpretation';
}

export interface DiaryEntry {
  id: string;
  at: string;
  /** the patient's own words (may be empty when everything was chosen on screen) */
  text: string;
  via: DiaryVia;
  /** compared with yesterday */
  feeling: Trend | null;
  items: DiaryItem[];
  /** took the medicine the doctor prescribed, if asked */
  medicine: 'yes' | 'some' | 'no' | null;
  /** urgent-help guidance shown while writing it (reasons) */
  urgent: string[];
  /** AI helped understand the words (the patient had AI assistance on) */
  ai: boolean;
  /** the patient allowed AI for their data when this was written (doctor-side AI summaries use only these) */
  aiAllowed: boolean;
  /** shared with the connected doctor (Dr … user id), or null */
  sharedWith: string | null;
  /** '' when the patient wrote it; otherwise the caregiver's name */
  by?: string;
}

const TRENDS: Trend[] = ['better', 'same', 'worse'];
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanDiaryItem(x: unknown): DiaryItem | null {
  if (!x || typeof x !== 'object') return null;
  const i = x as Partial<DiaryItem>;
  const concept = s(i.concept, 40).replace(/[^a-z_]/g, '');
  const en = s(i.en, 80);
  if (!concept || !en) return null;
  const sev = typeof i.severity === 'number' && Number.isFinite(i.severity) ? Math.round(Math.min(10, Math.max(0, i.severity))) : null;
  return {
    concept, en, ar: s(i.ar, 80) || en, severity: sev,
    trend: TRENDS.includes(i.trend as Trend) ? (i.trend as Trend) : null,
    quote: s(i.quote, 160),
    prov: i.prov === 'said' || i.prov === 'chosen' || i.prov === 'interpretation' ? i.prov : 'chosen',
  };
}

export function cleanDiaryEntry(x: unknown): DiaryEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Partial<DiaryEntry>;
  const items = Array.isArray(e.items) ? e.items.slice(0, 12).map(cleanDiaryItem).filter((i): i is DiaryItem => !!i) : [];
  const feeling = TRENDS.includes(e.feeling as Trend) ? (e.feeling as Trend) : null;
  const text = s(e.text, 600);
  if (!items.length && !feeling && !text) return null;
  return {
    id: s(e.id, 60) || '',
    at: s(e.at, 40) || new Date().toISOString(),
    text, via: e.via === 'voice' || e.via === 'touch' ? e.via : 'text',
    feeling, items,
    medicine: e.medicine === 'yes' || e.medicine === 'some' || e.medicine === 'no' ? e.medicine : null,
    urgent: Array.isArray(e.urgent) ? e.urgent.slice(0, 6).map((r) => s(r, 120)).filter(Boolean) : [],
    ai: e.ai === true, aiAllowed: e.aiAllowed === true,
    sharedWith: typeof e.sharedWith === 'string' && e.sharedWith ? s(e.sharedWith, 80) : null,
    ...(s(e.by, 60) ? { by: s(e.by, 60) } : {}),
  };
}

/** The same calendar day (local time). */
export const sameDay = (a: string, b: Date = new Date()) => {
  const d = new Date(a);
  return d.getFullYear() === b.getFullYear() && d.getMonth() === b.getMonth() && d.getDate() === b.getDate();
};
