import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuSend, LuVideo, LuCircleHelp, LuSparkles, LuCircleCheck, LuMessageCircle, LuPencil } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Field, fmtDate } from '../../ui/components';
import type { ClarificationFormat, CommunicationPreferences, Message, MessageMeta, StructuredReport } from '../../domain/types';
import { DEFAULT_SIGNAL } from '../../domain/types';
import { correctionOptions } from '../../services/intent/ReconstructionEngine';
import { SignalBoard } from '../signal/SignalBoard';
import { mustConfirm } from '../../services/signal/SignalEngine';
import { FollowUpAnswerBubble, FollowUpAnswerFlow, FollowUpRequestBubble, VisitSummaryCard, isDue } from './FollowUp';
import { ProbeComposer, ProbeRequestBubble, ProbeAnswerBubble, ProbeAnswerFlow, TeachBackFlow, TeachBackBubble } from './Interact';
import { teachBackDue } from '../../services/teachback/check';

const SYMBOL: Record<string, string> = { Yes: '👍', No: '👎', 'Not sure': '❔' };

/** Suggests a question format that fits what the patient shared about how they communicate. */
export function suggestFormat(prefs: CommunicationPreferences | undefined, hasOptions: boolean, signalSession: boolean): ClarificationFormat {
  if (signalSession) return hasOptions ? 'symbols' : 'yes_no';
  if (prefs && prefs.yesNoQuestions && !prefs.multipleChoice) return 'yes_no';
  if (hasOptions && (!prefs || prefs.multipleChoice || prefs.visualOptions)) return 'choice';
  return 'text';
}

/** Answers attached to report items, for showing as "clarified after sharing". */
export function clarifiedAddenda(msgs: Message[]) {
  return msgs.filter((m) => m.kind === 'clarification_answer' && m.meta?.approvedByPatient)
    .map((m) => ({ label: m.meta?.itemLabel ?? 'Answer', text: m.meta?.raw ? `${m.meta.raw}${m.meta.wordingSource === 'ai' ? ` (“${m.body}”, AI wording approved by patient)` : ''}` : m.body, at: m.createdAt }));
}

/** Consultation-scoped messaging with structured clarification requests. Authorization is enforced by the backend. */
export function MessagesPanel({ consultationId, canSend, disabledReason, report, patientPrefs, signalSession }: {
  consultationId: string; canSend: boolean; disabledReason?: string; report?: StructuredReport;
  patientPrefs?: CommunicationPreferences; signalSession?: boolean;
}) {
  const { backend, me, toast } = useApp();
  const msgs = useLoad(() => backend.listMessages(consultationId), [consultationId]);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'text' | 'yes_no' | 'item' | 'probe'>('text');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const isDoctor = me?.profile.role === 'doctor';

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key?.startsWith('accesscare.db')) msgs.reload(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [msgs.data?.length]);

  const send = async (body: string, kind: Message['kind'] = 'text', meta?: MessageMeta) => {
    setErr(null); setSending(true);
    try { await backend.sendMessage(consultationId, body, kind, meta); setText(''); msgs.reload(); return true; }
    catch (e) { setErr((e as Error).message); toast('Not sent — ' + (e as Error).message); return false; }
    finally { setSending(false); }
  };

  const list = msgs.data ?? [];
  const answeredIds = new Set(list.filter((m) => m.kind === 'clarification_answer' || m.kind === 'followup_answer' || m.kind === 'body_probe_answer').map((m) => m.meta?.replyTo));
  const openProbes = list.filter((m) => m.kind === 'body_probe' && m.meta?.probe && !answeredIds.has(m.id));
  const tbDue = !isDoctor && teachBackDue(list);
  const dueFollowUps = list.filter((m) => m.kind === 'followup' && isDue(m) && !answeredIds.has(m.id));
  const legacyQ = [...list].reverse().find((m) => m.kind === 'yes_no_question');
  const legacyAnswered = legacyQ && list.some((m) => m.createdAt > legacyQ.createdAt && m.senderRole === 'patient');
  const openRequests = list.filter((m) => m.kind === 'clarification' && !answeredIds.has(m.id));

  return (
    <div className="stack">
      {msgs.error && <Banner kind="danger">{msgs.error}</Banner>}
      <div className="bubble-list" aria-live="polite" data-testid="messages">
        {msgs.loading && !msgs.data && <div className="skeleton" style={{ height: 48 }} />}
        {msgs.data && list.length === 0 && <p className="small muted" style={{ textAlign: 'center', padding: 12 }}>No messages yet. Messages are linked to this consultation only.</p>}
        {list.map((m) => {
          const mine = m.senderId === me?.profile.id;
          return (
            m.kind === 'prescription' && m.meta?.rx ? <PrescriptionCard key={m.id} m={m} /> :
            m.kind === 'visit_summary' && m.meta?.summary ? <VisitSummaryCard key={m.id} m={m} /> :
            m.kind === 'followup' && m.meta?.followup ? <FollowUpRequestBubble key={m.id} m={m} answered={answeredIds.has(m.id)} isDoctor={isDoctor} /> :
            m.kind === 'followup_answer' && m.meta?.followupAnswer ? <FollowUpAnswerBubble key={m.id} m={m} isDoctor={isDoctor} /> :
            m.kind === 'body_probe' && m.meta?.probe ? <ProbeRequestBubble key={m.id} m={m} isDoctor={isDoctor} answer={list.find((x) => x.kind === 'body_probe_answer' && x.meta?.replyTo === m.id)} /> :
            m.kind === 'body_probe_answer' && m.meta?.probeAnswer ? <ProbeAnswerBubble key={m.id} m={m} isDoctor={isDoctor} /> :
            m.kind === 'teachback' && m.meta?.teachback ? <TeachBackBubble key={m.id} m={m} isDoctor={isDoctor} /> :
            <div key={m.id} className={`bubble ${mine ? 'me' : 'them'}${m.kind === 'yes_no_question' || m.kind === 'clarification' ? ' question' : ''}`} data-kind={m.kind}>
              {m.kind === 'yes_no_question' && <b className="bubble-tag">Yes/No question</b>}
              {m.kind === 'clarification' && <b className="bubble-tag">CLARIFICATION{m.meta?.itemLabel ? ` · ${m.meta.itemLabel.toUpperCase()}` : ''}</b>}
              {m.kind === 'clarification_answer' && <b className="bubble-tag">ANSWER{m.meta?.itemLabel ? ` · ${m.meta.itemLabel.toUpperCase()}` : ''}</b>}
              {m.body}
              {m.kind === 'clarification_answer' && m.meta && (
                <span className="meta">Selected: “{m.meta.raw}” · {m.meta.wordingSource === 'ai' ? 'AI wording' : m.meta.wordingSource === 'template' ? 'AccessCare wording' : 'own words'} · {m.meta.approvedByPatient ? 'approved by patient' : 'not approved'}</span>
              )}
              <span className="meta">{m.senderRole === 'doctor' ? 'Doctor' : 'Patient'} · {fmtDate(m.createdAt)}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {!isDoctor && canSend && openRequests.map((r) => <ClarificationAnswerCard key={r.id} request={r} onSend={send} />)}
      {!isDoctor && canSend && dueFollowUps.map((r) => <FollowUpAnswerFlow key={r.id} request={r} onSend={send} />)}
      {!isDoctor && canSend && openProbes.map((r) => <ProbeAnswerFlow key={r.id} request={r} onSend={send} />)}
      {!isDoctor && canSend && tbDue && <TeachBackFlow msgs={list} onSend={send} />}
      {!isDoctor && canSend && legacyQ && !legacyAnswered && (
        <div className="card" style={{ gap: 8 }}>
          <b>Your doctor asked: {legacyQ.body}</b>
          <div className="grid2">
            <button className="choice yesno yes" onClick={() => send(`Yes — re: “${legacyQ.body}”`)}>Yes</button>
            <button className="choice yesno" onClick={() => send(`No — re: “${legacyQ.body}”`)}>No</button>
          </div>
          <Button variant="ghost" onClick={() => send(`Not sure — re: “${legacyQ.body}”`)}>Not sure</Button>
        </div>
      )}

      {canSend ? (
        <div className="stack" style={{ gap: 8 }}>
          {isDoctor && (
            <div className="seg" role="group" aria-label="What to send">
              <button aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Message</button>
              <button aria-pressed={mode === 'yes_no'} onClick={() => setMode('yes_no')}>Yes/No</button>
              <button aria-pressed={mode === 'item'} onClick={() => setMode('item')} data-testid="mode-item">Ask about an item</button>
              <button aria-pressed={mode === 'probe'} onClick={() => setMode('probe')} data-testid="mode-probe">Here?</button>
            </div>
          )}
          {isDoctor && mode === 'probe'
            ? <ProbeComposer onSend={async (body, meta) => { const ok = await send(body, 'body_probe', meta); if (ok) setMode('text'); return ok; }} />
            : isDoctor && mode === 'item'
            ? <ClarificationComposer report={report} patientPrefs={patientPrefs} signalSession={signalSession} onSend={async (q, meta) => { if (await send(q, 'clarification', meta)) setMode('text'); }} />
            : (
              <div className="composer">
                <input id={`msg-${consultationId}`} className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
                  placeholder={mode === 'yes_no' ? 'e.g. Is it worse at night?' : 'Write a message'} aria-label="Message"
                  onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) send(text.trim(), mode === 'yes_no' ? 'clarification' : 'text', mode === 'yes_no' ? { format: 'yes_no', options: ['Yes', 'No'] } : undefined); }} />
                <button className="btn primary send" aria-label="Send message" disabled={!text.trim() || sending}
                  onClick={() => send(text.trim(), mode === 'yes_no' ? 'clarification' : 'text', mode === 'yes_no' ? { format: 'yes_no', options: ['Yes', 'No'] } : undefined)}><LuSend /></button>
              </div>
            )}
          {err && <Banner kind="danger">{err}</Banner>}
        </div>
      ) : disabledReason ? <p className="small muted">{disabledReason}</p> : null}
      <div className="row tiny muted" style={{ gap: 8 }}><LuVideo aria-hidden /> Video calls are not available in this prototype. {backend.shared ? 'Messages sync between devices automatically.' : 'Offline demo: messages stay in this browser.'}</div>
    </div>
  );
}

function ClarificationComposer({ report, patientPrefs, signalSession, onSend }: {
  report?: StructuredReport; patientPrefs?: CommunicationPreferences; signalSession?: boolean; onSend: (question: string, meta: MessageMeta) => void;
}) {
  const items = useMemo(() => {
    const rec = report?.reconstruction;
    if (!rec) return [];
    const rank = (s: string) => (s === 'needs_clarification' ? 0 : s === 'unanswered' || s === 'unsure' || s === 'suggested' ? 1 : 2);
    return [...rec.items].filter((i) => i.status !== 'removed').sort((a, b) => rank(a.status) - rank(b.status));
  }, [report]);
  const [key, setKey] = useState(items[0]?.key ?? '');
  const item = items.find((i) => i.key === key);
  const opts = item ? correctionOptions(item.field).filter((o) => !/\/ 10/.test(o)) : [];
  const [format, setFormat] = useState<ClarificationFormat>(suggestFormat(patientPrefs, opts.length > 0, !!signalSession));
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!item) return;
    const f = suggestFormat(patientPrefs, opts.length > 0, !!signalSession);
    setFormat(f);
    setQ(item.value && item.status === 'confirmed' ? `Can you tell me more about: ${item.label.toLowerCase()} (“${item.value}”)?` : `Can you tell me about: ${item.label.toLowerCase()}?`);
  }, [key]); // eslint-disable-line
  if (!items.length) return <p className="small muted">This report has no itemized details to ask about. Send a message instead.</p>;
  const options = format === 'yes_no' ? ['Yes', 'No'] : format === 'choice' || format === 'symbols' ? opts.slice(0, 8) : undefined;
  return (
    <div className="card tinted" style={{ gap: 10 }} data-testid="clarification-composer">
      <div className="field"><label htmlFor="clar-item">Report item</label>
        <select id="clar-item" className="input" value={key} onChange={(e) => setKey(e.target.value)}>
          {items.map((i) => <option key={i.key} value={i.key}>{i.label}: {i.value ?? (i.status === 'unsure' ? 'not sure' : 'not specified')}{i.status !== 'confirmed' ? ` — ${i.status.replace('_', ' ')}` : ''}</option>)}
        </select>
      </div>
      <Field id="clar-q" label="Question" value={q} onChange={setQ} maxLength={300} />
      <div className="field"><label>Answer format</label>
        <div className="seg">
          {(['yes_no', 'choice', 'symbols', 'text'] as ClarificationFormat[]).filter((f) => f === 'yes_no' || f === 'text' || opts.length > 0).map((f) => (
            <button key={f} aria-pressed={format === f} onClick={() => setFormat(f)}>{f === 'yes_no' ? 'Yes/No' : f === 'choice' ? 'Choices' : f === 'symbols' ? 'Symbols' : 'Free text'}</button>
          ))}
        </div>
        <span className="hint">{patientPrefs ? 'Suggested from the patient’s shared communication preferences.' : 'The patient hasn’t shared communication preferences.'}{signalSession ? ' This report came from Silent Signal: picture answers work best.' : ''}</span>
      </div>
      {options && <div className="row wrap" style={{ gap: 6 }}>{options.map((o) => <span key={o} className="chip">{o}</span>)}</div>}
      <Button disabled={!q.trim()} onClick={() => onSend(q.trim(), { itemKey: item!.key, itemLabel: item!.label, format, options })} data-testid="send-clarification"><LuCircleHelp aria-hidden /> Send clarification request</Button>
    </div>
  );
}

/** Patient answers a doctor's clarification with their preferred input, reviews the wording, approves, sends. */
function ClarificationAnswerCard({ request, onSend }: { request: Message; onSend: (body: string, kind: Message['kind'], meta: MessageMeta) => Promise<boolean> }) {
  const { prefs, ai } = useApp();
  const meta = request.meta ?? {};
  const options = [...(meta.options ?? []), 'Not sure'].filter((v, i, a) => a.indexOf(v) === i);
  const [raw, setRaw] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [wording, setWording] = useState<{ body: string; source: 'template' | 'ai' | 'patient' } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const sp = prefs.signal ?? DEFAULT_SIGNAL;
  const label = meta.itemLabel ? meta.itemLabel.toLowerCase() : 'your doctor’s question';
  const chose = (v: string) => { setRaw(v); setWording({ body: v === 'Not sure' ? `I’m not sure about ${label}.` : `About ${label}: ${v}.`, source: 'template' }); };
  const aiState = ai.state(prefs.aiAssist);
  return (
    <div className="card raised" style={{ gap: 12 }} data-testid="clarification-card">
      <div className="row"><LuMessageCircle style={{ color: 'var(--teal-ink)', fontSize: '1.3em' }} aria-hidden /><div className="grow"><div className="tiny muted strong">YOUR DOCTOR ASKS{meta.itemLabel ? ` · ${meta.itemLabel.toUpperCase()}` : ''}</div><b>{request.body}</b></div></div>
      {!wording && (meta.format === 'text' || !meta.format ? (
        <div className="stack">
          <Field id={`ans-${request.id}`} label="Your answer" multiline value={text} onChange={setText} maxLength={500} />
          <Button disabled={!text.trim()} onClick={() => { setRaw(text.trim()); setWording({ body: text.trim(), source: 'patient' }); }}>Review answer</Button>
          <Button variant="ghost" onClick={() => chose('Not sure')}>I’m not sure</Button>
        </div>
      ) : meta.format === 'symbols' ? (
        <SignalBoard options={options.map((o) => ({ id: o, label: o, symbol: SYMBOL[o] ?? '•' }))} method={sp.method} scanMs={sp.scanMs} confirm={mustConfirm(sp)} prompt="Choose your answer" speakOut={sp.speakSelections} onResult={(r) => chose(r.optionId)} />
      ) : (
        <div className={meta.format === 'yes_no' ? 'grid2' : 'stack'} style={{ gap: 8 }}>
          {options.map((o) => <button key={o} className={`choice${meta.format === 'yes_no' ? ' yesno' : ''}${o === 'Yes' ? ' yes' : ''}`} onClick={() => chose(o)} data-option={o}>
            {prefs.visualOptions && SYMBOL[o] && <span className="ico" aria-hidden>{SYMBOL[o]}</span>}{o}</button>)}
        </div>
      ))}
      {wording && (
        <div className="stack" data-testid="answer-review">
          <div className="tiny muted strong">You selected</div><b>{raw}</b>
          <div className="row between"><span className="tiny muted strong">Message to send</span>
            <span className={`prov ${wording.source === 'ai' ? 'prov-ai' : wording.source === 'template' ? 'prov-template' : 'prov-patient'}`}>{wording.source === 'ai' ? 'AI wording' : wording.source === 'template' ? 'AccessCare wording' : 'Your words'}</span></div>
          {editing ? <Field id={`edit-${request.id}`} label="Edit message" value={wording.body} onChange={(v) => setWording({ body: v, source: 'patient' })} maxLength={500} />
            : <div className="pre">{wording.body}</div>}
          <div className="grid2">
            <Button variant="secondary" onClick={() => setEditing(!editing)}><LuPencil aria-hidden /> {editing ? 'Done' : 'Edit'}</Button>
            {wording.source === 'ai'
              ? <Button variant="secondary" onClick={() => chose(raw!)}>Reject AI wording</Button>
              : wording.source === 'template' && aiState === 'available'
                ? <Button variant="secondary" busy={aiBusy} onClick={async () => { setAiBusy(true); const w = await ai.wordMessage([`Question: ${request.body}`, `Answer chosen: ${raw}`]); setAiBusy(false); if (w) setWording({ body: w, source: 'ai' }); }}><LuSparkles aria-hidden /> AI wording</Button>
                : <Button variant="secondary" onClick={() => { setWording(null); setRaw(null); }}>Change answer</Button>}
          </div>
          <Button big data-testid="approve-answer" onClick={() => onSend(wording.body, 'clarification_answer', {
            replyTo: request.id, itemKey: meta.itemKey, itemLabel: meta.itemLabel, raw: raw ?? wording.body, wordingSource: wording.source, approvedByPatient: true,
          })}><LuCircleCheck aria-hidden /> Approve and send</Button>
        </div>
      )}
    </div>
  );
}

/** A doctor-approved prescription as the patient (and doctor) sees it in the conversation. */
function PrescriptionCard({ m }: { m: Message }) {
  const rx = m.meta!.rx!;
  const rows: [string, string][] = [['Medicine', rx.medication], ['Dose', rx.dose], ['How to take it', rx.route], ['How often', rx.frequency], ['For how long', rx.duration], ['Instructions', rx.instructions]];
  return (
    <div className="rx-card" data-kind="prescription" data-testid="prescription-card">
      <b className="bubble-tag">PRESCRIPTION · APPROVED BY {rx.approvedBy.toUpperCase()}</b>
      {rows.filter(([, v]) => v).map(([k, v]) => <div className="rx-row" key={k}><span>{k}</span><span>{v}</span></div>)}
      <span className="meta">Approved {fmtDate(rx.approvedAt)} by your doctor{rx.labelUrl ? <> · <a href={rx.labelUrl} target="_blank" rel="noreferrer">Medicine information (FDA label)</a></> : null}</span>
      <span className="tiny muted">If you have questions or side effects, message your doctor. In an emergency call your local emergency number.</span>
    </div>
  );
}
