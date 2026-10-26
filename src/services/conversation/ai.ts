// Claude as the conversation partner — with the record kept by AccessCare.
//
// Claude reads the record and the patient's new message and returns JSON:
// what it understood (each detail with the patient's own words as a quote), a
// short empathetic reply, and the next question with answer choices that fit
// the patient's symptom. AccessCare then checks everything:
//   • only known fields and allowed values are kept; body regions must be real ids
//   • a detail whose quote is not in the patient's words is kept only as an
//     "interpretation" that the patient is asked to confirm
//   • replies and questions that diagnose, name diseases, give medicine advice or
//     falsely reassure are dropped (the rule-based wording is used instead)
//   • safety rules still run on every message; the AI can only add urgency
// If the AI does not answer or the answer fails the checks, the rule-based
// turn is used and the UI says so.

import type { ConsultRecord, Complaint, Fact, Pending, SlotId, Via } from '../../domain/conversation';
import { BODY_REGIONS } from '../../domain/bodyRegions';
import { BODY, CONCEPT_BY_ID, CONCEPTS, LOCATIONS, ONSET, ONSET_TYPE, PATTERN, SENSATIONS, SEVERITY, SIDE, norm } from './lexicon';
import { ruleTurn, safetyCheck, nextQuestion, detectLang, addRegions, sidedIds, type ConsultInput, type ConsultTurn } from './Consult';

/** Must match a prefix allowed by server/cloudflare-worker.mjs */
export const CONVERSE_PREFIX = 'You are AccessCare AI, a warm medical communication assistant';

const REGION_IDS = BODY_REGIONS.map((r) => r.id);
const FIELDS: SlotId[] = ['location', 'side', 'sensation', 'severity', 'onset', 'onset_type', 'pattern'];
const ENUMS: Record<string, string[]> = {
  severity: [...SEVERITY.map((s) => s.value), ...Array.from({ length: 11 }, (_, i) => String(i))],
  onset: ONSET.map((s) => s.value), onset_type: ONSET_TYPE.map((s) => s.value), pattern: PATTERN.map((s) => s.value),
  sensation: [...SENSATIONS.map((s) => s.value), 'other'], side: SIDE.map((s) => s.value),
};

function compactRecord(rec: ConsultRecord) {
  return rec.complaints.map((c) => ({
    id: c.id, concept: c.concept, label: rec.lang === 'ar' ? c.ar : c.en, said: c.quote.slice(0, 160),
    regions: c.regions.map((r) => r.id),
    known: Object.fromEntries(Object.entries(c.facts).map(([k, f]) => [k, f!.value + (f!.confirmed ? '' : ' (unconfirmed)')])),
    not_sure: c.unknown, asked: c.asked, ...(c.with ? { with: c.with } : {}),
  }));
}

export function buildPrompt(rec: ConsultRecord, input: ConsultInput): string {
  const said = input.kind === 'text' ? input.text : input.kind === 'option' ? input.label : `(body map) ${input.ids.join(', ')}`;
  const via = input.via === 'touch' ? 'tapping an answer button' : input.via === 'text' ? 'typing' : input.via === 'body_map' ? 'the body map' : 'speaking (speech recognition may contain small mistakes)';
  const lang = detectLang(said) ?? rec.lang;
  const recent = rec.turns.slice(-6).map((t) => `${t.who}: ${t.text.slice(0, 220)}`);
  return `${CONVERSE_PREFIX}. You help a patient tell their doctor what they feel, by talking with them kindly, like a thoughtful nurse taking notes — not like a form.
Rules: never diagnose or name possible illnesses; never suggest medicines or treatments; never say a symptom is harmless or that they will be fine; never claim to be a doctor or a human. You may explain in general terms why a question matters. If something could be an emergency, say so plainly and tell them to call emergency services now.
Language: answer in ${lang === 'ar' ? 'warm, simple Egyptian Arabic (no English words unless the patient used them)' : 'warm, plain English'}.
Known so far (complaints): ${JSON.stringify(compactRecord(rec))}
Patient said they do NOT have: ${JSON.stringify(rec.denied)}
Recent conversation: ${JSON.stringify(recent)}
Question they were answering: ${JSON.stringify(rec.pending?.text ?? '')}${rec.pending?.slot ? ` (field: ${rec.pending.slot}, complaint ${rec.pending.complaint})` : ''}
New message, by ${via}: ${JSON.stringify(said.slice(0, 600))}

Do this:
1. Understand what they mean (dialect, everyday words, small recognition mistakes). Extract EVERY detail they gave, for any complaint, even if not asked. Use an existing complaint id, or "new" for a new symptom (give concept and a short label in their language). Several symptoms or body areas are fine.
2. If they change an earlier answer, mark it "correction": true. If they say they do not have a symptom, put its concept in "denies".
3. "reply": 1–2 short sentences that respond to what they actually said, with empathy (acknowledge discomfort or worry), and briefly restate what you understood. If they asked a question, answer it briefly in general terms and say the doctor can tell them more. Do not put a question in "reply".
4. "question": the ONE most useful next question about THEIR symptoms that is not answered yet (for a headache: onset, sudden or gradual, where in the head, strength, pattern, other symptoms — never unrelated body areas). Do not ask what they already told you. Give 2–7 short answer options in their language that fit the question, and include a "not sure" option. If they seem unable to describe, offer simpler options. Use null when the doctor has enough (for each main complaint: when it started, where, how strong, pattern, other symptoms) and you have asked whether there is anything else.
5. "urgent": true if anything could need emergency care now.

Allowed values — concept: ${JSON.stringify(CONCEPTS.map((c) => c.id).concat('other'))}; regions: ${JSON.stringify(REGION_IDS)}; severity: mild|moderate|severe|0..10; onset: today|days|week|longer; onset_type: sudden|gradual; pattern: constant|comes_and_goes; sensation: ${JSON.stringify(ENUMS.sensation)}; side: left|right|both; location: short words (e.g. forehead, temples, upper belly).
Each update needs "quote": the patient's exact words that support it. If you inferred it without explicit words, add "inferred": true.
Reply with only JSON:
{"reply":"...","updates":[{"complaint":"c1"|"new","concept":"headache","label":"...","field":"onset"|"regions"|...|null,"value":"today","quote":"...","inferred":false,"correction":false}],"denies":[],"not_sure":[{"complaint":"c1","field":"onset"}],"question":{"complaint":"c1","field":"onset_type","text":"...","options":["...","..."]}|null,"urgent":false,"urgent_reason":""}`;
}

// ---------------------------------------------------------------- guards
const BAD_EN = /\b(diagnos\w*|you (probably|likely|may|might) have|it (is|could be|might be|sounds like) (a |an )?(migraine|infection|virus|flu|stroke|heart attack|cancer|tumou?r|appendicitis|ulcer|gastritis|sinusitis|meningitis|covid)|probabl\w* (a |an )?\w*itis|take (some )?(paracetamol|ibuprofen|aspirin|panadol|medicine|medication|pills?|tablets?)|nothing (serious|to worry)|don'?t worry|you('| wi)ll be (fine|ok|okay)|not serious|harmless|i am a doctor|as a doctor)\b/i;
const BAD_AR = /(تشخيص|غالبا عندك|ممكن يكون عندك|اكيد عندك|يمكن عندك|ده (صداع نصفي|التهاب|فيروس|برد|انفلونزا|جلطه|قرحه)|التهاب|جلطه|سرطان|ورم|فيروس|خد (بنادول|مسكن|دوا|حبايه|علاج)|اشرب (دوا|علاج)|مسكن|بنادول|متقلقش|ماتقلقش|مفيش حاجه خطيره|حاجه بسيطه|هتبقي كويس|مش خطير|انا دكتور)/;
export function guardReply(text: unknown, max = 420): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > max) return null;
  if (BAD_EN.test(t) || BAD_AR.test(norm(t)) || BAD_AR.test(t)) return null;
  return t;
}

function quoteIn(quote: unknown, said: string): string | null {
  if (typeof quote !== 'string' || quote.length < 1 || quote.length > 200) return null;
  const q = norm(quote); const s = norm(said);
  return q && s.includes(q) ? quote.trim() : null;
}

function wordsFor(slot: SlotId, value: string, area?: string): { en: string; ar: string } | null {
  const list = slot === 'severity' ? SEVERITY : slot === 'onset' ? ONSET : slot === 'onset_type' ? ONSET_TYPE : slot === 'pattern' ? PATTERN : slot === 'sensation' ? SENSATIONS : slot === 'side' ? SIDE : null;
  if (slot === 'severity' && /^\d+$/.test(value)) return { en: `${value} out of 10`, ar: `${value} من 10` };
  if (list) { const w = list.find((x) => x.value === value); return w ? { en: w.en, ar: w.ar } : (slot === 'sensation' && value === 'other' ? { en: 'something else', ar: 'حاجة تانية' } : null); }
  if (slot === 'location') {
    const known = area ? (LOCATIONS as Record<string, { value: string; en: string; ar: string }[] | undefined>)[area]?.find((x) => x.value === value || x.en === value) : undefined;
    return known ? { en: known.en, ar: known.ar } : { en: value, ar: value };
  }
  return null;
}

// ---------------------------------------------------------------- apply
export function applyAI(prev: ConsultRecord, input: ConsultInput, raw: unknown): ConsultTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const reply = guardReply(r.reply);
  if (!reply) return null;
  const rec: ConsultRecord = JSON.parse(JSON.stringify(prev));
  const said = input.kind === 'text' ? input.text : input.kind === 'option' ? input.label : '';
  const via: Via = input.via;
  const det = detectLang(said); if (det) rec.lang = det;
  rec.turns.push({ who: 'patient', text: said || `[body map: ${input.kind === 'regions' ? input.ids.join(', ') : ''}]`, via });
  const newIds: Record<string, string> = {};
  const nextId = () => `c${Math.max(0, ...rec.complaints.map((x) => Number(x.id.slice(1)) || 0)) + 1}`;
  const prov = (inferred: boolean, quote: string | null): Fact['prov'] => (inferred || !quote ? 'inferred' : input.kind === 'option' ? 'chosen' : 'said');

  const base = rec;

  const updates = Array.isArray(r.updates) ? r.updates.slice(0, 16) : [];
  for (const u0 of updates) {
    if (!u0 || typeof u0 !== 'object') continue;
    const u = u0 as Record<string, unknown>;
    const quote = input.kind === 'option' ? said : quoteIn(u.quote, said);
    const inferred = u.inferred === true || !quote;
    let c: Complaint | undefined;
    const cid = typeof u.complaint === 'string' ? u.complaint : '';
    if (cid === 'new' || cid.startsWith('new')) {
      const key = cid + String(u.concept ?? '') + String(u.label ?? '');
      c = base.complaints.find((x) => x.id === newIds[key]);
      if (!c) {
        const concept = typeof u.concept === 'string' && (CONCEPT_BY_ID[u.concept] || u.concept === 'other') ? u.concept : 'other';
        if (base.complaints.some((x) => x.concept === concept && concept !== 'other' && concept !== 'pain')) c = base.complaints.find((x) => x.concept === concept);
        else {
          const k = CONCEPT_BY_ID[concept];
          const lab = typeof u.label === 'string' && u.label.trim().length <= 60 ? u.label.trim() : '';
          if (!k && !lab) continue;
          c = { id: nextId(), concept, en: k?.en ?? (rec.lang === 'en' ? lab : lab), ar: k?.ar ?? lab, quote: said.slice(0, 300), via, prov: inferred ? 'inferred' : 'said', confirmed: !inferred,
            regions: (k?.regions ?? []).map((id) => ({ id, quote: quote ?? undefined, prov: prov(inferred, quote), by: 'ai' as const, via, confirmed: !inferred })), facts: {}, unknown: [], asked: [] };
          if (lab && k) { if (rec.lang === 'ar') c.ar = lab; else c.en = lab; }
          if (k?.sensation) c.facts.sensation = { value: k.sensation, en: k.sensation, ar: SENSATIONS.find((s) => s.value === k.sensation)?.ar ?? k.sensation, ...(quote ? { quote } : {}), prov: prov(inferred, quote), by: 'ai', via, confirmed: !inferred };
          base.complaints.push(c);
          newIds[key] = c.id;
          const main = base.complaints.find((x) => x.id === prev.pending?.complaint);
          if (prev.pending?.slot === 'associated' && main && main !== c) { c.with = main.id; main.facts.associated = { value: concept, en: c.en, ar: c.ar, ...(quote ? { quote } : {}), prov: prov(inferred, quote), by: 'ai', via, confirmed: !inferred }; }
        }
      }
    } else c = base.complaints.find((x) => x.id === cid);
    if (!c) continue;
    const field = u.field;
    if (field === 'regions' || field === 'region') {
      const vals = (Array.isArray(u.value) ? u.value : [u.value]).filter((v): v is string => typeof v === 'string' && (REGION_IDS.includes(v) || BODY.some((b) => b.region === v && b.sided)));
      addRegions(c, vals, quote ?? undefined, prov(inferred, quote), 'ai', via);
      continue;
    }
    if (typeof field !== 'string' || !FIELDS.includes(field as SlotId)) continue;
    const slot = field as SlotId;
    const value = typeof u.value === 'number' ? String(u.value) : typeof u.value === 'string' ? u.value.trim().toLowerCase() : '';
    if (!value || (ENUMS[slot] && !ENUMS[slot].includes(value)) || (slot === 'location' && value.length > 60)) continue;
    const area = CONCEPT_BY_ID[c.concept]?.area;
    const w = wordsFor(slot, value, area); if (!w) continue;
    const old = c.facts[slot];
    if (old && old.value !== value) {
      if (u.correction !== true && old.confirmed) continue; // a contradiction is not silently overwritten
      base.corrections.push({ complaint: c.id, field: slot, from: old.en, to: w.en, ...(quote ? { quote } : {}), by: 'patient' });
    }
    c.facts[slot] = { value, en: slot === 'location' && !w.en ? value : w.en, ar: w.ar, ...(quote ? { quote } : {}), prov: prov(inferred, quote), by: 'ai', via, confirmed: !inferred };
    c.unknown = c.unknown.filter((s) => s !== slot);
    if (slot === 'side') {
      // "left" turns a body part with sides into the left one
      const sided = c.regions.filter((x) => !/_(l|r)$/.test(x.id) && BODY.some((b) => b.region === x.id && b.sided));
      for (const x of sided) {
        addRegions(c, sidedIds(x.id, value), quote ?? undefined, x.prov, 'ai', via);
        for (const id of sidedIds(x.id, value)) { const nr = c.regions.find((r) => r.id === id); if (nr) { nr.prov = x.prov; nr.confirmed = x.confirmed; } }
      }
    }
  }
  // What the vocabulary rules understood from the same words is never lost when the AI misses it:
  // a symptom, body part, time or strength found by the rules (always quoted from the patient's words)
  // fills only what the AI left empty, and never overrides an AI value.
  if (input.kind === 'text') {
    const rt = ruleTurn(prev, input).rec;
    const isNew = (x: Complaint) => !prev.complaints.some((p) => p.id === x.id);
    const aiNew = base.complaints.filter(isNew);
    const ruleNew = rt.complaints.filter(isNew);
    const fill = (c: Complaint, rc: Complaint, before?: Complaint) => {
      if (rc.concept === 'pain' && c.concept === 'pain' && !c.regions.length && rc.regions.length) { c.en = rc.en; c.ar = rc.ar; }
      const have = new Set([...c.regions, ...(before?.regions ?? [])].map((x) => x.id));
      const add = rc.regions.filter((x) => !have.has(x.id));
      if (add.length) addRegions(c, add.map((x) => x.id), add[0].quote, add[0].prov, 'rules', via);
      for (const [slot, f] of Object.entries(rc.facts) as [SlotId, Fact][]) if (f && !c.facts[slot] && !before?.facts[slot]) c.facts[slot] = f;
    };
    // complaints that already existed: new details the rules found in this message
    for (const rc of rt.complaints.filter((x) => !isNew(x))) { const c = base.complaints.find((x) => x.id === rc.id); if (c) fill(c, rc, prev.complaints.find((p) => p.id === rc.id)); }
    // new complaints: matched to the AI's by symptom (or one-to-one), otherwise added from the rules
    for (const rc of ruleNew) {
      const c = aiNew.find((x) => x.concept === rc.concept) ?? (aiNew.length === 1 && ruleNew.length === 1 ? aiNew[0] : undefined);
      if (c) fill(c, rc);
      else if (!(rc.concept === 'unwell' && base.complaints.length) && !base.complaints.some((x) => x.concept === rc.concept && rc.concept !== 'pain')) base.complaints.push({ ...JSON.parse(JSON.stringify(rc)), id: nextId(), asked: [] } as Complaint);
    }
    for (const d of rt.denied) if (!base.denied.includes(d) && !base.complaints.some((c) => c.concept === d)) base.denied.push(d);
  }
  for (const d of Array.isArray(r.denies) ? r.denies : []) if (typeof d === 'string' && CONCEPT_BY_ID[d] && !base.denied.includes(d) && !base.complaints.some((c) => c.concept === d)) base.denied.push(d);
  for (const n of Array.isArray(r.not_sure) ? r.not_sure : []) {
    const x = n as Record<string, unknown>; const c = base.complaints.find((k) => k.id === x?.complaint);
    if (c && typeof x.field === 'string' && FIELDS.includes(x.field as SlotId) && !c.facts[x.field as SlotId] && !c.unknown.includes(x.field as SlotId)) c.unknown.push(x.field as SlotId);
  }
  // a patient question is kept for the doctor
  if (input.kind === 'text' && /[?؟]\s*$/.test(said.trim())) base.notes.push({ text: said.slice(0, 300), via, kind: 'question' });

  // urgency: rules always; AI can add
  const urgent = safetyCheck(base, said);
  if (r.urgent === true) urgent.push(`AI safety check: ${typeof r.urgent_reason === 'string' && r.urgent_reason.trim() ? r.urgent_reason.trim().slice(0, 140) : 'your words may describe something urgent'}`);
  const newUrgent = [...new Set(urgent)].filter((x) => !base.urgent.includes(x));
  base.urgent.push(...newUrgent);

  // next question: the AI's, if it is about a real complaint and not already answered; else the rules' choice
  let q: Pending | null = null;
  const rq = r.question as Record<string, unknown> | null | undefined;
  if (rq && typeof rq === 'object') {
    const text = guardReply(rq.text, 260);
    const c = base.complaints.find((x) => x.id === rq.complaint) ?? base.complaints.find((x) => x.id === newIds[Object.keys(newIds)[0]]);
    const slot = typeof rq.field === 'string' && FIELDS.includes(rq.field as SlotId) ? rq.field as SlotId : undefined;
    const already = c && slot && (c.facts[slot]?.confirmed || (slot === 'location' && c.concept === 'pain' && c.regions.length > 0));
    const opts = Array.isArray(rq.options) ? rq.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0 && o.length <= 48 && !!guardReply(o, 48)).slice(0, 8) : [];
    if (text && !already) {
      q = { kind: slot ? 'slot' : 'opening', ...(c ? { complaint: c.id } : {}), ...(slot ? { slot } : {}), text, options: opts.map((o, i) => ({ id: `ai:${i}`, label: o })), ai: true };
      if (c && slot && !c.asked.includes(slot)) c.asked.push(slot);
    }
  }
  // unconfirmed interpretations are always checked with the patient first (rules decide that question)
  const rulesNext = nextQuestion(base);
  if (rulesNext?.kind === 'confirm' || rulesNext?.kind === 'clarify_conflict') q = rulesNext;
  let review = false;
  if (!q && rq === null) {
    // the AI thinks the doctor has enough; ask "anything else?" once, then review
    if (!base.anythingElseAsked && rulesNext) { q = nextQuestion({ ...base, complaints: base.complaints.map((c) => ({ ...c, asked: [...c.asked, 'location', 'side', 'sensation', 'severity', 'onset', 'onset_type', 'pattern', 'associated'] as SlotId[] })) }); }
    if (!q) review = true;
  }
  if (!q && !review) q = rulesNext;
  if (!q) review = true;
  if (q?.kind === 'anything_else') base.anythingElseAsked = true;
  base.pending = q;
  base.misses = 0;
  base.ai.used++;
  const say = [reply, ...(q ? [q.text] : [])];
  base.turns.push({ who: 'assistant', text: say.join(' '), ai: true });
  return { rec: base, say, options: q?.options ?? [], urgent: newUrgent, review, ai: true };
}

/** One turn: AI when available (validated), otherwise the rules. */
export async function converse(rec: ConsultRecord, input: ConsultInput, ask: ((prompt: string) => Promise<unknown>) | null): Promise<ConsultTurn> {
  // explicit structured answers (a tapped rule option, yes/no, body map) never need the AI
  const structured = input.kind === 'regions' || (input.kind === 'option' && !input.id.startsWith('ai:'))
    || rec.pending?.kind === 'confirm' || rec.pending?.kind === 'clarify_conflict';
  if (ask && !structured) {
    let raw: unknown = null;
    try { raw = await ask(buildPrompt(rec, input)); } catch { raw = null; }
    const t = raw ? applyAI(rec, input, raw) : null;
    if (t) return t;
    const fallback = ruleTurn(rec, input.kind === 'option' ? { kind: 'text', text: input.label, via: input.via } : input);
    fallback.rec.ai.failed++;
    fallback.rec.ai.lastError = raw ? 'answer failed the checks' : 'no answer';
    return fallback;
  }
  return ruleTurn(rec, input.kind === 'option' && input.id.startsWith('ai:') ? { kind: 'text', text: input.label, via: input.via } : input);
}
