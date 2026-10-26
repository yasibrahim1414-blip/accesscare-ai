// "Here?" — the doctor points at a body area and asks; the patient answers.
// Teach-back — after the visit the patient explains the plan in their own words
// and AccessCare checks it against what the doctor actually wrote.
import { BODY_REGIONS } from './bodyRegions';

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const REGION_IDS = new Set(BODY_REGIONS.map((r) => r.id));

export interface ProbeMeta {
  id: string;
  /** body regions the doctor pointed at (highlighted on the patient's body map) */
  regions: string[];
  /** e.g. "Does it hurt here?" */
  question: string;
  /** ask how strong (0–10) when the answer is yes */
  askStrength: boolean;
}
export interface ProbeAnswer {
  replyTo: string;
  answer: 'yes' | 'no' | 'not_sure';
  strength: number | null;
  regions: string[];
  /** how the patient answered (buttons, voice, signs) */
  via: string;
  approvedByPatient: true;
}

export function cleanProbe(p: Partial<ProbeMeta> | undefined): ProbeMeta | undefined {
  if (!p) return undefined;
  const regions = Array.isArray(p.regions) ? [...new Set(p.regions.filter((r): r is string => typeof r === 'string' && REGION_IDS.has(r)))].slice(0, 6) : [];
  const out: ProbeMeta = { id: s(p.id, 40), regions, question: s(p.question, 200) || 'Does it hurt here?', askStrength: p.askStrength !== false };
  return out.id && regions.length ? out : undefined;
}
export function cleanProbeAnswer(a: Partial<ProbeAnswer> | undefined): ProbeAnswer | undefined {
  if (!a || a.approvedByPatient !== true) return undefined;
  const answer = a.answer === 'yes' || a.answer === 'no' ? a.answer : 'not_sure';
  const strength = answer === 'yes' && typeof a.strength === 'number' && Number.isFinite(a.strength) ? Math.round(Math.min(10, Math.max(0, a.strength))) : null;
  const regions = Array.isArray(a.regions) ? a.regions.filter((r): r is string => typeof r === 'string' && REGION_IDS.has(r)).slice(0, 6) : [];
  const out: ProbeAnswer = { replyTo: s(a.replyTo, 80), answer, strength, regions, via: s(a.via, 40) || 'buttons', approvedByPatient: true };
  return out.replyTo ? out : undefined;
}

// ---------------------------------------------------------------- teach-back
export type TBStatus = 'understood' | 'different' | 'missing';
export interface TBPoint {
  /** e.g. "rx:<id>:frequency" or "visit:urgent" */
  id: string;
  /** what this point is about ("How often", "When to get urgent help") */
  label: string;
  /** what the doctor wrote — the only wording shown as "correct" */
  correct: string;
  status: TBStatus;
  /** the patient's words for this point ('' when missing) */
  quote: string;
  /** who judged it: AccessCare rules or AI (with a quote from the patient) */
  by: 'rules' | 'ai';
}
export interface TeachBack {
  replyTo: string;
  /** the patient's explanation, in their words */
  text: string;
  points: TBPoint[];
  ai: boolean;
  approvedByPatient: true;
}
const ST: TBStatus[] = ['understood', 'different', 'missing'];
export function cleanTeachBack(t: Partial<TeachBack> | undefined): TeachBack | undefined {
  if (!t || t.approvedByPatient !== true) return undefined;
  const points = Array.isArray(t.points) ? t.points.slice(0, 20).map((p) => ({
    id: s(p?.id, 80), label: s(p?.label, 80), correct: s(p?.correct, 300),
    status: ST.includes(p?.status as TBStatus) ? (p.status as TBStatus) : 'missing', quote: s(p?.quote, 200), by: p?.by === 'ai' ? 'ai' as const : 'rules' as const,
  })).filter((p) => p.id && p.label) : [];
  const out: TeachBack = { replyTo: s(t.replyTo, 80), text: s(t.text, 1000), points, ai: t.ai === true, approvedByPatient: true };
  return out.replyTo && out.points.length ? out : undefined;
}
