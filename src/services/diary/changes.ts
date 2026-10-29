// "What changed?" for the doctor: compares a patient's shared diary entries over
// time. The rules always run and every line cites the entries it comes from
// (D1, D2 … oldest first, C1 … for shared reports). AI may only reword the
// facts into a short summary; each AI line must cite real references, may not add
// numbers that are not in the facts, and may not diagnose or advise.
import { dateLocale } from '../../i18n/lang';
import type { DiaryEntry, DiaryItem, Trend } from '../../domain/diary';
import { PROMPT_PREFIX } from '../clinical/engine';

export interface ChangeLine { id: string; level: 'urgent' | 'attention' | 'info'; en: string; ar: string; refs: string[] }
export interface ReportRef { id: string; ref: string; at: string; status: string }
export interface ChangeSummary {
  lines: ChangeLine[];
  /** entries in date order with their reference ids */
  refs: { ref: string; entry: DiaryEntry }[];
  reports: ReportRef[];
  ai?: { lines: { text: string; refs: string[] }[]; rejected: number };
}

const DAY = 86400_000;
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);
const d = (iso: string, lang: string) => new Date(iso).toLocaleDateString(dateLocale(lang), { day: 'numeric', month: 'short' });
const keyOf = (i: DiaryItem) => (i.concept === 'pain' || i.concept === 'other' ? `${i.concept}:${i.en.toLowerCase()}` : i.concept);

export function whatChanged(entriesIn: DiaryEntry[], reports: { id: string; at: string; status: string }[] = [], nowIso = new Date().toISOString()): ChangeSummary {
  const entries = [...entriesIn].sort((a, b) => a.at.localeCompare(b.at));
  const refs = entries.map((entry, k) => ({ ref: `D${k + 1}`, entry }));
  const reportRefs: ReportRef[] = [...reports].sort((a, b) => a.at.localeCompare(b.at)).map((r, k) => ({ ...r, ref: `C${k + 1}` }));
  const lines: ChangeLine[] = [];
  let n = 0;
  const add = (level: ChangeLine['level'], en: string, ar: string, r: string[]) => lines.push({ id: `K${++n}`, level, en, ar, refs: r });
  if (!refs.length) return { lines, refs, reports: reportRefs };

  // urgent-help guidance shown while writing
  for (const { ref, entry } of refs) {
    if (entry.urgent.length && days(entry.at, nowIso) <= 14) add('urgent', `Urgent-help guidance was shown to the patient (${d(entry.at, 'en')}): ${entry.urgent.join('; ')}.`, `ظهرت للمريض إرشادات الطوارئ (${d(entry.at, 'ar')}): ${entry.urgent.join('؛ ')}.`, [ref]);
  }

  // per symptom
  const by = new Map<string, { item: DiaryItem; ref: string; at: string }[]>();
  for (const { ref, entry } of refs) for (const item of entry.items) {
    const k = keyOf(item); if (!by.has(k)) by.set(k, []); by.get(k)!.push({ item, ref, at: entry.at });
  }
  const recentStart = new Date(new Date(nowIso).getTime() - 7 * DAY).toISOString();
  const hasOlder = refs.some((r) => r.entry.at < recentStart) || reportRefs.some((r) => r.at < recentStart);
  for (const [, pts] of by) {
    const name = pts[pts.length - 1].item; const label = { en: name.en, ar: name.ar };
    const sev = pts.filter((p) => p.item.severity !== null);
    if (sev.length >= 2) {
      const a = sev[0], b = sev[sev.length - 1];
      const delta = b.item.severity! - a.item.severity!;
      const span = Math.max(1, days(a.at, b.at));
      if (delta >= 2) add('attention', `${cap(label.en)} got stronger: ${a.item.severity} → ${b.item.severity} out of 10 over ${span} day(s).`, `${label.ar} زاد: من ${a.item.severity} إلى ${b.item.severity} من 10 خلال ${span} يوم.`, [a.ref, b.ref]);
      else if (delta <= -2) add('info', `${cap(label.en)} eased: ${a.item.severity} → ${b.item.severity} out of 10 over ${span} day(s).`, `${label.ar} خف: من ${a.item.severity} إلى ${b.item.severity} من 10 خلال ${span} يوم.`, [a.ref, b.ref]);
      else add('info', `${cap(label.en)} about the same: ${a.item.severity} → ${b.item.severity} out of 10.`, `${label.ar} تقريبًا زي ما هو: من ${a.item.severity} إلى ${b.item.severity} من 10.`, [a.ref, b.ref]);
    } else {
      const last3 = pts.slice(-3).filter((p) => p.item.trend);
      const worse = last3.filter((p) => p.item.trend === 'worse');
      const better = last3.filter((p) => p.item.trend === 'better');
      if (worse.length >= 2 && worse.length > better.length) add('attention', `${cap(label.en)}: the patient said “worse” in ${worse.length} of the last ${last3.length} check-ins that mention it.`, `${label.ar}: المريض قال "أسوأ" في ${worse.length} من آخر ${last3.length} مرات اتذكر فيها.`, worse.map((p) => p.ref));
      else if (better.length >= 2 && better.length > worse.length) add('info', `${cap(label.en)}: the patient said “better” in ${better.length} of the last ${last3.length} check-ins that mention it.`, `${label.ar}: المريض قال "أحسن" في ${better.length} من آخر ${last3.length} مرات اتذكر فيها.`, better.map((p) => p.ref));
    }
    if (hasOlder && pts[0].at >= recentStart) add('attention', `New: ${label.en}, first noted ${d(pts[0].at, 'en')}.`, `جديد: ${label.ar}، أول مرة اتذكر ${d(pts[0].at, 'ar')}.`, [pts[0].ref]);
    const lastMention = pts[pts.length - 1];
    const later = refs.filter((r) => r.entry.at > lastMention.at && r.entry.items.length > 0);
    if (later.length >= 3) add('info', `${cap(label.en)} has not been mentioned since ${d(lastMention.at, 'en')} (${later.length} check-ins).`, `${label.ar} ماتذكرش من ${d(lastMention.at, 'ar')} (${later.length} مرات تسجيل).`, [lastMention.ref, later[later.length - 1].ref]);
  }

  // overall feeling in the last check-ins
  const lastF = refs.slice(-5).filter((r) => r.entry.feeling);
  const fw = lastF.filter((r) => r.entry.feeling === 'worse'); const fb = lastF.filter((r) => r.entry.feeling === 'better');
  if (fw.length >= 2 && fw.length > fb.length) add('attention', `Feels worse overall in ${fw.length} of the last ${lastF.length} check-ins.`, `حاسس إنه أسوأ عمومًا في ${fw.length} من آخر ${lastF.length} مرات تسجيل.`, fw.map((r) => r.ref));
  else if (fb.length >= 2 && fb.length > fw.length) add('info', `Feels better overall in ${fb.length} of the last ${lastF.length} check-ins.`, `حاسس إنه أحسن عمومًا في ${fb.length} من آخر ${lastF.length} مرات تسجيل.`, fb.map((r) => r.ref));

  // medicine
  const med = refs.slice(-7).filter((r) => r.entry.medicine);
  const missed = med.filter((r) => r.entry.medicine !== 'yes');
  if (missed.length) add('attention', `Medicine not taken or only partly taken in ${missed.length} of ${med.length} check-ins that mention it.`, `الدوا ماتخدش أو اتاخد جزئيًا في ${missed.length} من ${med.length} مرات اتذكر فيها.`, missed.map((r) => r.ref));
  else if (med.length >= 2) add('info', `Medicine taken in all ${med.length} check-ins that mention it.`, `الدوا اتاخد في كل الـ${med.length} مرات اللي اتذكر فيها.`, med.map((r) => r.ref));

  // gaps
  const last = refs[refs.length - 1];
  const gap = days(last.entry.at, nowIso);
  if (gap >= 4) add('info', `No check-in for ${gap} days (last: ${d(last.entry.at, 'en')}).`, `مفيش تسجيل من ${gap} أيام (آخر مرة: ${d(last.entry.at, 'ar')}).`, [last.ref]);
  const lastReport = reportRefs[reportRefs.length - 1];
  if (lastReport) {
    const since = refs.filter((r) => r.entry.at > lastReport.at).length;
    add('info', `${since} check-in(s) since the last shared report (${d(lastReport.at, 'en')}).`, `${since} تسجيل من آخر تقرير اتبعت (${d(lastReport.at, 'ar')}).`, [lastReport.ref, ...(since ? [refs[refs.length - 1].ref] : [])]);
  }
  const order = { urgent: 0, attention: 1, info: 2 } as const;
  lines.sort((a, b) => order[a.level] - order[b.level]);
  return { lines, refs, reports: reportRefs };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- AI wording (optional)
export function changesPrompt(s: ChangeSummary): string {
  const allowed = s.refs.filter((r) => r.entry.aiAllowed).slice(-25); // the latest 25 (keeps the request within the server's size limit)
  return `${PROMPT_PREFIX} Task: what changed. Write a short summary (at most 5 lines) of how this patient's own daily check-ins changed over time, for their treating doctor.
Rules: describe only what is in the facts and check-ins below; every line must cite references like ["D2","D5"] or fact ids like ["K1"]; do not add numbers that are not written below; do not diagnose, name possible illnesses, suggest causes, tests or treatments, or reassure. Plain English.
Facts computed by AccessCare (with their references):
${s.lines.slice(0, 30).map((l) => `${l.id} [${l.refs.join(',')}] ${l.en}`).join('\n')}
Check-ins (patient-approved, oldest first):
${allowed.map((r) => `${r.ref} ${r.entry.at.slice(0, 10)} feeling=${r.entry.feeling ?? 'not said'} medicine=${r.entry.medicine ?? 'not said'} items=${r.entry.items.map((i) => `${i.en}${i.severity !== null ? ` ${i.severity}/10` : ''}${i.trend ? ` ${i.trend}` : ''}`).join('; ') || 'none'} words=${JSON.stringify(r.entry.text.slice(0, 200))}`).join('\n')}
Reply with only JSON: {"lines":[{"text":"...","refs":["D1","D3"]}]}`;
}

const BAD = /\b(diagnos\w*|likely|probabl\w*|possibl\w*|suggest\w*|indicat\w*|consistent with|caused by|due to|should|must|recommend\w*|prescrib\w*|consider\w*|treat\w*|dose|infection|disease|disorder|syndrome|don'?t worry|nothing serious|reassur\w*)\b/i;

export function applyChangesAI(s: ChangeSummary, raw: unknown): ChangeSummary {
  const known = new Set([...s.refs.filter((r) => r.entry.aiAllowed).map((r) => r.ref), ...s.lines.map((l) => l.id), ...s.reports.map((r) => r.ref)]);
  const source = s.lines.map((l) => l.en).join(' ') + ' ' + s.refs.filter((r) => r.entry.aiAllowed).map((r) => `${r.entry.text} ${r.entry.items.map((i) => i.severity ?? '').join(' ')} ${r.entry.at}`).join(' ');
  const nums = new Set(source.match(/\d+/g) ?? []);
  const out: { text: string; refs: string[] }[] = [];
  let rejected = 0;
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { lines?: unknown }).lines) ? (raw as { lines: unknown[] }).lines.slice(0, 8) : [];
  for (const x of list) {
    const l = x as { text?: unknown; refs?: unknown };
    const text = typeof l.text === 'string' ? l.text.replace(/\s+/g, ' ').trim().slice(0, 260) : '';
    const r = Array.isArray(l.refs) ? l.refs.filter((v): v is string => typeof v === 'string' && known.has(v)) : [];
    const badNum = (text.match(/\d+/g) ?? []).some((v) => !nums.has(v));
    if (!text || !r.length || BAD.test(text) || badNum || out.length >= 5) { rejected++; continue; }
    out.push({ text, refs: [...new Set(r)] });
  }
  return { ...s, ai: { lines: out, rejected } };
}

export type ClinicalAsk = (prompt: string, maxTokens: number) => Promise<{ json: unknown } | { error: string }>;
export async function summarizeChanges(s: ChangeSummary, ask: ClinicalAsk): Promise<ChangeSummary | { error: string }> {
  if (!s.refs.some((r) => r.entry.aiAllowed)) return { error: 'The patient has not allowed AI for their check-ins, so only the rule-based summary is shown.' };
  const r = await ask(changesPrompt(s), 900);
  if ('error' in r) return r;
  return applyChangesAI(s, r.json);
}

/** Points for a chart: one series per symptom that has at least one strength value. */
export function seriesOf(entries: DiaryEntry[]): { key: string; en: string; ar: string; points: { at: string; v: number }[] }[] {
  const m = new Map<string, { key: string; en: string; ar: string; points: { at: string; v: number }[] }>();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) for (const i of e.items) {
    if (i.severity === null) continue;
    const k = keyOf(i);
    if (!m.has(k)) m.set(k, { key: k, en: i.en, ar: i.ar, points: [] });
    m.get(k)!.points.push({ at: e.at, v: i.severity });
  }
  return [...m.values()].sort((a, b) => b.points.length - a.points.length);
}
export type { Trend };
