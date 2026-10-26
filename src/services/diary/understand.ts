// Daily check-in: turns the patient's own words ("my headache is better today,
// about 4, but I feel dizzy") into diary items. Rules always run (English and
// Arabic); with AI on, Claude may add what the rules missed — every AI item must
// quote the patient's words, uses only known symptom ids, and the patient
// confirms everything before it is saved. Nothing here diagnoses.
import { understand, safetyCheck, startConsult } from '../conversation/Consult';
import { CONCEPT_BY_ID, norm } from '../conversation/lexicon';
import { CONVERSE_PREFIX } from '../conversation/ai';
import { regionLabel, regionLabelIn, REGION_BY_ID } from '../../domain/bodyRegions';
import type { DiaryItem, Trend } from '../../domain/diary';

export interface DiaryReading {
  items: DiaryItem[];
  feeling: Trend | null;
  medicine: 'yes' | 'some' | 'no' | null;
  urgent: string[];
  ai: boolean;
}

const TREND_WORDS: Record<Trend, RegExp> = {
  better: /\b(better|improv\w*|less|easing|eased|lighter|not as bad|gone|went away|disappeared)\b|(احسن|أحسن|اتحسن|اتحسنت|خف|خفت|خفيت|قل|قلت|راح|راحت|بقى احسن|بقيت احسن|الحمد لله احسن)/,
  worse: /\b(worse|worst|more|increas\w*|stronger|getting bad|bad again)\b|(اسوا|أسوأ|اوحش|أوحش|زاد|زادت|اشد|أشد|بقى اجمد|اجمد|بيزيد|زيادة|تعبان اكتر|اكتر من امبارح)/,
  same: /\b(same|no change|not changed|unchanged|as before|like yesterday)\b|(زي ما هو|زي ماهو|زي امبارح|نفس الحال|نفس الشيء|مفيش تغيير|مش متغير|ثابت)/,
};
const SEV_NUM: Record<string, number> = { mild: 3, moderate: 5, severe: 8 };
const MED_YES = /\b(took|taking|take) (my |the )?(medicine|medication|pills?|tablets?)\b|(خدت|اخدت|أخدت|باخد|بخد) (الدوا|الدواء|العلاج|الحباية|الحبوب)/;
const MED_NO = /\b(forgot|didn'?t take|did not take|stopped|skipped) (my |the |to take )?(medicine|medication|pills?|tablets?)\b|(نسيت|مخدتش|ماخدتش|وقفت|بطلت) (الدوا|الدواء|العلاج|الحباية|الحبوب)/;
const MED_SOME = /\b(sometimes|some days|missed (a|one|some) (dose|pill))\b|(ساعات باخد|نسيت مرة|فوت جرعة)/;

function trendOf(t: string): Trend | null {
  const n = norm(t);
  if (TREND_WORDS.worse.test(n) || TREND_WORDS.worse.test(t)) return 'worse';
  if (TREND_WORDS.better.test(n) || TREND_WORDS.better.test(t)) return 'better';
  if (TREND_WORDS.same.test(n) || TREND_WORDS.same.test(t)) return 'same';
  return null;
}

/** "my headache is better, but I feel dizzy" → ["my headache is better", "I feel dizzy"] */
export function clauses(text: string): string[] {
  return text.split(/[.!?؟،,;\n]+|\s+(?:but|and also|however|بس|لكن|وكمان|وبرضه|كمان)\s+/i).map((x) => x.trim()).filter(Boolean);
}

function labelFor(concept: string, regions: string[]): { en: string; ar: string } {
  const k = CONCEPT_BY_ID[concept];
  if (concept === 'pain' && regions.length) {
    return { en: `${regions.map((r) => (REGION_BY_ID[r] ? regionLabel(r) : r.replace(/_/g, ' ')).toLowerCase()).join(' and ')} pain`, ar: `وجع في ${regions.map((r) => regionLabelIn(r, 'ar')).join(' و')}` };
  }
  return { en: k?.en ?? concept, ar: k?.ar ?? k?.en ?? concept };
}

/** Rules only (always available, no AI). */
export function readDiaryRules(text: string): DiaryReading {
  const items: DiaryItem[] = [];
  let feeling: Trend | null = null;
  for (const c of clauses(text)) {
    const u = understand(c);
    const trend = trendOf(c);
    const bare = norm(c).match(/(?:^|\s)(10|[0-9])(?:\s*(?:\/|out of|من)\s*10)?(?:\s|$)/);
    const num = u.number?.value ?? (bare ? Number(bare[1]) : null);
    const sev = num ?? (u.severity ? SEV_NUM[u.severity.value] : null);
    const found = u.concepts.filter((x) => !x.negated && x.value !== 'unwell');
    if (!found.length) {
      const last = items[items.length - 1];
      // "…, about 4" / "worse than yesterday" right after a symptom belongs to that symptom
      if (last && num !== null && last.severity === null) last.severity = num;
      if (last && trend && last.trend === null) last.trend = trend;
      // "I feel better today" — about the day, not one symptom
      else if (trend && !feeling) feeling = trend;
      continue;
    }
    for (const h of found) {
      const regions = h.value === 'pain' ? u.body.filter((b) => !b.misspelled).map((b) => b.value) : [];
      const lab = labelFor(h.value, regions);
      if (items.some((i) => i.concept === h.value && i.en === lab.en)) continue;
      items.push({
        concept: h.value, en: lab.en, ar: lab.ar,
        severity: found.length === 1 && sev !== null && sev !== undefined ? sev : null,
        trend: found.length === 1 ? trend : null,
        quote: h.misspelled ? h.quote : c.slice(0, 160),
        prov: h.misspelled || (u.severity && num === null && found.length === 1) ? 'interpretation' : 'said',
      });
    }
  }
  const t = text;
  const medicine = MED_NO.test(t) ? 'no' : MED_SOME.test(t) ? 'some' : MED_YES.test(t) ? 'yes' : null;
  const urgent = [...new Set(safetyCheck(startConsult('en').rec, text))];
  return { items, feeling, medicine, urgent, ai: false };
}

// ---------------------------------------------------------------- AI (optional)
const ALLOWED = Object.keys(CONCEPT_BY_ID).filter((k) => k !== 'unwell');
export function diaryPrompt(text: string, lang: 'en' | 'ar'): string {
  return `${CONVERSE_PREFIX}. Task: daily symptom diary. A patient wrote or said a short daily check-in. Extract ONLY what they actually said: each symptom, how strong (0-10) if they said it, and whether it is better, the same or worse than before if they said it.
Rules: never diagnose, never suggest medicines, never add symptoms they did not mention. Every item must include "quote": words copied exactly from the patient's text. If they did not give a number, severity is null (you may convert "mild"/"moderate"/"severe" only as 3/5/8). Use concept ids from this list, or "other" with a short "label": ${JSON.stringify(ALLOWED)}.
Also: "feeling" = how they feel overall compared with before (better/same/worse) or null; "medicine" = whether they took their medicine (yes/some/no) or null.
Language of labels for "other": ${lang === 'ar' ? 'Egyptian Arabic' : 'English'}.
Patient's words: ${JSON.stringify(text.slice(0, 600))}
Reply with only JSON: {"items":[{"concept":"headache","label":null,"severity":4,"trend":"better","quote":"..."}],"feeling":"better"|"same"|"worse"|null,"medicine":"yes"|"some"|"no"|null}`;
}

const contains = (text: string, quote: string) => !!quote && norm(text).includes(norm(quote));

/** Merges a validated AI reading into the rules reading. Invalid AI items are dropped. */
export function applyDiaryAI(text: string, base: DiaryReading, raw: unknown): DiaryReading {
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as { items?: unknown; feeling?: unknown; medicine?: unknown };
  const out: DiaryReading = { ...base, items: base.items.map((i) => ({ ...i })) };
  let used = false;
  const numbers = new Set((norm(text).match(/\d+/g) ?? []).map(Number));
  const sevWords = /\b(mild|moderate|severe|slight|bad|terrible|awful|strong)\b|(خفيف|متوسط|شديد|جامد|بسيط|فظيع)/;
  for (const x of Array.isArray(r.items) ? r.items.slice(0, 8) : []) {
    if (!x || typeof x !== 'object') continue;
    const it = x as { concept?: unknown; label?: unknown; severity?: unknown; trend?: unknown; quote?: unknown };
    const quote = typeof it.quote === 'string' ? it.quote.trim().slice(0, 160) : '';
    if (!contains(text, quote)) continue; // must be the patient's own words
    const concept = typeof it.concept === 'string' && (ALLOWED.includes(it.concept) || it.concept === 'other') ? it.concept : null;
    if (!concept) continue;
    const label = concept === 'other' && typeof it.label === 'string' ? it.label.replace(/\s+/g, ' ').trim().slice(0, 50) : '';
    if (concept === 'other' && (!label || !contains(text, label.split(' ')[0]))) continue;
    let severity: number | null = typeof it.severity === 'number' && Number.isInteger(it.severity) && it.severity >= 0 && it.severity <= 10 ? it.severity : null;
    if (severity !== null && !numbers.has(severity) && !(sevWords.test(norm(quote)) && [3, 5, 8].includes(severity))) severity = null;
    const trend = it.trend === 'better' || it.trend === 'same' || it.trend === 'worse' ? it.trend : null;
    const lab = concept === 'other' ? { en: label, ar: label } : labelFor(concept, []);
    const existing = out.items.find((i) => i.concept === concept && (concept !== 'other' || i.en === label));
    if (existing) {
      if (existing.severity === null && severity !== null) { existing.severity = severity; used = true; }
      if (existing.trend === null && trend) { existing.trend = trend; used = true; }
      continue;
    }
    out.items.push({ concept, en: lab.en, ar: lab.ar, severity, trend, quote, prov: 'interpretation' });
    used = true;
  }
  if (!out.feeling && (r.feeling === 'better' || r.feeling === 'same' || r.feeling === 'worse')) { out.feeling = r.feeling; used = true; }
  if (!out.medicine && (r.medicine === 'yes' || r.medicine === 'some' || r.medicine === 'no')) { out.medicine = r.medicine; used = true; }
  out.ai = used;
  return out;
}

export async function readDiary(text: string, lang: 'en' | 'ar', ask: ((p: string) => Promise<unknown>) | null): Promise<DiaryReading> {
  const base = readDiaryRules(text);
  if (!ask || !text.trim()) return base;
  try { return applyDiaryAI(text, base, await ask(diaryPrompt(text, lang))); } catch { return base; }
}
