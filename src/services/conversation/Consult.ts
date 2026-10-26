// AccessCare conversation manager (UI-independent, testable).
//
// The patient talks (or signs, types, taps, points on the body map); every
// input updates ONE record of what they told us. The next question is chosen
// from what is still missing for the symptoms they actually reported — a
// headache gets questions about the head, never a list of unrelated body areas.
//
// Two ways to understand an answer:
//   • AI (Claude, when the patient turned it on): understands free wording and
//     dialect, writes an empathetic reply and the next question. Its output is
//     validated (allowed values only, quotes checked against the patient's words,
//     no diagnosis or false reassurance) — see ai.ts.
//   • Rules (always available, and used whenever the AI is off or fails): the
//     English/Arabic vocabulary in lexicon.ts.
// Safety rules run on every message first and can never be removed by AI.

import type { ConsultLang, ConsultRecord, Complaint, Fact, Pending, SlotId, Via, RegionFact } from '../../domain/conversation';
import { REGION_BY_ID } from '../../domain/bodyRegions';
import {
  BODY, CONCEPTS, CONCEPT_BY_ID, CUES, LOCATIONS, ONSET, ONSET_TYPE, PATTERN, SENSATIONS, SEVERITY, SIDE,
  findAny, negatedAt, norm, tokensOf, misspelledConcept, misspelledBody, type AreaId, type Concept, type ValueWord,
} from './lexicon';

export type ConsultInput =
  | { kind: 'text'; text: string; via: Via }
  | { kind: 'option'; id: string; label: string; via: Via }
  | { kind: 'regions'; ids: string[]; via: Via };

export interface ConsultTurn {
  rec: ConsultRecord;
  say: string[];
  options: { id: string; label: string }[];
  /** urgent-help reasons found in this turn (show emergency guidance now) */
  urgent: string[];
  /** everything needed has been asked: read the summary for approval */
  review: boolean;
  /** this turn's wording/understanding came from the AI */
  ai: boolean;
}

const L = (lang: ConsultLang, en: string, ar: string) => (lang === 'ar' ? ar : en);
const clone = (r: ConsultRecord): ConsultRecord => JSON.parse(JSON.stringify(r));

export function newRecord(lang: ConsultLang): ConsultRecord {
  return { v: 1, lang, complaints: [], denied: [], notes: [], corrections: [], urgent: [], turns: [], pending: null, misses: 0, ai: { used: 0, failed: 0 }, anythingElseAsked: false };
}

/** Detects Arabic vs English from the patient's words (null when unclear). */
export function detectLang(text: string): ConsultLang | null {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return null;
  return ar >= en ? 'ar' : 'en';
}

// ---------------------------------------------------------------- understanding (rules)
export interface Hit<T = string> { value: T; quote: string; index: number }
export interface Understanding {
  /** misspelled: found by spelling similarity — an interpretation to confirm */
  concepts: (Hit & { negated: boolean; misspelled?: boolean })[];
  greeting: boolean;
  body: (Hit & { sided: boolean; area: AreaId; detail?: string; misspelled?: boolean })[];
  severity?: Hit; number?: Hit<number>; onset?: Hit; onsetType?: Hit; pattern?: Hit; sensation?: Hit; side?: Hit;
  notSure: boolean; cantDescribe: boolean; fear: boolean; pause: boolean; stop: boolean; speakingHard: boolean;
  correction: boolean; yes: boolean; no: boolean; nothingElse: boolean; question: boolean;
}

function origTokens(text: string): string[] {
  return text.replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
}
function quoteOf(text: string, index: number, form: string): string {
  const n = norm(form).split(' ').length;
  return origTokens(text).slice(index, index + n).join(' ');
}
function valueHit(text: string, toks: string[], list: ValueWord[]): Hit | undefined {
  let best: (Hit & { len: number }) | undefined;
  for (const v of list) {
    const h = findAny(toks, v.words);
    if (h && !negatedAt(toks, h.index) && (!best || h.length > best.len)) best = { value: v.value, quote: quoteOf(text, h.index, h.form), index: h.index, len: h.length };
  }
  return best && { value: best.value, quote: best.quote, index: best.index };
}

export function understand(text: string): Understanding {
  const toks = tokensOf(text);
  const has = (forms: string[]) => !!findAny(toks, forms);
  // symptoms: specific ones first; generic "pain"/"unwell" only where no specific symptom covers the words
  const concepts: Understanding['concepts'] = [];
  const covered = new Set<number>();
  for (const c of CONCEPTS) {
    if (c.id === 'pain' || c.id === 'unwell') continue;
    const h = findAny(toks, c.words);
    if (!h) continue;
    const n = norm(h.form).split(' ').length;
    for (let k = h.index; k < h.index + n; k++) covered.add(k);
    concepts.push({ value: c.id, quote: quoteOf(text, h.index, h.form), index: h.index, negated: negatedAt(toks, h.index) });
  }
  for (const m of misspelledConcept(toks, covered)) if (!concepts.some((x) => x.value === m.id)) {
    for (let k = m.index; k < m.index + 1; k++) covered.add(k);
    concepts.push({ value: m.id, quote: origTokens(text)[m.index] ?? m.token, index: m.index, negated: negatedAt(toks, m.index), misspelled: true });
  }
  for (const id of ['pain', 'unwell']) {
    const h = findAny(toks, CONCEPT_BY_ID[id].words);
    if (h && !covered.has(h.index)) concepts.push({ value: id, quote: quoteOf(text, h.index, h.form), index: h.index, negated: negatedAt(toks, h.index) });
  }
  const greeting = /^(hi|hello|hey|hiya|good (morning|afternoon|evening)|greetings|salam|marhaba)( there| doctor| doc)?[!. ]*$/i.test(text.trim())
    || /^(اهلا|أهلا|اهلين|مرحبا|هاي|هالو|السلام عليكم|سلام عليكم|سلام|ازيك|إزيك|صباح الخير|مساء الخير)( يا دكتور| يا دكتوره)?[!.؟ ]*$/.test(text.trim());
  // body parts (several allowed: "from my neck to my head")
  const body: Understanding['body'] = [];
  const bodyCovered = new Set<number>();
  const bodyHits = BODY.map((b) => ({ b, h: findAny(toks, b.words) })).filter((x) => x.h).sort((a, z) => z.h!.length - a.h!.length);
  for (const { b, h } of bodyHits) {
    if (bodyCovered.has(h!.index)) continue;
    const n = norm(h!.form).split(' ').length;
    for (let k = h!.index; k < h!.index + n; k++) bodyCovered.add(k);
    body.push({ value: b.region, quote: quoteOf(text, h!.index, h!.form), index: h!.index, sided: !!b.sided, area: b.area, detail: b.detail });
  }
  for (const m of misspelledBody(toks)) if (!bodyCovered.has(m.index) && !body.some((b) => b.value === m.word.region)) {
    body.push({ value: m.word.region, quote: origTokens(text)[m.index] ?? m.token, index: m.index, sided: !!m.word.sided, area: m.word.area, detail: m.word.detail, misspelled: true });
  }
  body.sort((a, z) => a.index - z.index);
  // numbers as strength: "7 out of 10", "٨ من ١٠", "seven"
  let number: Hit<number> | undefined;
  const nm = norm(text).match(/\b(10|[0-9])\s*(out of|من|\/)\s*(10|عشره)\b/) ?? norm(text).match(/^(10|[0-9])$/);
  if (nm) number = { value: Number(nm[1]), quote: nm[0], index: 0 };
  const sev = valueHit(text, toks, SEVERITY);
  return {
    concepts, body, number, greeting,
    severity: sev, onset: valueHit(text, toks, ONSET), onsetType: valueHit(text, toks, ONSET_TYPE), pattern: valueHit(text, toks, PATTERN),
    sensation: valueHit(text, toks, SENSATIONS), side: valueHit(text, toks, SIDE),
    notSure: has(CUES.notSure) && !has(CUES.cantDescribe), cantDescribe: has(CUES.cantDescribe), fear: has(CUES.fear), pause: has(CUES.pause), stop: has(CUES.stop),
    speakingHard: has(CUES.speakingHard), correction: has(CUES.correction), yes: has(CUES.yes), no: has(CUES.no), nothingElse: has(CUES.nothingElse),
    question: /[?؟]\s*$/.test(text.trim()) || CUES.questionStart.some((q) => norm(text).startsWith(norm(q))),
  };
}

// ---------------------------------------------------------------- labels
const label = (c: Complaint, lang: ConsultLang) => (lang === 'ar' ? c.ar : c.en);
function regionWords(ids: string[], lang: ConsultLang): string {
  const ar: Record<string, string> = { head: 'الراس', face: 'الوش', neck: 'الرقبة', chest: 'الصدر', abdomen: 'البطن', upper_back: 'الضهر من فوق', lower_back: 'الضهر من تحت', shoulder: 'الكتف', upper_arm: 'الدراع', elbow: 'الكوع', forearm: 'الساعد', wrist: 'الرسغ', hand: 'الإيد', hip: 'الورك', thigh: 'الفخد', knee: 'الركبة', lower_leg: 'الساق', ankle: 'الكاحل', foot: 'القدم' };
  return ids.map((id) => {
    const base = id.replace(/_(l|r)$/, ''); const side = id.endsWith('_l') ? 'l' : id.endsWith('_r') ? 'r' : '';
    if (lang === 'en') return (REGION_BY_ID[id]?.label ?? base.replace('_', ' ')).toLowerCase();
    return `${ar[base] ?? base}${side === 'l' ? ' الشمال' : side === 'r' ? ' اليمين' : ''}`;
  }).join(lang === 'ar' ? ' و' : ' and ');
}
function painLabel(regions: string[]): { en: string; ar: string } {
  return regions.length ? { en: `pain in the ${regionWords(regions, 'en')}`, ar: `وجع في ${regionWords(regions, 'ar')}` } : { en: 'pain', ar: 'وجع' };
}
const valueWord = (list: ValueWord[], v: string) => list.find((x) => x.value === v);
function factFrom(list: ValueWord[], value: string, quote: string | undefined, prov: Fact['prov'], by: Fact['by'], via: Via): Fact {
  const w = valueWord(list, value);
  return { value, en: w?.en ?? value, ar: w?.ar ?? value, ...(quote ? { quote } : {}), prov, by, via, confirmed: prov !== 'inferred' };
}
function sevFact(v: string, quote: string | undefined, prov: Fact['prov'], by: Fact['by'], via: Via): Fact {
  if (/^\d+$/.test(v)) return { value: v, en: `${v} out of 10`, ar: `${v} من 10`, ...(quote ? { quote } : {}), prov, by, via, confirmed: prov !== 'inferred' };
  return factFrom(SEVERITY, v, quote, prov, by, via);
}
function areaOf(c: Complaint): AreaId | undefined {
  const k = CONCEPT_BY_ID[c.concept];
  if (k?.area && k.area !== 'general') return k.area;
  const r = c.regions[0]?.id.replace(/_(l|r)$/, '');
  return BODY.find((b) => b.region === r)?.area;
}

// ---------------------------------------------------------------- record updates
function addComplaint(rec: ConsultRecord, concept: string, quote: string, via: Via, prov: Complaint['prov'], by: Fact['by'], extra: Partial<Complaint> = {}): Complaint {
  const k = CONCEPT_BY_ID[concept];
  const id = `c${Math.max(0, ...rec.complaints.map((x) => Number(x.id.slice(1)) || 0)) + 1}`;
  const c: Complaint = {
    id, concept, en: k?.en ?? concept, ar: k?.ar ?? concept, quote, via, prov, confirmed: prov !== 'inferred',
    regions: (k?.regions ?? []).map((r) => ({ id: r, quote, prov, by, via, confirmed: prov !== 'inferred' })),
    facts: {}, unknown: [], asked: [], ...extra,
  };
  if (k?.sensation) c.facts.sensation = factFrom(SENSATIONS, k.sensation, quote, prov, by, via);
  rec.complaints.push(c);
  return c;
}

/** Sets a fact; a different existing value is replaced only when the patient corrects it — otherwise the conflict is returned. */
function setFact(rec: ConsultRecord, c: Complaint, slot: SlotId, f: Fact, isCorrection: boolean): { conflict?: { old: Fact; next: Fact } } {
  const old = c.facts[slot];
  if (old && old.value !== f.value && !isCorrection) return { conflict: { old, next: f } };
  if (old && old.value !== f.value) rec.corrections.push({ complaint: c.id, field: slot, from: old.en, to: f.en, ...(f.quote ? { quote: f.quote } : {}), by: 'patient' });
  c.facts[slot] = f;
  c.unknown = c.unknown.filter((s) => s !== slot);
  return {};
}

export function addRegions(c: Complaint, ids: string[], quote: string | undefined, prov: RegionFact['prov'], by: RegionFact['by'], via: Via) {
  for (const id of ids) if ((REGION_BY_ID[id] || BODY.some((b) => b.region === id)) && !c.regions.some((r) => r.id === id)) c.regions.push({ id, ...(quote ? { quote } : {}), prov, by, via, confirmed: prov !== 'inferred' });
  // a sided region replaces the same region without a side ("abdomen" → "abdomen_r")
  const bases = new Set(c.regions.filter((r) => /_(l|r)$/.test(r.id)).map((r) => r.id.replace(/_(l|r)$/, '')));
  c.regions = c.regions.filter((r) => !bases.has(r.id));
  if (c.concept === 'pain') { const l = painLabel(c.regions.map((r) => r.id)); c.en = l.en; c.ar = l.ar; }
}

export const sidedIds = (base: string, side: string): string[] => (side === 'both' ? [`${base}_l`, `${base}_r`] : [`${base}_${side === 'left' ? 'l' : 'r'}`]);
const needsSide = (c: Complaint) => c.regions.some((r) => BODY.some((b) => b.region === r.id && b.sided));

// ---------------------------------------------------------------- safety
const URGENT_TEXT = {
  en: 'This could need urgent medical help. Please call your local emergency number now, or ask someone near you to call. Do not wait for a reply in this app. In the UAE call 998. In Egypt call 123.',
  ar: 'ده ممكن يحتاج مساعدة طبية عاجلة. اتصل بالطوارئ دلوقتي، أو اطلب من حد جنبك يتصل. ماتستناش رد في التطبيق. في الإمارات اتصل بـ ٩٩٨، وفي مصر بـ ١٢٣.',
};
export function urgentText(lang: ConsultLang) { return URGENT_TEXT[lang]; }

const SAFETY_RE: { re: RegExp; reason: string }[] = [
  { re: /chest.{0,16}(pain|pressure|tight|heavy|hurt|squeez)|pressure in (my )?chest|tight(ness)? in (my )?chest/i, reason: 'chest pain or pressure' },
  { re: /can'?t breathe|cannot breathe|hard to breathe|short(ness)? of breath|struggling to breathe/i, reason: 'difficulty breathing' },
  { re: /fainted|passed out|unconscious|blacked out/i, reason: 'fainting' },
  { re: /droop|slurred|face (is )?(drooping|numb)/i, reason: 'face or speech changes' },
  { re: /worst headache|thunderclap|sudden(ly)? (very )?(severe|bad|terrible) headache/i, reason: 'a sudden, very severe headache' },
  { re: /suicid|kill myself|end my life|hurt myself/i, reason: 'thoughts of self-harm' },
  { re: /(bleeding|blood).{0,20}(won'?t stop|a lot|heavy)|heavy bleeding|vomiting blood|coughing (up )?blood/i, reason: 'heavy bleeding' },
  { re: /(الم|وجع|ضغط|تقل|تقلل)\s*(في\s*|على\s*)?(صدري|الصدر)|صدري\s*(بيوجعني|وجعاني|مقبوض|تقيل)/, reason: 'chest pain or pressure' },
  { re: /(مش|ما)\s*(قادر|قادره|بقدرش|عارف|عارفه)\s*(ا)?تنفس|صعوب[هة]\s*(في\s*)?(التنفس|النفس)|ضيق\s*(في\s*)?(التنفس|النفس)|نفسي\s*(مقطوع|بيتقطع)|مخنوق|بتخنق/, reason: 'difficulty breathing' },
  { re: /(اغمي|اتغمي|اغمى)\s*(عليا|علي|عليه)|فقدت\s*الوعي|وقعت\s*من\s*طولي/, reason: 'fainting' },
  { re: /لساني\s*(تقيل|تقل)|وشي\s*(مايل|معوج|معووج)|نص\s*(جسمي|وشي)\s*(مش|منمل|تقيل)/, reason: 'face or speech changes' },
  { re: /(صداع|راسي|دماغي).{0,25}(فجاه|فجأه|مره واحده).{0,25}(جامد|شديد|مش مستحمل|فظيع)|(صداع|راسي|دماغي).{0,25}(جامد|شديد|مش مستحمل|فظيع).{0,25}(فجاه|فجأه|مره واحده)|اسوا صداع|أسوأ صداع/, reason: 'a sudden, very severe headache' },
  { re: /(ا|أ)نتحر|(ا|أ)قتل\s*نفسي|(عايز|عايزه)\s*(ا|أ)موت|أريد\s*أن\s*أموت|(ا|أ)ذي\s*نفسي/, reason: 'thoughts of self-harm' },
  { re: /(نزيف|دم).{0,20}(مش\s*بيقف|كتير|جامد)|برجع\s*دم|بكح\s*دم/, reason: 'heavy bleeding' },
];

/** Rules decide; AI can only add reasons. Structured checks cover answers given by touch or signs too. */
export function safetyCheck(rec: ConsultRecord, text: string): string[] {
  const t = norm(text);
  const reasons: string[] = [];
  for (const k of SAFETY_RE) if (k.re.test(text) || k.re.test(t)) reasons.push(k.reason);
  for (const c of rec.complaints) {
    if (c.concept === 'chest_pain' || (c.concept === 'pain' && c.confirmed && c.regions.some((r) => r.id === 'chest' && r.confirmed))) reasons.push('chest pain or pressure');
    if (c.concept === 'breathing' && c.facts.severity?.value !== 'mild') reasons.push('difficulty breathing');
    if (c.concept === 'fainting') reasons.push('fainting');
    if (c.concept === 'headache' && c.facts.onset_type?.value === 'sudden' && (c.facts.severity?.value === 'severe' || Number(c.facts.severity?.value) >= 8)) reasons.push('a sudden, very severe headache');
    if ((c.concept === 'weakness' || c.concept === 'numbness' || c.concept === 'vision') && c.facts.onset_type?.value === 'sudden') reasons.push('sudden weakness, numbness or vision change');
    // new trouble speaking is a stroke warning sign (NHS: FAST) — unless the patient said it built up gradually or is long-standing
    if (c.concept === 'speech' && c.facts.onset_type?.value !== 'gradual' && c.facts.onset?.value !== 'longer') reasons.push('new trouble speaking');
    if (c.concept === 'headache' && rec.complaints.some((x) => ['speech', 'weakness', 'numbness'].includes(x.concept) && x.facts.onset_type?.value !== 'gradual' && x.facts.onset?.value !== 'longer')) reasons.push('headache with trouble speaking, weakness or numbness');
    if (c.concept === 'headache' && rec.complaints.some((x) => x.concept === 'stiff_neck') && rec.complaints.some((x) => x.concept === 'fever')) reasons.push('headache with fever and a stiff neck');
  }
  return [...new Set(reasons)].filter((r) => !rec.urgent.includes(r));
}

// ---------------------------------------------------------------- questions
function opt(id: string, en: string, ar: string, lang: ConsultLang) { return { id, label: L(lang, en, ar) }; }
const notSureOpt = (lang: ConsultLang) => opt('ns', 'Not sure', 'مش متأكد', lang);

export function openingQuestion(lang: ConsultLang, simpler = false): Pending {
  const ids = ['headache', 'abdominal_pain', 'dizziness', 'fever', 'cough', 'breathing', 'chest_pain', 'pain'];
  return {
    kind: 'opening',
    text: simpler ? L(lang, 'That is okay. You can pick what is closest, or show me where on the body map.', 'ولا يهمك. اختار الأقرب من دول، أو وريني المكان على صورة الجسم.')
      : L(lang, 'What is bothering you today? Tell me in your own words — there is no right or wrong way to say it.', 'إيه اللي تاعبك النهارده؟ احكيلي بكلامك، مفيش طريقة صح وطريقة غلط.'),
    options: [...ids.map((id) => opt(`concept:${id}`, cap(CONCEPT_BY_ID[id].en), CONCEPT_BY_ID[id].ar, lang)), opt('concept:unwell', 'Something else', 'حاجة تانية', lang)],
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function slotQuestion(rec: ConsultRecord, c: Complaint, slot: SlotId): Pending | null {
  const lang = rec.lang; const lab = label(c, lang); const area = areaOf(c);
  const base = { kind: 'slot' as const, complaint: c.id, slot };
  const ns = notSureOpt(lang);
  switch (slot) {
    case 'onset': return { ...base, text: L(lang, `When did the ${lab} start?`, `بدأت تحس بـ${lab} إمتى؟`), options: [...ONSET.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), ns] };
    case 'onset_type': {
      const why = c.concept === 'headache' ? L(lang, ' I ask because a headache that starts very suddenly needs quick attention.', ' بسأل علشان الصداع اللي بييجي فجأة جامد محتاج اهتمام بسرعة.')
        : (c.concept === 'weakness' || c.concept === 'numbness' || c.concept === 'vision' || c.concept === 'speech') ? L(lang, ' I ask because sudden changes like this need quick attention.', ' بسأل علشان التغيير المفاجئ ده محتاج اهتمام بسرعة.') : '';
      return { ...base, text: L(lang, `Did it start suddenly, or build up gradually?${why}`, `جه فجأة، ولا زاد بالتدريج؟${why}`), options: [...ONSET_TYPE.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), ns] };
    }
    case 'location': {
      if (!c.regions.length && (!area || area === 'general')) {
        // where is it? choose an area (then the body map can refine it)
        const areas: [string, string, string][] = [['head', 'Head', 'الراس'], ['neck', 'Neck or throat', 'الرقبة أو الزور'], ['chest', 'Chest', 'الصدر'], ['abdomen', 'Belly', 'البطن'], ['upper_back', 'Back', 'الضهر'], ['arm', 'Arm or hand', 'الدراع أو الإيد'], ['leg', 'Leg or foot', 'الرجل أو القدم']];
        return { ...base, text: L(lang, `Where do you feel the ${lab}? You can also show me on the body map.`, `بتحس بـ${lab} فين؟ وممكن توريني على صورة الجسم.`), options: [...areas.map(([id, en, ar]) => opt(`area:${id}`, en, ar, lang)), ns] };
      }
      const locs = area ? LOCATIONS[area] : undefined;
      if (!locs) return null;
      const q = area === 'head' ? L(lang, 'Where in your head do you feel it most?', 'بتحس بيه في أنهي حتة من راسك أكتر؟')
        : area === 'abdomen' ? L(lang, 'Which part of your belly hurts most?', 'أنهي حتة في بطنك بتوجعك أكتر؟')
        : area === 'chest' ? L(lang, 'Where in your chest is it?', 'في أنهي حتة من صدرك؟') : L(lang, 'Which part of your back?', 'أنهي حتة من ضهرك؟');
      return { ...base, text: q, options: [...locs.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), opt('v:other', 'Somewhere else', 'مكان تاني', lang), ns] };
    }
    case 'side': return { ...base, text: L(lang, 'Is it on your left side, your right side, or both?', 'في الناحية الشمال، ولا اليمين، ولا الاتنين؟'), options: [...SIDE.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), ns] };
    case 'sensation': return { ...base, text: L(lang, `What does it feel like?`, 'إحساسه عامل إزاي؟'), options: [...SENSATIONS.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), opt('v:other', 'Something else', 'حاجة تانية', lang), ns] };
    case 'severity': return { ...base, text: L(lang, 'How strong is it right now — mild, moderate, or severe? You can also give a number from 0 to 10.', 'قد إيه شديد دلوقتي: خفيف، متوسط، ولا شديد؟ وممكن تقول رقم من صفر لعشرة.'), options: [...SEVERITY.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), ns] };
    case 'pattern': return { ...base, text: L(lang, 'Is it there all the time, or does it come and go?', 'موجود على طول، ولا بييجي ويروح؟'), options: [...PATTERN.map((o) => opt(`v:${o.value}`, cap(o.en), o.ar, lang)), ns] };
    case 'associated': {
      const rel = (CONCEPT_BY_ID[c.concept]?.related ?? []).filter((id) => !rec.complaints.some((x) => x.concept === id) && !rec.denied.includes(id));
      if (!rel.length) return null;
      const names = rel.map((id) => L(lang, CONCEPT_BY_ID[id].en, CONCEPT_BY_ID[id].ar));
      return { ...base, text: L(lang, `Along with the ${lab}, do you have any of these: ${names.join(', ')}? Or none of them?`, `مع ${lab}، عندك أي حاجة من دول: ${names.join('، ')}؟ ولا مفيش؟`),
        options: [...rel.map((id) => opt(`assoc:${id}`, cap(CONCEPT_BY_ID[id].en), CONCEPT_BY_ID[id].ar, lang)), opt('assoc:none', 'None of these', 'ولا حاجة من دول', lang), ns] };
    }
  }
  return null;
}

/** Slots still worth asking for a complaint, in its own order. */
function openSlots(rec: ConsultRecord, c: Complaint): SlotId[] {
  const k = CONCEPT_BY_ID[c.concept];
  let plan: SlotId[] = c.with ? ['onset'] : [...(k?.plan ?? ['onset', 'severity'])];
  if (needsSide(c) && !plan.includes('side') && areaOf(c) !== 'abdomen') plan.unshift('side');
  if (areaOf(c) === 'abdomen') plan = plan.filter((s) => s !== 'side');
  if (!needsSide(c) && c.concept !== 'numbness' && c.concept !== 'weakness') plan = plan.filter((s) => s !== 'side');
  if (c.concept === 'pain' && c.regions.length) plan = plan.filter((s) => s !== 'location' || ['head', 'abdomen', 'chest', 'back'].includes(areaOf(c) ?? ''));
  return plan.filter((s) => !c.facts[s] && !c.unknown.includes(s) && !c.asked.includes(s) && (s !== 'side' || !c.regions.some((r) => /_(l|r)$/.test(r.id)) || ['numbness', 'weakness'].includes(c.concept)));
}

export function nextQuestion(rec: ConsultRecord): Pending | null {
  const lang = rec.lang;
  if (!rec.complaints.length) return openingQuestion(lang, rec.misses > 0);
  // unconfirmed interpretations are checked with the patient first
  for (const c of rec.complaints) {
    if (c.prov === 'inferred' && !c.confirmed) return { kind: 'confirm', complaint: c.id, text: L(lang, `Did you mean ${enA(c)}?`, `قصدك ${label(c, 'ar')}؟`), options: [opt('yes', 'Yes', 'أيوه', lang), opt('no', 'No', 'لأ', lang)] };
    const ir = c.regions.find((r) => r.prov === 'inferred' && !r.confirmed);
    if (ir) return { kind: 'confirm', complaint: c.id, value: `region:${ir.id}`, text: L(lang, `I understood that it is in the ${regionWords([ir.id], 'en')}. Is that right?`, `فهمت إنه في ${regionWords([ir.id], 'ar')}. صح كده؟`), options: [opt('yes', 'Yes', 'أيوه', lang), opt('no', 'No', 'لأ', lang)] };
    for (const [slot, f] of Object.entries(c.facts) as [SlotId, Fact][]) {
      if (f.prov === 'inferred' && !f.confirmed) return { kind: 'confirm', complaint: c.id, slot, value: f.value, text: L(lang, `About the ${label(c, 'en')}: I understood "${f.en}". Is that right?`, `بالنسبة لـ${label(c, 'ar')}: فهمت "${f.ar}". صح كده؟`), options: [opt('yes', 'Yes', 'أيوه', lang), opt('no', 'No', 'لأ', lang)] };
    }
  }
  const real = rec.complaints.filter((c) => c.concept !== 'unwell');
  const vague = rec.complaints.find((c) => c.concept === 'unwell' && !c.asked.includes('sensation'));
  if (!real.length && vague) {
    const ids = ['pain', 'dizziness', 'fatigue', 'nausea', 'fever', 'breathing', 'headache'];
    return { kind: 'clarify_vague', complaint: vague.id, text: L(lang, 'I am sorry you are not feeling well. Can you tell me a little more about how you feel? For example: pain, dizziness, tiredness, nausea, fever, or trouble breathing.', 'سلامتك. ممكن تحكيلي أكتر شوية إحساسك عامل إزاي؟ مثلاً: وجع، دوخة، تعب، غثيان، سخونية، ولا صعوبة في النفس.'),
      options: [...ids.map((id) => opt(`concept:${id}`, cap(CONCEPT_BY_ID[id].en), CONCEPT_BY_ID[id].ar, lang)), opt('concept:other', 'Something else', 'حاجة تانية', lang)] };
  }
  for (const c of [...real.filter((c) => !c.with), ...real.filter((c) => c.with)]) {
    for (const s of openSlots(rec, c)) { const q = slotQuestion(rec, c, s); if (q) return q; c.asked.push(s); }
  }
  if (!rec.anythingElseAsked) return { kind: 'anything_else', text: L(lang, 'Is there anything else you would like your doctor to know?', 'في حاجة تانية حابب الدكتور يعرفها؟'), options: [opt('else:no', 'No, that is all', 'لأ، بس كده', lang), opt('else:yes', 'Yes, something else', 'أيوه، في حاجة كمان', lang)] };
  return null;
}

// ---------------------------------------------------------------- replies (rules)
function understoodLine(rec: ConsultRecord, c: Complaint, fresh: boolean, only?: Set<SlotId>): string {
  const lang = rec.lang;
  const f: Partial<Record<SlotId, Fact>> = only ? Object.fromEntries(Object.entries(c.facts).filter(([k]) => only.has(k as SlotId))) : c.facts;
  const parts: string[] = [];
  if (lang === 'ar') {
    const fem = !!CONCEPT_BY_ID[c.concept]?.fem;
    if (f.severity) parts.push(/^\d+$/.test(f.severity.value) ? `قوته ${f.severity.value} من 10` : `${fem ? 'وإنها' : 'وإنه'} ${f.severity.value === 'mild' ? (fem ? 'خفيفة' : 'خفيف') : f.severity.value === 'moderate' ? (fem ? 'متوسطة' : 'متوسط') : (fem ? 'شديدة' : 'شديد')}`);
    if (f.onset) parts.push(`${fem ? 'وبدأت' : 'وبدأ'} ${f.onset.quote && /[؀-ۿ]/.test(f.onset.quote) ? f.onset.quote : f.onset.ar}`);
    if (f.onset_type) parts.push(f.onset_type.ar);
    if (f.location) parts.push(/^(في|فوق|تحت|ورا|حوالين)/.test(f.location.ar) ? f.location.ar : `في ${f.location.ar}`);
    if (f.pattern) parts.push(f.pattern.ar);
    if (f.side && !(fresh && /شمال|يمين/.test(c.ar))) parts.push(f.side.ar);
    if (!fresh) return parts.length ? `تمام: ${parts.map((p) => p.replace(/^و/, '')).join('، ')}.` : 'تمام.';
    return `فهمت إن عندك ${c.ar}${parts.length ? `، ${parts.join('، ')}` : ''}.`;
  }
  if (f.severity) parts.push(/^\d+$/.test(f.severity.value) ? `${f.severity.value} out of 10` : `it is ${f.severity.en}`);
  if (f.onset) parts.push(`it started ${f.onset.quote && !/[؀-ۿ]/.test(f.onset.quote) ? f.onset.quote.replace(/^since /i, 'since ') : f.onset.en}`);
  if (f.onset_type) parts.push(`it ${f.onset_type.en}`);
  if (f.location) parts.push(`mostly in ${/^the /.test(f.location.en) ? '' : 'the '}${f.location.en}`);
  if (f.pattern) parts.push(f.pattern.value === 'constant' ? 'it is there all the time' : 'it comes and goes');
  if (f.side && !(fresh && /left|right/.test(c.en))) parts.push(f.side.en);
  if (!fresh) return parts.length ? `Got it: ${parts.join(', ')}.` : 'Got it.';
  return `I understand you have ${enA(c)}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}
const ARTICLE = new Set(['headache', 'cough', 'fever', 'rash', 'sore_throat', 'stiff_neck']);
const enA = (c: Complaint) => (ARTICLE.has(c.concept) ? `a ${c.en}` : c.en);
const SORRY = { en: ['I am sorry you are dealing with this.', 'That sounds uncomfortable.', 'Thank you for telling me.'], ar: ['ألف سلامة عليك.', 'سلامتك، ربنا يشفيك.', 'شكراً إنك قلتلي.'] };

// ---------------------------------------------------------------- the rule-based turn
export function ruleTurn(prev: ConsultRecord, input: ConsultInput): ConsultTurn {
  const rec = clone(prev);
  const lang = rec.lang;
  const say: string[] = [];
  const pend = rec.pending;
  const correctionsBefore = rec.corrections.length;
  const text = input.kind === 'text' ? input.text.trim() : input.kind === 'option' ? input.label : '';
  if (input.kind !== 'regions') rec.turns.push({ who: 'patient', text, via: input.via });
  else rec.turns.push({ who: 'patient', text: `[${L(lang, 'body map', 'صورة الجسم')}: ${regionWords(input.ids, lang)}]`, via: 'body_map' });

  const target = (): Complaint | undefined => rec.complaints.find((c) => c.id === pend?.complaint) ?? rec.complaints.filter((c) => c.concept !== 'unwell').slice(-1)[0] ?? rec.complaints.slice(-1)[0];
  let understoodSomething = false;
  let conflict: { c: Complaint; slot: SlotId; old: Fact; next: Fact } | null = null;
  const fresh: Complaint[] = [];
  const touched = new Set<Complaint>();
  const newSlots = new Map<Complaint, Set<SlotId>>();
  const set = (c: Complaint, slot: SlotId, f: Fact, corr: boolean) => {
    if (!newSlots.has(c)) newSlots.set(c, new Set()); newSlots.get(c)!.add(slot);
    const r = setFact(rec, c, slot, f, corr || (pend?.kind === 'slot' && pend.slot === slot && pend.complaint === c.id) || pend?.kind === 'clarify_conflict');
    if (r.conflict) conflict = { c, slot, old: r.conflict.old, next: r.conflict.next };
    else { understoodSomething = true; touched.add(c); }
  };

  // ---- options (touch, or a confirmed sign mapped to an option)
  if (input.kind === 'option') {
    const id = input.id; const c = target();
    if (id === 'ns') {
      if (pend?.kind === 'slot' && c && pend.slot) { c.unknown.push(pend.slot); say.push(L(lang, 'That is okay — I will note it as not sure.', 'ولا يهمك، هكتب إنك مش متأكد.')); }
      else if (pend?.kind === 'opening') { rec.misses++; }
      understoodSomething = true;
    } else if (id.startsWith('concept:')) {
      const cid = id.slice(8);
      if (pend?.kind === 'clarify_vague') { const v = rec.complaints.find((x) => x.id === pend.complaint); if (v) v.asked.push('sensation'); }
      if (cid === 'other' || cid === 'unwell') {
        if (!rec.complaints.some((x) => x.concept === 'unwell')) addComplaint(rec, 'unwell', input.label, input.via, 'chosen', 'patient');
        rec.complaints.forEach((x) => { if (x.concept === 'unwell') x.asked.push('sensation'); });
        say.push(L(lang, 'Please tell me in your own words, or type it. Take your time.', 'احكيلي بكلامك أو اكتبه، وخد وقتك.'));
        rec.pending = { kind: 'opening', text: L(lang, 'What would you like to tell your doctor?', 'حابب تقول للدكتور إيه؟'), options: [] };
        return done(rec, say, false);
      }
      if (!rec.complaints.some((x) => x.concept === cid)) fresh.push(addComplaint(rec, cid, input.label, input.via, 'chosen', 'patient'));
      understoodSomething = true;
    } else if (id.startsWith('area:') && c) {
      const a = id.slice(5);
      const region = a === 'arm' ? 'upper_arm' : a === 'leg' ? 'lower_leg' : a;
      if (c.concept === 'pain' || !c.regions.length) addRegions(c, [region], input.label, 'chosen', 'patient', input.via);
      c.asked.push('location');
      if (a === 'arm' || a === 'leg') say.push(L(lang, 'If you can, show me the exact spot on the body map.', 'لو تقدر، وريني المكان بالظبط على صورة الجسم.'));
      understoodSomething = true; touched.add(c);
    } else if (id.startsWith('assoc:') && c) {
      const a = id.slice(6);
      if (a === 'none') { c.facts.associated = { value: 'none', en: 'none of the symptoms asked about', ar: 'ولا حاجة من اللي اتسألت عنها', prov: 'chosen', by: 'patient', via: input.via, confirmed: true }; rec.denied.push(...(CONCEPT_BY_ID[c.concept]?.related ?? []).filter((x) => !rec.complaints.some((k) => k.concept === x) && !rec.denied.includes(x))); }
      else { const n = addComplaint(rec, a, input.label, input.via, 'chosen', 'patient', { with: c.id }); fresh.push(n); c.facts.associated = { value: a, en: CONCEPT_BY_ID[a].en, ar: CONCEPT_BY_ID[a].ar, prov: 'chosen', by: 'patient', via: input.via, confirmed: true }; }
      understoodSomething = true; touched.add(c);
    } else if (id.startsWith('v:') && c && pend?.slot) {
      const v = id.slice(2);
      applySlotValue(rec, c, pend.slot, v, input.label, 'chosen', 'patient', input.via, set);
      understoodSomething = true;
    } else if (id === 'yes' || id === 'no') {
      return handleConfirm(rec, id === 'yes', input.via, say);
    } else if (id === 'else:no') {
      rec.anythingElseAsked = true; rec.pending = null;
      return { rec, say: [L(lang, 'Thank you. Here is the summary for your doctor.', 'شكراً. ده الملخص اللي هيروح للدكتور.')], options: [], urgent: [], review: true, ai: false };
    } else if (id === 'else:yes') {
      rec.anythingElseAsked = true;
      rec.pending = { kind: 'opening', text: L(lang, 'Please tell me — what else is going on?', 'اتفضل، قولّي إيه كمان؟'), options: [] };
      return done(rec, [L(lang, 'Please tell me — what else is going on?', 'اتفضل، قولّي إيه كمان؟')], false, true);
    } else if (id === 'conflict:old' || id === 'conflict:new') {
      return handleConflict(rec, id === 'conflict:new', say);
    }
  }

  // ---- body map
  if (input.kind === 'regions') {
    let c = pend?.kind === 'slot' && (pend.slot === 'location' || pend.slot === 'side') ? target() : undefined;
    if (!c && rec.complaints.length === 1 && (!rec.complaints[0].regions.length || rec.complaints[0].concept === 'pain')) c = rec.complaints[0];
    if (!c) { c = addComplaint(rec, 'pain', '', 'body_map', 'chosen', 'patient'); fresh.push(c); }
    addRegions(c, input.ids, undefined, 'chosen', 'patient', 'body_map');
    c.asked.push('location'); if (input.ids.some((i) => /_(l|r)$/.test(i))) c.asked.push('side');
    understoodSomething = true; touched.add(c);
  }

  // ---- words (speech, typing, a confirmed signed message)
  if (input.kind === 'text') {
    const u = understand(input.text);
    const det = detectLang(input.text); if (det) rec.lang = det;
    const lg = rec.lang;
    if (u.stop) { rec.turns.push({ who: 'assistant', text: '' }); return done(rec, [L(lg, 'Okay, we can stop here. Nothing is sent unless you approve it. Say continue whenever you want, or main menu to leave.', 'تمام، نقف هنا. مفيش حاجة هتتبعت غير لما توافق. قول كمّل في أي وقت، أو القائمة علشان تخرج.')], false, true); }
    if (u.pause) return done(rec, [L(lg, 'Of course, take your time. I am here when you are ready.', 'طبعاً، خد وقتك. أنا هنا لما تكون جاهز.')], false, true);
    if (u.greeting && !u.concepts.length) {
      const q = rec.pending ?? nextQuestion(rec);
      rec.pending = q;
      const hello = [rec.complaints.length ? L(lg, 'Hello! Let us continue.', 'أهلاً! يلا نكمّل.') : L(lg, 'Hello! I am here to help you tell your doctor how you feel.', 'أهلاً بيك! أنا هنا علشان أساعدك تقول لدكتورك إنت حاسس بإيه.'), ...(q ? [q.text] : [])];
      rec.turns.push({ who: 'assistant', text: hello.join(' ') });
      return { rec, say: hello, options: q?.options ?? [], urgent: [], review: false, ai: false };
    }

    if (pend?.kind === 'confirm' && (u.yes || u.no) && !u.concepts.length) return handleConfirm(rec, u.yes && !u.no, input.via, say);
    if (pend?.kind === 'anything_else' && (u.nothingElse || (u.no && !u.concepts.length))) { rec.anythingElseAsked = true; rec.pending = null; return { rec, say: [L(lg, 'Thank you. Here is the summary for your doctor.', 'شكراً. ده الملخص اللي هيروح للدكتور.')], options: [], urgent: [], review: true, ai: false }; }
    if (pend?.kind === 'anything_else') rec.anythingElseAsked = true;

    // new symptoms (several allowed), and the ones the patient says they do NOT have
    for (const h of u.concepts) {
      if (h.negated) { if (!rec.denied.includes(h.value)) rec.denied.push(h.value); understoodSomething = true; continue; }
      if (h.value === 'pain' && u.concepts.some((x) => x !== h && !x.negated && x.value !== 'unwell')) continue;
      if (h.value === 'unwell' && u.concepts.some((x) => x !== h && !x.negated)) continue;
      const exists = rec.complaints.find((x) => x.concept === h.value && (h.value !== 'pain' || !u.body.length || x.regions.some((r) => u.body.some((b) => r.id.startsWith(b.value)))));
      if (exists) { touched.add(exists); understoodSomething = true; continue; }
      const withId = pend?.kind === 'slot' && pend.slot === 'associated' ? pend.complaint : undefined;
      const c = addComplaint(rec, h.value, input.text.slice(0, 300), input.via, h.misspelled ? 'inferred' : 'said', h.misspelled ? 'rules' : 'patient', withId ? { with: withId } : {});
      if (withId) { const main = rec.complaints.find((x) => x.id === withId); if (main) main.facts.associated = { value: h.value, en: c.en, ar: c.ar, quote: h.quote, prov: 'said', by: 'patient', via: input.via, confirmed: true }; }
      fresh.push(c); understoodSomething = true;
    }
    if (pend?.kind === 'slot' && pend.slot === 'associated' && (u.no || u.nothingElse) && !fresh.length) {
      const main = target(); if (main) { main.facts.associated = { value: 'none', en: 'none of the symptoms asked about', ar: 'ولا حاجة من اللي اتسألت عنها', quote: input.text, prov: 'said', by: 'patient', via: input.via, confirmed: true }; rec.denied.push(...(CONCEPT_BY_ID[main.concept]?.related ?? []).filter((x) => !rec.complaints.some((c) => c.concept === x))); understoodSomething = true; }
    }
    // which complaint the details belong to
    const mentioned = fresh[0] ?? [...touched][0];
    const c = mentioned ?? target();
    if (c) {
      // body parts the symptom itself does not imply (a new pain spot, or several regions)
      const implied = new Set(CONCEPT_BY_ID[c.concept]?.regions ?? []);
      const extra = u.body.filter((b) => !implied.has(b.value));
      const area = areaOf(c);
      for (const b of u.body) {
        if (b.detail && (b.area === area || (area === 'face' && b.area === 'face'))) set(c, 'location', { value: b.detail, en: (LOCATIONS[b.area]?.find((x) => x.value === b.detail)?.en) ?? b.detail.replace(/_/g, ' '), ar: (LOCATIONS[b.area]?.find((x) => x.value === b.detail)?.ar) ?? b.quote, quote: b.quote, prov: 'said', by: 'patient', via: input.via, confirmed: true }, u.correction);
      }
      if (extra.length && (c.concept === 'pain' || !c.regions.length || pend?.slot === 'location' || extra.some((b) => b.area === area || b.area === 'neck'))) {
        for (const b of extra) {
          const ids = b.sided && u.side && u.side.value !== 'both' ? sidedIds(b.value, u.side.value) : b.sided && u.side?.value === 'both' ? sidedIds(b.value, 'both') : [b.value];
          addRegions(c, ids, b.quote, b.misspelled ? 'inferred' : 'said', b.misspelled ? 'rules' : 'patient', input.via);
        }
        understoodSomething = true; touched.add(c);
      } else if (extra.length && !fresh.length && !u.concepts.length) {
        // a pain in another place, reported on its own ("and my knee too")
        const n = addComplaint(rec, 'pain', input.text.slice(0, 300), input.via, 'said', 'patient');
        for (const b of extra) addRegions(n, [b.value], b.quote, b.misspelled ? 'inferred' : 'said', b.misspelled ? 'rules' : 'patient', input.via);
        fresh.push(n); understoodSomething = true;
      }
      // values
      const answering = (s: SlotId) => pend?.kind === 'slot' && pend.slot === s && pend.complaint === c.id;
      if (u.number && (answering('severity') || /out of|من/.test(u.number.quote))) set(c, 'severity', sevFact(String(u.number.value), u.number.quote, 'said', 'patient', input.via), u.correction);
      else if (answering('severity') && /^\s*(10|[0-9])\s*$/.test(norm(input.text))) set(c, 'severity', sevFact(norm(input.text).trim(), input.text, 'said', 'patient', input.via), u.correction);
      else if (u.severity) set(c, 'severity', sevFact(u.severity.value, u.severity.quote, 'said', 'patient', input.via), u.correction);
      if (u.onset) set(c, 'onset', factFrom(ONSET, u.onset.value, u.onset.quote, 'said', 'patient', input.via), u.correction);
      if (u.onsetType) set(c, 'onset_type', factFrom(ONSET_TYPE, u.onsetType.value, u.onsetType.quote, 'said', 'patient', input.via), u.correction);
      if (u.pattern) set(c, 'pattern', factFrom(PATTERN, u.pattern.value, u.pattern.quote, 'said', 'patient', input.via), u.correction);
      if (u.sensation && (answering('sensation') || c.concept === 'pain') && u.sensation.value !== 'pain') set(c, 'sensation', factFrom(SENSATIONS, u.sensation.value, u.sensation.quote, 'said', 'patient', input.via), u.correction);
      if (u.side && needsSide(c) && !c.regions.some((r) => /_(l|r)$/.test(r.id))) {
        const sided = c.regions.filter((r) => BODY.some((b) => b.region === r.id && b.sided));
        for (const r of sided) addRegions(c, sidedIds(r.id, u.side.value), u.side.quote, 'said', 'patient', input.via);
        c.facts.side = factFrom(SIDE, u.side.value, u.side.quote, 'said', 'patient', input.via); understoodSomething = true; touched.add(c);
        if (!newSlots.has(c)) newSlots.set(c, new Set()); newSlots.get(c)!.add('side');
      } else if (u.side && (c.concept === 'numbness' || c.concept === 'weakness')) set(c, 'side', factFrom(SIDE, u.side.value, u.side.quote, 'said', 'patient', input.via), u.correction);
      if ((answering('location') || answering('side')) && area && LOCATIONS[area] && !c.facts.location) {
        const loc = valueHit(input.text, tokensOf(input.text), LOCATIONS[area]!);
        if (loc) set(c, 'location', factFrom(LOCATIONS[area]!, loc.value, loc.quote, 'said', 'patient', input.via), u.correction);
        else if (!u.notSure && input.text.length > 2 && !u.concepts.length) { set(c, 'location', { value: 'other', en: input.text.slice(0, 80), ar: input.text.slice(0, 80), quote: input.text.slice(0, 80), prov: 'said', by: 'patient', via: input.via, confirmed: true }, u.correction); }
      }
      if (u.notSure && pend?.kind === 'slot' && pend.slot && !c.facts[pend.slot]) { c.unknown.push(pend.slot); understoodSomething = true; say.push(L(lg, 'That is completely fine — I will note it as not sure.', 'ولا يهمك خالص، هكتب إنك مش متأكد.')); }
    }
    if (u.question) { rec.notes.push({ text: input.text.slice(0, 300), via: input.via, kind: 'question' }); understoodSomething = true; say.push(L(lg, 'That is a good question for your doctor. I cannot give medical advice, but I have added your question to the message so the doctor sees it.', 'ده سؤال مهم للدكتور. أنا مقدرش أدي نصيحة طبية، بس ضفت سؤالك للرسالة علشان الدكتور يشوفه.')); }
    if (u.fear) { rec.notes.push({ text: input.text.slice(0, 300), via: input.via, kind: 'feeling' }); understoodSomething = true; say.push(L(lg, 'I understand you are worried — that is a very natural feeling when you are unwell. I am here to help you explain everything clearly to your doctor.', 'فاهم إنك قلقان، وده إحساس طبيعي جداً لما تكون تعبان. أنا هنا علشان أساعدك توصّل كل حاجة للدكتور بوضوح.')); }
    if (u.cantDescribe) { understoodSomething = true; rec.misses = Math.max(rec.misses, 1); say.push(L(lg, 'No problem at all — you do not need medical words. You can tell me where it is, pick from simple choices, or show me on the body map.', 'ولا يهمك خالص، مش لازم كلام طبي. ممكن تقولّي مكانه، أو تختار من اختيارات بسيطة، أو توريني على صورة الجسم.')); }
    if (u.speakingHard) { understoodSomething = true; say.push(L(lg, 'Take your time — there is no rush. If this difficulty speaking is new or came on suddenly, please call emergency services now. Otherwise we can use short answers, the buttons, typing, or signs.', 'خد وقتك، مفيش استعجال. لو صعوبة الكلام دي جديدة أو جت فجأة، اتصل بالطوارئ دلوقتي. غير كده نقدر نستخدم إجابات قصيرة، أو الزراير، أو الكتابة، أو الإشارات.')); }
    if (!understoodSomething && pend?.kind === 'opening' && input.text.length > 3 && !u.notSure) {
      // something we have no word for: keep the patient's own words as the complaint
      fresh.push(addComplaint(rec, 'other', input.text.slice(0, 300), input.via, 'said', 'patient', { en: input.text.slice(0, 60), ar: input.text.slice(0, 60) }));
      understoodSomething = true;
    }
    if (!understoodSomething && u.notSure && pend?.kind === 'opening') { rec.misses++; understoodSomething = true; say.push(L(lg, 'That is okay.', 'ولا يهمك.')); }
  }

  // a question that was not answered (the patient talked about something else) is asked again later, once
  if (pend?.kind === 'slot' && pend.slot) {
    const pc = rec.complaints.find((x) => x.id === pend.complaint);
    if (pc && !pc.facts[pend.slot] && !pc.unknown.includes(pend.slot) && understoodSomething && !(pc.reasked ?? []).includes(pend.slot)) {
      pc.asked = pc.asked.filter((s) => s !== pend.slot); pc.reasked = [...(pc.reasked ?? []), pend.slot];
    }
  }

  // ---- reply
  if (conflict) {
    const k = conflict as { c: Complaint; slot: SlotId; old: Fact; next: Fact };
    rec.pending = { kind: 'clarify_conflict', complaint: k.c.id, slot: k.slot, value: k.next.value, other: k.old.value,
      text: L(rec.lang, `Earlier you told me "${k.old.en}", and now "${k.next.en}". Which one is right?`, `قبل كده قلتلي "${k.old.ar}"، ودلوقتي "${k.next.ar}". أنهي الصح؟`),
      options: [opt('conflict:old', k.old.en, k.old.ar, rec.lang), opt('conflict:new', k.next.en, k.next.ar, rec.lang)] };
    (rec.pending as Pending & { next?: Fact }).next = k.next;
    return done(rec, [...say, rec.pending.text], false, true);
  }
  if (!understoodSomething) {
    rec.misses++;
    const q = rec.pending ?? nextQuestion(rec);
    const sorry = rec.misses >= 2
      ? L(rec.lang, 'I am sorry, I am still not sure what you mean — that is my fault, not yours. You can tap one of the choices, type it, or show me on the body map.', 'آسف، لسه مش متأكد قصدك إيه، والغلط مني مش منك. ممكن تدوس على اختيار، أو تكتبه، أو توريني على صورة الجسم.')
      : L(rec.lang, 'Sorry, I did not quite catch that. Could you say it another way?', 'آسف، مفهمتش كويس. ممكن تقولها بطريقة تانية؟');
    if (q) rec.pending = q;
    return { rec, say: [sorry, ...(q && rec.misses < 2 ? [q.text] : [])], options: q?.options ?? [], urgent: [], review: false, ai: false };
  }
  rec.misses = 0;
  if (fresh.length) {
    // a symptom read from a misspelled word is asked about ("Did you mean…?") instead of being stated
    const shown = fresh.filter((c) => c.prov !== 'inferred' && !(c.regions.length && c.regions.every((r) => r.prov === 'inferred')) && c.concept !== 'unwell' && c.concept !== 'other' && !(c.concept === 'pain' && !c.regions.length));
    if (rec.complaints.length === fresh.length && shown.length) say.unshift(SORRY[rec.lang][0]);
    if (shown.length === 1) say.push(understoodLine(rec, shown[0], true));
    else if (shown.length > 1) {
      const names = shown.map((c) => (rec.lang === 'ar' ? c.ar : enA(c)));
      say.push(L(rec.lang, `I understand you have ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. I will ask about each one.`, `فهمت إن عندك ${names.join(' و')}. هسألك عن كل واحدة.`));
    }
    if (fresh.some((c) => c.concept === 'other')) say.push(L(rec.lang, 'Thank you, I wrote that down in your own words.', 'شكراً، كتبت ده بكلامك زي ما قلته.'));
  } else {
    for (const c of touched) if (c.concept !== 'unwell' && newSlots.get(c)?.size) {
      const line = understoodLine(rec, c, false, newSlots.get(c));
      say.push(rec.corrections.length > correctionsBefore ? line.replace(/^Got it:/, 'Okay, I changed that:').replace(/^تمام:/, 'تمام، عدلتها:') : line);
      break;
    }
  }
  return done(rec, say, false);
}

function applySlotValue(rec: ConsultRecord, c: Complaint, slot: SlotId, v: string, quote: string, prov: Fact['prov'], by: Fact['by'], via: Via, set: (c: Complaint, s: SlotId, f: Fact, corr: boolean) => void) {
  const area = areaOf(c);
  if (slot === 'severity') set(c, slot, sevFact(v, quote, prov, by, via), true);
  else if (slot === 'onset') set(c, slot, factFrom(ONSET, v, quote, prov, by, via), true);
  else if (slot === 'onset_type') set(c, slot, factFrom(ONSET_TYPE, v, quote, prov, by, via), true);
  else if (slot === 'pattern') set(c, slot, factFrom(PATTERN, v, quote, prov, by, via), true);
  else if (slot === 'sensation') set(c, slot, factFrom(SENSATIONS, v, quote, prov, by, via), true);
  else if (slot === 'side') {
    for (const r of c.regions.filter((r) => BODY.some((b) => b.region === r.id && b.sided))) addRegions(c, sidedIds(r.id, v), quote, prov, by, via);
    set(c, slot, factFrom(SIDE, v, quote, prov, by, via), true);
  } else if (slot === 'location') {
    const list = (area && LOCATIONS[area]) || [];
    set(c, slot, v === 'other' ? { value: 'other', en: 'somewhere else', ar: 'مكان تاني', prov, by, via, confirmed: prov !== 'inferred' } : factFrom(list, v, quote, prov, by, via), true);
    if (area === 'abdomen' && (v === 'right' || v === 'left')) addRegions(c, [`abdomen_${v === 'left' ? 'l' : 'r'}`], quote, prov, by, via);
    if (area === 'back') addRegions(c, [v === 'lower' ? 'lower_back' : 'upper_back'], quote, prov, by, via);
  }
}

function handleConfirm(rec: ConsultRecord, yes: boolean, via: Via, say: string[]): ConsultTurn {
  const p = rec.pending; const lang = rec.lang;
  const c = rec.complaints.find((x) => x.id === p?.complaint);
  if (p?.kind === 'confirm' && c && p.value?.startsWith('region:')) {
    const id = p.value.slice(7); const r = c.regions.find((x) => x.id === id);
    if (r && yes) { r.confirmed = true; say.push(L(lang, 'Thank you for confirming.', 'شكراً إنك أكدت.')); }
    else if (r) { c.regions = c.regions.filter((x) => x !== r); rec.corrections.push({ complaint: c.id, field: 'body area', from: regionWords([id], 'en'), to: 'removed', by: 'patient' }); c.asked = c.asked.filter((s) => s !== 'location'); say.push(L(lang, 'Okay. Where is it, then? You can also show me on the body map.', 'تمام. أمال فين؟ وممكن توريني على صورة الجسم.')); }
  } else if (p?.kind === 'confirm' && c) {
    if (!p.slot) {
      if (yes) {
        c.confirmed = true; c.prov = 'said'; c.regions.forEach((r) => { r.confirmed = true; });
        // what the symptom itself implies (a headache is a pain) is confirmed with it
        const implied = CONCEPT_BY_ID[c.concept]?.sensation;
        if (implied && c.facts.sensation?.value === implied) { c.facts.sensation.confirmed = true; c.facts.sensation.prov = 'said'; }
        say.push(L(lang, 'Thank you for confirming.', 'شكراً إنك أكدت.'));
      }
      else { rec.complaints = rec.complaints.filter((x) => x !== c); rec.corrections.push({ complaint: c.id, field: 'symptom', from: c.en, to: 'removed', by: 'patient' }); say.push(L(lang, 'Okay, I removed that. Please tell me in your own words.', 'تمام، شيلته. قولّي بكلامك من فضلك.')); }
    } else {
      const f = c.facts[p.slot];
      if (f) {
        if (yes) { f.confirmed = true; say.push(L(lang, 'Thank you for confirming.', 'شكراً إنك أكدت.')); }
        else { delete c.facts[p.slot]; c.asked = c.asked.filter((s) => s !== p.slot); rec.corrections.push({ complaint: c.id, field: p.slot, from: f.en, to: 'removed', by: 'patient' }); say.push(L(lang, 'Okay, I removed that.', 'تمام، شيلت ده.')); }
      }
    }
  }
  void via;
  return done(rec, say, false);
}

function handleConflict(rec: ConsultRecord, takeNew: boolean, say: string[]): ConsultTurn {
  const p = rec.pending as (Pending & { next?: Fact }) | null;
  const c = rec.complaints.find((x) => x.id === p?.complaint);
  if (c && p?.slot && p.next) {
    if (takeNew) { const old = c.facts[p.slot]; rec.corrections.push({ complaint: c.id, field: p.slot, from: old?.en ?? '', to: p.next.en, by: 'patient' }); c.facts[p.slot] = { ...p.next, confirmed: true }; }
    else if (c.facts[p.slot]) c.facts[p.slot]!.confirmed = true;
    say.push(L(rec.lang, 'Thank you, I updated it.', 'شكراً، عدلتها.'));
  }
  rec.pending = null;
  return done(rec, say, false);
}

/** Picks the next question (or review) and finishes the turn. */
function done(rec: ConsultRecord, say: string[], ai: boolean, keepPending = false): ConsultTurn {
  const urgent: string[] = [];
  const last = [...rec.turns].reverse().find((t) => t.who === 'patient');
  for (const r of safetyCheck(rec, last?.text ?? '')) { urgent.push(r); rec.urgent.push(r); }
  if (!keepPending || !rec.pending) {
    const q = nextQuestion(rec);
    rec.pending = q;
    if (q?.kind === 'slot' || q?.kind === 'clarify_vague') { const c = rec.complaints.find((x) => x.id === q.complaint); if (c && q.slot && !c.asked.includes(q.slot)) c.asked.push(q.slot); }
    if (q?.kind === 'anything_else') rec.anythingElseAsked = true;
    if (!q) {
      rec.turns.push({ who: 'assistant', text: say.join(' '), ai });
      return { rec, say: [...say, L(rec.lang, 'Thank you. Here is the summary for your doctor.', 'شكراً. ده الملخص اللي هيروح للدكتور.')], options: [], urgent, review: true, ai };
    }
    if (!say.includes(q.text)) say.push(q.text);
  }
  rec.turns.push({ who: 'assistant', text: say.join(' '), ai });
  return { rec, say, options: rec.pending?.options ?? [], urgent, review: false, ai };
}

/** First turn of a consultation (asks the opening question). */
export function startConsult(lang: ConsultLang, prev?: ConsultRecord): ConsultTurn {
  const rec = prev ? clone(prev) : newRecord(lang);
  rec.lang = lang;
  if (prev && rec.complaints.length) {
    // coming back to change something: keep everything, ask what to change
    rec.pending = { kind: 'opening', text: L(lang, 'What would you like to change or add? Tell me in your own words.', 'عايز تغيّر أو تضيف إيه؟ قولّي بكلامك.'), options: [] };
    return { rec, say: [rec.pending.text], options: [], urgent: [], review: false, ai: false };
  }
  rec.pending = openingQuestion(lang);
  rec.turns.push({ who: 'assistant', text: rec.pending.text });
  return { rec, say: [rec.pending.text], options: rec.pending.options, urgent: [], review: false, ai: false };
}

// ---------------------------------------------------------------- summary
const TAG = {
  said: { en: 'your words', ar: 'كلامك' },
  chosen: { en: 'you chose', ar: 'انت اخترت' },
  inferred: { en: 'interpretation, not confirmed', ar: 'تفسير لسه متأكدش' },
  confirmedInf: { en: 'interpretation you confirmed', ar: 'تفسير انت أكدته' },
};
function tagOf(f: { prov: Fact['prov']; confirmed: boolean; quote?: string }, lang: ConsultLang): string {
  const t = f.prov === 'inferred' ? (f.confirmed ? TAG.confirmedInf : TAG.inferred) : f.prov === 'said' ? TAG.said : TAG.chosen;
  return f.prov === 'said' && f.quote ? `${t[lang]}: "${f.quote}"` : t[lang];
}
const SLOT_NAME: Record<SlotId, { en: string; ar: string }> = {
  location: { en: 'Where exactly', ar: 'المكان بالظبط' }, side: { en: 'Side', ar: 'الناحية' }, sensation: { en: 'Feels like', ar: 'الإحساس' },
  severity: { en: 'Strength', ar: 'الشدة' }, onset: { en: 'Started', ar: 'بدأ' }, onset_type: { en: 'How it started', ar: 'بدأ إزاي' },
  pattern: { en: 'Pattern', ar: 'النمط' }, associated: { en: 'Along with it', ar: 'معاه' },
};

/** The summary the patient approves; each line says whether it is their words, their choice, or an interpretation. */
export function summaryLines(rec: ConsultRecord, lang: ConsultLang = rec.lang): string[] {
  const out: string[] = [];
  const cs = rec.complaints.filter((c) => c.concept !== 'unwell' || rec.complaints.length === 1);
  cs.forEach((c, i) => {
    out.push(`${i + 1}. ${cap(label(c, lang))}${c.with ? L(lang, ` (together with the ${label(rec.complaints.find((x) => x.id === c.with) ?? c, lang)})`, ` (مع ${label(rec.complaints.find((x) => x.id === c.with) ?? c, lang)})`) : ''} — ${c.quote ? `${L(lang, 'you said', 'انت قلت')}: "${c.quote}"` : tagOf(c, lang)}`);
    if (c.regions.length) out.push(`   ${L(lang, 'Body area', 'مكان في الجسم')}: ${regionWords(c.regions.map((r) => r.id), lang)} (${c.regions.some((r) => r.via === 'body_map') ? L(lang, 'shown on the body map', 'اتحدد على صورة الجسم') : tagOf({ ...c.regions[0], quote: undefined }, lang)})`);
    for (const s of ['location', 'side', 'sensation', 'severity', 'onset', 'onset_type', 'pattern', 'associated'] as SlotId[]) {
      const f = c.facts[s];
      if (f) out.push(`   ${SLOT_NAME[s][lang]}: ${lang === 'ar' ? f.ar : f.en} (${tagOf(f, lang)})`);
      else if (c.unknown.includes(s)) out.push(`   ${SLOT_NAME[s][lang]}: ${L(lang, 'not sure', 'مش متأكد')}`);
    }
    const notAsked = (CONCEPT_BY_ID[c.concept]?.plan ?? []).filter((s) => !c.facts[s] && !c.unknown.includes(s) && s !== 'side' && s !== 'associated' && !(s === 'location' && c.concept === 'pain' && c.regions.length));
    if (notAsked.length && !c.with) out.push(`   ${L(lang, 'Not answered', 'متجاوبش عليه')}: ${notAsked.map((s) => SLOT_NAME[s][lang]).join(lang === 'ar' ? '، ' : ', ')}`);
  });
  if (rec.denied.length) out.push(`${L(lang, 'You said you do not have', 'قلت إن مفيش')}: ${[...new Set(rec.denied)].map((d) => L(lang, CONCEPT_BY_ID[d]?.en ?? d, CONCEPT_BY_ID[d]?.ar ?? d)).join(lang === 'ar' ? '، ' : ', ')}`);
  const qs = rec.notes.filter((n) => n.kind === 'question');
  if (qs.length) out.push(`${L(lang, 'Your questions for the doctor', 'أسئلتك للدكتور')}: ${qs.map((q) => `"${q.text}"`).join('; ')}`);
  if (rec.corrections.length) out.push(`${L(lang, 'You corrected', 'انت صححت')}: ${rec.corrections.map((x) => `${x.from} → ${x.to === 'removed' ? L(lang, 'removed', 'اتشال') : x.to}`).join('; ')}`);
  if (rec.urgent.length) out.push(`${L(lang, 'Urgent-help guidance was shown because of', 'اتعرضت إرشادات الطوارئ بسبب')}: ${rec.urgent.join('; ')}`);
  return out;
}

/** Short spoken version of the summary. */
export function spokenSummary(rec: ConsultRecord): string[] {
  const lang = rec.lang;
  const out: string[] = [];
  for (const c of rec.complaints.filter((x) => x.concept !== 'unwell' || rec.complaints.length === 1)) out.push(understoodLine(rec, c, true));
  const unknown = rec.complaints.flatMap((c) => c.unknown.map((s) => SLOT_NAME[s][lang]));
  if (unknown.length) out.push(L(lang, `Marked as not sure: ${unknown.join(', ')}.`, `مكتوب إنك مش متأكد من: ${unknown.join('، ')}.`));
  if (rec.notes.some((n) => n.kind === 'question')) out.push(L(lang, 'Your questions are included for the doctor.', 'أسئلتك متضافة للدكتور.'));
  return out;
}

/** Data for the existing report pipeline. */
export function reportData(rec: ConsultRecord) {
  const regionIds = [...new Set(rec.complaints.flatMap((c) => c.regions.map((r) => r.id)))].filter((id) => REGION_BY_ID[id]);
  const sensations = [...new Set(rec.complaints.map((c) => c.facts.sensation?.value).filter(Boolean))] as string[];
  const main = rec.complaints.find((c) => c.concept !== 'unwell') ?? rec.complaints[0];
  const f = main?.facts ?? {};
  const onsetMap: Record<string, string> = { today: 'Today', days: '1–3 days ago', week: 'About a week ago', longer: 'More than a week ago' };
  const sev = f.severity?.value;
  return {
    regionIds, sensations,
    description: rec.complaints.map((c) => c.quote).filter(Boolean).join(' | ').slice(0, 1000),
    severityNumber: sev && /^\d+$/.test(sev) ? Number(sev) : undefined,
    severityWord: sev && !/^\d+$/.test(sev) ? (sev === 'mild' ? 'Mild' : sev === 'moderate' ? 'Moderate' : 'Severe') : undefined,
    onset: f.onset ? onsetMap[f.onset.value] : undefined,
    pattern: f.pattern ? (f.pattern.value === 'constant' ? 'constant' as const : 'comes_and_goes' as const) : undefined,
    associated: rec.complaints.filter((c) => c.with).map((c) => cap(c.en)),
  };
}

export type { Concept };
