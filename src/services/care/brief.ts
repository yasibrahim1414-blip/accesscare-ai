// Pre-visit brief for the doctor: one page built by fixed rules from what the
// patient shared — check-ins (D…), reports (C…), medicine check-ins (M…),
// understanding checks (T…), unanswered questions (Q…) and photos (P…). Every
// line cites its source. AI may only condense these lines (same checks as the
// "what changed" summary: real references, no new numbers, nothing diagnostic).
import { dateLocale } from '../../i18n/lang';
import type { DiaryEntry } from '../../domain/diary';
import type { Message } from '../../domain/types';
import type { DoseData, PatientRecord, PhotoData } from '../../domain/care';
import { whatChanged, type ChangeLine, type ChangeSummary } from '../diary/changes';
import { adherence, type MedPlan } from './meds';
import { PROMPT_PREFIX } from '../clinical/engine';

export interface BriefSection { key: 'urgent' | 'changes' | 'medicines' | 'understanding' | 'open' | 'photos'; en: string; ar: string; lines: ChangeLine[] }
export interface Brief { sections: BriefSection[]; summary: ChangeSummary; sources: { ref: string; en: string; ar: string; at: string }[]; ai?: { lines: { text: string; refs: string[] }[]; rejected: number } }

const d = (iso: string, lang: string) => new Date(iso).toLocaleDateString(dateLocale(lang), { day: 'numeric', month: 'short' });
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function buildBrief(input: {
  diary: DiaryEntry[];
  reports: { id: string; at: string; status: string }[];
  threads: { consultationId: string; messages: Message[] }[];
  plans: MedPlan[];
  doses: PatientRecord<DoseData>[];
  photos: PatientRecord<PhotoData>[];
  now?: Date;
}): Brief {
  const now = input.now ?? new Date();
  const summary = whatChanged(input.diary, input.reports, now.toISOString());
  const sources: Brief['sources'] = [
    ...summary.refs.map((r) => ({ ref: r.ref, en: `Check-in ${d(r.entry.at, 'en')}`, ar: `تسجيل ${d(r.entry.at, 'ar')}`, at: r.entry.at })),
    ...summary.reports.map((r) => ({ ref: r.ref, en: `Report ${d(r.at, 'en')}`, ar: `تقرير ${d(r.at, 'ar')}`, at: r.at })),
  ];
  let n = 100;
  const line = (level: ChangeLine['level'], en: string, ar: string, refs: string[]): ChangeLine => ({ id: `K${++n}`, level, en, ar, refs });

  // medicines
  const med: ChangeLine[] = [];
  const adh = adherence(input.plans, input.doses, 7, now);
  input.plans.filter((p) => p.active || adh.perMed.some((m) => m.name === p.name)).forEach((p, i) => {
    const ref = `M${i + 1}`;
    sources.push({ ref, en: `Prescription: ${p.name} ${p.dose}, ${p.frequency}`, ar: `روشتة: ${p.name} ${p.dose}، ${p.frequency}`, at: p.sentAt });
    const m = adh.perMed.find((x) => x.name === p.name);
    if (m && m.planned) {
      const k = pct(m.taken, m.planned);
      med.push(line(k < 80 ? 'attention' : 'info', `${p.name}: ${m.taken} of ${m.planned} scheduled doses checked in as taken in the last 7 days (${k}%).`, `${p.name}: ${m.taken} من ${m.planned} جرعة متسجلة إنها اتاخدت في آخر ٧ أيام (${k}%).`, [ref]));
    } else if (p.active && !p.asNeeded) med.push(line('info', `${p.name}: no dose check-ins shared yet.`, `${p.name}: مفيش تسجيلات جرعات متشاركة لسه.`, [ref]));
  });
  input.doses.filter((r) => r.data.status === 'side_effect').slice(0, 6).forEach((r, i) => {
    const ref = `M${input.plans.length + i + 1}`;
    sources.push({ ref, en: `Side-effect check-in ${d(r.at, 'en')}`, ar: `تسجيل عرض جانبي ${d(r.at, 'ar')}`, at: r.at });
    med.push(line(r.data.urgent.length ? 'urgent' : 'attention', `Side effect reported with ${r.data.medicine} (${d(r.at, 'en')}): “${r.data.sideEffect}”${r.by ? ` — recorded by caregiver ${r.by}` : ''}.`, `عرض جانبي مع ${r.data.medicine} (${d(r.at, 'ar')}): "${r.data.sideEffect}"${r.by ? ` — سجّله المرافق ${r.by}` : ''}.`, [ref]));
  });

  // understanding checks + unanswered questions
  const und: ChangeLine[] = [];
  const open: ChangeLine[] = [];
  let t = 0, q = 0;
  for (const th of input.threads) {
    const msgs = [...th.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of msgs) {
      if (m.kind === 'teachback' && m.meta?.teachback) {
        const ref = `T${++t}`;
        sources.push({ ref, en: `Understanding check ${d(m.createdAt, 'en')}`, ar: `مراجعة الفهم ${d(m.createdAt, 'ar')}`, at: m.createdAt });
        const pts = m.meta.teachback.points;
        const off = pts.filter((p) => p.status !== 'understood');
        und.push(line(off.length ? 'attention' : 'info',
          off.length ? `Understanding check: ${pts.length - off.length} of ${pts.length} points matched; different or missing: ${off.map((p) => p.label).join(', ')}.` : `Understanding check: all ${pts.length} points matched the plan.`,
          off.length ? `مراجعة الفهم: ${pts.length - off.length} من ${pts.length} نقاط مطابقة؛ مختلف أو ناقص: ${off.map((p) => p.label).join('، ')}.` : `مراجعة الفهم: كل الـ ${pts.length} نقاط مطابقة للخطة.`, [ref]));
      }
      const asks = m.senderRole === 'doctor' && (m.kind === 'yes_no_question' || m.kind === 'clarification' || m.kind === 'body_probe' || m.kind === 'followup');
      if (asks) {
        const answered = msgs.some((x) => x.senderRole === 'patient' && x.createdAt > m.createdAt && (x.meta?.replyTo === m.id || x.meta?.probeAnswer?.replyTo === m.id || x.meta?.followupAnswer?.replyTo === m.id || (m.kind === 'yes_no_question' && x.kind === 'text')));
        if (!answered) {
          const ref = `Q${++q}`;
          sources.push({ ref, en: `Your question ${d(m.createdAt, 'en')}`, ar: `سؤالك ${d(m.createdAt, 'ar')}`, at: m.createdAt });
          open.push(line('info', `Still unanswered by the patient: “${(m.meta?.probe?.question ?? m.body).slice(0, 120)}” (${d(m.createdAt, 'en')}).`, `لسه المريض مردش: "${(m.meta?.probe?.question ?? m.body).slice(0, 120)}" (${d(m.createdAt, 'ar')}).`, [ref]));
        }
      }
    }
  }

  // photos
  const ph: ChangeLine[] = [];
  const byArea = new Map<string, PatientRecord<PhotoData>[]>();
  for (const p of input.photos) byArea.set(p.data.area || 'Other', [...(byArea.get(p.data.area || 'Other') ?? []), p]);
  let pi = 0;
  for (const [area, rows] of byArea) {
    const ref = `P${++pi}`;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    sources.push({ ref, en: `Photos: ${area}`, ar: `صور: ${area}`, at: sorted[sorted.length - 1].at });
    ph.push(line('info', `${rows.length} photo(s) of ${area}, ${d(sorted[0].at, 'en')} → ${d(sorted[sorted.length - 1].at, 'en')} — compare them in Progress.`, `${rows.length} صورة لـ ${area}، ${d(sorted[0].at, 'ar')} ← ${d(sorted[sorted.length - 1].at, 'ar')} — قارنهم في التطور.`, [ref]));
  }

  const urgent = [...summary.lines.filter((l) => l.level === 'urgent'), ...med.filter((l) => l.level === 'urgent')];
  const sections: BriefSection[] = [
    { key: 'urgent' as const, en: 'Urgent', ar: 'عاجل', lines: urgent },
    { key: 'changes' as const, en: 'Since the patient’s check-ins began', ar: 'من أول تسجيلات المريض', lines: summary.lines.filter((l) => l.level !== 'urgent') },
    { key: 'medicines' as const, en: 'Medicines', ar: 'الأدوية', lines: med.filter((l) => l.level !== 'urgent') },
    { key: 'understanding' as const, en: 'Understanding of the plan', ar: 'فهم الخطة', lines: und },
    { key: 'open' as const, en: 'Open questions', ar: 'أسئلة مفتوحة', lines: open },
    { key: 'photos' as const, en: 'Photos', ar: 'الصور', lines: ph },
  ].filter((s) => s.lines.length);
  return { sections, summary, sources };
}

export function briefPrompt(b: Brief): string {
  const all = b.sections.flatMap((s) => s.lines);
  return `${PROMPT_PREFIX} Task: pre-visit brief. Condense the facts below into at most 5 short lines for the treating doctor, most important first.
Rules: use only these facts; every line must cite the fact ids or references it uses, like ["K101","M1"]; do not add numbers that are not written below; do not diagnose, name possible illnesses, suggest causes, tests or treatments, or reassure. Plain English.
Facts computed by AccessCare (with their references):
${all.slice(0, 40).map((l) => `${l.id} [${l.refs.join(',')}] ${l.en}`).join('\n')}
Reply with only JSON: {"lines":[{"text":"...","refs":["K101"]}]}`;
}

const BAD = /\b(diagnos\w*|likely|probabl\w*|possibl\w*|suggest\w*|indicat\w*|consistent with|caused by|due to|should|must|recommend\w*|prescrib\w*|consider\w*|treat\w*|infection|disease|disorder|syndrome|don'?t worry|nothing serious|reassur\w*)\b/i;

export function applyBriefAI(b: Brief, raw: unknown): Brief {
  const all = b.sections.flatMap((s) => s.lines);
  const known = new Set([...all.map((l) => l.id), ...all.flatMap((l) => l.refs)]);
  const nums = new Set(all.map((l) => l.en).join(' ').match(/\d+/g) ?? []);
  const out: { text: string; refs: string[] }[] = [];
  let rejected = 0;
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { lines?: unknown }).lines) ? (raw as { lines: unknown[] }).lines.slice(0, 8) : [];
  for (const x of list) {
    const l = x as { text?: unknown; refs?: unknown };
    const text = typeof l.text === 'string' ? l.text.replace(/\s+/g, ' ').trim().slice(0, 260) : '';
    const r = Array.isArray(l.refs) ? l.refs.filter((v): v is string => typeof v === 'string' && known.has(v)) : [];
    if (!text || !r.length || BAD.test(text) || (text.match(/\d+/g) ?? []).some((v) => !nums.has(v)) || out.length >= 5) { rejected++; continue; }
    out.push({ text, refs: [...new Set(r)] });
  }
  return { ...b, ai: { lines: out, rejected } };
}

// ---------------------------------------------------------------- alerts for the doctor's overview
export interface CareAlert { patientId: string; patientName: string; at: string; level: 'urgent' | 'attention'; en: string; ar: string; kind: 'diary' | 'side_effect' | 'missed' }

/** Recent things that need a look, from what each patient shared (last 3 days). */
export function alertsFor(patientId: string, patientName: string, diary: DiaryEntry[], doses: PatientRecord<DoseData>[], plans: MedPlan[], now = new Date()): CareAlert[] {
  const since = now.getTime() - 3 * 86400_000;
  const out: CareAlert[] = [];
  for (const e of diary) if (e.urgent.length && new Date(e.at).getTime() >= since)
    out.push({ patientId, patientName, at: e.at, level: 'urgent', kind: 'diary', en: `Urgent warning in a check-in: ${e.urgent.join(', ')}`, ar: `تحذير عاجل في تسجيل: ${e.urgent.join('، ')}` });
  for (const r of doses) if (r.data.status === 'side_effect' && new Date(r.at).getTime() >= since)
    out.push({ patientId, patientName, at: r.at, level: r.data.urgent.length ? 'urgent' : 'attention', kind: 'side_effect', en: `Side effect with ${r.data.medicine}: “${r.data.sideEffect}”`, ar: `عرض جانبي مع ${r.data.medicine}: "${r.data.sideEffect}"` });
  if (plans.length) {
    const a = adherence(plans, doses, 3, now);
    if (a.planned >= 3 && a.missed + a.notChecked >= Math.ceil(a.planned / 2))
      out.push({ patientId, patientName, at: now.toISOString(), level: 'attention', kind: 'missed', en: `${a.missed + a.notChecked} of ${a.planned} doses in the last 3 days missed or not checked in`, ar: `${a.missed + a.notChecked} من ${a.planned} جرعة في آخر ٣ أيام فاتت أو مش متسجلة` });
  }
  return out.sort((x, y) => (x.level === y.level ? y.at.localeCompare(x.at) : x.level === 'urgent' ? -1 : 1));
}
