// Medicines between visits: the schedule comes only from prescriptions the doctor
// approved and sent (never invented); the patient checks in each dose (taken /
// missed / side effect); adherence is counted from those check-ins.
// Reminder times are device settings the patient can change (default times are
// spread over the day from "twice a day" etc.).

import type { Message } from '../../domain/types';
import type { RxMeta } from '../../domain/clinical';
import { localDay, type DoseData, type DoseStatus, type PatientRecord } from '../../domain/care';
import { durationDays, timesPerDay } from '../teachback/check';
import { readDiaryRules } from '../diary/understand';

export interface MedPlan {
  rxId: string;
  consultationId: string;
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
  sentAt: string;
  startDay: string;
  /** last day of the course (inclusive), null when no duration was written */
  endDay: string | null;
  perDay: number | null;
  asNeeded: boolean;
  /** reminder times (HH:MM), [] when taken only as needed */
  times: string[];
  active: boolean;
}

const DEFAULT_TIMES: Record<number, string[]> = {
  1: ['09:00'], 2: ['09:00', '21:00'], 3: ['08:00', '14:00', '20:00'], 4: ['08:00', '12:00', '16:00', '20:00'],
  5: ['07:00', '11:00', '15:00', '19:00', '23:00'], 6: ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'],
};
export const defaultTimes = (n: number | null) => (n && DEFAULT_TIMES[Math.min(6, Math.max(1, n))]) || [];

const addDays = (day: string, n: number) => { const [y, m, d] = day.split('-').map(Number); return localDay(new Date(y, m - 1, d + n)); };
const AS_NEEDED = /\b(as needed|when needed|if needed|prn|as required)\b|عند (الحاجه|اللزوم|الضروره)|لو احتجت/i;

/** Medicines from the prescriptions the doctor sent (newest prescription of a medicine wins). */
export function plansFromMessages(threads: { consultationId: string; messages: Message[] }[], today = new Date(), times: (rxId: string) => string[] | null = () => null): MedPlan[] {
  const out = new Map<string, MedPlan>();
  const all = threads.flatMap((t) => t.messages.filter((m) => m.kind === 'prescription' && m.meta?.rx).map((m) => ({ m, cid: t.consultationId })))
    .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt));
  for (const { m, cid } of all) {
    const rx = m.meta!.rx as RxMeta;
    const text = `${rx.frequency} ${rx.instructions}`;
    const asNeeded = AS_NEEDED.test(text.toLowerCase());
    const perDay = asNeeded ? null : timesPerDay(text)?.value ?? null;
    const days = durationDays(`${rx.duration} ${rx.instructions}`)?.value ?? null;
    const startDay = localDay(new Date(m.createdAt));
    const endDay = days ? addDays(startDay, days - 1) : null;
    const plan: MedPlan = {
      rxId: rx.id, consultationId: cid, name: rx.medication, dose: rx.dose, frequency: rx.frequency, duration: rx.duration,
      instructions: rx.instructions, sentAt: m.createdAt, startDay, endDay, perDay, asNeeded,
      times: asNeeded ? [] : (times(rx.id) ?? defaultTimes(perDay)),
      active: !endDay || endDay >= localDay(today),
    };
    out.set(rx.medication.trim().toLowerCase(), plan);
  }
  return [...out.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export type SlotState = DoseStatus | 'due' | 'upcoming' | 'not_checked';
export interface Slot { plan: MedPlan; slot: string; day: string; state: SlotState; record?: PatientRecord<DoseData> }

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const recordFor = (doses: PatientRecord<DoseData>[], rxId: string, day: string, slot: string) =>
  doses.find((r) => r.data.rxId === rxId && r.data.day === day && r.data.slot === slot);

/** Today's doses with their state: checked in, due now (−30 min…+2 h), still upcoming, or past and not checked. */
export function todaySlots(plans: MedPlan[], doses: PatientRecord<DoseData>[], now = new Date()): Slot[] {
  const day = localDay(now);
  const t = now.getHours() * 60 + now.getMinutes();
  const out: Slot[] = [];
  for (const plan of plans) {
    if (!plan.active || plan.startDay > day) continue;
    const sentDay = localDay(new Date(plan.sentAt));
    for (const slot of plan.times) {
      if (sentDay === day && minutes(slot) < minutes(localTime(new Date(plan.sentAt)))) continue; // prescribed after this time today
      const rec = recordFor(doses, plan.rxId, day, slot);
      const st: SlotState = rec ? rec.data.status : t < minutes(slot) - 30 ? 'upcoming' : t <= minutes(slot) + 120 ? 'due' : 'not_checked';
      out.push({ plan, slot, day, state: st, record: rec });
    }
    // check-ins today at a time no longer in the schedule (times changed) still show
    for (const r of doses) if (r.data.rxId === plan.rxId && r.data.day === day && r.data.slot && !plan.times.includes(r.data.slot) && !out.some((o) => o.plan.rxId === plan.rxId && o.slot === r.data.slot))
      out.push({ plan, slot: r.data.slot, day, state: r.data.status, record: r });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot) || a.plan.name.localeCompare(b.plan.name));
}

/** The next dose to take (due now first, then the next upcoming one today). */
export function nextDose(slots: Slot[]): Slot | null {
  return slots.find((s) => s.state === 'due') ?? slots.find((s) => s.state === 'upcoming') ?? null;
}

export interface Adherence {
  planned: number; taken: number; missed: number; notChecked: number; sideEffects: number;
  perMed: { name: string; planned: number; taken: number }[];
  days: { day: string; planned: number; taken: number }[];
  sideEffectNotes: { at: string; medicine: string; text: string; by: string }[];
}

/** Adherence over the last `n` days, counted only from scheduled doses whose time has passed. */
export function adherence(plans: MedPlan[], doses: PatientRecord<DoseData>[], n = 7, now = new Date()): Adherence {
  const today = localDay(now);
  const t = now.getHours() * 60 + now.getMinutes();
  const res: Adherence = { planned: 0, taken: 0, missed: 0, notChecked: 0, sideEffects: 0, perMed: [], days: [], sideEffectNotes: [] };
  const per = new Map<string, { name: string; planned: number; taken: number }>();
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const row = { day, planned: 0, taken: 0 };
    for (const p of plans) {
      if (p.startDay > day || (p.endDay && p.endDay < day)) continue;
      // counted per day (not per exact time), so a dose checked in at a changed reminder time still counts
      const slots = p.times.filter((slot) => !(day === today && minutes(slot) > t) && !(day === localDay(new Date(p.sentAt)) && minutes(slot) < minutes(localTime(new Date(p.sentAt)))));
      if (!slots.length) continue;
      const recs = doses.filter((r) => r.data.rxId === p.rxId && r.data.day === day);
      const took = Math.min(slots.length, recs.filter((r) => r.data.status === 'taken' || r.data.status === 'side_effect').length);
      const miss = Math.min(slots.length - took, recs.filter((r) => r.data.status === 'missed').length);
      row.planned += slots.length; row.taken += took;
      res.missed += miss; res.notChecked += slots.length - took - miss;
      const m = per.get(p.rxId) ?? { name: p.name, planned: 0, taken: 0 };
      m.planned += slots.length; m.taken += took;
      per.set(p.rxId, m);
    }
    res.planned += row.planned; res.taken += row.taken;
    res.days.push(row);
  }
  const since = addDays(today, -(n - 1));
  for (const r of doses) if (r.data.status === 'side_effect' && r.data.day >= since) {
    res.sideEffects++;
    res.sideEffectNotes.push({ at: r.at, medicine: r.data.medicine, text: r.data.sideEffect, by: r.by });
  }
  res.perMed = [...per.values()];
  return res;
}

const localTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const ALLERGY = /(swell|swollen|puff).{0,30}(lip|face|tongue|throat|eye)|(lip|face|tongue|throat).{0,20}(swell|swollen|puff)|can'?t breathe|cannot breathe|trouble breathing|hard to breathe|short of breath|wheez|hives all over|throat (is )?(closing|tight)|(ورم|تورم|انتفاخ|اتنفخ|وارم|وارمه).{0,20}(شفايف|شفايفي|شفتي|وشي|الوش|لساني|اللسان|زوري|الزور|عيني)|(شفايفي|وشي|لساني|زوري).{0,15}(ورم|وارم|وارمه|اتنفخ|منفوخ)|مش قادر اتنفس|صعوبه في التنفس|ضيق في التنفس|نفسي مقطوع|زوري بيقفل/i;

/** Urgent reasons for a side effect the patient described (allergic reaction + the diary's red flags). */
export function sideEffectUrgent(text: string): string[] {
  const out: string[] = [];
  const t = text.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  if (ALLERGY.test(t)) out.push('possible severe allergic reaction');
  for (const r of readDiaryRules(text).urgent) if (!out.includes(r)) out.push(r);
  return out;
}

/** What the patient said when asked about a dose ("I took it", "نسيت", "عملي طفح"). */
export function readDoseAnswer(text: string): { status: DoseStatus; sideEffect: string } | null {
  const t = text.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
  if (!t) return null;
  if (/side effect|made me|it gave me|rash|itch|dizzy|nause|vomit|stomach|swell|allerg|عرض جانبي|اعراض جانبيه|عملي|عملتلي|جالي|طفح|هرش|حكه|دوخه|دايخ|ترجيع|رجعت|مغص|ورم|حساسيه|تعبني/.test(t)) return { status: 'side_effect', sideEffect: text.trim().slice(0, 300) };
  const words = new Set(t.split(/[\s,.!?؟،]+/).filter(Boolean));
  const has = (...w: string[]) => w.some((x) => words.has(x));
  if (/\b(missed|forgot|didn'?t take|did not take|skip|skipped|not yet)\b|نسيت|ماخدتهاش|مخدتهاش|ماخدتوش|مخدتوش|فوتها|فوتّها/.test(t) || has('no', 'لا', 'لأ', 'لسه')) return { status: 'missed', sideEffect: '' };
  if (/\b(took|taken|take it|done|i did|had it)\b|اخدت|خدت|اخدتها|خدتها|اخدته|خدته|شربت|بلعت/.test(t) || has('yes', 'yeah', 'yep', 'تمام', 'ايوه', 'اه', 'نعم', 'اخدتها', 'خدتها')) return { status: 'taken', sideEffect: '' };
  return null;
}

/** The patient's reminder times as recorded with their latest check-in of each medicine (doctor / caregiver side). */
export function timesFromDoses(doses: PatientRecord<DoseData>[]): (rxId: string) => string[] | null {
  const latest = new Map<string, string[]>();
  for (const r of [...doses].sort((a, b) => a.at.localeCompare(b.at))) if (r.data.rxId && r.data.times?.length) latest.set(r.data.rxId, r.data.times);
  return (rxId) => latest.get(rxId) ?? null;
}

// ---------------------------------------------------------------- reminder times (device settings)
const KEY = 'accesscare.medtimes.v1';
export function savedTimes(rxId: string): string[] | null {
  try { const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string[]>; const v = all[rxId]; return Array.isArray(v) && v.every((x) => /^\d\d:\d\d$/.test(x)) ? v : null; } catch { return null; }
}
export function saveTimes(rxId: string, times: string[]) {
  try { const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string[]>; all[rxId] = [...new Set(times.filter((x) => /^\d\d:\d\d$/.test(x)))].sort(); localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked: defaults are used */ }
}
export const remindersOn = () => { try { return localStorage.getItem('accesscare.reminders.v1') === 'on'; } catch { return false; } };
export const setRemindersOn = (on: boolean) => { try { localStorage.setItem('accesscare.reminders.v1', on ? 'on' : 'off'); } catch { /* */ } };
