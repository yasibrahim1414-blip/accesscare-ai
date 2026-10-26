// Deterministic rules of the Clinical Intelligence Engine.
//
//   warnings()  — warning signs taken from the public NHS "when to get urgent
//                 help" pages in references.ts. Conservative: something the
//                 patient did not answer is treated as possibly present for
//                 urgency, never as "absent".
//   missing()   — information that could change the assessment, chosen per
//                 reported complaint (a headache is never asked about the chest)
//   conflicts() — contradictions in what was reported
//   ruleSteps() — next steps that follow directly from a fired rule
// The rules never diagnose. They are not clinically validated.

import type { ClinicalConflict, ClinicalWarning, MissingItem, NextStep } from '../../domain/clinical';
import type { Case, Sym } from './facts';
import { conceptLabel } from './facts';

// ---------------------------------------------------------------- helpers
const NEURO = ['speech', 'weakness', 'numbness', 'vision'];
const sym = (c: Case, id: string) => c.symptoms.find((s) => s.concept === id);
const any = (c: Case, ids: string[]) => c.symptoms.filter((s) => ids.includes(s.concept));
const val = (s: Sym | undefined, a: string) => s?.attrs[a]?.value;
const ev = (s: Sym | undefined, ...attrs: string[]) => (s ? [s.factId, ...attrs.map((a) => s.attrs[a]?.factId).filter((x): x is string => !!x)] : []);
/** not stated as gradual or long-standing → treated as possibly new */
const maybeNew = (s: Sym) => val(s, 'onset_type') !== 'gradual' && val(s, 'onset') !== 'longer';
const severe = (s: Sym | undefined) => { const v = val(s, 'severity'); return v === 'severe' || (!!v && /^\d+$/.test(v) && Number(v) >= 8); };
const sudden = (s: Sym | undefined) => val(s, 'onset_type') === 'sudden';

const TEXT: Record<string, RegExp> = {
  speech: /slurr|trouble (speaking|talking)|difficult(y)? (speaking|talking)|can'?t (speak|talk|get (my )?words out)|words (come|coming) out wrong|لساني\s*(تقيل|تقل)|كلامي\s*(تقيل|متلخبط)|صعوب[ةه]\s*(في\s*)?(الكلام|النطق)|مش\s*(قادر|عارف)\s*(ا|أ)?(نطق|تكلم)/i,
  face: /droop|face (is )?(numb|drooping|lopsided)|وشي\s*(مايل|معوج|معووج)|نص\s*وشي/i,
  confusion: /\bconfus|disorient|not making sense|متلخبط\s*في\s*الكلام|مش\s*فاكر\s*حاجه|تايه/i,
  seizure: /seizure|convuls|\bfit\b|تشنج|نوب[ةه]\s*صرع/i,
  head_injury: /hit my head|head injury|banged my head|fell on my head|خبطت\s*راسي|اتخبطت\s*في\s*راسي|وقعت\s*على\s*راسي/i,
  worst_headache: /worst headache|thunderclap|اسو(ا|أ)\s*صداع|أسوأ\s*صداع/i,
  light: /light hurts|sensitiv\w* to (bright )?light|النور\s*(بيضايقني|بيوجع)/i,
  rash_nonfading: /rash (that )?(does ?n[o']?t|won'?t) fade|non-?blanching|طفح\s*مش\s*بيختفي/i,
  breathing: /can'?t breathe|cannot breathe|hard to breathe|short(ness)? of breath|struggling to breathe|trouble breathing|مش\s*(قادر|عارف)\s*(ا|أ)?تنفس|ضيق\s*(في\s*)?(التنفس|النفس)|نفسي\s*مقطوع|مخنوق/i,
  bleeding: /(bleeding|blood).{0,20}(won'?t stop|a lot|heavy)|heavy bleeding|نزيف.{0,15}(مش\s*بيقف|جامد|كتير)/i,
  gi_blood: /vomit\w* blood|throwing up blood|coffee.?grounds|black (stool|poo)|blood in (my )?(stool|poo)|برجع\s*دم|ترجيع\s*دم|براز\s*(اسود|فيه\s*دم)/i,
  self_harm: /suicid|kill myself|end my life|hurt myself|harm myself|(ا|أ)نتحر|(ا|أ)قتل\s*نفسي|(عايز|عايزه)\s*(ا|أ)موت|(ا|أ)ذي\s*نفسي/i,
  radiating: /(spread|spreading|goes|going|moves?) (to|into|down) (my )?(left |right )?(arm|jaw|neck|back)|بيوصل\s*ل?(دراعي|فكي|رقبتي|ضهري)|بيمشي\s*في\s*دراعي/i,
  palpitations: /palpitation|heart (is )?(racing|pounding|fluttering)|irregular heartbeat|قلبي\s*(بيدق\s*جامد|بيرفرف|مش\s*منتظم)/i,
  exertion: /while (exercising|running|walking fast)|during exercise|وانا\s*(بجري|بتمرن|بلعب\s*رياضه)/i,
};
function textHit(c: Case, key: string): string | null {
  const re = TEXT[key];
  for (const w of c.words) if (re.test(w.text)) return w.factId;
  for (const y of c.yes) if (re.test(y.text) || (key === 'speech' && /speak|speech|talk/i.test(y.text)) || (key === 'face' && /face/i.test(y.text) && /weak|numb|droop/i.test(y.text))) return y.factId;
  return null;
}
const yesSudden = (c: Case, re: RegExp) => c.yes.find((y) => re.test(y.text) && /sudden/i.test(y.text))?.factId ?? null;

// ---------------------------------------------------------------- warnings
interface Rule { id: string; level: 'emergency' | 'urgent' | 'info'; title: string; action: string; refs: string[]; test(c: Case): { evidence: string[]; why: string } | null }

const CALL = 'Advise calling the local emergency number now (UAE 998, Egypt 123). Do not wait for routine review.';
const SOON = 'Arrange same-day clinical assessment; tell the patient how to get urgent help if it gets worse.';

const RULES: Rule[] = [
  { id: 'stroke_signs', level: 'emergency', title: 'Possible stroke warning signs (FAST)', action: CALL, refs: ['nhs_stroke'],
    test(c) {
      const hits = any(c, NEURO).filter((s) => (s.concept === 'speech' ? maybeNew(s) : sudden(s) || (s.concept !== 'vision' && maybeNew(s) && val(s, 'onset') === 'today')));
      const t = [textHit(c, 'face'), yesSudden(c, /weak|numb|speak|speech/i)].filter((x): x is string => !!x);
      if (!hits.length && !t.length) return null;
      return { evidence: [...hits.flatMap((s) => ev(s, 'onset_type', 'onset')), ...t], why: `Reported: ${[...hits.map((s) => conceptLabel(s.concept).toLowerCase()), ...(t.length ? ['face or limb weakness / speech difficulty'] : [])].join(', ')}${hits.some((s) => !s.attrs.onset_type) ? ' — whether it began suddenly is not known, so it is treated as possibly new' : ''}.` };
    } },
  { id: 'headache_neuro', level: 'emergency', title: 'Headache with neurological symptoms', action: CALL, refs: ['nhs_headache', 'nhs_stroke'],
    test(c) {
      const h = sym(c, 'headache'); if (!h) return null;
      const n = any(c, NEURO).filter((s) => s.concept === 'vision' || maybeNew(s));
      const t = ['speech', 'confusion', 'seizure'].map((k) => textHit(c, k)).filter((x): x is string => !!x);
      if (!n.length && !t.length) return null;
      return { evidence: [...ev(h), ...n.flatMap((s) => ev(s, 'onset_type')), ...(n.length ? [] : t)], why: `Headache reported together with ${n.length ? n.map((s) => conceptLabel(s.concept).toLowerCase()).join(', ') : 'speech difficulty, confusion or a seizure (in the patient’s words)'}.` };
    } },
  { id: 'thunderclap', level: 'emergency', title: 'Sudden, very severe headache', action: CALL, refs: ['nhs_headache'],
    test(c) {
      const h = sym(c, 'headache'); const w = textHit(c, 'worst_headache');
      if (h && sudden(h) && severe(h)) return { evidence: ev(h, 'onset_type', 'severity'), why: 'The headache started suddenly and is severe.' };
      if (w) return { evidence: [...ev(h), w], why: 'The patient described it as the worst headache / thunderclap.' };
      return null;
    } },
  { id: 'thunderclap_unclear', level: 'urgent', title: 'Sudden headache — strength not known', action: 'Clarify the strength now (sudden severe headache is an emergency sign); arrange prompt assessment.', refs: ['nhs_headache'],
    test(c) { const h = sym(c, 'headache'); return h && sudden(h) && !h.attrs.severity ? { evidence: ev(h, 'onset_type'), why: 'The headache started suddenly; how strong it is was not answered.' } : null; } },
  { id: 'meningism', level: 'emergency', title: 'Fever with stiff neck, severe headache or non-fading rash', action: CALL, refs: ['nhs_meningitis', 'nhs_headache'],
    test(c) {
      const f = sym(c, 'fever'); if (!f) return null;
      const n = sym(c, 'stiff_neck'); const h = sym(c, 'headache'); const r = textHit(c, 'rash_nonfading'); const l = textHit(c, 'light');
      if (n || r || (h && (severe(h) || l))) return { evidence: [...ev(f), ...ev(n), ...ev(h, 'severity'), ...[r, l].filter((x): x is string => !!x)], why: `Fever reported with ${[n && 'a stiff neck', h && 'a headache', r && 'a rash that does not fade', l && 'light sensitivity'].filter(Boolean).join(', ')}.` };
      return null;
    } },
  { id: 'chest_pain_red', level: 'emergency', title: 'Chest pain with warning features', action: CALL, refs: ['nhs_chest_pain'],
    test(c) {
      const p = sym(c, 'chest_pain'); if (!p) return null;
      const w = any(c, ['breathing', 'sweating', 'nausea', 'dizziness', 'fainting']); const rad = textHit(c, 'radiating');
      if (w.length || rad || severe(p) || sudden(p)) return { evidence: [...ev(p, 'severity', 'onset_type'), ...w.flatMap((s) => ev(s)), ...(rad ? [rad] : [])], why: `Chest pain${w.length ? ` with ${w.map((s) => conceptLabel(s.concept).toLowerCase()).join(', ')}` : ''}${rad ? ', spreading to the arm/jaw/neck/back' : ''}${severe(p) ? ', severe' : ''}${sudden(p) ? ', sudden onset' : ''}.` };
      return null;
    } },
  { id: 'chest_pain', level: 'urgent', title: 'Chest pain needs prompt assessment', action: SOON, refs: ['nhs_chest_pain'],
    test(c) { const p = sym(c, 'chest_pain'); return p ? { evidence: ev(p), why: 'Chest pain was reported. Its features (spread, breathlessness, sweating) are not all known.' } : null; } },
  { id: 'breathing', level: 'emergency', title: 'Breathing difficulty', action: CALL, refs: ['nhs_breathless'],
    test(c) {
      const b = sym(c, 'breathing'); const t = textHit(c, 'breathing');
      if (b && val(b, 'severity') === 'mild') return null;
      if (b || t) return { evidence: [...ev(b, 'severity'), ...(t ? [t] : [])], why: b?.attrs.severity ? 'Breathing difficulty was reported and is not mild.' : 'Breathing difficulty was reported; how severe it is was not answered.' };
      return null;
    } },
  { id: 'breathing_mild', level: 'urgent', title: 'Mild breathing difficulty', action: SOON, refs: ['nhs_breathless'],
    test(c) { const b = sym(c, 'breathing'); return b && val(b, 'severity') === 'mild' ? { evidence: ev(b, 'severity'), why: 'The patient rated breathing difficulty as mild.' } : null; } },
  { id: 'fainting', level: 'urgent', title: 'Fainting', action: SOON, refs: ['nhs_fainting'],
    test(c) { const f = sym(c, 'fainting'); return f ? { evidence: ev(f), why: 'Fainting was reported.' } : null; } },
  { id: 'fainting_red', level: 'emergency', title: 'Fainting with chest pain, palpitations, exertion or a seizure', action: CALL, refs: ['nhs_fainting'],
    test(c) {
      const f = sym(c, 'fainting'); if (!f) return null;
      const x = [ev(sym(c, 'chest_pain')), [textHit(c, 'palpitations'), textHit(c, 'exertion'), textHit(c, 'seizure')].filter((z): z is string => !!z)].flat();
      return x.length ? { evidence: [...ev(f), ...x], why: 'Fainting together with chest pain, a racing or irregular heartbeat, fainting during exercise, or a seizure.' } : null;
    } },
  { id: 'abdominal_red', level: 'emergency', title: 'Sudden or severe stomach pain / bleeding signs', action: CALL, refs: ['nhs_stomach'],
    test(c) {
      const a = sym(c, 'abdominal_pain'); const g = textHit(c, 'gi_blood');
      if ((a && (sudden(a) || severe(a))) || g) return { evidence: [...ev(a, 'onset_type', 'severity'), ...(g ? [g] : [])], why: g ? 'The patient’s words mention vomiting blood or blood / black stool.' : 'Stomach pain that started suddenly or is severe.' };
      return null;
    } },
  { id: 'sepsis_signs', level: 'emergency', title: 'Fever with breathing difficulty or confusion', action: CALL, refs: ['nhs_sepsis'],
    test(c) { const f = sym(c, 'fever'); const b = sym(c, 'breathing'); const t = textHit(c, 'confusion'); return f && (b || t) ? { evidence: [...ev(f), ...ev(b), ...(t ? [t] : [])], why: 'Fever reported with breathing difficulty or confusion.' } : null; } },
  { id: 'bleeding', level: 'emergency', title: 'Heavy bleeding', action: CALL, refs: [],
    test(c) { const t = textHit(c, 'bleeding'); return t ? { evidence: [t], why: 'The patient described heavy or non-stopping bleeding.' } : null; } },
  { id: 'self_harm', level: 'emergency', title: 'Thoughts of self-harm', action: 'Contact the patient now; if they may act on it, advise calling the emergency number or going to the emergency department.', refs: ['nhs_suicide'],
    test(c) { const t = textHit(c, 'self_harm'); return t ? { evidence: [t], why: 'The patient’s words mention harming themselves or wanting to die.' } : null; } },
  { id: 'head_injury', level: 'urgent', title: 'Headache after a head injury', action: SOON, refs: ['nhs_headache'],
    test(c) { const h = sym(c, 'headache'); const t = textHit(c, 'head_injury'); return h && t ? { evidence: [...ev(h), t], why: 'Headache with a head injury mentioned in the patient’s words.' } : null; } },
  { id: 'headache_soon', level: 'urgent', title: 'Headache with vomiting or vision problems', action: 'Urgent (same-day) review is advised by the NHS page for headache with vomiting or vision problems.', refs: ['nhs_headache'],
    test(c) {
      const h = sym(c, 'headache'); if (!h) return null;
      const x = any(c, ['vomiting', 'vision']);
      return x.length ? { evidence: [...ev(h), ...x.flatMap((s) => ev(s))], why: `Headache with ${x.map((s) => conceptLabel(s.concept).toLowerCase()).join(' and ')}.` } : null;
    } },
];

export function warnings(c: Case): ClinicalWarning[] {
  const out: ClinicalWarning[] = [];
  for (const r of RULES) {
    const hit = r.test(c);
    if (hit) out.push({ id: r.id, level: r.level, title: r.title, why: hit.why, evidence: [...new Set(hit.evidence)], action: r.action, refs: r.refs, by: 'rules' });
  }
  // an emergency rule supersedes its milder version
  const has = (id: string) => out.some((w) => w.id === id);
  const drop = new Set<string>();
  if (has('chest_pain_red')) drop.add('chest_pain');
  if (has('fainting_red')) drop.add('fainting');
  if (has('thunderclap')) drop.add('thunderclap_unclear');
  const list = out.filter((w) => !drop.has(w.id));
  for (const u of c.urgentShown) list.push({ id: `shown:${u.reason}`, level: 'info', title: 'The patient was shown emergency guidance', why: `While reporting, AccessCare showed the patient urgent-help guidance because of: ${u.reason}.`, evidence: [u.factId], action: 'Check that the patient got help.', refs: [], by: 'rules' });
  for (const s of c.symptoms.filter((x) => x.status === 'interpretation')) {
    list.push({ id: `interp:${s.concept}`, level: 'info', title: `${conceptLabel(s.concept)} is an interpretation`, why: 'This symptom was found in the patient’s words by AccessCare and was not confirmed by the patient. Confirm it before relying on it.', evidence: [s.factId], action: 'Confirm with the patient.', refs: [], by: 'rules' });
  }
  const order = { emergency: 0, urgent: 1, info: 2 } as const;
  return list.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------------------------------------------------------------- missing information
interface Ask { topic: string; why: string; importance: 'high' | 'medium'; question: string; format: MissingItem['format']; options?: string[]; refs: string[]; known(c: Case, s?: Sym): 'known' | 'unsure' | 'unknown' }
const attrKnown = (a: string) => (_c: Case, s?: Sym): 'known' | 'unsure' | 'unknown' => (s?.attrs[a] ? 'known' : s?.unsure.has(a) ? 'unsure' : 'unknown');
const symKnown = (ids: string[]) => (c: Case): 'known' | 'unsure' | 'unknown' => (ids.every((id) => sym(c, id) || c.denied.has(id)) || ids.some((id) => sym(c, id)) ? 'known' : 'unknown');
const ONSET_TYPE_OPTS = ['Suddenly (within seconds or minutes)', 'Gradually', 'Not sure'];
const SEV_OPTS = ['Mild', 'Moderate', 'Severe', 'Not sure'];
const ONSET_OPTS = ['Today', 'A few days ago', 'About a week ago', 'More than a week ago', 'Not sure'];

const onsetType = (what: string, why: string, refs: string[], imp: 'high' | 'medium' = 'high'): Ask => ({ topic: 'How it started (suddenly or gradually)', why, importance: imp, question: `Did the ${what} start suddenly, or build up gradually?`, format: 'choice', options: ONSET_TYPE_OPTS, refs, known: attrKnown('onset_type') });
const severity = (what: string, why: string, refs: string[], imp: 'high' | 'medium' = 'medium'): Ask => ({ topic: 'How strong it is', why, importance: imp, question: `How strong is the ${what} now?`, format: 'choice', options: SEV_OPTS, refs, known: attrKnown('severity') });
const onset = (what: string): Ask => ({ topic: 'When it started', why: 'Timing helps decide how quickly it needs to be seen.', importance: 'medium', question: `When did the ${what} start?`, format: 'choice', options: ONSET_OPTS, refs: [], known: attrKnown('onset') });

const PLAN: Record<string, (Ask & { key: string })[]> = {
  headache: [
    { key: 'onset_type', ...onsetType('headache', 'A headache that comes on suddenly and is extremely painful is an emergency sign.', ['nhs_headache']) },
    { key: 'severity', ...severity('headache', 'Sudden severe headache needs emergency care; strength also guides urgency.', ['nhs_headache'], 'high') },
    { key: 'neuro', topic: 'Trouble speaking, weakness or numbness', why: 'Headache with difficulty speaking, weakness or numbness needs emergency care.', importance: 'high', question: 'Along with the headache, do you have trouble speaking, weakness, or numbness in your face, arm or leg?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_headache', 'nhs_stroke'], known: symKnown(['speech', 'weakness', 'numbness']) },
    { key: 'fever_neck', topic: 'Fever or a stiff neck', why: 'Headache with a high temperature and a stiff neck needs emergency care.', importance: 'high', question: 'Do you have a fever or a stiff neck?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_headache', 'nhs_meningitis'], known: symKnown(['fever', 'stiff_neck']) },
    { key: 'vision_vomit', topic: 'Vision problems or vomiting', why: 'Headache with vision problems or vomiting needs urgent review.', importance: 'medium', question: 'Do you have vision problems or vomiting with the headache?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_headache'], known: symKnown(['vision', 'vomiting']) },
    { key: 'onset', ...onset('headache') },
  ],
  chest_pain: [
    { key: 'assoc', topic: 'Breathlessness, sweating, nausea or light-headedness', why: 'Chest pain with any of these needs emergency care.', importance: 'high', question: 'With the chest pain, do you have trouble breathing, sweating, nausea or dizziness?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_chest_pain'], known: symKnown(['breathing', 'sweating', 'nausea', 'dizziness']) },
    { key: 'radiation', topic: 'Spread to the arm, jaw, neck or back', why: 'Chest pain spreading to the arm, neck, jaw or back needs emergency care.', importance: 'high', question: 'Does the chest pain spread to your arm, jaw, neck or back?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_chest_pain'], known: (c) => (textHit(c, 'radiating') || c.clarified.has('chest_pain:radiation') ? 'known' : 'unknown') },
    { key: 'onset_type', ...onsetType('chest pain', 'Sudden chest pain that does not go away needs emergency care.', ['nhs_chest_pain']) },
    { key: 'severity', ...severity('chest pain', 'Strength guides urgency.', ['nhs_chest_pain']) },
  ],
  abdominal_pain: [
    { key: 'onset_type', ...onsetType('stomach pain', 'Stomach pain that came on suddenly or is severe needs emergency care.', ['nhs_stomach']) },
    { key: 'severity', ...severity('stomach pain', 'Severe stomach pain needs emergency care.', ['nhs_stomach'], 'high') },
    { key: 'blood', topic: 'Blood in vomit or stool', why: 'Vomiting blood or bloody/black stool needs emergency care.', importance: 'high', question: 'Have you vomited blood, or had bloody or black stool?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_stomach'], known: (c) => (textHit(c, 'gi_blood') || c.clarified.has('abdominal_pain:blood') ? 'known' : 'unknown') },
    { key: 'fever', topic: 'Fever or vomiting', why: 'Helps judge how unwell the patient is.', importance: 'medium', question: 'Do you have a fever or vomiting?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: [], known: symKnown(['fever', 'vomiting']) },
  ],
  breathing: [
    { key: 'severity', ...severity('breathing difficulty', 'Severe breathing difficulty (e.g. unable to speak in full sentences) needs emergency care.', ['nhs_breathless'], 'high') },
    { key: 'chest', topic: 'Chest pain or tightness', why: 'Breathlessness with chest tightness needs emergency care.', importance: 'high', question: 'Do you have chest pain or tightness?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_breathless'], known: symKnown(['chest_pain']) },
    { key: 'onset', ...onset('breathing difficulty') },
  ],
  fever: [
    { key: 'onset', ...onset('fever') },
    { key: 'red', topic: 'Breathing difficulty, confusion or a rash', why: 'Fever with fast breathing, confusion or a non-fading rash can be sepsis or meningitis.', importance: 'high', question: 'With the fever, do you have trouble breathing, confusion, or a rash?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_sepsis', 'nhs_meningitis'], known: symKnown(['breathing', 'rash']) },
  ],
  speech: [
    { key: 'onset_type', ...onsetType('trouble speaking', 'New, sudden speech difficulty is a stroke warning sign. Long-standing difficulty may be part of how this patient communicates.', ['nhs_stroke']) },
    { key: 'onset', ...onset('trouble speaking') },
  ],
  weakness: [
    { key: 'onset_type', ...onsetType('weakness', 'Sudden weakness, especially on one side, is a stroke warning sign.', ['nhs_stroke']) },
    { key: 'side', topic: 'Which side', why: 'One-sided weakness is a stroke warning sign.', importance: 'medium', question: 'Is the weakness on one side of your body, or both?', format: 'choice', options: ['Left side', 'Right side', 'Both sides', 'Not sure'], refs: ['nhs_stroke'], known: attrKnown('side') },
  ],
  numbness: [
    { key: 'onset_type', ...onsetType('numbness', 'Sudden numbness, especially on one side, is a stroke warning sign.', ['nhs_stroke']) },
  ],
  vision: [{ key: 'onset_type', ...onsetType('vision problem', 'Sudden loss of vision needs emergency care.', ['nhs_headache']) }],
  dizziness: [{ key: 'fainting', topic: 'Fainting', why: 'Fainting changes the urgency.', importance: 'medium', question: 'Have you fainted?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_fainting'], known: symKnown(['fainting']) }],
  fainting: [{ key: 'chest', topic: 'Chest pain or irregular heartbeat', why: 'Fainting with chest pain or an irregular heartbeat needs emergency care.', importance: 'high', question: 'Did you have chest pain or a racing or irregular heartbeat?', format: 'yes_no', options: ['Yes', 'No', 'Not sure'], refs: ['nhs_fainting'], known: (c) => (sym(c, 'chest_pain') || textHit(c, 'palpitations') || c.clarified.has('fainting:chest') ? 'known' : 'unknown') }],
};
const GENERIC: (Ask & { key: string })[] = [
  { key: 'onset', ...onset('problem') },
  { key: 'severity', topic: 'How strong it is', why: 'Strength guides urgency.', importance: 'medium', question: 'How strong is it now?', format: 'choice', options: SEV_OPTS, refs: [], known: attrKnown('severity') },
];

/** Medication-safety information: asked for only when the doctor considers treatment (never asked of every patient up front). */
export const TREATMENT_ASKS: { key: keyof import('../../domain/clinical').Documented; topic: string; question: string; format: MissingItem['format']; options?: string[]; why: string }[] = [
  { key: 'allergies', topic: 'Allergies to medicines', question: 'Are you allergic to any medicines? If yes, which ones?', format: 'text', why: 'Needed before any medicine is considered.' },
  { key: 'medications', topic: 'Medicines taken now', question: 'Which medicines do you take now (including over-the-counter and herbal)? If none, say “none”.', format: 'text', why: 'Needed to check interactions.' },
  { key: 'age', topic: 'Age', question: 'How old are you?', format: 'text', why: 'Many medicines depend on age.' },
];

export function missing(c: Case): MissingItem[] {
  const out: MissingItem[] = [];
  const statusOf = (id: string, k: 'known' | 'unsure' | 'unknown'): MissingItem['status'] | null =>
    c.clarified.has(id) ? (/^not sure$/i.test(c.clarified.get(id)!.answer) ? 'unsure' : null) : k === 'known' ? null : c.asked.has(id) ? 'asked' : k === 'unsure' ? 'unsure' : 'missing';
  const seen = new Set<string>();
  for (const s of c.symptoms.filter((x) => x.concept !== 'unwell')) {
    const plan = PLAN[s.concept] ?? GENERIC;
    for (const a of plan) {
      const id = `${s.concept}:${a.key}`;
      const st = statusOf(id, a.known(c, s));
      if (!st || seen.has(a.question)) continue;
      seen.add(a.question);
      out.push({ id, topic: a.topic, why: a.why, importance: a.importance, for: conceptLabel(s.concept), status: st, question: a.question, format: a.format, ...(a.options ? { options: a.options } : {}), refs: a.refs });
    }
  }
  return out.sort((a, b) => (a.importance === b.importance ? 0 : a.importance === 'high' ? -1 : 1));
}

/** Treatment-relevant information that is not documented yet (for the medication section). */
export function treatmentGaps(c: Case): MissingItem[] {
  const d = c.documented;
  const unknown = (k: string) => (k === 'allergies' ? d.allergies.status === 'unknown' : k === 'medications' ? d.medications.status === 'unknown' : k === 'age' ? !d.age : false);
  return TREATMENT_ASKS.filter((t) => unknown(t.key)).map((t) => {
    const id = `doc:${t.key}`;
    const ans = c.clarified.get(id);
    return { id, topic: t.topic, why: t.why, importance: 'high' as const, for: 'treatment', status: ans ? 'answered' as const : c.asked.has(id) ? 'asked' as const : 'missing' as const, question: t.question, format: t.format, refs: [] };
  });
}

// ---------------------------------------------------------------- conflicts
export function conflicts(c: Case): ClinicalConflict[] {
  const out: ClinicalConflict[] = c.conflicts.map((k, i) => ({ id: `K${i + 1}`, ...k }));
  for (const s of c.symptoms) {
    const v = val(s, 'severity'); const n = v && /^\d+$/.test(v) ? Number(v) : null;
    if (n !== null && s.unsure.has('severity')) out.push({ id: `K${out.length + 1}`, description: `${conceptLabel(s.concept)}: a strength of ${n}/10 was given, but the patient also said they were not sure.`, evidence: ev(s, 'severity'), status: 'open' });
  }
  for (const [concept, fid] of c.denied) {
    const s = sym(c, concept);
    if (s) out.push({ id: `K${out.length + 1}`, description: `${conceptLabel(concept)} was reported and also denied.`, evidence: [s.factId, fid], status: 'open' });
  }
  // a later answer that disagrees with the report
  for (const [mid, a] of c.clarified) {
    const [concept, topic] = mid.split(':');
    const s = sym(c, concept);
    const before = s?.attrs[topic];
    if (s && before && before.factId !== a.factId && /^(sudden|gradual|mild|moderate|severe|today|days|week|longer)$/.test(before.value)) {
      const ans = a.answer.toLowerCase();
      if (!ans.startsWith(before.value.slice(0, 4))) out.push({ id: `K${out.length + 1}`, description: `${conceptLabel(concept)} — ${topic.replace('_', ' ')}: the report said “${before.value}”, the later answer was “${a.answer}”.`, evidence: [before.factId, a.factId], status: 'open' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- next steps that follow from the rules
export function ruleSteps(ws: ClinicalWarning[], miss: MissingItem[]): NextStep[] {
  const out: NextStep[] = [];
  const em = ws.filter((w) => w.level === 'emergency');
  if (em.length) out.push({ id: 'R1', kind: 'other', text: 'Contact the patient now and advise emergency care.', why: `Emergency warning: ${em.map((w) => w.title.toLowerCase()).join('; ')}.`, supporting: [...new Set(em.flatMap((w) => w.evidence))], refs: [...new Set(em.flatMap((w) => w.refs))], by: 'rules' });
  for (const m of miss.filter((x) => x.importance === 'high' && x.status !== 'asked').slice(0, 3)) {
    out.push({ id: `R${out.length + 1}`, kind: 'question', text: m.question, why: m.why, supporting: [], refs: m.refs, by: 'rules' });
  }
  return out;
}
