// Builds the case the engine reasons about from a patient-approved report.
// Only what the patient reported (or approved later), and what the doctor
// documented. Every fact gets an id so each observation can point to it.

import type { CaseFact, FactSource, FactStatus, Documented } from '../../domain/clinical';
import type { ConsultRecord, Via } from '../../domain/conversation';
import type { Consultation, Message, StructuredReport } from '../../domain/types';
import { regionLabel } from '../../domain/bodyRegions';
import { CONCEPT_BY_ID } from '../conversation/lexicon';
import { understand } from '../conversation/Consult';

export interface Sym {
  concept: string;
  factId: string;
  status: FactStatus;
  /** attribute → value id (onset: today|days|week|longer, onset_type: sudden|gradual, severity: mild|moderate|severe|0-10, pattern, location, side) */
  attrs: Record<string, { value: string; factId: string }>;
  /** attributes the patient said they are not sure about */
  unsure: Set<string>;
}

export interface Case {
  facts: CaseFact[];
  symptoms: Sym[];
  /** concept → fact id of "patient said they do not have it" */
  denied: Map<string, string>;
  /** patient's own words (for wording rules), each with its fact id */
  words: { text: string; factId: string }[];
  /** questions the patient answered YES to (Silent Signal, clarifications), with fact ids */
  yes: { text: string; factId: string }[];
  regions: string[];
  urgentShown: { reason: string; factId: string }[];
  documented: Documented;
  /** clinical:<missing id> → answer given after sharing (patient-approved) */
  clarified: Map<string, { answer: string; factId: string }>;
  /** clinical:<missing id> questions sent and not yet answered */
  asked: Set<string>;
  conflicts: { description: string; evidence: string[]; status: 'open' | 'clarified' | 'unresolved' }[];
  /** what kind of report this was */
  kind: 'conversation' | 'body_map' | 'silent_signal';
}

const ONSET_IDS: Record<string, string> = { Today: 'today', '1–3 days ago': 'days', 'About a week ago': 'week', 'More than a week ago': 'longer', 'Before today': 'days' };
const SEV_IDS: Record<string, string> = { Mild: 'mild', Moderate: 'moderate', Severe: 'severe', 'Not severe': 'moderate' };
const ATTR_LABEL: Record<string, string> = { onset: 'Started', onset_type: 'How it started', severity: 'Strength', pattern: 'Pattern', location: 'Where exactly', side: 'Side', sensation: 'Feels like' };
const srcOf = (via: Via | undefined, prov: string): FactSource => (via === 'body_map' ? 'body_map' : prov === 'said' ? 'patient_words' : 'patient_choice');
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export function conceptLabel(id: string) { return cap(CONCEPT_BY_ID[id]?.en ?? id.replace(/_/g, ' ')); }

/** Maps an answer to the doctor's follow-up question (sent from the engine) to an attribute value. */
export const ANSWER_VALUE: Record<string, string> = {
  'Suddenly (within seconds or minutes)': 'sudden', Suddenly: 'sudden', 'Gradually': 'gradual', 'Built up gradually': 'gradual',
  Mild: 'mild', Moderate: 'moderate', Severe: 'severe', Today: 'today', 'A few days ago': 'days', 'About a week ago': 'week', 'More than a week ago': 'longer',
};

export function buildCase(c: Pick<Consultation, 'regionIds' | 'sensations' | 'details' | 'urgentGuidanceShown'>, report: StructuredReport & { conversation?: ConsultRecord }, messages: Message[], documented: Documented): Case {
  const facts: CaseFact[] = [];
  const add = (f: Omit<CaseFact, 'id'>): string => {
    const dup = facts.find((x) => x.label === f.label && x.value === f.value && x.concept === f.concept && x.attr === f.attr);
    if (dup) return dup.id;
    const id = `F${facts.length + 1}`; facts.push({ id, ...f }); return id;
  };
  const cs: Case = {
    facts, symptoms: [], denied: new Map(), words: [], yes: [], regions: [...new Set(c.regionIds)], urgentShown: [], documented,
    clarified: new Map(), asked: new Set(), conflicts: [], kind: report.conversation ? 'conversation' : report.signal ? 'silent_signal' : 'body_map',
  };
  const symptom = (concept: string, f: Omit<CaseFact, 'id' | 'concept'>): Sym => {
    let s = cs.symptoms.find((x) => x.concept === concept);
    if (s) { if (f.status === 'confirmed' && s.status !== 'confirmed') { s.status = 'confirmed'; facts.find((x) => x.id === s!.factId)!.status = 'confirmed'; } return s; }
    s = { concept, factId: add({ ...f, concept }), status: f.status, attrs: {}, unsure: new Set() };
    cs.symptoms.push(s); cs.denied.delete(concept);
    return s;
  };
  const attr = (s: Sym, name: string, value: string, shown: string, status: FactStatus, source: FactSource, quote?: string) => {
    if (s.attrs[name]) return;
    s.attrs[name] = { value, factId: add({ label: `${conceptLabel(s.concept)} — ${ATTR_LABEL[name] ?? name}`, value: shown, status, source, concept: s.concept, attr: name, ...(quote ? { quote } : {}) }) };
  };

  // ---------- 1. conversation reports (Talk to AccessCare / Blind Mode)
  const rec = report.conversation;
  if (rec && Array.isArray(rec.complaints)) {
    const real = rec.complaints.filter((x) => x.concept !== 'unwell' || rec.complaints.length === 1);
    for (const k of real) {
      const status: FactStatus = k.prov === 'inferred' && !k.confirmed ? 'interpretation' : 'confirmed';
      const s = symptom(k.concept, { label: cap(k.en), value: k.quote ? `Patient said: “${k.quote}”` : 'Chosen by the patient', status, source: srcOf(k.via, k.prov), ...(k.quote ? { quote: k.quote } : {}) });
      if (k.regions.length) add({ label: `${conceptLabel(k.concept)} — Body area`, value: k.regions.map((r) => regionLabel(r.id)).join(', '), status: k.regions.every((r) => r.confirmed) ? 'confirmed' : 'interpretation', source: k.regions.some((r) => r.via === 'body_map') ? 'body_map' : 'patient_words', concept: k.concept, attr: 'region' });
      for (const [slot, f] of Object.entries(k.facts)) {
        if (!f || slot === 'associated') continue;
        if (slot === 'sensation' && f.value === CONCEPT_BY_ID[k.concept]?.sensation) continue; // "headache — feels like: pain" adds nothing
        attr(s, slot, f.value, f.en, f.prov === 'inferred' && !f.confirmed ? 'interpretation' : 'confirmed', srcOf(f.via, f.prov), f.quote);
      }
      for (const u of k.unknown) { s.unsure.add(u); add({ label: `${conceptLabel(k.concept)} — ${ATTR_LABEL[u] ?? u}`, value: 'Patient is not sure', status: 'unsure', source: 'patient_choice', concept: k.concept, attr: u }); }
    }
    for (const d of rec.denied ?? []) {
      const s = cs.symptoms.find((x) => x.concept === d);
      if (!s) cs.denied.set(d, add({ label: conceptLabel(d), value: 'Patient said they do not have this', status: 'denied', source: 'patient_choice', concept: d }));
      else cs.conflicts.push({ description: `${conceptLabel(d)} was reported and also denied.`, evidence: [s.factId], status: 'open' });
    }
    for (const n of rec.notes ?? []) if (n.text?.trim()) cs.words.push({ text: n.text, factId: add({ label: n.kind === 'question' ? 'Question for the doctor' : 'In the patient’s words', value: n.text.slice(0, 300), status: 'confirmed', source: 'patient_words', quote: n.text.slice(0, 300) }) });
    for (const t of (rec.turns ?? []).filter((t) => t.who === 'patient' && t.via !== 'touch' && t.via !== 'body_map' && (t.text ?? '').trim().length > 2).slice(-15)) {
      cs.words.push({ text: t.text, factId: add({ label: 'In the patient’s words', value: t.text.slice(0, 300), status: 'confirmed', source: 'patient_words', quote: t.text.slice(0, 300) }) });
    }
    for (const x of rec.corrections ?? []) cs.conflicts.push({ description: `The patient corrected ${x.field}: “${x.from}” → “${x.to}”.`, evidence: [], status: 'clarified' });
    for (const u of rec.urgent ?? []) cs.urgentShown.push({ reason: u, factId: add({ label: 'Emergency guidance shown to the patient', value: u, status: 'confirmed', source: 'system' }) });
  }

  // ---------- 2. body map / questionnaire reports (Reconstruction items)
  const items = report.reconstruction?.items ?? [];
  if (!rec && items.length) {
    const regions = items.filter((i) => i.field === 'region' && i.status !== 'removed').map((i) => i.key.replace(/^region:/, ''));
    const sens = items.filter((i) => i.field === 'sensation' && i.status === 'confirmed').map((i) => (i.key.replace(/^sensation:/, '')));
    const base = (id: string) => id.replace(/_(l|r)$/, '');
    const painful = sens.some((x) => x === 'pain' || x === 'burning') || sens.length === 0;
    const concepts = new Set<string>();
    if (painful && regions.some((r) => base(r) === 'head')) concepts.add('headache');
    if (painful && regions.some((r) => base(r) === 'chest')) concepts.add('chest_pain');
    if (painful && regions.some((r) => base(r).startsWith('abdomen'))) concepts.add('abdominal_pain');
    if (painful && regions.some((r) => /back/.test(base(r)))) concepts.add('back_pain');
    if (sens.includes('numbness') || sens.includes('tingling')) concepts.add('numbness');
    if (sens.includes('weakness')) concepts.add('weakness');
    if (!concepts.size) concepts.add('pain');
    const regionText = regions.map(regionLabel).join(', ');
    const sensText = sens.map(cap).join(', ');
    const onset = items.find((i) => i.key === 'onset'); const sev = items.find((i) => i.key === 'severity'); const pat = items.find((i) => i.key === 'pattern');
    for (const k of concepts) {
      const s = symptom(k, { label: k === 'pain' ? `${sensText || 'Pain'}${regionText ? ` — ${regionText}` : ''}` : conceptLabel(k), value: `Chosen on the body map${regionText ? `: ${regionText}` : ''}${sensText ? ` (${sensText})` : ''}`, status: 'confirmed', source: 'body_map' });
      if (onset?.value && onset.status === 'confirmed') attr(s, 'onset', ONSET_IDS[onset.value] ?? onset.value, onset.value, 'confirmed', 'patient_choice');
      else if (onset?.status === 'unsure') s.unsure.add('onset');
      if (sev?.value && sev.status === 'confirmed') { const n = sev.value.match(/^(\d+)/); attr(s, 'severity', n ? n[1] : SEV_IDS[sev.value] ?? sev.value, sev.value, 'confirmed', 'patient_choice'); }
      else if (sev?.status === 'unsure') s.unsure.add('severity');
      if (pat?.value && pat.status === 'confirmed') attr(s, 'pattern', /constant/i.test(pat.value) ? 'constant' : 'comes_and_goes', pat.value, 'confirmed', 'patient_choice');
      else if (pat?.status === 'unsure') s.unsure.add('pattern');
    }
    const assoc = items.find((i) => i.key === 'associated');
    if (assoc?.value && assoc.status === 'confirmed' && !/nothing else/i.test(assoc.value)) {
      for (const h of understand(assoc.value).concepts) if (!h.negated) symptom(h.value, { label: conceptLabel(h.value), value: `Chosen: ${assoc.value}`, status: 'confirmed', source: 'patient_choice' });
    } else if (assoc?.value && /nothing else/i.test(assoc.value)) {
      for (const d of ['nausea', 'fever', 'dizziness', 'breathing', 'fatigue']) cs.denied.set(d, add({ label: conceptLabel(d), value: 'Patient chose “Nothing else”', status: 'denied', source: 'patient_choice', concept: d }));
    }
    const ctx = items.find((i) => i.key === 'context' || i.key === 'other_sensation');
    for (const it of items.filter((i) => (i.key === 'context' || i.key === 'other_sensation') && i.value)) {
      const fid = add({ label: 'In the patient’s words', value: it.value!.slice(0, 300), status: 'confirmed', source: 'patient_words', quote: it.value!.slice(0, 300) });
      cs.words.push({ text: it.value!, factId: fid });
      // symptoms named in their own words are listed as interpretations of those words (rules), not as confirmed answers
      for (const h of understand(it.value!).concepts) if (!h.negated && !cs.symptoms.some((s) => s.concept === h.value) && h.value !== 'pain' && h.value !== 'unwell') symptom(h.value, { label: conceptLabel(h.value), value: `Found in the patient’s words: “${h.quote}”`, status: 'interpretation', source: 'patient_words', quote: h.quote });
    }
    void ctx;
  }
  for (const k of report.reconstruction?.contradictions ?? []) cs.conflicts.push({ description: k.description, evidence: [], status: k.status });

  // ---------- 3. Silent Signal selections
  for (const sel of report.signal?.selections ?? []) {
    const st: FactStatus = sel.status === 'not_sure' ? 'unsure' : 'confirmed';
    if (sel.status === 'unanswered' || !sel.confirmed) continue;
    const fid = add({ label: sel.question, value: sel.choice, status: st, source: 'silent_signal' });
    if (/^yes$/i.test(sel.choice)) cs.yes.push({ text: sel.question, factId: fid });
  }
  if (report.signal && !cs.symptoms.length) {
    const regions = report.signal.regionIds;
    if (regions.length) symptom(regions.some((r) => r === 'head') ? 'headache' : regions.some((r) => r === 'chest') ? 'chest_pain' : 'pain', { label: `Pain — ${regions.map(regionLabel).join(', ')}`, value: 'Selected with Silent Signal', status: 'confirmed', source: 'silent_signal' });
  }
  if (c.urgentGuidanceShown && !cs.urgentShown.length) cs.urgentShown.push({ reason: 'urgent-help guidance was shown during the report', factId: add({ label: 'Emergency guidance shown to the patient', value: 'Shown during the report', status: 'confirmed', source: 'system' }) });

  // ---------- 4. answers the patient approved after sending (clarifications)
  const byId = new Map(messages.map((m) => [m.id, m]));
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.kind !== 'clarification_answer' || !m.meta?.approvedByPatient) continue;
    const req = m.meta.replyTo ? byId.get(m.meta.replyTo) : undefined;
    if (req) answered.add(req.id);
    const raw = (m.meta.raw ?? m.body).trim();
    const key = m.meta.itemKey ?? req?.meta?.itemKey ?? '';
    const question = req?.body ?? m.meta.itemLabel ?? 'Doctor’s question';
    const notSure = /^not sure$/i.test(raw);
    const fid = add({ label: m.meta.itemLabel ?? question, value: `${raw} (answered after sending: “${question}”)`, status: notSure ? 'unsure' : 'confirmed', source: 'clarification' });
    if (key.startsWith('clinical:')) {
      const mid = key.slice('clinical:'.length);
      cs.clarified.set(mid, { answer: raw, factId: fid });
      const [concept, topic] = mid.split(':');
      const sym = cs.symptoms.find((s) => s.concept === concept);
      if (sym && topic && ANSWER_VALUE[raw] && !sym.attrs[topic]) sym.attrs[topic] = { value: ANSWER_VALUE[raw], factId: fid };
      if (sym && topic && notSure) sym.unsure.add(topic);
    }
    if (/^yes$/i.test(raw)) {
      cs.yes.push({ text: question, factId: fid });
      // "yes" names a symptom only when the question asked about exactly one; a yes to "A, B or C?" stays a yes to that question
      const named = understand(question).concepts.filter((h) => h.value !== 'pain' && h.value !== 'unwell');
      if (named.length === 1) symptom(named[0].value, { label: conceptLabel(named[0].value), value: `Answered “Yes” after sending: “${question}”`, status: 'confirmed', source: 'clarification' });
      // otherwise each is possible (at least one is present): kept as an interpretation so urgency rules still see it
      else for (const h of named) symptom(h.value, { label: conceptLabel(h.value), value: `Possibly — “Yes” to a question about several symptoms: “${question}”`, status: 'interpretation', source: 'clarification' });
    } else if (/^no$/i.test(raw)) {
      for (const h of understand(question).concepts) {
        const s = cs.symptoms.find((x) => x.concept === h.value);
        if (!s) cs.denied.set(h.value, fid);
        else if (s.status === 'confirmed') cs.conflicts.push({ description: `${conceptLabel(h.value)} was reported, but the later answer to “${question}” was “No”.`, evidence: [s.factId, fid], status: 'open' });
      }
    } else if (!notSure) cs.words.push({ text: raw, factId: fid });
  }
  for (const m of messages) if (m.kind === 'clarification' && !answered.has(m.id) && m.meta?.itemKey?.startsWith('clinical:')) cs.asked.add(m.meta.itemKey.slice('clinical:'.length));

  // ---------- 5. documented by the doctor
  const d = documented;
  if (d.age) add({ label: 'Age', value: `${d.age} years`, status: 'confirmed', source: 'clinician' });
  if (d.sex !== 'unknown') add({ label: 'Sex', value: d.sex, status: 'confirmed', source: 'clinician' });
  if (d.pregnancy !== 'unknown') add({ label: 'Pregnancy', value: d.pregnancy.replace('_', ' '), status: 'confirmed', source: 'clinician' });
  if (d.allergies.status !== 'unknown') add({ label: 'Allergies', value: d.allergies.status === 'none_known' ? 'No known allergies' : d.allergies.items.join(', '), status: 'confirmed', source: 'clinician' });
  if (d.medications.status !== 'unknown') add({ label: 'Current medicines', value: d.medications.status === 'none' ? 'None' : d.medications.items.join(', '), status: 'confirmed', source: 'clinician' });
  if (d.conditions) add({ label: 'Relevant conditions', value: d.conditions, status: 'confirmed', source: 'clinician' });
  if (d.kidney !== 'unknown') add({ label: 'Kidney function', value: d.kidney, status: 'confirmed', source: 'clinician' });
  if (d.liver !== 'unknown') add({ label: 'Liver function', value: d.liver, status: 'confirmed', source: 'clinician' });
  return cs;
}
