// Doctor side: schedule a follow-up after treatment, and explain the visit to the patient.

import React, { useState } from 'react';
import { LuHeartPulse, LuSparkles, LuSend, LuFileText } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, Button, Field, fmtDate } from '../../ui/components';
import type { Message } from '../../domain/types';
import { followUpFlags, type Prescription } from '../../domain/clinical';
import { randomId } from '../../services/crypto';
import { checkSummary, summaryPrompt } from '../../services/clinical/visit';
import type { ClinicalAI } from '../../services/clinical/engine';

const DAY = 86_400_000;

export function FollowUpSection({ consultationId, messages, prescriptions, reloadMessages, log }: {
  consultationId: string; messages: Message[]; prescriptions: Prescription[]; reloadMessages: () => void; log: (a: string, d?: string) => void;
}) {
  const { backend, me, toast } = useApp();
  const sent = prescriptions.filter((p) => p.status === 'sent');
  const [days, setDays] = useState(3);
  // null = the most recently sent prescription (it may be sent after this section first appears)
  const [rxPick, setRxId] = useState<string | null>(null);
  const rxId = rxPick ?? sent[sent.length - 1]?.id ?? '';
  const [busy, setBusy] = useState(false);
  const fus = messages.filter((m) => m.kind === 'followup' && m.meta?.followup);
  const answerOf = (id: string) => messages.find((m) => m.kind === 'followup_answer' && m.meta?.followupAnswer?.replyTo === id);
  const schedule = async () => {
    setBusy(true);
    try {
      const rx = sent.find((p) => p.id === rxId);
      const dueAt = new Date(Date.now() + days * DAY).toISOString();
      await backend.sendMessage(consultationId, 'Your doctor will check how you are doing.', 'followup', {
        followup: { id: randomId('fu_'), dueAt, askedBy: me?.profile.fullName ?? 'your doctor', ...(rx ? { rxId: rx.id, medication: rx.medication } : {}) },
      });
      log('follow-up scheduled', `${days ? `in ${days} day(s)` : 'now'}${rx ? ` · ${rx.medication}` : ''}`);
      reloadMessages(); toast(days ? `Follow-up scheduled for ${fmtDate(dueAt)}` : 'Follow-up sent to the patient');
    } catch (e) { toast(`Not sent — ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ gap: 10 }} data-testid="cie-followup">
      <p className="small muted" style={{ margin: 0 }}>The patient is asked how they feel, about side effects and whether they take the medicine — with large buttons, read aloud on request. Answers that suggest a severe allergic reaction show emergency guidance to the patient at once. There are no push notifications: the patient sees it on their home screen when they open AccessCare.</p>
      {fus.map((m) => {
        const f = m.meta!.followup!; const a = answerOf(m.id)?.meta?.followupAnswer;
        const flags = a ? followUpFlags(a) : [];
        const due = Date.parse(f.dueAt) <= Date.now();
        return (
          <div key={m.id} className={`card flat ${flags.some((x) => x.level === 'emergency') ? 'cie-warn danger' : flags.some((x) => x.level === 'urgent') ? 'cie-warn warn' : ''}`} style={{ gap: 4 }} data-testid="followup-item" data-state={a ? 'answered' : due ? 'waiting' : 'scheduled'}>
            <div className="row between"><b><LuHeartPulse aria-hidden /> Follow-up{f.medication ? ` · ${f.medication}` : ''}</b><span className={`tag ${a ? 'confirmed' : due ? 'suggested' : 'unanswered'}`}>{a ? 'Answered' : due ? 'Waiting for the patient' : `Scheduled ${fmtDate(f.dueAt)}`}</span></div>
            {flags.map((x) => <div key={x.text} className={`small ${x.level === 'emergency' ? 'danger-text' : x.level === 'urgent' ? 'warn-text' : 'muted'}`}><b>{x.level === 'emergency' ? 'EMERGENCY WARNING' : x.level === 'urgent' ? 'URGENT' : 'Note'}:</b> {x.text}</div>)}
            {a && flags.length === 0 && <div className="small muted">No warning from the follow-up answers.</div>}
            {a && <div className="tiny muted">Full answers are in Messages.</div>}
          </div>
        );
      })}
      <div className="field"><label htmlFor="fu-days">When</label><select id="fu-days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={0}>Now</option><option value={1}>In 1 day</option><option value={3}>In 3 days</option><option value={7}>In 7 days</option></select></div>
      {sent.length > 0 && <div className="field"><label htmlFor="fu-rx">About</label><select id="fu-rx" className="input" value={rxId} onChange={(e) => setRxId(e.target.value)}>{sent.map((p) => <option key={p.id} value={p.id}>{p.medication} (sent {fmtDate(p.sentAt)})</option>)}<option value="">General — no specific medicine</option></select></div>}
      <Button variant="secondary" busy={busy} onClick={schedule} data-testid="fu-schedule"><LuHeartPulse aria-hidden /> {days ? 'Schedule follow-up' : 'Send follow-up now'}</Button>
    </div>
  );
}

export function VisitSummarySection({ consultationId, messages, prescriptions, reloadMessages, log, consent, ai }: {
  consultationId: string; messages: Message[]; prescriptions: Prescription[]; reloadMessages: () => void; log: (a: string, d?: string) => void; consent: boolean; ai: ClinicalAI | null;
}) {
  const { backend, me, toast } = useApp();
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState<{ text: string; source: 'doctor' | 'ai_reviewed'; warnings: string[] } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sent = messages.filter((m) => m.kind === 'visit_summary' && m.meta?.summary);
  const rxLines = prescriptions.filter((p) => p.status === 'sent').map((p) => `- ${p.medication}: ${[p.dose, p.route, p.frequency, p.duration && `for ${p.duration}`].filter(Boolean).join(', ')}${p.instructions ? `. ${p.instructions}` : ''}`);
  const simplify = async () => {
    if (!ai) return;
    setBusy('ai'); setErr(null);
    const source = `${notes}\n${rxLines.join('\n')}`;
    const r = await ai(summaryPrompt(notes, rxLines), 900).catch((e) => ({ error: (e as Error).message }));
    setBusy(null);
    if ('error' in r) { setErr(`AI request failed: ${r.error}. You can send your own wording.`); return; }
    const c = checkSummary(source, r.json);
    if ('rejected' in c) { setErr(c.rejected); log('visit explanation: AI wording rejected', c.rejected); return; }
    setDraft({ text: c.text, source: 'ai_reviewed', warnings: c.warnings }); setReviewed(false);
    log('visit explanation: AI wording drafted', c.warnings.join(' ') || undefined);
  };
  const send = async () => {
    const d = draft ?? { text: notes.trim(), source: 'doctor' as const, warnings: [] };
    if (!d.text) return;
    setBusy('send');
    try {
      await backend.sendMessage(consultationId, d.text.slice(0, 1990), 'visit_summary', { summary: { id: randomId('vs_'), text: d.text, source: d.source, approvedBy: me?.profile.fullName ?? 'Doctor', approvedAt: new Date().toISOString() } });
      log('visit explanation sent', d.source === 'ai_reviewed' ? 'AI wording reviewed and approved by doctor' : 'doctor’s own wording');
      setNotes(''); setDraft(null); setReviewed(false); reloadMessages(); toast('Explanation sent to the patient');
    } catch (e) { toast(`Not sent — ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  return (
    <div className="card" style={{ gap: 10 }} data-testid="cie-visit">
      <p className="small muted" style={{ margin: 0 }}>Write what the patient should know after this visit. {consent && ai ? 'AI can reword it in plain, simple English — it may not add anything, and you review it before it is sent.' : 'The patient did not allow AI for this report (or no AI is available), so your own wording is sent.'} The patient can have it read aloud.</p>
      {sent.map((m) => <div key={m.id} className="tiny muted"><LuFileText aria-hidden /> Sent {fmtDate(m.createdAt)}{m.meta!.summary!.source === 'ai_reviewed' ? ' (AI wording reviewed by you)' : ''}.</div>)}
      <Field id="vs-notes" label="Your explanation for the patient" multiline value={notes} onChange={(v) => { setNotes(v); setDraft(null); }} maxLength={3000} />
      {err && <Banner kind="warn">{err}</Banner>}
      {consent && ai && !draft && <Button variant="secondary" busy={busy === 'ai'} disabled={notes.trim().length < 10} onClick={simplify} data-testid="vs-simplify"><LuSparkles aria-hidden /> Make it simpler with AI</Button>}
      {draft && <div className="stack" data-testid="vs-draft">
        <div className="row between"><span className="tiny strong muted">AI WORDING — CHECK EVERY LINE</span><span className="prov prov-ai"><LuSparkles aria-hidden /> AI</span></div>
        {draft.warnings.map((w) => <Banner key={w} kind="warn">{w}</Banner>)}
        <Field id="vs-draft-text" label="Edit if needed" multiline value={draft.text} onChange={(v) => setDraft({ ...draft, text: v })} maxLength={1800} />
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} data-testid="vs-reviewed" /> I checked this wording against my explanation.</label>
        <Button variant="ghost" onClick={() => setDraft(null)}>Use my own wording instead</Button>
      </div>}
      <Button busy={busy === 'send'} disabled={draft ? !reviewed || !draft.text.trim() : notes.trim().length < 5} onClick={send} data-testid="vs-send"><LuSend aria-hidden /> Approve and send to the patient</Button>
    </div>
  );
}
