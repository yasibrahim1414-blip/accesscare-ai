// Follow-up after treatment and the visit explanation, as they appear in the
// consultation messages. The patient answers with large buttons (read aloud on
// request), reviews the answers and approves them before they are sent.

import React, { useEffect, useMemo, useState } from 'react';
import { LuVolume2, LuSquare, LuSiren, LuCircleCheck, LuHeartPulse, LuFileText } from 'react-icons/lu';
import { Button, Field, fmtDate } from '../../ui/components';
import type { Message, MessageMeta } from '../../domain/types';
import { SIDE_EFFECTS, followUpFlags, type FollowUpAnswer } from '../../domain/clinical';
import { Speaker } from '../../services/voice/Speech';
import { REF_BY_ID } from '../../services/clinical/references';

const T = {
  en: {
    title: 'How are you doing?', from: (d: string) => `Your doctor ${d} asks`, med: (m: string) => `About your medicine: ${m}`,
    feeling: 'Compared with before, do you feel…', better: 'Better', same: 'The same', worse: 'Worse', notSure: 'Not sure',
    se: 'Since starting, have you noticed any of these? Choose all that apply.', none: 'None of these',
    adh: 'Are you taking the medicine as your doctor said?', yes: 'Yes', sometimes: 'Sometimes', no: 'No',
    other: 'Anything else you want your doctor to know? (optional)', next: 'Next', review: 'Review your answers', send: 'Approve and send', change: 'Change',
    read: 'Read aloud', stop: 'Stop', sent: 'Answers sent to your doctor.', coming: (d: string) => `Your doctor will ask how you are doing on ${d}.`,
    emergency: 'This could be a serious allergic reaction. Call your local emergency number now (UAE 998, Egypt 123). Do not wait for your doctor’s reply.',
    you: 'You answered', se2: 'Side effects', adh2: 'Taking the medicine', feel2: 'Feeling',
  }
};
type L = typeof T.en;

function useSpeaker() {
  const [on, setOn] = useState(false);
  const sp = useMemo(() => new Speaker((s) => setOn(s.speaking)), []);
  useEffect(() => () => sp.stop(), [sp]);
  return { on, say: (lines: string[]) => (on ? sp.stop() : void sp.speak(lines, { lang: 'en', rate: 0.95 })), stop: () => sp.stop() };
}
function ReadAloud({ lines, label }: { lines: string[]; label: L }) {
  const s = useSpeaker();
  return <button className="chip" onClick={() => s.say(lines)} aria-pressed={s.on} style={{ cursor: 'pointer', minHeight: 40 }}>{s.on ? <><LuSquare aria-hidden /> {label.stop}</> : <><LuVolume2 aria-hidden /> {label.read}</>}</button>;
}
const isDue = (m: Message) => !!m.meta?.followup && Date.parse(m.meta.followup.dueAt) <= Date.now();

export function answerLines(a: FollowUpAnswer, t: L): string[] {
  const se = a.sideEffects.map((x) => (x === 'none' ? t.none : x === 'not_sure' ? t.notSure : SIDE_EFFECTS.find((s) => s.id === x)?.en ?? x));
  const adh: Record<string, string> = { yes: t.yes, sometimes: t.sometimes, no: t.no, not_sure: t.notSure };
  return [`${t.feel2}: ${t[a.feeling === 'not_sure' ? 'notSure' : a.feeling]}`, `${t.se2}: ${se.join(', ')}`,
    ...(a.adherence !== 'not_asked' ? [`${t.adh2}: ${adh[a.adherence]}`] : []), ...(a.other ? [`“${a.other}”`] : [])];
}

/** Patient: answer a due follow-up. */
export function FollowUpAnswerFlow({ request, onSend }: { request: Message; onSend: (body: string, kind: Message['kind'], meta: MessageMeta) => Promise<boolean> }) {
  const f = request.meta!.followup!;
  const t = T.en;
  const [step, setStep] = useState(0);
  const [feeling, setFeeling] = useState<FollowUpAnswer['feeling'] | null>(null);
  const [se, setSe] = useState<string[]>([]);
  const [adh, setAdh] = useState<FollowUpAnswer['adherence'] | null>(f.rxId || f.medication ? null : 'not_asked');
  const [other, setOther] = useState('');
  const answer: FollowUpAnswer = { replyTo: request.id, feeling: feeling ?? 'not_sure', sideEffects: se.length ? se : ['not_sure'], adherence: adh ?? 'not_sure', ...(other.trim() ? { other: other.trim() } : {}), approvedByPatient: true };
  const flags = followUpFlags(answer);
  const emergency = flags.some((x) => x.level === 'emergency');
  const toggle = (id: string) => setSe((cur) => (id === 'none' || id === 'not_sure' ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.filter((x) => x !== 'none' && x !== 'not_sure'), id]));
  const big = (sel: boolean) => `choice${sel ? ' selected' : ''}`;
  const qs = [t.feeling, t.se, ...(adh !== 'not_asked' ? [t.adh] : []), t.other];
  return (
    <div className="card raised" style={{ gap: 12 }} data-testid="followup-card">
      <div className="row"><LuHeartPulse style={{ color: 'var(--teal-ink)', fontSize: '1.4em' }} aria-hidden /><div className="grow"><div className="tiny muted strong">{t.from(f.askedBy)}</div><b style={{ fontSize: '1.1em' }}>{t.title}</b>{f.medication && <div className="small muted">{t.med(f.medication)}</div>}</div></div>
      {emergency && <div className="banner danger" role="alert" data-testid="followup-emergency"><LuSiren aria-hidden /><div className="grow"><b>{t.emergency}</b></div></div>}
      {step === 0 && <>
        <div className="row between"><b>{t.feeling}</b><ReadAloud lines={[t.feeling, t.better, t.same, t.worse, t.notSure]} label={t} /></div>
        <div className="stack" style={{ gap: 8 }}>
          {(['better', 'same', 'worse', 'not_sure'] as const).map((k) => <button key={k} className={big(feeling === k)} aria-pressed={feeling === k} data-option={`feel:${k}`} onClick={() => { setFeeling(k); setStep(1); }}><span className="ico" aria-hidden>{k === 'better' ? '🙂' : k === 'same' ? '😐' : k === 'worse' ? '😣' : '❔'}</span>{t[k === 'not_sure' ? 'notSure' : k]}</button>)}
        </div>
      </>}
      {step === 1 && <>
        <div className="row between"><b>{t.se}</b><ReadAloud lines={[t.se, ...SIDE_EFFECTS.map((s) => s.en), t.none]} label={t} /></div>
        <div className="stack" style={{ gap: 8 }}>
          {[...SIDE_EFFECTS.map((s) => ({ id: s.id, label: s.en })), { id: 'none', label: t.none }, { id: 'not_sure', label: t.notSure }].map((o) => (
            <button key={o.id} className={big(se.includes(o.id))} aria-pressed={se.includes(o.id)} data-option={`se:${o.id}`} onClick={() => toggle(o.id)}>{se.includes(o.id) && <LuCircleCheck aria-hidden />} {o.label}</button>))}
        </div>
        <Button disabled={!se.length} onClick={() => setStep(adh === 'not_asked' ? 3 : 2)} data-testid="followup-next">{t.next}</Button>
      </>}
      {step === 2 && <>
        <div className="row between"><b>{t.adh}</b><ReadAloud lines={[t.adh, t.yes, t.sometimes, t.no, t.notSure]} label={t} /></div>
        <div className="stack" style={{ gap: 8 }}>
          {(['yes', 'sometimes', 'no', 'not_sure'] as const).map((k) => <button key={k} className={big(adh === k)} data-option={`adh:${k}`} onClick={() => { setAdh(k); setStep(3); }}>{t[k === 'not_sure' ? 'notSure' : k]}</button>)}
        </div>
      </>}
      {step === 3 && <>
        <Field id={`fu-other-${request.id}`} label={t.other} multiline value={other} onChange={setOther} maxLength={500} />
        <Button onClick={() => setStep(4)} data-testid="followup-review">{t.review}</Button>
      </>}
      {step === 4 && <div className="stack" data-testid="followup-review-box">
        <div className="tiny muted strong">{t.you}</div>
        <div className="pre">{answerLines(answer, t).join('\n')}</div>
        <ReadAloud lines={answerLines(answer, t)} label={t} />
        <div className="grid2"><Button variant="secondary" onClick={() => setStep(0)}>{t.change}</Button>
          <Button onClick={() => onSend(answerLines(answer, T.en).join(' · '), 'followup_answer', { followupAnswer: answer, replyTo: request.id, approvedByPatient: true })} data-testid="followup-send"><LuCircleCheck aria-hidden /> {t.send}</Button></div>
      </div>}
      {step < 4 && <div className="tiny muted">{step + 1} / {qs.length + 1}</div>}
    </div>
  );
}

/** The follow-up request in the message list (both sides). */
export function FollowUpRequestBubble({ m, answered, isDoctor }: { m: Message; answered: boolean; isDoctor: boolean }) {
  const f = m.meta!.followup!; const t = T.en;
  return (
    <div className={`bubble ${isDoctor ? 'me' : 'them'} question`} data-kind="followup">
      <b className="bubble-tag">FOLLOW-UP{f.medication ? ` · ${f.medication.toUpperCase()}` : ''}</b>
      {isDoctor ? `Follow-up ${isDue(m) ? 'sent' : 'scheduled'} for ${fmtDate(f.dueAt)}${answered ? ' — answered' : isDue(m) ? ' — waiting for the patient' : ''}.`
        : answered ? t.sent : isDue(m) ? t.title : t.coming(fmtDate(f.dueAt))}
      <span className="meta">{fmtDate(m.createdAt)}</span>
    </div>
  );
}

/** The patient's approved follow-up answer, with the rule-based flags. */
export function FollowUpAnswerBubble({ m, isDoctor }: { m: Message; isDoctor: boolean }) {
  const a = m.meta!.followupAnswer!; const t = T.en;
  const flags = followUpFlags(a);
  return (
    <div className={`card flat ${flags.some((x) => x.level === 'emergency') ? 'cie-warn danger' : flags.some((x) => x.level === 'urgent') ? 'cie-warn warn' : ''}`} style={{ gap: 6 }} data-kind="followup_answer" data-testid="followup-answer">
      <b className="bubble-tag">{isDoctor ? 'FOLLOW-UP ANSWER · APPROVED BY PATIENT' : 'YOUR FOLLOW-UP ANSWER'}</b>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{answerLines(a, t).join('\n')}</div>
      {flags.map((x) => <div key={x.text} className={`small ${x.level === 'emergency' ? 'danger-text' : x.level === 'urgent' ? 'warn-text' : 'muted'}`}><b>{x.level === 'emergency' ? 'EMERGENCY WARNING' : x.level === 'urgent' ? 'URGENT' : 'NOTE'}</b> {x.text}{isDoctor && x.refs.map((r) => REF_BY_ID[r] && <React.Fragment key={r}> · <a href={REF_BY_ID[r].url} target="_blank" rel="noreferrer">NHS: {REF_BY_ID[r].title}</a></React.Fragment>)}</div>)}
      <span className="meta">{fmtDate(m.createdAt)}</span>
    </div>
  );
}

/** The doctor's approved explanation of the visit, with read aloud. */
export function VisitSummaryCard({ m }: { m: Message }) {
  const v = m.meta!.summary!;
  const lines = v.text.split(/\n+/).filter(Boolean);
  return (
    <div className="rx-card" data-kind="visit_summary" data-testid="visit-summary">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}><b className="bubble-tag"><LuFileText aria-hidden /> YOUR VISIT, EXPLAINED · {v.approvedBy.toUpperCase()}</b><ReadAloud lines={lines} label={T.en} /></div>
      <div style={{ fontSize: '1.08em', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{v.text}</div>
      <span className="meta">Approved by your doctor {fmtDate(v.approvedAt)}{v.source === 'ai_reviewed' ? ' · worded with AI help and reviewed by your doctor' : ''}</span>
    </div>
  );
}

export { isDue };
