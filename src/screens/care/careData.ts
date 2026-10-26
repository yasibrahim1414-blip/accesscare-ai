// Data shared by the care screens: the medicine plan (from the doctor's sent
// prescriptions), dose check-ins, and the summary written for caregivers.
import { useApp, useLoad } from '../../app/AppContext';
import type { Backend, ConsultationView } from '../../services/backend/Backend';
import type { Message } from '../../domain/types';
import { STATUS_LABELS } from '../../domain/types';
import type { DiaryEntry } from '../../domain/diary';
import { cleanCard, localDay, type CardData, type CareDigest, type DoseData, type PatientRecord } from '../../domain/care';
import { adherence, plansFromMessages, savedTimes, timesFromDoses, todaySlots, type MedPlan } from '../../services/care/meds';

export interface MedData { plans: MedPlan[]; doses: PatientRecord<DoseData>[]; threads: { consultationId: string; messages: Message[] }[]; consults: ConsultationView[] }

export async function loadMedData(backend: Backend): Promise<MedData> {
  const consults = (await backend.listConsultations()).filter((v) => v.consultation.status !== 'draft');
  const threads = await Promise.all(consults.map(async (v) => ({ consultationId: v.consultation.id, messages: await backend.listMessages(v.consultation.id).catch(() => [] as Message[]) })));
  const doses = (await backend.listRecords('dose')) as PatientRecord<DoseData>[];
  // this device's reminder times, else the times recorded with the latest check-in (another device), else from the prescription
  const recorded = timesFromDoses(doses);
  const plans = plansFromMessages(threads, new Date(), (id) => savedTimes(id) ?? recorded(id));
  return { plans, doses, threads, consults };
}

export function useMeds() {
  const { backend, me } = useApp();
  return useLoad(() => (me?.profile.role === 'patient' ? loadMedData(backend) : Promise.resolve({ plans: [], doses: [], threads: [], consults: [] } as MedData)), [me?.profile.id]);
}

/** Share check-ins with the doctor (device setting; on unless the patient turned it off). */
export const shareCareDefault = () => { try { return localStorage.getItem('accesscare.sharecare.v1') !== 'off'; } catch { return true; } };
export const setShareCareDefault = (on: boolean) => { try { localStorage.setItem('accesscare.sharecare.v1', on ? 'on' : 'off'); } catch { /* */ } };

const FEEL: Record<string, string> = { better: 'better', same: 'about the same', worse: 'worse' };

/** The summary a linked caregiver can read (only what helps them help: medicines, how the patient feels, doctor replies, alerts, the emergency card). */
export function buildDigest(name: string, md: MedData, diary: DiaryEntry[], card: CardData | null, now = new Date()): CareDigest {
  const today = todaySlots(md.plans, md.doses, now);
  const adh = adherence(md.plans, md.doses, 7, now);
  const alerts: CareDigest['alerts'] = [];
  for (const e of diary.slice(0, 14)) if (e.urgent.length) alerts.push({ at: e.at, text: `Urgent warning in a check-in: ${e.urgent.join(', ')}`, ar: `تحذير عاجل في تسجيل: ${e.urgent.join('، ')}` });
  for (const n of adh.sideEffectNotes.slice(0, 5)) alerts.push({ at: n.at, text: `Side effect with ${n.medicine}: ${n.text}`, ar: `عرض جانبي مع ${n.medicine}: ${n.text}` });
  const missedToday = today.filter((s) => s.state === 'not_checked' || s.state === 'missed').length;
  if (missedToday) alerts.push({ at: now.toISOString(), text: `${missedToday} dose(s) today not taken or not checked yet`, ar: `${missedToday} جرعة النهارده ماتاخدتش أو لسه متسجلتش` });
  const lastDoctor = (cid: string) => {
    const t = md.threads.find((x) => x.consultationId === cid);
    const m = [...(t?.messages ?? [])].reverse().find((x) => x.senderRole === 'doctor');
    return m ? (m.kind === 'prescription' && m.meta?.rx ? `Prescription: ${m.meta.rx.medication} ${m.meta.rx.dose}, ${m.meta.rx.frequency}` : m.body).slice(0, 400) : '';
  };
  return {
    patientName: name, updatedAt: now.toISOString(),
    medicines: md.plans.filter((p) => p.active).slice(0, 12).map((p) => ({
      rxId: p.rxId, name: p.name, dose: p.dose, times: p.times,
      today: today.filter((s) => s.plan.rxId === p.rxId).map((s) => ({ slot: s.slot, status: s.state === 'not_checked' ? 'due' : s.state as CareDigest['medicines'][number]['today'][number]['status'] })),
    })),
    adherence7d: adh.planned ? { taken: adh.taken, planned: adh.planned } : null,
    diary: diary.filter((e) => e.feeling || e.items.length || e.by).slice(0, 7).map((e) => ({ at: e.at, feeling: e.feeling ? FEEL[e.feeling] : '', items: e.items.map((i) => `${i.en}${i.severity !== null ? ` ${i.severity}/10` : ''}`), ...(e.by ? { by: e.by, note: e.text.slice(0, 300) } : {}) })),
    consultations: md.consults.slice(0, 6).map((v) => ({
      title: v.consultation.approved?.report?.regions?.join(', ') || v.consultation.approved?.report?.sensations?.join(', ') || `Consultation ${new Date(v.consultation.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      status: STATUS_LABELS[v.consultation.status] ?? v.consultation.status, at: v.consultation.updatedAt, lastDoctorMessage: lastDoctor(v.consultation.id),
    })),
    alerts: alerts.slice(0, 10),
    card: card ? cleanCard(card) : null,
  };
}

export const todayKey = () => localDay();
