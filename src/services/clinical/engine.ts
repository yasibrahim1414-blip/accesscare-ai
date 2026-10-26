// AccessCare AI — Clinical Intelligence Engine.
//
//   analyzeRules()  deterministic part (always runs): facts, warning signs,
//                   missing information, contradictions, rule next steps
//   withAI()        optional: Claude adds clinical considerations and next
//                   steps — only if the patient allowed AI for this report.
//                   Every AI item must cite facts that exist; references can
//                   only be chosen from the checked catalog; anything that
//                   fails validation is dropped (and counted).
//   suggestMeds()   optional, doctor-requested: medication options to review.
//                   Withheld until age, allergies and current medicines are
//                   documented; never during an emergency warning; every option
//                   must have an FDA label (openFDA) or it is not shown; no doses.
// AI can add warnings, never remove one. Nothing here diagnoses, prescribes, or is clinically validated.

import type { AIRun, ClinicalAnalysis, ClinicalWarning, Consideration, Documented, MedOption, MedSuggestions, NextStep } from '../../domain/clinical';
import type { ConsultRecord } from '../../domain/conversation';
import type { Consultation, Message, StructuredReport } from '../../domain/types';
import { buildCase, type Case } from './facts';
import { conflicts, missing, ruleSteps, treatmentGaps, warnings } from './rules';
import { REFERENCES, validRefs } from './references';
import { allergyConflict, fetchLabel, parseLabel, validGeneric, type FdaSource } from './openfda';

export interface EngineInput {
  consultation: Pick<Consultation, 'regionIds' | 'sensations' | 'details' | 'urgentGuidanceShown' | 'approved'>;
  messages: Message[];
  documented: Documented;
}
export type ClinicalAI = (prompt: string, maxTokens: number) => Promise<{ json: unknown } | { error: string }>;

export const ENGINE_NAME = 'AccessCare AI — Clinical Intelligence Engine';
export const PROMPT_PREFIX = 'You support a licensed doctor reviewing a patient-approved symptom report.';
const now = () => new Date().toISOString();

export function reportOf(c: EngineInput['consultation']) {
  return (c.approved?.report ?? { regions: [], sensations: [], fields: [], clarifications: [], flags: [], generatedBy: 'demo-rules' }) as StructuredReport & { conversation?: ConsultRecord };
}

export function caseOf(input: EngineInput): Case {
  return buildCase(input.consultation, reportOf(input.consultation), input.messages, input.documented);
}

export function analyzeRules(input: EngineInput): ClinicalAnalysis {
  const cs = caseOf(input);
  const ws = warnings(cs);
  const miss = missing(cs);
  const limitations = [
    'Decision support for a licensed clinician. It is not a diagnosis, and this software is not clinically validated.',
    'Based only on what the patient reported and approved (and what you documented). No examination, vital signs, records or test results are available to it.',
    'Warning rules cover a limited set of urgent-help signs from public NHS pages. No warning does not mean the patient is safe.',
  ];
  if (cs.symptoms.some((s) => s.status === 'interpretation')) limitations.push('Some symptoms are AccessCare’s interpretation of the patient’s words and were not confirmed by the patient (marked “interpretation”).');
  if (reportOf(input.consultation).conversation?.ai?.used) limitations.push('Claude helped understand the patient’s words during the conversation; interpretations were checked with the patient before they counted.');
  if (!cs.symptoms.length) limitations.push('No symptom could be identified from this report; review the patient’s own words.');
  return {
    v: 1, generatedAt: now(), facts: cs.facts, warnings: ws, missing: miss, conflicts: conflicts(cs),
    considerations: [], nextSteps: ruleSteps(ws, miss), limitations, ai: { status: 'not_requested' },
  };
}

// ---------------------------------------------------------------- AI considerations
const NO_GO = /\d+\s*%|\bpercent|probabilit|likelihood of|\bodds\b|definitely|certainly|confirmed diagnosis|diagnosed with|\bthe diagnosis is\b|you have\b|nothing (serious|to worry)|rule[sd]? out\b.*\bsafely/i;
const DOSE = /\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|units?|iu)\b|\bprescrib|\bdose\b|\bdosing\b/i;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Fact list for prompts, kept within the proxy's prompt size limit (12,000 characters). */
function factLines(a: ClinicalAnalysis, budget = 6500) {
  for (const n of [220, 140, 90, 60]) {
    const t = a.facts.slice(0, 80).map((f) => `${f.id} [${f.status}; ${f.source}] ${f.label}: ${f.value.length > n ? `${f.value.slice(0, n)}…` : f.value}`).join('\n');
    if (t.length <= budget) return t;
  }
  return a.facts.slice(0, 40).map((f) => `${f.id} [${f.status}] ${f.label}: ${f.value.slice(0, 50)}`).join('\n').slice(0, budget);
}

export function analysisPrompt(a: ClinicalAnalysis): string {
  return `${PROMPT_PREFIX}
You are not talking to the patient. Help the doctor think about the case. You never diagnose; you list possibilities to evaluate.

FACTS (the only patient information that exists; ids in brackets are how you cite them):
${factLines(a)}

WARNING SIGNS ALREADY FOUND BY RULES:
${a.warnings.filter((w) => w.level !== 'info').map((w) => `- ${w.level.toUpperCase()}: ${w.title} (${w.evidence.join(', ')})`).join('\n') || '- none'}

MISSING OR UNCERTAIN:
${a.missing.map((m) => `- ${m.for}: ${m.topic} (${m.status})`).join('\n') || '- none listed'}

REFERENCES YOU MAY CITE (ids only; cite none if none fits):
${REFERENCES.filter((r) => r.id !== 'openfda_label').map((r) => `- ${r.id}: ${r.publisher} — ${r.title}`).join('\n')}

Reply with only this JSON:
{"considerations":[{"title":"possible explanation or clinical concern to evaluate","supporting":["F1"],"against":["F3"],"missing":["what information would change this"],"uncertainty":"one sentence on what is uncertain","refs":["nhs_headache"]}],
 "next_steps":[{"kind":"question|examination|investigation|referral|other","text":"what the doctor may consider doing","why":"why, from the facts","supporting":["F2"],"refs":[]}],
 "extra_warnings":[{"title":"an urgent concern the rules missed","why":"why","evidence":["F1"]}]}
Rules: use ONLY the facts above — never add symptoms, history, test results, medicines or allergies. Every item must cite fact ids in "supporting"/"evidence". Facts marked "unsure" or "interpretation" are uncertain; "denied" means the patient said no. Do not give probabilities, percentages or certainty. Do not name medicines or doses (a separate, doctor-requested step handles medicines). Do not repeat the rule warnings. At most 4 considerations and 5 next steps; short plain sentences. If the facts are too limited, return few items and say what is missing.`;
}

/** Validates AI output against the case. Returns the merged analysis. */
export function applyAI(a: ClinicalAnalysis, raw: unknown): ClinicalAnalysis {
  const ids = new Set(a.facts.map((f) => f.id));
  const usable = new Set(a.facts.filter((f) => f.status !== 'denied').map((f) => f.id));
  const idList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ids.has(x)))].slice(0, 12) : []);
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let rejected = 0;
  const considerations: Consideration[] = [];
  for (const x of (Array.isArray(j.considerations) ? j.considerations : []).slice(0, 6)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const title = str(o.title, 140); const supporting = idList(o.supporting);
    const missingList = (Array.isArray(o.missing) ? o.missing : []).map((m) => str(m, 160)).filter(Boolean).slice(0, 5);
    const uncertainty = str(o.uncertainty, 260);
    const all = [title, uncertainty, ...missingList].join(' ');
    if (title.length < 4 || !supporting.some((id) => usable.has(id)) || NO_GO.test(all) || DOSE.test(all) || considerations.length >= 4) { rejected++; continue; }
    considerations.push({ id: `AC${considerations.length + 1}`, title, supporting, against: idList(o.against).filter((id) => !supporting.includes(id)), missing: missingList, uncertainty: uncertainty || 'Not stated by the AI.', refs: validRefs(o.refs), by: 'ai' });
  }
  const steps: NextStep[] = [];
  const kinds = ['question', 'examination', 'investigation', 'referral', 'other'] as const;
  for (const x of (Array.isArray(j.next_steps) ? j.next_steps : []).slice(0, 8)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const text = str(o.text, 220); const why = str(o.why, 260); const supporting = idList(o.supporting);
    if (text.length < 4 || !supporting.length || NO_GO.test(`${text} ${why}`) || DOSE.test(`${text} ${why}`) || steps.length >= 5) { rejected++; continue; }
    steps.push({ id: `AS${steps.length + 1}`, kind: kinds.includes(o.kind as typeof kinds[number]) ? (o.kind as NextStep['kind']) : 'other', text, why, supporting, refs: validRefs(o.refs), by: 'ai' });
  }
  const extra: ClinicalWarning[] = [];
  for (const x of (Array.isArray(j.extra_warnings) ? j.extra_warnings : []).slice(0, 3)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const title = str(o.title, 120); const why = str(o.why, 260); const evidence = idList(o.evidence);
    if (title.length < 4 || !evidence.some((id) => usable.has(id)) || NO_GO.test(`${title} ${why}`)) { rejected++; continue; }
    extra.push({ id: `ai:${extra.length + 1}`, level: 'urgent', title, why: why || 'Raised by the AI.', evidence, action: 'Review this concern; the AI can add warnings but never remove the rule-based ones.', refs: [], by: 'ai' });
  }
  const order = { emergency: 0, urgent: 1, info: 2 } as const;
  return {
    ...a, considerations, nextSteps: [...a.nextSteps.filter((s) => s.by === 'rules'), ...steps],
    warnings: [...a.warnings.filter((w) => w.by === 'rules'), ...extra].sort((p, q) => order[p.level] - order[q.level]),
    ai: { status: 'used', at: now(), rejected },
  };
}

/** Rules + (when allowed and available) AI. Never throws: AI problems are reported in `ai`. */
export async function analyze(input: EngineInput, ai: ClinicalAI | null): Promise<ClinicalAnalysis> {
  const base = analyzeRules(input);
  const consent = reportOf(input.consultation).aiConsent === true;
  if (!consent) return { ...base, ai: { status: 'not_consented' } };
  if (!ai) return { ...base, ai: { status: 'unavailable', error: 'No AI service in this view.' } };
  const r = await ai(analysisPrompt(base), 1500).catch((e) => ({ error: (e as Error).message || 'failed' }));
  if ('error' in r) return { ...base, ai: { status: 'failed', error: r.error, at: now() } };
  if (!r.json || typeof r.json !== 'object') return { ...base, ai: { status: 'failed', error: 'The AI answer was not valid JSON; nothing from it was used.', at: now() } };
  return applyAI(base, r.json);
}

// ---------------------------------------------------------------- medication options
export function medsGate(a: ClinicalAnalysis, d: Documented, consent: boolean): string[] {
  const out: string[] = [];
  const em = a.warnings.filter((w) => w.level === 'emergency');
  if (em.length) out.push(`An emergency warning is active (${em.map((w) => w.title.toLowerCase()).join('; ')}). Emergency assessment comes before treatment options.`);
  if (!d.age) out.push('Age is not documented.');
  if (d.allergies.status === 'unknown') out.push('Allergies are not documented (record “no known allergies” if the patient has none).');
  if (d.medications.status === 'unknown') out.push('Current medicines are not documented (record “none” if the patient takes none).');
  const age = Number(d.age);
  if (d.age && age >= 12 && age <= 55 && d.sex !== 'male' && d.pregnancy === 'unknown') out.push('Pregnancy status is not documented.');
  if (!consent) out.push('The patient did not allow AI assistance for this report, so AI medication options are not generated.');
  return out;
}

export function medsPrompt(a: ClinicalAnalysis, d: Documented): string {
  return `${PROMPT_PREFIX}
The doctor asked for medication OPTIONS TO REVIEW. The doctor decides and prescribes; you only list options worth checking.

FACTS:
${factLines(a)}

DOCUMENTED BY THE DOCTOR: age ${d.age || 'unknown'}; sex ${d.sex}; pregnancy ${d.pregnancy}; allergies ${d.allergies.status === 'listed' ? d.allergies.items.join(', ') : d.allergies.status}; current medicines ${d.medications.status === 'listed' ? d.medications.items.join(', ') : d.medications.status}; conditions ${d.conditions || 'none documented'}; kidney ${d.kidney}; liver ${d.liver}.
WARNINGS: ${a.warnings.filter((w) => w.level !== 'info').map((w) => w.title).join('; ') || 'none'}
STILL MISSING: ${a.missing.filter((m) => m.status !== 'answered').map((m) => `${m.for}: ${m.topic}`).join('; ') || 'nothing listed'}

Reply with only this JSON:
{"withhold":false,"reason":"","options":[{"generic":"generic (INN) name only","reason":"why a doctor might consider it for the reported symptoms","supporting":["F1"],"checks":["what to check before prescribing"]}]}
Rules: generic names only (no brands); NO doses, strengths, frequencies or durations; at most 3 options; never an option that matches a documented allergy or duplicates a current medicine. Set "withhold": true with a reason when the facts do not support any medicine yet (for example when examination, tests or missing answers are needed first, or the cause is unclear). Do not invent patient information.`;
}

export async function suggestMeds(a: ClinicalAnalysis, d: Documented, consent: boolean, ai: ClinicalAI | null, fda: FdaSource): Promise<MedSuggestions> {
  const base = { generatedAt: now(), options: [] as MedOption[], unverified: [] as string[], source: 'openFDA drug labeling (U.S. FDA) — not verified by FDA for clinical use' };
  const gate = medsGate(a, d, consent);
  if (gate.length) return { ...base, status: 'withheld', reasons: gate };
  if (!ai) return { ...base, status: 'unavailable', reasons: ['No AI service is available in this view.'] };
  const r = await ai(medsPrompt(a, d), 900).catch((e) => ({ error: (e as Error).message || 'failed' }));
  if ('error' in r) return { ...base, status: 'failed', reasons: [`AI request failed: ${r.error}`] };
  const j = (r.json && typeof r.json === 'object' ? r.json : null) as { withhold?: unknown; reason?: unknown; options?: unknown } | null;
  if (!j) return { ...base, status: 'failed', reasons: ['The AI answer was not valid JSON; nothing from it was used.'] };
  if (j.withhold === true) return { ...base, status: 'withheld', reasons: [`AI: ${str(j.reason, 300) || 'the facts do not support a medication option yet.'}`] };
  const ids = new Set(a.facts.map((f) => f.id));
  const cand = (Array.isArray(j.options) ? j.options : []).slice(0, 3).map((x) => (x ?? {}) as Record<string, unknown>)
    .map((o) => ({ generic: str(o.generic, 50).toLowerCase(), reason: str(o.reason, 300), supporting: (Array.isArray(o.supporting) ? o.supporting : []).filter((y): y is string => typeof y === 'string' && ids.has(y)).slice(0, 8), checks: (Array.isArray(o.checks) ? o.checks : []).map((c) => str(c, 160)).filter(Boolean).slice(0, 4) }))
    .filter((o) => validGeneric(o.generic) && o.reason && !DOSE.test(`${o.reason} ${o.checks.join(' ')}`) && o.supporting.length);
  if (!cand.length) return { ...base, status: 'withheld', reasons: ['The AI gave no option that passed the checks (generic name, a reason tied to the report, no dosing).'] };
  const reasons: string[] = [];
  const options: MedOption[] = [];
  const unverified: string[] = [];
  let unreachable = 0;
  for (const [i, o] of cand.entries()) {
    if (d.medications.status === 'listed' && d.medications.items.some((m) => m.toLowerCase().includes(o.generic.split(' ')[0]))) { reasons.push(`${o.generic} removed: the patient already takes it.`); continue; }
    const res = await fetchLabel(o.generic, fda);
    if (res.status === 'unavailable') { unreachable++; continue; }
    if (res.status === 'not_found') { unverified.push(o.generic); continue; }
    const label = parseLabel(res.label, d);
    const clash = allergyConflict(label, d);
    if (clash) { reasons.push(`${o.generic} removed: it matches a documented allergy — ${clash}`); continue; }
    options.push({ id: `MO${i + 1}`, generic: o.generic, reason: o.reason, supporting: o.supporting, checks: o.checks, verification: 'label_found', label, by: 'ai' });
  }
  if (unreachable && !options.length) return { ...base, status: 'unavailable', reasons: [...reasons, 'The FDA label service (openFDA) could not be reached from this view, so no option could be checked. Options are not shown unchecked.'] };
  if (unreachable) reasons.push(`${unreachable} option(s) could not be checked because openFDA did not answer; they are not shown.`);
  if (unverified.length) reasons.push(`No FDA label was found for: ${unverified.join(', ')} — not shown as options.`);
  return { ...base, status: options.length ? 'ok' : 'withheld', reasons: options.length ? reasons : [...reasons, 'No option could be verified against an FDA label.'], options, unverified };
}

/** Every reference cited anywhere in the analysis. */
export function citedRefs(a: ClinicalAnalysis): string[] {
  return [...new Set([...a.warnings.flatMap((w) => w.refs), ...a.missing.flatMap((m) => m.refs), ...a.considerations.flatMap((c) => c.refs), ...a.nextSteps.flatMap((s) => s.refs)])];
}
/** Medication-safety information not documented yet, with ask status. */
export const treatmentGapsOf = (input: EngineInput) => treatmentGaps(caseOf(input));
export type { AIRun };
