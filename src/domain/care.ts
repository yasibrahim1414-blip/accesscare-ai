// Care records the patient keeps between visits, stored the same way as the
// symptom diary (the patient owns them; the connected doctor reads only the ones
// the patient shared):
//   dose   — a medicine check-in: taken, missed, or a side effect (adherence)
//   photo  — a guided photo of a wound / skin area for a timeline (no AI judgement)
//   card   — the patient's emergency card (never shared; shown as a QR code)
// Caregivers: a family member with their own account whom the patient links by
// the caregiver's ID (the patient decides; knowing an ID gives no access). The
// patient's app writes an encrypted "care digest" for each linked caregiver, and
// check-ins a caregiver records reach the patient's records marked with their name.

export type RecordKind = 'dose' | 'photo' | 'card';
export type DoseStatus = 'taken' | 'missed' | 'side_effect';

export interface DoseData {
  /** medicine name as prescribed */
  medicine: string;
  /** the prescription it belongs to ('' when the patient added it) */
  rxId: string;
  dose: string;
  /** the planned time it answers ('09:00'), '' when not tied to a time */
  slot: string;
  /** the calendar day of the planned dose (YYYY-MM-DD, local) */
  day: string;
  status: DoseStatus;
  /** the patient's own words about a side effect */
  sideEffect: string;
  via: 'voice' | 'touch' | 'text' | 'camera';
  /** urgent-help reasons shown while recording it */
  urgent: string[];
  /** the patient's reminder times for this medicine when it was recorded (lets the doctor count doses the same way) */
  times?: string[];
}

export interface PhotoData {
  /** body area, in the patient's words or chosen ('Left knee') */
  area: string;
  note: string;
  /** a JPEG data URL, compressed on the device (≤ ~110 KB) */
  image: string;
  w: number;
  h: number;
}

export interface CardData {
  allergies: string;
  medicines: string;
  conditions: string;
  bloodType: string;
  contactName: string;
  contactPhone: string;
  notes: string;
}

export type RecordData = DoseData | PhotoData | CardData;

export interface PatientRecord<T extends RecordData = RecordData> {
  id: string;
  kind: RecordKind;
  at: string;
  data: T;
  /** shared with the connected doctor (their user id), or null */
  sharedWith: string | null;
  /** '' when the patient made it; otherwise the caregiver's name */
  by: string;
}

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ml = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]+/g, ' ').trim().slice(0, max) : '');
const STATUSES: DoseStatus[] = ['taken', 'missed', 'side_effect'];
export const MAX_PHOTO_CHARS = 150_000;

export function cleanDose(x: unknown): DoseData | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as Partial<DoseData>;
  const medicine = s(d.medicine, 80);
  if (!medicine || !STATUSES.includes(d.status as DoseStatus)) return null;
  const slot = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.slot)) ? String(d.slot) : '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(d.day)) ? String(d.day) : localDay();
  return {
    medicine, rxId: s(d.rxId, 60).replace(/[^\w-]/g, ''), dose: s(d.dose, 60), slot, day,
    status: d.status as DoseStatus, sideEffect: d.status === 'side_effect' ? s(d.sideEffect, 300) : '',
    via: d.via === 'voice' || d.via === 'text' || d.via === 'camera' ? d.via : 'touch',
    urgent: Array.isArray(d.urgent) ? d.urgent.slice(0, 6).map((r) => s(r, 120)).filter(Boolean) : [],
    ...(Array.isArray(d.times) ? { times: [...new Set(d.times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))).map(String))].sort().slice(0, 6) } : {}),
  };
}

export function cleanPhoto(x: unknown): PhotoData | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Partial<PhotoData>;
  const image = typeof p.image === 'string' ? p.image : '';
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > MAX_PHOTO_CHARS) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(4000, Math.max(1, v))) : 0);
  return { area: s(p.area, 60), note: s(p.note, 300), image, w: n(p.w), h: n(p.h) };
}

export function cleanCard(x: unknown): CardData | null {
  if (!x || typeof x !== 'object') return null;
  const c = x as Partial<CardData>;
  const out: CardData = {
    allergies: ml(c.allergies, 300), medicines: ml(c.medicines, 300), conditions: ml(c.conditions, 300),
    bloodType: s(c.bloodType, 8).toUpperCase().replace(/[^ABO+\-]/g, ''),
    contactName: s(c.contactName, 60), contactPhone: s(c.contactPhone, 24).replace(/[^\d+()\- ]/g, ''),
    notes: ml(c.notes, 300),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

export function cleanRecordData(kind: RecordKind, data: unknown): RecordData | null {
  return kind === 'dose' ? cleanDose(data) : kind === 'photo' ? cleanPhoto(data) : kind === 'card' ? cleanCard(data) : null;
}

export function cleanRecord(x: unknown): PatientRecord | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<PatientRecord>;
  if (r.kind !== 'dose' && r.kind !== 'photo' && r.kind !== 'card') return null;
  const data = cleanRecordData(r.kind, r.data);
  if (!data) return null;
  return {
    id: s(r.id, 60).replace(/[^\w-]/g, ''), kind: r.kind, at: s(r.at, 40) || new Date().toISOString(), data,
    sharedWith: r.kind !== 'card' && typeof r.sharedWith === 'string' && r.sharedWith ? s(r.sharedWith, 80) : null,
    by: s(r.by, 60),
  };
}

/** YYYY-MM-DD in local time. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- caregivers
export interface CaregiverLink { id: string; name: string; caregiverId: string; since: string }

/** What a caregiver sees: written by the patient's app, encrypted for that caregiver only. */
export interface CareDigest {
  patientName: string;
  updatedAt: string;
  medicines: { rxId: string; name: string; dose: string; times: string[]; today: { slot: string; status: DoseStatus | 'due' | 'upcoming' }[] }[];
  adherence7d: { taken: number; planned: number } | null;
  diary: { at: string; feeling: string; items: string[]; by?: string; note?: string }[];
  consultations: { title: string; status: string; at: string; lastDoctorMessage: string }[];
  alerts: { at: string; text: string; ar?: string }[];
  card: CardData | null;
}

/** Something a caregiver records for the patient (reaches the patient's records marked with their name). */
export interface CaregiverItem {
  id: string;
  at: string;
  kind: 'dose' | 'note';
  dose?: DoseData;
  note?: string;
}

export function cleanCaregiverItem(x: unknown): CaregiverItem | null {
  if (!x || typeof x !== 'object') return null;
  const i = x as Partial<CaregiverItem>;
  const base = { id: s(i.id, 60).replace(/[^\w-]/g, ''), at: s(i.at, 40) || new Date().toISOString() };
  if (!base.id) return null;
  if (i.kind === 'dose') { const d = cleanDose(i.dose); return d ? { ...base, kind: 'dose', dose: d } : null; }
  if (i.kind === 'note') { const n = s(i.note, 600); return n ? { ...base, kind: 'note', note: n } : null; }
  return null;
}

export function cleanDigest(x: unknown): CareDigest | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as Partial<CareDigest>;
  const arr = <T>(v: unknown, n: number, f: (y: unknown) => T | null): T[] => (Array.isArray(v) ? v.slice(0, n).map(f).filter((y): y is T => !!y) : []);
  const DS = ['taken', 'missed', 'side_effect', 'due', 'upcoming'];
  return {
    patientName: s(d.patientName, 80), updatedAt: s(d.updatedAt, 40),
    medicines: arr(d.medicines, 12, (m) => {
      const o = m as CareDigest['medicines'][number];
      if (!o || !s(o.name, 80)) return null;
      return { rxId: s(o.rxId, 60).replace(/[^\w-]/g, ''), name: s(o.name, 80), dose: s(o.dose, 60), times: arr(o.times, 6, (t) => (/^\d\d:\d\d$/.test(String(t)) ? String(t) : null)),
        today: arr(o.today, 6, (t) => { const q = t as { slot: string; status: string }; return q && /^\d\d:\d\d$/.test(q.slot) && DS.includes(q.status) ? { slot: q.slot, status: q.status as DoseStatus } : null; }) };
    }),
    adherence7d: d.adherence7d && typeof d.adherence7d.taken === 'number' && typeof d.adherence7d.planned === 'number' ? { taken: Math.max(0, Math.round(d.adherence7d.taken)), planned: Math.max(0, Math.round(d.adherence7d.planned)) } : null,
    diary: arr(d.diary, 7, (e) => { const o = e as CareDigest['diary'][number]; return o && s(o.at, 40) ? { at: s(o.at, 40), feeling: s(o.feeling, 20), items: arr(o.items, 8, (t) => s(t, 80) || null), ...(s(o.by, 60) ? { by: s(o.by, 60), note: s(o.note, 300) } : {}) } : null; }),
    consultations: arr(d.consultations, 6, (c) => { const o = c as CareDigest['consultations'][number]; return o && s(o.title, 120) ? { title: s(o.title, 120), status: s(o.status, 30), at: s(o.at, 40), lastDoctorMessage: s(o.lastDoctorMessage, 400) } : null; }),
    alerts: arr(d.alerts, 10, (a) => { const o = a as CareDigest['alerts'][number]; return o && s(o.text, 200) ? { at: s(o.at, 40), text: s(o.text, 200), ...(s(o.ar, 200) ? { ar: s(o.ar, 200) } : {}) } : null; }),
    card: d.card ? cleanCard(d.card) : null,
  };
}

export const CAREGIVER_ID_PATTERN = /^CG-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export function normalizeCaregiverId(raw: string): string {
  const x = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CG/, '');
  return x.length === 8 ? `CG-${x.slice(0, 4)}-${x.slice(4)}` : raw.trim().toUpperCase();
}
export function generateCaregiverId(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(b, (x) => A[x % A.length]).join('');
  return `CG-${c.slice(0, 4)}-${c.slice(4)}`;
}
