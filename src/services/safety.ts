// Emergency safety rules. Conservative and deliberately simple: they only
// decide whether to SHOW urgent-help guidance. They never diagnose and never
// tell the patient they are safe.

import type { Sensation, SymptomDetails } from '../domain/types';

/** Shown as one-tap checkboxes before (and at any point during) a consultation. */
export const RED_FLAG_CHECKS = [
  { id: 'chest_pressure', label: 'New chest pain, pressure or tightness' },
  { id: 'breathing', label: 'Severe difficulty breathing' },
  { id: 'sudden_weakness', label: 'Sudden weakness or numbness, especially on one side' },
  { id: 'face_speech', label: 'Face drooping, or sudden trouble speaking or understanding' },
  { id: 'fainting', label: 'Fainting, or hard to stay awake' },
  { id: 'bleeding', label: 'Heavy bleeding that will not stop' },
  { id: 'worst_headache', label: 'Sudden, very severe headache' },
] as const;

const KEYWORDS: { re: RegExp; reason: string }[] = [
  { re: /chest\s*(pain|pressure|tight)|pressure in (my )?chest/i, reason: 'chest pressure or pain was mentioned' },
  { re: /can'?t breathe|cannot breathe|hard to breathe|short(ness)? of breath|struggling to breathe/i, reason: 'difficulty breathing was mentioned' },
  { re: /fainted|passed out|unconscious/i, reason: 'fainting was mentioned' },
  { re: /droop|slurred|can'?t speak|cannot speak/i, reason: 'face or speech changes were mentioned' },
  { re: /worst headache|thunderclap/i, reason: 'a sudden severe headache was mentioned' },
  { re: /suicid|kill myself|end my life/i, reason: 'thoughts of self-harm were mentioned' },
  // Arabic (Egyptian and Modern Standard)
  { re: /(ألم|الم|وجع|ضغط|تقل)\s*(في\s*)?(صدري|الصدر|صدرى)/, reason: 'chest pressure or pain was mentioned' },
  { re: /(مش|ما|مو)\s*(قادر|قادره|قادرة|بقدرش|اقدرش|أقدرش)\s*(ا|أ)?تنفس|صعوب[هة]\s*(في\s*)?(التنفس|النفس)|ضيق\s*(في\s*)?(التنفس|النفس)|نفسي\s*(مقطوع|بيتقطع)|مخنوق/, reason: 'difficulty breathing was mentioned' },
  { re: /(اغمى|أغمي|اغمي|اتغمى)\s*(عليا|علي|عليه)|فقدت\s*الوعي|وقعت\s*من\s*طولي/, reason: 'fainting was mentioned' },
  { re: /(مش|ما)\s*(قادر|قادره|قادرة)\s*(ا|أ)?تكلم|لساني\s*(تقيل|تقل)|وشي\s*(مايل|معوج|معووج)|نص\s*جسمي/, reason: 'face or speech changes were mentioned' },
  { re: /(ا|أ)نتحر|(ا|أ)قتل\s*نفسي|عايز\s*(ا|أ)موت|عايزه\s*(ا|أ)موت|أريد\s*أن\s*أموت/, reason: 'thoughts of self-harm were mentioned' },
];

export interface SafetyResult {
  urgent: boolean;
  reasons: string[];
  /** true when the patient should be offered the quick red-flag check */
  suggestCheck: boolean;
}

/** Shown whenever no warning pattern was recognized — never a reassurance. */
export const SAFETY_LIMIT_NOTE = 'No urgent warning pattern was recognized automatically. That does not mean you are safe: this check can miss things. If you feel very unwell or worse, call your local emergency number.';

export function assessSafety(input: {
  regionIds: string[];
  sensations: Sensation[];
  details: SymptomDetails;
  redFlags?: string[];
  /** associated symptoms the patient confirmed (comma-separated) */
  associated?: string | null;
  /** an AI hint can only add a reason, never remove one */
  aiHint?: { concern: boolean; reason: string } | null;
}): SafetyResult {
  const reasons: string[] = [];
  const assoc = (input.associated ?? '').toLowerCase();
  if (/trouble breathing/.test(assoc)) reasons.push('trouble breathing was reported');
  if (input.regionIds.includes('chest') && input.sensations.some((s) => s === 'pain' || s === 'burning') && /dizziness|nausea|trouble breathing/.test(assoc)) {
    reasons.push('chest pain together with other symptoms');
  }
  if (input.aiHint?.concern) reasons.push(`AI safety check: ${input.aiHint.reason || 'your words may describe something urgent'}`);
  for (const f of input.redFlags ?? []) {
    const check = RED_FLAG_CHECKS.find((c) => c.id === f);
    if (check) reasons.push(check.label);
  }
  const text = [input.details.description, input.details.otherSensation].filter(Boolean).join(' ');
  for (const k of KEYWORDS) if (k.re.test(text)) reasons.push(k.reason);

  const sudden = /sudden|just now|right now|minutes ago/i.test(text) || /just now|today/i.test(input.details.onset ?? '');
  if (sudden && input.sensations.some((s) => s === 'weakness' || s === 'numbness')) {
    reasons.push('new weakness or numbness that started recently');
  }

  const chest = input.regionIds.includes('chest');
  const suggestCheck = chest || input.sensations.includes('weakness') || (input.details.severity ?? 0) >= 8;
  return { urgent: reasons.length > 0, reasons: [...new Set(reasons)], suggestCheck };
}

export const EMERGENCY_NUMBERS = [
  { region: 'United Arab Emirates', number: '998', label: 'Ambulance' },
  { region: 'UAE (police / general)', number: '999', label: 'Police' },
  { region: 'EU & many countries', number: '112', label: 'Emergency' },
  { region: 'United States & Canada', number: '911', label: 'Emergency' },
  { region: 'United Kingdom', number: '999', label: 'Emergency' },
];
