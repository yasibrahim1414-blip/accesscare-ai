// Patient Intent Reconstruction Engine.
//
//   capture  → build(): a provisional, item-by-item representation of what the
//              patient reported (selections, typed words, rule/AI suggestions)
//   detect   → gaps (missing items) and contradictions between items/words
//   clarify  → nextQuestion()/applyAnswer(): one question at a time, adapted to
//              the patient's preferences, never asking the same thing twice
//   verify   → correct()/remove()/restore(): patient edits with full history
//   measure  → metrics(): what was captured, corrected, resolved, still missing
//   report   → buildBrief(): an 11-section clinical brief where every line is
//              labeled patient / system wording / unknown
//
// Rules this engine never breaks: no diagnosis, no invented values, silence is
// never an answer, suggestions stay "suggested" until the patient confirms.

import type { CommunicationPreferences, Sensation, SymptomDetails, StructuredReport, ReportField, ClarificationAnswer } from '../../domain/types';
import { SENSATION_LABELS } from '../../domain/types';
import { REGION_BY_ID, regionLabel } from '../../domain/bodyRegions';
import type {
  BriefLine, BriefSection, ClinicalBrief, Contradiction, FieldKey, HistoryEntry, ReconItem, Reconstruction, Suggestion, VerificationMetrics,
} from '../../domain/reconstruction';

export interface CaptureInput { regionIds: string[]; sensations: Sensation[]; details: SymptomDetails }
export interface FieldSuggestion extends Suggestion { field: FieldKey }

const now = () => new Date().toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------- option vocabularies ----------
export const ONSET_OPTIONS = ['Today', '1–3 days ago', 'About a week ago', 'More than a week ago'];
export const PATTERN_OPTIONS = ['Constant', 'Comes and goes'];
export const SEVERITY_WORDS = ['Mild', 'Moderate', 'Severe'];
export const EXTENT_OPTIONS = ['Whole area', 'One specific spot'];
export const BOTH_SIDES_OPTIONS = ['Same on both sides', 'Different on each side'];
export const ASSOCIATED_OPTIONS = ['Nausea', 'Fever', 'Dizziness', 'Trouble breathing', 'Tiredness', 'Nothing else'];

const ICONS: Record<string, string> = {
  Today: '⏱️', '1–3 days ago': '📅', 'About a week ago': '🗓️', 'More than a week ago': '⌛',
  Constant: '➖', 'Comes and goes': '〰️', Mild: '🙂', Moderate: '😐', Severe: '😣',
  'Whole area': '⬛', 'One specific spot': '📍', 'Same on both sides': '⚖️', 'Different on each side': '↔️',
  Nausea: '🤢', Fever: '🌡️', Dizziness: '💫', 'Trouble breathing': '🫁', Tiredness: '😴', 'Nothing else': '✖️',
  Yes: '👍', No: '👎',
};

/** Plain-language explanations offered next to questions. */
export const GLOSSARY: Record<string, string> = {
  onset: '“When it began” means the first time you noticed it.',
  pattern: '“Comes and goes” means it stops and starts again. “Constant” means it is there all the time.',
  severity: 'How strong it feels to you. There is no right or wrong answer.',
  extent: 'Whether you feel it across the whole area you chose, or in one small spot.',
  associated: 'Other things you notice at the same time, anywhere in the body.',
};

const LIMB_BASES = (ids: string[]) => ids.filter((id) => id.endsWith('_l')).map((id) => id.slice(0, -2)).filter((b) => ids.includes(`${b}_r`));

// ---------- free-text understanding (rules) ----------
/** Proposes values found in the patient's own words. Always returns quotes; never invents. */
export function extractByRules(text: string | undefined): FieldSuggestion[] {
  if (!text) return [];
  const out: FieldSuggestion[] = [];
  const find = (re: RegExp) => { const m = text.match(re); return m ? m[0] : null; };
  let q: string | null;
  if ((q = find(/\b(today|this morning|this afternoon|tonight|just now|an hour ago)\b/i))) out.push({ field: 'onset', value: 'Today', quote: q, by: 'rules' });
  else if ((q = find(/\b(yesterday|(a|one|two|three|1|2|3) days? ago|last night)\b/i))) out.push({ field: 'onset', value: '1–3 days ago', quote: q, by: 'rules' });
  else if ((q = find(/\b(last week|a week ago|(four|five|six|4|5|6) days ago)\b/i))) out.push({ field: 'onset', value: 'About a week ago', quote: q, by: 'rules' });
  else if ((q = find(/\b(for (weeks|months|years)|(\d+|two|three|several|few) (weeks|months|years)( ago)?|since last month)\b/i))) out.push({ field: 'onset', value: 'More than a week ago', quote: q, by: 'rules' });
  if ((q = find(/\b(comes and goes|on and off|off and on|now and then|sometimes|intermittent(ly)?)\b/i))) out.push({ field: 'pattern', value: 'Comes and goes', quote: q, by: 'rules' });
  else if ((q = find(/\b(all the time|constant(ly)?|non-?stop|never stops)\b/i))) out.push({ field: 'pattern', value: 'Constant', quote: q, by: 'rules' });
  if ((q = find(/\b([1-9]|10)\s*(\/|out of)\s*10\b/i))) out.push({ field: 'severity', value: `${q.match(/\d+/)![0]} / 10 (patient-rated)`, quote: q, by: 'rules' });
  else if ((q = find(/\b(unbearable|very bad|really bad|severe|excruciating|worst)\b/i))) out.push({ field: 'severity', value: 'Severe', quote: q, by: 'rules' });
  else if ((q = find(/\b(mild|slight|a little|a bit)\b/i))) out.push({ field: 'severity', value: 'Mild', quote: q, by: 'rules' });
  if ((q = find(/\b(nause(a|ous)|feel(ing)? sick|vomit(ing)?)\b/i))) out.push({ field: 'associated', value: 'Nausea', quote: q, by: 'rules' });
  else if ((q = find(/\b(fever|temperature|chills)\b/i))) out.push({ field: 'associated', value: 'Fever', quote: q, by: 'rules' });
  else if ((q = find(/\b(dizz(y|iness)|light-?headed)\b/i))) out.push({ field: 'associated', value: 'Dizziness', quote: q, by: 'rules' });
  return out;
}

// ---------- build ----------
function item(key: string, field: FieldKey, label: string, value: string | null, source: ReconItem['source'], opts: { optional?: boolean; status?: ReconItem['status'] } = {}): ReconItem {
  const status = opts.status ?? (value ? 'confirmed' : 'unanswered');
  return {
    key, field, label, value, status, source: value ? source : 'none', optional: opts.optional,
    initial: { value, status }, corrected: false,
    history: [{ at: now(), action: 'captured', to: value, by: value ? 'patient' : 'rules', note: value ? undefined : 'not provided yet' }],
  };
}

/** Values the patient chose directly (e.g. in Silent Signal); 'not_sure' marks the item unsure. */
export type Prefill = Partial<Record<'onset' | 'pattern' | 'severity' | 'associated', string>>;

export function build(input: CaptureInput, suggestions: FieldSuggestion[] = [], prefill: Prefill = {}): Reconstruction {
  const d = input.details;
  const items: ReconItem[] = [];
  for (const r of input.regionIds) items.push(item(`region:${r}`, 'region', 'Body region', regionLabel(r), 'patient_selected'));
  const named = input.sensations.filter((s) => s !== 'not_sure' && s !== 'other');
  for (const s of named) items.push(item(`sensation:${s}`, 'sensation', 'Sensation', SENSATION_LABELS[s], 'patient_selected'));
  if (input.sensations.includes('other')) items.push(item('other_sensation', 'other_sensation', 'Other sensation', d.otherSensation ?? null, 'patient_typed'));
  if (input.sensations.includes('not_sure') && named.length === 0 && !input.sensations.includes('other')) {
    items.push(item('sensation:not_sure', 'sensation', 'Sensation', 'Patient is not sure how to describe it', 'patient_selected', { status: 'unsure' }));
  }
  items.push(item('onset', 'onset', 'When it began', d.onset ? normalizeOnset(d.onset) : null, 'patient_selected'));
  items.push(item('pattern', 'pattern', 'Pattern', d.pattern ? (d.pattern === 'constant' ? 'Constant' : 'Comes and goes') : null, 'patient_selected'));
  items.push(item('severity', 'severity', 'Severity', d.severity !== undefined ? `${d.severity} / 10 (patient-rated)` : null, 'patient_selected'));
  if (input.regionIds.some((id) => REGION_BY_ID[id]?.limb)) items.push(item('extent', 'extent', 'Extent', null, 'none'));
  if (LIMB_BASES(input.regionIds).length) items.push(item('both_sides', 'both_sides', 'Both sides', null, 'none'));
  items.push(item('associated', 'associated', 'Other symptoms', null, 'none'));
  items.push(item('context', 'context', 'In the patient’s own words', d.description ?? null, 'patient_typed', { optional: true }));

  for (const [k, v] of Object.entries(prefill)) {
    const it = items.find((i) => i.key === k);
    if (!it || !v) continue;
    if (v === 'not_sure') { it.status = 'unsure'; it.initial = { value: null, status: 'unsure' }; it.history = [{ at: now(), action: 'marked_unsure', by: 'patient' }]; continue; }
    it.value = v; it.status = 'confirmed'; it.source = 'patient_selected'; it.initial = { value: v, status: 'confirmed' };
    it.history = [{ at: now(), action: 'captured', to: v, by: 'patient' }];
  }
  const rec: Reconstruction = { version: 1, createdAt: now(), items, contradictions: [], asked: [] };
  addSuggestions(rec, suggestions);
  rec.contradictions = detectContradictions(rec, input);
  return rec;
}

const normalizeOnset = (s: string) => (/today|just now/i.test(s) ? 'Today' : /1.3 days/i.test(s) ? '1–3 days ago' : /week ago/i.test(s) ? 'About a week ago' : /longer|more than/i.test(s) ? 'More than a week ago' : s);

/** Adds suggestions only to items that have no value; a suggestion is never treated as an answer. */
export function addSuggestions(rec: Reconstruction, suggestions: FieldSuggestion[]) {
  const text = (rec.items.find((i) => i.key === 'context')?.value ?? '').toLowerCase();
  for (const s of suggestions) {
    const it = rec.items.find((i) => i.field === s.field && i.key === s.field);
    if (!it || it.value || it.suggestion || it.status === 'removed') continue;
    if (!s.quote || !text.includes(s.quote.toLowerCase())) continue; // must be grounded in the patient's words
    it.suggestion = { value: s.value, quote: s.quote, by: s.by };
    it.status = 'suggested';
    it.history.push({ at: now(), action: 'suggested', to: s.value, by: s.by, note: `from “${s.quote}”` });
  }
}

// ---------- contradictions ----------
export function detectContradictions(rec: Reconstruction, input?: CaptureInput): Contradiction[] {
  const get = (k: string) => rec.items.find((i) => i.key === k);
  const text = (get('context')?.value ?? '').toLowerCase();
  const out: Contradiction[] = [];
  const keep = (c: Contradiction) => {
    const prev = rec.contradictions.find((p) => p.id === c.id);
    out.push(prev ? { ...c, status: prev.status, resolution: prev.resolution } : c);
  };
  const pattern = get('pattern')?.value;
  if (pattern === 'Constant' && /comes and goes|on and off|sometimes|now and then/.test(text)) {
    keep({ id: 'c_pattern', keys: ['pattern', 'context'], status: 'open', description: 'You chose “constant”, but your words say it comes and goes.' });
  }
  if (pattern === 'Comes and goes' && /all the time|constant|never stops/.test(text)) {
    keep({ id: 'c_pattern', keys: ['pattern', 'context'], status: 'open', description: 'You chose “comes and goes”, but your words say it is there all the time.' });
  }
  const sens = input?.sensations ?? [];
  if (sens.includes('not_sure') && sens.some((s) => s !== 'not_sure' && s !== 'other')) {
    const list = sens.filter((s) => s !== 'not_sure' && s !== 'other').map((s) => SENSATION_LABELS[s].toLowerCase()).join(' and ');
    keep({ id: 'c_sensation', keys: rec.items.filter((i) => i.field === 'sensation').map((i) => i.key), status: 'open', description: `You chose “Not sure” and also “${list}”.` });
  }
  const regions = rec.items.filter((i) => i.field === 'region' && i.status !== 'removed').map((i) => i.key.slice(7));
  const paired = regions.filter((r) => /_(l|r)$/.test(r));
  if (paired.length) {
    const hasL = paired.some((r) => r.endsWith('_l')), hasR = paired.some((r) => r.endsWith('_r'));
    if (hasL && !hasR && /\bright (arm|hand|leg|foot|knee|shoulder|side|wrist|elbow|ankle|hip|thigh)\b/.test(text)) {
      keep({ id: 'c_side', keys: paired.map((r) => `region:${r}`).concat('context'), status: 'open', description: 'You selected the LEFT side, but your words mention the right side.' });
    }
    if (hasR && !hasL && /\bleft (arm|hand|leg|foot|knee|shoulder|side|wrist|elbow|ankle|hip|thigh)\b/.test(text)) {
      keep({ id: 'c_side', keys: paired.map((r) => `region:${r}`).concat('context'), status: 'open', description: 'You selected the RIGHT side, but your words mention the left side.' });
    }
  }
  const sev = get('severity')?.value;
  const n = sev ? Number(sev.match(/^\d+/)?.[0]) : NaN;
  if ((n >= 8 || sev === 'Severe') && /\b(mild|slight|a little|a bit)\b/.test(text)) keep({ id: 'c_severity', keys: ['severity', 'context'], status: 'open', description: 'You rated it as strong, but your words describe it as mild.' });
  if ((n <= 3 || sev === 'Mild') && /\b(unbearable|severe|worst|excruciating)\b/.test(text)) keep({ id: 'c_severity', keys: ['severity', 'context'], status: 'open', description: 'You rated it as mild, but your words describe it as very strong.' });
  if (get('onset')?.value === 'Today' && /\b(for|since) (weeks|months|years)\b|\b\d+ (weeks|months|years)\b/.test(text)) {
    keep({ id: 'c_onset', keys: ['onset', 'context'], status: 'open', description: 'You chose “today”, but your words say it has been going on longer.' });
  }
  // a contradiction once detected stays on record; if the conflict disappeared, it was resolved
  for (const prev of rec.contradictions) {
    if (!out.some((c) => c.id === prev.id)) out.push(prev.status === 'open' || prev.status === 'unresolved' ? { ...prev, status: 'clarified', resolution: prev.resolution ?? 'resolved by the patient’s changes' } : prev);
  }
  const blocked = new Set(out.filter((c) => c.status !== 'clarified').flatMap((c) => c.keys));
  for (const it of rec.items) {
    if (it.field === 'context') continue;
    if (blocked.has(it.key) && it.status === 'confirmed') it.status = 'needs_clarification';
    else if (!blocked.has(it.key) && it.status === 'needs_clarification') it.status = it.value ? 'confirmed' : 'unanswered';
  }
  return out;
}

// ---------- questions ----------
export interface QOption { label: string; value: string; icon?: string }
export interface Question {
  id: string;
  kind: 'contradiction' | 'suggestion' | 'missing' | 'optional';
  key: string;
  text: string;
  reason: string;
  explain?: string;
  format: 'yes_no' | 'choice' | 'multi' | 'text';
  options: QOption[];
}
const opts = (labels: string[]): QOption[] => labels.map((l) => ({ label: l, value: l, icon: ICONS[l] }));

export function nextQuestion(rec: Reconstruction, prefs: CommunicationPreferences, input: CaptureInput): Question | null {
  const short = prefs.simpleText || prefs.shortSentences;
  const yesNoOnly = prefs.yesNoQuestions && !prefs.multipleChoice;
  const ask = (q: Question) => (rec.asked.includes(q.id) ? null : q);
  const get = (k: string) => rec.items.find((i) => i.key === k);
  const what = rec.items.filter((i) => (i.field === 'sensation' || i.field === 'other_sensation') && i.value && i.status !== 'unsure').map((i) => i.value!.toLowerCase()).join(' and ') || 'it';
  const where = (() => { const r = rec.items.filter((i) => i.field === 'region' && i.status !== 'removed'); return r.length === 1 ? `your ${r[0].value!.toLowerCase()}` : 'the areas you chose'; })();

  // 1. contradictions, one at a time
  for (const c of rec.contradictions.filter((x) => x.status === 'open')) {
    let q: Question | null = null;
    if (c.id === 'c_pattern') q = { id: 'q_c_pattern', kind: 'contradiction', key: 'pattern', reason: c.description, explain: GLOSSARY.pattern,
      text: short ? 'Is it there all the time?' : `${c.description} Which is right?`, format: 'choice', options: opts(PATTERN_OPTIONS) };
    if (c.id === 'c_sensation') q = { id: 'q_c_sensation', kind: 'contradiction', key: c.keys[0] ?? 'sensation', reason: c.description,
      text: short ? `Does “${what}” describe it?` : `${c.description} Does “${what}” describe what you feel?`, format: 'yes_no', options: opts(['Yes', 'No']) };
    if (c.id === 'c_side') q = { id: 'q_c_side', kind: 'contradiction', key: c.keys[0], reason: c.description,
      text: short ? 'Which side is it?' : `${c.description} Which side is it?`, format: 'choice', options: opts(['Left side', 'Right side', 'Both sides']) };
    if (c.id === 'c_severity') q = { id: 'q_c_severity', kind: 'contradiction', key: 'severity', reason: c.description, explain: GLOSSARY.severity,
      text: short ? 'How strong is it?' : `${c.description} How strong is it?`, format: 'choice', options: opts(SEVERITY_WORDS) };
    if (c.id === 'c_onset') q = { id: 'q_c_onset', kind: 'contradiction', key: 'onset', reason: c.description, explain: GLOSSARY.onset,
      text: short ? 'When did it start?' : `${c.description} When did it start?`, format: 'choice', options: opts(ONSET_OPTIONS) };
    if (q && (q = ask(q))) return q;
  }
  // 2. suggestions waiting for confirmation
  for (const it of rec.items.filter((i) => i.status === 'suggested' && i.suggestion)) {
    const q = ask({ id: `q_s_${it.key}`, kind: 'suggestion', key: it.key, reason: `From your words “${it.suggestion!.quote}”.`,
      text: short ? `${it.label}: ${it.suggestion!.value}. Right?` : `You wrote “${it.suggestion!.quote}”. Did you mean: ${it.label.toLowerCase()} — ${it.suggestion!.value}?`,
      format: 'yes_no', options: opts(['Yes', 'No']) });
    if (q) return q;
  }
  // 3. missing information
  const missing = (k: string) => { const it = get(k); return it && !it.value && it.status !== 'removed' && it.status !== 'unsure'; };
  if (missing('other_sensation')) { const q = ask({ id: 'q_other', kind: 'missing', key: 'other_sensation', reason: 'You chose “Other” without describing it.', text: short ? 'What does it feel like?' : 'You chose “Other”. What does it feel like, in a few words?', format: 'text', options: [] }); if (q) return q; }
  if (missing('onset')) {
    const q = ask(yesNoOnly
      ? { id: 'q_onset', kind: 'missing', key: 'onset', reason: 'When it started was not given.', explain: GLOSSARY.onset, text: short ? 'Did it start today?' : `Did the ${what} start today?`, format: 'yes_no', options: [{ label: 'Yes', value: 'Today', icon: '👍' }, { label: 'No', value: 'Before today', icon: '👎' }] }
      : { id: 'q_onset', kind: 'missing', key: 'onset', reason: 'When it started was not given.', explain: GLOSSARY.onset, text: short ? 'When did it start?' : `When did the ${what} begin?`, format: 'choice', options: opts(ONSET_OPTIONS) });
    if (q) return q;
  }
  if (missing('pattern')) {
    const q = ask(yesNoOnly
      ? { id: 'q_pattern', kind: 'missing', key: 'pattern', reason: 'Whether it is constant was not given.', explain: GLOSSARY.pattern, text: 'Is it there all the time?', format: 'yes_no', options: [{ label: 'Yes', value: 'Constant', icon: '👍' }, { label: 'No', value: 'Comes and goes', icon: '👎' }] }
      : { id: 'q_pattern', kind: 'missing', key: 'pattern', reason: 'Whether it is constant was not given.', explain: GLOSSARY.pattern, text: short ? 'Is it there all the time?' : 'Is it there all the time, or does it come and go?', format: 'choice', options: opts(PATTERN_OPTIONS) });
    if (q) return q;
  }
  if (missing('severity') && rec.items.some((i) => i.field === 'sensation' && i.status !== 'unsure')) {
    const q = ask(yesNoOnly
      ? { id: 'q_severity', kind: 'missing', key: 'severity', reason: 'How strong it is was not given.', explain: GLOSSARY.severity, text: short ? 'Is it very strong?' : `Is the ${what} very strong?`, format: 'yes_no', options: [{ label: 'Yes', value: 'Severe', icon: '👍' }, { label: 'No', value: 'Not severe', icon: '👎' }] }
      : { id: 'q_severity', kind: 'missing', key: 'severity', reason: 'How strong it is was not given.', explain: GLOSSARY.severity, text: short ? 'How strong is it?' : `How strong is the ${what}?`, format: 'choice', options: opts(SEVERITY_WORDS) });
    if (q) return q;
  }
  if (missing('extent')) {
    const q = ask(yesNoOnly
      ? { id: 'q_extent', kind: 'missing', key: 'extent', reason: 'Which part of the area is affected was not given.', explain: GLOSSARY.extent, text: short ? 'Is it the whole area?' : `Does it affect all of ${where}?`, format: 'yes_no', options: [{ label: 'Yes', value: 'Whole area', icon: '👍' }, { label: 'No', value: 'One specific spot', icon: '👎' }] }
      : { id: 'q_extent', kind: 'missing', key: 'extent', reason: 'Which part of the area is affected was not given.', explain: GLOSSARY.extent, text: short ? 'Whole area or one spot?' : `Does it affect all of ${where}, or one specific spot?`, format: 'choice', options: opts(EXTENT_OPTIONS) });
    if (q) return q;
  }
  if (missing('both_sides')) { const q = ask({ id: 'q_both', kind: 'missing', key: 'both_sides', reason: 'You selected the same area on both sides.', text: short ? 'Same on both sides?' : 'You chose both sides. Does it feel the same on both sides?', format: 'choice', options: opts(BOTH_SIDES_OPTIONS) }); if (q) return q; }
  if (missing('associated')) {
    const q = ask(yesNoOnly
      ? { id: 'q_assoc', kind: 'missing', key: 'associated', reason: 'Other symptoms were not mentioned.', explain: GLOSSARY.associated, text: 'Do you notice anything else, like fever, nausea or trouble breathing?', format: 'yes_no', options: [{ label: 'Yes', value: '__yes', icon: '👍' }, { label: 'No', value: 'Nothing else', icon: '👎' }] }
      : { id: 'q_assoc', kind: 'missing', key: 'associated', reason: 'Other symptoms were not mentioned.', explain: GLOSSARY.associated, text: short ? 'Anything else you notice?' : 'Do you notice anything else at the same time? Choose all that apply.', format: 'multi', options: opts(ASSOCIATED_OPTIONS) });
    if (q) return q;
  }
  if (get('associated')?.value === '__yes') {
    const q = ask({ id: 'q_assoc_which', kind: 'missing', key: 'associated', reason: 'You said you notice something else.', text: 'What else do you notice? Choose all that apply.', format: 'multi', options: opts(ASSOCIATED_OPTIONS.filter((o) => o !== 'Nothing else')) });
    if (q) return q;
  }
  if (!get('context')?.value) { const q = ask({ id: 'q_context', kind: 'optional', key: 'context', reason: 'Optional — only if you want to add something.', text: short ? 'Anything else for your doctor?' : 'Is there anything else you would like your doctor to know? (optional)', format: 'text', options: [] }); if (q) return q; }
  void input;
  return null;
}

export type Answer = { type: 'value'; value: string; raw?: string } | { type: 'unsure' } | { type: 'skip' };

const push = (it: ReconItem, e: Omit<HistoryEntry, 'at'>) => it.history.push({ at: now(), ...e });

/** Applies one answer. Returns a new reconstruction (inputs are not mutated). */
export function applyAnswer(recIn: Reconstruction, q: Question, a: Answer, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  rec.asked.push(q.id);
  const it = rec.items.find((i) => i.key === q.key);
  const contradiction = q.kind === 'contradiction' ? rec.contradictions.find((c) => `q_${c.id}` === q.id) : undefined;

  if (q.kind === 'suggestion' && it?.suggestion) {
    if (a.type === 'value' && a.value === 'Yes') {
      push(it, { action: 'suggestion_accepted', from: null, to: it.suggestion.value, by: 'patient' });
      it.value = it.suggestion.value; it.status = 'confirmed'; it.source = 'patient_confirmed_suggestion';
    } else {
      push(it, { action: a.type === 'value' ? 'suggestion_rejected' : a.type === 'unsure' ? 'marked_unsure' : 'skipped', from: it.suggestion.value, to: null, by: 'patient' });
      it.status = a.type === 'unsure' ? 'unsure' : 'unanswered';
    }
    delete it.suggestion;
    return finish(rec, input);
  }

  if (contradiction) {
    if (a.type === 'value') {
      contradiction.status = 'clarified';
      contradiction.resolution = a.value;
      if (contradiction.id === 'c_sensation') {
        if (a.value === 'No') for (const k of contradiction.keys) { const s = rec.items.find((i) => i.key === k); if (s) { push(s, { action: 'corrected', from: s.value, to: null, by: 'patient', note: 'patient said this does not describe it' }); s.status = 'removed'; } }
        else for (const k of contradiction.keys) { const s = rec.items.find((i) => i.key === k); if (s) { s.status = 'confirmed'; push(s, { action: 'clarified', to: s.value, by: 'patient' }); } }
      } else if (contradiction.id === 'c_side') {
        for (const k of contradiction.keys) { const s = rec.items.find((i) => i.key === k); if (s && s.field === 'region') { s.status = 'confirmed'; push(s, { action: 'clarified', to: `${s.value} — patient says: ${a.value}`, by: 'patient' }); s.value = a.value === 'Left side' || a.value === 'Right side' || a.value === 'Both sides' ? `${s.value} (patient clarified: ${a.value.toLowerCase()})` : s.value; } }
      } else if (it) {
        push(it, { action: 'clarified', from: it.value, to: a.value, by: 'patient' });
        if (it.value !== a.value) it.corrected = it.initial.value !== null;
        it.value = a.value; it.status = 'confirmed'; it.source = 'patient_answer';
      }
    } else {
      contradiction.status = 'unresolved';
      if (it) { it.status = 'needs_clarification'; push(it, { action: a.type === 'unsure' ? 'marked_unsure' : 'skipped', by: 'patient', note: 'contradiction left unresolved' }); }
    }
    return finish(rec, input);
  }

  if (!it) return finish(rec, input);
  if (a.type === 'value') {
    let value = a.value;
    if (q.format === 'multi') value = a.value.split('|').filter(Boolean).join(', ');
    push(it, { action: 'answered', from: it.value, to: value, by: 'patient' });
    it.value = value; it.status = 'confirmed'; it.source = q.format === 'text' ? 'patient_typed' : 'patient_answer';
  } else if (a.type === 'unsure') {
    push(it, { action: 'marked_unsure', by: 'patient' }); it.status = 'unsure';
  } else {
    push(it, { action: 'skipped', by: 'patient' }); // stays unanswered: silence is never an answer
  }
  return finish(rec, input);
}

function finish(rec: Reconstruction, input: CaptureInput): Reconstruction {
  rec.contradictions = detectContradictions(rec, input);
  return rec;
}

// ---------- verification edits ----------
export function correct(recIn: Reconstruction, key: string, value: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it) return rec;
  const v = value.trim().slice(0, 300);
  if (!v || v === it.value) return rec;
  push(it, { action: 'corrected', from: it.value, to: v, by: 'patient' });
  it.corrected = true; it.value = v; it.status = 'confirmed'; it.source = 'patient_correction'; delete it.suggestion;
  for (const c of rec.contradictions) if (c.keys.includes(key) && c.status !== 'clarified') { c.status = 'clarified'; c.resolution = `corrected ${it.label.toLowerCase()} to “${v}”`; }
  return finish(rec, input);
}
export function markUnsure(recIn: Reconstruction, key: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it) return rec;
  push(it, { action: 'marked_unsure', from: it.value, by: 'patient' });
  it.status = 'unsure'; it.corrected = it.initial.value !== null; delete it.suggestion;
  return finish(rec, input);
}
export function remove(recIn: Reconstruction, key: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it) return rec;
  push(it, { action: 'removed', from: it.value, by: 'patient' });
  it.status = 'removed'; delete it.suggestion;
  return finish(rec, input);
}
export function restore(recIn: Reconstruction, key: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it || it.status !== 'removed') return rec;
  push(it, { action: 'restored', to: it.value, by: 'patient' });
  it.status = it.value ? 'confirmed' : 'unanswered';
  return finish(rec, input);
}
export function rejectSuggestion(recIn: Reconstruction, key: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it?.suggestion) return rec;
  push(it, { action: 'suggestion_rejected', from: it.suggestion.value, by: 'patient' });
  delete it.suggestion; it.status = 'unanswered';
  return finish(rec, input);
}
export function acceptSuggestion(recIn: Reconstruction, key: string, input: CaptureInput): Reconstruction {
  const rec = clone(recIn);
  const it = rec.items.find((i) => i.key === key);
  if (!it?.suggestion) return rec;
  push(it, { action: 'suggestion_accepted', to: it.suggestion.value, by: 'patient' });
  it.value = it.suggestion.value; it.status = 'confirmed'; it.source = 'patient_confirmed_suggestion'; delete it.suggestion;
  return finish(rec, input);
}

/** Choices offered when correcting an item in the verification screen. */
export function correctionOptions(field: FieldKey): string[] {
  switch (field) {
    case 'onset': return ONSET_OPTIONS;
    case 'pattern': return PATTERN_OPTIONS;
    case 'severity': return [...SEVERITY_WORDS, ...Array.from({ length: 10 }, (_, i) => `${i + 1} / 10 (patient-rated)`)];
    case 'extent': return EXTENT_OPTIONS;
    case 'both_sides': return BOTH_SIDES_OPTIONS;
    case 'associated': return ASSOCIATED_OPTIONS;
    case 'sensation': return Object.values(SENSATION_LABELS).filter((s) => s !== 'Other' && s !== 'Not sure');
    default: return [];
  }
}

// ---------- measure ----------
export function metrics(rec: Reconstruction): VerificationMetrics {
  const req = rec.items.filter((i) => !i.optional);
  const hist = rec.items.flatMap((i) => i.history);
  return {
    initiallyCaptured: rec.items.filter((i) => i.initial.value !== null).length,
    missingAtStart: req.filter((i) => i.initial.value === null).length,
    missingResolved: req.filter((i) => i.initial.value === null && i.value !== null && i.status === 'confirmed').length,
    stillMissing: req.filter((i) => i.status === 'unanswered' || i.status === 'unsure' || i.status === 'suggested').length,
    correctedByPatient: rec.items.filter((i) => i.corrected).length,
    removedByPatient: rec.items.filter((i) => i.status === 'removed').length,
    suggestionsOffered: hist.filter((h) => h.action === 'suggested').length,
    suggestionsAccepted: hist.filter((h) => h.action === 'suggestion_accepted').length,
    suggestionsRejected: hist.filter((h) => h.action === 'suggestion_rejected').length,
    contradictionsDetected: rec.contradictions.length,
    contradictionsClarified: rec.contradictions.filter((c) => c.status === 'clarified').length,
    finalConfirmed: rec.items.filter((i) => i.status === 'confirmed').length,
  };
}

// ---------- report ----------
const live = (rec: Reconstruction, f: FieldKey) => rec.items.filter((i) => i.field === f && i.status !== 'removed');
const fmt = (it: ReconItem | undefined): BriefLine => {
  if (!it || (!it.value && it.status !== 'unsure')) return { text: 'Not specified', provenance: 'unknown' };
  if (it.status === 'unsure') return { text: 'Patient is not sure', provenance: 'unknown' };
  if (it.status === 'needs_clarification') return { text: `${it.value} — needs clarification`, provenance: 'unknown' };
  return { text: it.value!, provenance: 'patient' };
};

/** Template wording for the main concern: only names what the patient confirmed. */
export function templateMainConcern(rec: Reconstruction): string {
  const s = [...live(rec, 'sensation'), ...live(rec, 'other_sensation')].filter((i) => i.value && i.status === 'confirmed').map((i) => i.value!.toLowerCase());
  const r = live(rec, 'region').map((i) => i.value!.replace(/ \(patient clarified.*\)$/, ''));
  const sens = s.length ? s.join(' and ') : 'a sensation they could not name';
  return `Patient reports ${sens} in the ${r.join(', ').toLowerCase() || 'selected area'}.`;
}

export function buildBrief(rec: Reconstruction, opts: { mainConcern?: string; wordedBy?: 'rules' | 'ai' } = {}): ClinicalBrief {
  const wordedBy = opts.mainConcern ? (opts.wordedBy ?? 'ai') : 'rules';
  const get = (k: string) => rec.items.find((i) => i.key === k && i.status !== 'removed');
  const sec = (id: number, title: string, lines: BriefLine[]): BriefSection => ({ id, title, lines: lines.length ? lines : [{ text: 'Not specified', provenance: 'unknown' }] });
  const unanswered = rec.items.filter((i) => !i.optional && (i.status === 'unanswered' || i.status === 'unsure' || i.status === 'suggested')).map((i) => ({ text: `${i.label}${i.status === 'unsure' ? ' (patient not sure)' : i.status === 'suggested' ? ' (system suggestion not confirmed)' : ''}`, provenance: 'unknown' as const }));
  const contra = rec.contradictions.filter((c) => c.status !== 'clarified').map((c) => ({ text: c.description, provenance: 'unknown' as const }));
  const corrections = rec.items.flatMap((i) => i.history.filter((h) => h.by === 'patient' && (h.action === 'corrected' || h.action === 'removed' || h.action === 'suggestion_rejected'))
    .map((h) => ({ text: h.action === 'removed' ? `Removed ${i.label.toLowerCase()} “${h.from}”` : h.action === 'suggestion_rejected' ? `Rejected the suggestion “${h.from}” for ${i.label.toLowerCase()}` : `Changed ${i.label.toLowerCase()} from “${h.from ?? 'not specified'}” to “${h.to}”`, provenance: 'patient' as const })));
  const clarified = rec.contradictions.filter((c) => c.status === 'clarified').map((c) => ({ text: `Clarified: ${c.description} → ${c.resolution}`, provenance: 'patient' as const }));
  const context = get('context');
  return {
    wordedBy,
    generatedAt: now(),
    sections: [
      sec(1, 'Main concern', [{ text: opts.mainConcern ?? templateMainConcern(rec), provenance: opts.mainConcern ? 'ai_wording' : 'template_wording' }]),
      sec(2, 'Selected body regions', live(rec, 'region').map((i) => ({ text: i.value!, provenance: 'patient' }))),
      sec(3, 'Patient-described sensations', [...live(rec, 'sensation'), ...live(rec, 'other_sensation')].map(fmt)),
      sec(4, 'Onset and duration', [fmt(get('onset'))]),
      sec(5, 'Frequency and pattern', [fmt(get('pattern'))]),
      sec(6, 'Severity', [fmt(get('severity'))]),
      sec(7, 'Associated symptoms', [fmt(get('associated'))].concat(get('extent') ? [{ ...fmt(get('extent')), text: `Extent: ${fmt(get('extent')).text}` }] : []).concat(get('both_sides') ? [{ ...fmt(get('both_sides')), text: `Both sides: ${fmt(get('both_sides')).text}` }] : [])),
      sec(8, 'Patient-provided context', context?.value ? [{ text: `“${context.value}”`, provenance: 'patient' }] : [{ text: 'None provided', provenance: 'unknown' }]),
      sec(9, 'Unanswered questions', unanswered.length ? unanswered : [{ text: 'None', provenance: 'patient' }]),
      sec(10, 'Contradictions requiring clarification', contra.length ? contra : [{ text: 'None open', provenance: 'patient' }]),
      sec(11, 'Patient corrections during verification', [...corrections, ...clarified].length ? [...corrections, ...clarified] : [{ text: 'No corrections', provenance: 'patient' }]),
    ],
  };
}

const TAG: Record<string, string> = { patient: '', template_wording: ' [wording by AccessCare]', ai_wording: ' [wording by AI]', unknown: ' [unknown]', clinician: ' [clinician]' };

/** Plain text of the brief — the exact text the patient approves and the doctor receives. */
export function briefText(brief: ClinicalBrief): string {
  const out: string[] = [];
  for (const s of brief.sections) {
    out.push(`${s.id}. ${s.title}: ${s.lines.map((l) => l.text + TAG[l.provenance]).join('; ')}`);
  }
  out.push('This is the patient’s report, organized for the doctor. It is not a diagnosis.');
  return out.join('\n');
}

/** Legacy structured view (kept for existing screens and backends). */
export function toStructuredReport(rec: Reconstruction, brief: ClinicalBrief, answers: ClarificationAnswer[], generatedBy: StructuredReport['generatedBy']): StructuredReport {
  const fields: ReportField[] = rec.items.filter((i) => i.field !== 'region' && i.field !== 'sensation').map((i) => ({
    label: i.label,
    value: i.status === 'removed' ? 'Removed by patient' : i.value ?? (i.optional ? 'None provided' : 'Not specified'),
    status: i.status === 'confirmed' ? 'confirmed' : i.status === 'unsure' ? 'unsure' : i.status === 'needs_clarification' ? 'needs_clarification' : 'unanswered',
  }));
  return {
    regions: live(rec, 'region').map((i) => i.value!),
    sensations: [...live(rec, 'sensation'), ...live(rec, 'other_sensation')].filter((i) => i.value).map((i) => i.value!),
    fields, clarifications: answers, flags: rec.contradictions.filter((c) => c.status !== 'clarified').map((c) => c.description),
    generatedBy, reconstruction: rec, brief, metrics: metrics(rec),
  };
}
