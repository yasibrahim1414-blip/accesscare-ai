// Teach-back: the patient explains the treatment plan in their own words
// (English or Arabic); AccessCare compares it with what the doctor actually
// wrote (the approved prescription and visit explanation). The rules check the
// medicine name, the dose, how often, for how long, and when to get urgent help.
// With AI (only if the patient allowed it), Claude may judge points the rules
// could not find — but only by quoting the patient's own words. The "correct"
// wording shown to the patient is always the doctor's, never AI text.
import type { Message } from '../../domain/types';
import type { TBPoint, TBStatus } from '../../domain/interact';
import { CONVERSE_PREFIX } from '../conversation/ai';
import { norm } from '../conversation/lexicon';

export interface PlanPoint { id: string; label: { en: string; ar: string }; correct: string; kind: 'name' | 'dose' | 'frequency' | 'duration' | 'urgent'; med?: string }

const AR_NUM: Record<string, number> = { 'واحد': 1, 'واحده': 1, 'اتنين': 2, 'اثنين': 2, 'تلاته': 3, 'ثلاثه': 3, 'تلات': 3, 'ثلاث': 3, 'اربعه': 4, 'اربع': 4, 'خمسه': 5, 'خمس': 5, 'سته': 6, 'ست': 6, 'سبعه': 7, 'سبع': 7, 'تمنيه': 8, 'تمانيه': 8, 'تسعه': 9, 'عشره': 10, 'عشر': 10 };
const EN_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, twenty: 20, thirty: 30 };
const num = (w: string): number | null => (/^\d+$/.test(w) ? Number(w) : EN_NUM[w] ?? AR_NUM[w] ?? null);

/** times per day, from "twice daily", "3 times a day", "every 8 hours", "مرتين في اليوم", "كل ٨ ساعات" */
export function timesPerDay(text: string): { value: number; quote: string } | null {
  const t = norm(text);
  const pats: [RegExp, (m: RegExpMatchArray) => number | null][] = [
    [/\bevery (\w+) hours?\b/, (m) => { const n = num(m[1]); return n ? Math.round(24 / n) : null; }],
    [/كل (\S+) (ساعات|ساعه)/, (m) => { const n = num(m[1]); return n ? Math.round(24 / n) : null; }],
    [/\b(once|one time)\b( a| per| each)? ?(day|daily)?/, () => 1],
    [/\b(twice|two times)\b/, () => 2],
    [/\b(three times|thrice)\b/, () => 3],
    [/\b(four times)\b/, () => 4],
    [/\b(\d+|\w+) times?( a| per| each)? ?(day|daily)\b/, (m) => num(m[1])],
    [/\bmorning and (night|evening)\b/, () => 2],
    [/مرتين|مرتان/, () => 2],
    [/(\S+) مرات/, (m) => num(m[1])],
    [/مره (واحده )?(في|كل) (اليوم|يوم)|مره واحده|مره في اليوم|مره يوميا/, () => 1],
    [/الصبح و ?(بالليل|المسا|الليل)/, () => 2],
    [/\b(daily|a day|every day)\b|يوميا|كل يوم/, () => 1],
  ];
  return firstMatch(t, pats);
}
/** days, from "5 days", "for a week", "خمس أيام", "أسبوع" */
export function durationDays(text: string): { value: number; quote: string } | null {
  const t = norm(text);
  const pats: [RegExp, (m: RegExpMatchArray) => number | null][] = [
    [/\b(\d+|\w+) days?\b/, (m) => num(m[1])],
    [/\b(\d+|\w+) weeks?\b/, (m) => { const n = num(m[1]); return n ? n * 7 : null; }],
    [/\b(a|one) week\b/, () => 7],
    [/(\S+) (ايام|يوم)/, (m) => num(m[1])],
    [/اسبوعين/, () => 14],
    [/(\S+) اسابيع/, (m) => { const n = num(m[1]); return n ? n * 7 : null; }],
    [/اسبوع/, () => 7],
  ];
  return firstMatch(t, pats);
}
/** units per dose, from "1 tablet", "two pills", "حباية", "حبايتين" */
export function doseCount(text: string): { value: number; quote: string } | null {
  const t = norm(text);
  const pats: [RegExp, (m: RegExpMatchArray) => number | null][] = [
    [/\b(\d+|\w+) (tablets?|pills?|capsules?|caps?)\b/, (m) => num(m[1])],
    [/\b(a|one) (tablet|pill|capsule)\b/, () => 1],
    [/حبايتين|قرصين|كبسولتين/, () => 2],
    [/(\S+) (حبايات|اقراص|كبسولات)/, (m) => num(m[1])],
    [/حبايه|قرص|كبسوله/, () => 1],
  ];
  return firstMatch(t, pats);
}
function firstMatch(t: string, pats: [RegExp, (m: RegExpMatchArray) => number | null][]): { value: number; quote: string } | null {
  for (const [re, f] of pats) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) { const v = f(m); if (v) return { value: v, quote: m[0].trim() }; }
  }
  return null;
}
const URGENT_RE = /\b(emergency|ambulance|call 99\d|call 123|call 112|hospital|er\b)|طوارئ|اسعاف|الاسعاف|المستشفى|اتصل|998|999|123/;

/** The points to check, from the doctor's approved messages of one consultation (latest prescriptions and explanation). */
export function planPoints(msgs: Message[]): PlanPoint[] {
  const out: PlanPoint[] = [];
  const rxs = msgs.filter((m) => m.kind === 'prescription' && m.meta?.rx);
  for (const m of rxs.slice(-3)) {
    const rx = m.meta!.rx!; const med = rx.medication;
    out.push({ id: `rx:${rx.id}:name`, kind: 'name', med, label: { en: 'Which medicine', ar: 'اسم الدوا' }, correct: med });
    if (doseCount(rx.dose)) out.push({ id: `rx:${rx.id}:dose`, kind: 'dose', med, label: { en: `${med}: how much each time`, ar: `${med}: الجرعة كل مرة` }, correct: rx.dose });
    if (timesPerDay(rx.frequency)) out.push({ id: `rx:${rx.id}:frequency`, kind: 'frequency', med, label: { en: `${med}: how often`, ar: `${med}: كام مرة في اليوم` }, correct: rx.frequency });
    if (durationDays(rx.duration)) out.push({ id: `rx:${rx.id}:duration`, kind: 'duration', med, label: { en: `${med}: for how long`, ar: `${med}: لمدة قد إيه` }, correct: rx.duration });
  }
  const vs = [...msgs].reverse().find((m) => m.kind === 'visit_summary' && m.meta?.summary);
  // no prescription: how often / how long / how much come from the doctor's explanation, when it says so
  if (!rxs.length && vs) {
    const sentences = vs.meta!.summary!.text.split(/(?<=[.!؟?])\s+|\n/).map((x) => x.trim()).filter(Boolean);
    const pick = (f: (t: string) => unknown) => sentences.find((x) => f(x));
    const d = pick(doseCount), fr = pick(timesPerDay), du = pick(durationDays);
    if (d) out.push({ id: 'visit:dose', kind: 'dose', label: { en: 'How much each time', ar: 'الجرعة كل مرة' }, correct: d.slice(0, 300) });
    if (fr) out.push({ id: 'visit:frequency', kind: 'frequency', label: { en: 'How often', ar: 'كام مرة في اليوم' }, correct: fr.slice(0, 300) });
    if (du) out.push({ id: 'visit:duration', kind: 'duration', label: { en: 'For how long', ar: 'لمدة قد إيه' }, correct: du.slice(0, 300) });
  }
  const urgentSrc = [vs?.meta?.summary?.text ?? '', ...rxs.map((m) => m.meta!.rx!.instructions)].join(' ');
  if (URGENT_RE.test(norm(urgentSrc)) || URGENT_RE.test(urgentSrc)) {
    const sentence = urgentSrc.split(/(?<=[.!؟?])\s+|\n/).find((x) => URGENT_RE.test(norm(x)) || URGENT_RE.test(x)) ?? '';
    out.push({ id: 'visit:urgent', kind: 'urgent', label: { en: 'When to get urgent help', ar: 'إمتى تطلب مساعدة عاجلة' }, correct: sentence.trim().slice(0, 300) });
  }
  return out;
}
/** The message the teach-back answers (latest prescription or explanation). */
export function planSource(msgs: Message[]): Message | null {
  return [...msgs].reverse().find((m) => (m.kind === 'prescription' && m.meta?.rx) || (m.kind === 'visit_summary' && m.meta?.summary)) ?? null;
}
/** true when the patient has not yet explained the latest plan */
export function teachBackDue(msgs: Message[]): boolean {
  const src = planSource(msgs);
  if (!src || !planPoints(msgs).length) return false;
  return !msgs.some((m) => m.kind === 'teachback' && m.createdAt >= src.createdAt);
}

const sameMed = (said: string, med: string) => {
  const t = norm(said); const m = norm(med);
  if (!m) return null;
  if (t.includes(m)) return med;
  const first = m.split(' ')[0];
  const words = t.split(' ');
  const hit = words.find((w) => w.length >= 4 && (w === first || (first.length >= 5 && w.slice(0, 5) === first.slice(0, 5))));
  return hit ?? null;
};

/** Rules: compares the patient's words with each plan point. */
export function checkRules(text: string, points: PlanPoint[]): TBPoint[] {
  const multi = new Set(points.filter((p) => p.kind === 'name').map((p) => p.med)).size > 1;
  return points.map((p) => {
    const base = { id: p.id, label: p.label.en, correct: p.correct, by: 'rules' as const };
    let status: TBStatus = 'missing'; let quote = '';
    // with several medicines, only the part of the text around this medicine's name counts
    const scope = multi && p.med ? (() => { const n = norm(text); const i = n.indexOf(norm(p.med!).split(' ')[0]); return i >= 0 ? n.slice(i, i + 140) : ''; })() : text;
    if (p.kind === 'name') { const q = sameMed(text, p.correct); if (q) { status = 'understood'; quote = q; } }
    else if (p.kind === 'urgent') { const n = norm(text); const m = n.match(URGENT_RE) ?? text.match(URGENT_RE); if (m) { status = 'understood'; quote = m[0]; } }
    else {
      const f = p.kind === 'dose' ? doseCount : p.kind === 'frequency' ? timesPerDay : durationDays;
      const want = f(p.correct); const got = scope ? f(scope) : null;
      if (want && got) { status = want.value === got.value ? 'understood' : 'different'; quote = got.quote; }
    }
    return { ...base, status, quote };
  });
}

// ---------------------------------------------------------------- AI (optional)
export function teachBackPrompt(text: string, points: PlanPoint[], lang: 'en' | 'ar'): string {
  return `${CONVERSE_PREFIX}. Task: teach-back check. After a visit, a patient explained their treatment plan in their own words. For each plan point, decide whether the patient's words show they understood it ("understood"), said something different ("different"), or did not mention it ("missing").
Rules: judge only from the patient's words; for "understood" or "different" you MUST copy the exact words from the patient's text into "quote"; never add advice, never change the plan, never reassure.
Plan points (what the doctor wrote): ${JSON.stringify(points.map((p) => ({ id: p.id, about: p.label.en, doctor_wrote: p.correct })))}
Patient's words (${lang === 'ar' ? 'Arabic' : 'English'}): ${JSON.stringify(text.slice(0, 1000))}
Reply with only JSON: {"points":[{"id":"...","status":"understood"|"different"|"missing","quote":"..."}]}`;
}
export function applyTeachBackAI(text: string, rules: TBPoint[], raw: unknown): { points: TBPoint[]; ai: boolean } {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { points?: unknown }).points) ? (raw as { points: unknown[] }).points : [];
  let used = false;
  const out = rules.map((r) => ({ ...r }));
  for (const x of list.slice(0, 30)) {
    const a = x as { id?: unknown; status?: unknown; quote?: unknown };
    const p = out.find((q) => q.id === a.id);
    if (!p || p.status !== 'missing') continue; // the rules' finding stands
    if (a.status !== 'understood' && a.status !== 'different') continue;
    const quote = typeof a.quote === 'string' ? a.quote.trim().slice(0, 200) : '';
    if (!quote || !norm(text).includes(norm(quote))) continue; // must be the patient's own words
    p.status = a.status; p.quote = quote; p.by = 'ai'; used = true;
  }
  return { points: out, ai: used };
}
export async function checkTeachBack(text: string, points: PlanPoint[], lang: 'en' | 'ar', ask: ((p: string) => Promise<unknown>) | null): Promise<{ points: TBPoint[]; ai: boolean }> {
  const rules = checkRules(text, points);
  if (!ask || !rules.some((p) => p.status === 'missing')) return { points: rules, ai: false };
  try { return applyTeachBackAI(text, rules, await ask(teachBackPrompt(text, points, lang))); } catch { return { points: rules, ai: false }; }
}
