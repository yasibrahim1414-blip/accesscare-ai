// Shared validation for data every backend accepts from the app.

import type { AuditEvent, Message, MessageMeta, Role } from '../../domain/types';
import type { Reconstruction } from '../../domain/reconstruction';
import { cleanRxMeta, cleanFollowUp, cleanFollowUpAnswer, cleanVisitSummary } from '../../domain/clinical';
import { cleanProbe, cleanProbeAnswer, cleanTeachBack } from '../../domain/interact';
import { BackendError } from './Backend';

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : undefined);

/** Who may send which kind of message. */
export function messageKindFor(role: Role, kind: Message['kind'] | undefined): Message['kind'] {
  const doctor: Message['kind'][] = ['text', 'yes_no_question', 'clarification', 'prescription', 'followup', 'visit_summary', 'body_probe'];
  const patient: Message['kind'][] = ['text', 'clarification_answer', 'followup_answer', 'body_probe_answer', 'teachback'];
  const k = kind ?? 'text';
  return (role === 'doctor' ? doctor : patient).includes(k) ? k : 'text';
}

export function cleanMeta(meta: MessageMeta | undefined, kind: Message['kind']): MessageMeta | undefined {
  if (kind === 'prescription') { const rx = cleanRxMeta(meta?.rx); return rx ? { rx } : undefined; }
  if (kind === 'followup') { const f = cleanFollowUp(meta?.followup); return f ? { followup: f } : undefined; }
  if (kind === 'followup_answer') { const a = cleanFollowUpAnswer(meta?.followupAnswer); return a ? { followupAnswer: a, replyTo: a.replyTo, approvedByPatient: true } : undefined; }
  if (kind === 'visit_summary') { const v = cleanVisitSummary(meta?.summary); return v ? { summary: v } : undefined; }
  if (kind === 'body_probe') { const p = cleanProbe(meta?.probe); return p ? { probe: p } : undefined; }
  if (kind === 'body_probe_answer') { const a = cleanProbeAnswer(meta?.probeAnswer); return a ? { probeAnswer: a, replyTo: a.replyTo, approvedByPatient: true } : undefined; }
  if (kind === 'teachback') { const t = cleanTeachBack(meta?.teachback); return t ? { teachback: t, replyTo: t.replyTo, approvedByPatient: true } : undefined; }
  if (!meta || (kind !== 'clarification' && kind !== 'clarification_answer' && kind !== 'yes_no_question')) return undefined;
  const formats = ['yes_no', 'choice', 'text', 'symbols'];
  const out: MessageMeta = {
    itemKey: clip(meta.itemKey, 80), itemLabel: clip(meta.itemLabel, 80),
    format: formats.includes(meta.format as string) ? meta.format : undefined,
    options: Array.isArray(meta.options) ? meta.options.slice(0, 8).map((o) => clip(o, 80)!).filter(Boolean) : undefined,
    replyTo: clip(meta.replyTo, 80), raw: clip(meta.raw, 500),
    wordingSource: meta.wordingSource === 'ai' || meta.wordingSource === 'template' || meta.wordingSource === 'patient' ? meta.wordingSource : undefined,
    approvedByPatient: kind === 'clarification_answer' ? meta.approvedByPatient === true : undefined,
  };
  return JSON.parse(JSON.stringify(out));
}

export function cleanReconstruction(rec: Reconstruction | undefined): Reconstruction | undefined {
  if (!rec || typeof rec !== 'object' || !Array.isArray(rec.items) || !Array.isArray(rec.contradictions)) return undefined;
  const json = JSON.stringify(rec);
  if (json.length > 120_000) return undefined;
  return JSON.parse(json);
}

export function cleanAudit(list: AuditEvent[] | undefined): AuditEvent[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.slice(-120).map((e) => ({
    at: clip(e.at, 40) ?? new Date().toISOString(),
    by: e.by === 'doctor' || e.by === 'patient' ? e.by : 'system',
    action: clip(e.action, 60) ?? 'event', detail: clip(e.detail, 200),
  }));
}

/** A prescription message must carry a complete, doctor-approved prescription. */
export function requireValidRx(kind: Message['kind'], meta: MessageMeta | undefined) {
  if (kind === 'prescription' && !meta?.rx) throw new BackendError('invalid', 'A prescription can only be sent after the doctor approves it (medicine, dose, approval).');
  if (kind === 'followup' && !meta?.followup) throw new BackendError('invalid', 'A follow-up needs a date.');
  if (kind === 'followup_answer' && !meta?.followupAnswer) throw new BackendError('invalid', 'The answer must be reviewed and approved by the patient.');
  if (kind === 'visit_summary' && !meta?.summary) throw new BackendError('invalid', 'An explanation can only be sent after the doctor approves it.');
  if (kind === 'body_probe' && !meta?.probe) throw new BackendError('invalid', 'Choose at least one body area.');
  if (kind === 'body_probe_answer' && !meta?.probeAnswer) throw new BackendError('invalid', 'The answer must be approved by the patient.');
  if (kind === 'teachback' && !meta?.teachback) throw new BackendError('invalid', 'The explanation must be approved by the patient.');
}
/** On read: a "prescription" without a valid approved prescription is shown as an ordinary message. */
export const readKind = (kind: Message['kind'], meta: MessageMeta | undefined): Message['kind'] =>
  (kind === 'prescription' && !meta?.rx) || (kind === 'followup' && !meta?.followup) || (kind === 'followup_answer' && !meta?.followupAnswer) || (kind === 'visit_summary' && !meta?.summary)
  || (kind === 'body_probe' && !meta?.probe) || (kind === 'body_probe_answer' && !meta?.probeAnswer) || (kind === 'teachback' && !meta?.teachback) ? 'text' : kind;
