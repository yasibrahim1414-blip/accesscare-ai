import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuSparkles, LuPencil, LuSend, LuSave, LuCircleCheck, LuCircleHelp, LuShieldAlert, LuX, LuCheck, LuFileText } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Field, SpeakButton, Steps, TopBar, speak } from '../../ui/components';
import { BodySelector } from '../../body/BodySelector';
import { RED_FLAG_CHECKS, SAFETY_LIMIT_NOTE, assessSafety } from '../../services/safety';
import type { AuditEvent, ClarificationAnswer, Consultation, Sensation, SymptomDetails } from '../../domain/types';
import { SENSATION_LABELS } from '../../domain/types';
import type { ClinicalBrief, Reconstruction } from '../../domain/reconstruction';
import { EmergencyContent, UrgentHelpButton } from '../shared/Emergency';
import { regionLabel } from '../../domain/bodyRegions';
import {
  type Answer, type CaptureInput, type Question, applyAnswer, briefText, build, buildBrief, extractByRules, metrics, nextQuestion, templateMainConcern, toStructuredReport,
} from '../../services/intent/ReconstructionEngine';
import { BriefView, ContradictionList, ItemsVerifier, MetricsCard, Reconstruction3D } from '../shared/Reconstruction';

type Step = 'safety' | 'urgent' | 'body' | 'symptoms' | 'details' | 'understand' | 'clarify' | 'verify' | 'brief' | 'done';
const PROGRESS: Step[] = ['body', 'symptoms', 'details', 'clarify', 'verify', 'brief'];
const STEP_LABEL: Record<string, string> = { body: 'Where', symptoms: 'What you feel', details: 'More detail', clarify: 'Clarify', verify: 'Check our understanding', brief: 'Approve report' };

const SENSATION_ICONS: Record<Sensation, string> = {
  pain: '⚡', numbness: '🧊', burning: '🔥', itching: '🪶', swelling: '🎈', weakness: '🪫', tingling: '✨', other: '➕', not_sure: '❔',
};
const ONSET = ['Today', '1–3 days ago', 'About a week ago', 'More than a week ago'];
const now = () => new Date().toISOString();

export function ConsultationFlow({ id }: { id: string }) {
  const { backend, nav } = useApp();
  const load = useLoad(() => backend.getConsultation(id), [id]);
  if (load.loading && !load.data) return <><TopBar title="Consultation" /><div className="screen"><div className="pad"><div className="skeleton" style={{ height: 200 }} /></div></div></>;
  if (load.error || !load.data) return <><TopBar title="Consultation" /><div className="screen"><div className="pad"><Banner kind="danger">{load.error}</Banner><Button onClick={nav.back}>Go back</Button></div></div></>;
  return <Flow initial={load.data.consultation} />;
}

/** One adaptive question, answered with the simplest suitable input. */
export function QuestionCard({ q, onAnswer, label }: { q: Question; onAnswer: (a: Answer, shown: string) => void; label?: string }) {
  const { prefs } = useApp();
  const [text, setText] = useState('');
  const [multi, setMulti] = useState<string[]>([]);
  const [explain, setExplain] = useState(false);
  useEffect(() => { setText(''); setMulti([]); setExplain(false); if (prefs.textToSpeech) speak(q.text); }, [q.id]); // eslint-disable-line
  const yesNo = q.format === 'yes_no';
  return (
    <div className="card raised" style={{ gap: 16 }} data-testid="question-card">
      <div className="row between small">
        <span className="chip teal"><LuSparkles aria-hidden /> {label ?? 'Intent Bridge'}</span>
        {q.kind === 'contradiction' && <span className="tag needs_clarification">Possible mismatch</span>}
        {q.kind === 'suggestion' && <span className="tag suggested">Checking our understanding</span>}
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <h2 className="title grow" style={{ fontSize: prefs.largerText ? '1.55em' : '1.3em' }} data-testid="bridge-question">{q.text}</h2>
        <SpeakButton text={q.text} />
      </div>
      <p className="small muted">Why we ask: {q.reason}</p>
      {q.explain && (explain ? <div className="banner info small">{q.explain}</div>
        : <button className="link-btn" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => setExplain(true)}><LuCircleHelp aria-hidden style={{ verticalAlign: -2 }} /> What does this mean?</button>)}
      {q.format === 'text' && (
        <div className="stack">
          <Field id={`q-${q.id}`} label="Your answer" multiline value={text} onChange={setText} maxLength={500} />
          <Button big disabled={!text.trim()} onClick={() => onAnswer({ type: 'value', value: text.trim() }, text.trim())}>Save answer</Button>
        </div>
      )}
      {(q.format === 'choice' || q.format === 'yes_no') && (
        <div className={yesNo ? 'grid2' : 'stack'} style={{ gap: 10 }}>
          {q.options.map((o) => (
            <button key={o.label} className={`choice${yesNo ? ' yesno' : ''}${o.label === 'Yes' ? ' yes' : ''}`} onClick={() => onAnswer({ type: 'value', value: o.value }, o.label)}>
              {prefs.visualOptions && o.icon && <span className="ico" aria-hidden>{o.icon}</span>}{o.label}
            </button>
          ))}
        </div>
      )}
      {q.format === 'multi' && (
        <div className="stack">
          <div className="choice-grid">
            {q.options.map((o) => (
              <button key={o.label} className="choice" aria-pressed={multi.includes(o.value)}
                onClick={() => setMulti((m) => o.value === 'Nothing else' ? ['Nothing else'] : m.includes(o.value) ? m.filter((x) => x !== o.value) : [...m.filter((x) => x !== 'Nothing else'), o.value])}>
                {prefs.visualOptions && o.icon && <span className="ico" aria-hidden>{o.icon}</span>}{o.label}<span className="check" aria-hidden>✓</span>
              </button>
            ))}
          </div>
          <Button big disabled={!multi.length} onClick={() => onAnswer({ type: 'value', value: multi.join('|') }, multi.join(', '))}>Done</Button>
        </div>
      )}
      <div className="grid2">
        {q.kind !== 'optional' && <Button variant="secondary" onClick={() => onAnswer({ type: 'unsure' }, 'Not sure')}>Not sure</Button>}
        <Button variant="secondary" onClick={() => onAnswer({ type: 'skip' }, 'Skipped')} style={q.kind === 'optional' ? { gridColumn: '1 / -1' } : undefined}>Skip</Button>
      </div>
    </div>
  );
}

function Flow({ initial }: { initial: Consultation }) {
  const { backend, ai, prefs, nav, toast, refresh } = useApp();
  const resumeStep: Step = initial.reconstruction ? 'verify' : initial.sensations.length ? 'details' : initial.regionIds.length ? 'symptoms' : 'safety';
  const [step, setStep] = useState<Step>(resumeStep);
  const [regionIds, setRegions] = useState<string[]>(initial.regionIds);
  const [sensations, setSensations] = useState<Sensation[]>(initial.sensations);
  const [details, setDetails] = useState<SymptomDetails>(initial.details);
  const [rec, setRec] = useState<Reconstruction | null>(initial.reconstruction ?? null);
  const [answersLog, setAnswersLog] = useState<ClarificationAnswer[]>(initial.answers ?? []);
  const [audit, setAudit] = useState<AuditEvent[]>(initial.audit ?? []);
  const [redFlags, setRedFlags] = useState<string[]>([]);
  const [urgentShown, setUrgentShown] = useState(initial.urgentGuidanceShown);
  const [urgentReasons, setUrgentReasons] = useState<string[]>([]);
  const [urgentReturn, setUrgentReturn] = useState<Step>('body');
  const [brief, setBrief] = useState<ClinicalBrief | null>(null);
  const [summary, setSummary] = useState('');
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [sheet, setSheet] = useState<null | 'cancel' | 'reject'>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const [sharedTo, setSharedTo] = useState<string | null>(null);
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const input: CaptureInput = { regionIds, sensations, details };
  const q = useMemo(() => (rec && step === 'clarify' ? nextQuestion(rec, prefs, input) : null), // eslint-disable-next-line
    [rec, step, prefs]);
  const aiState = ai.state(prefs.aiAssist);

  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [step, q?.id]);

  const log = (action: string, detail?: string) => setAudit((a) => [...a, { at: now(), by: 'patient', action, detail }]);
  const persist = async (patch: Parameters<typeof backend.updateDraft>[1]) => {
    try { await backend.updateDraft(initial.id, patch); } catch (e) { toast((e as Error).message); }
  };
  const goUrgent = async (from: Step, reasons: string[]) => {
    setUrgentReasons(reasons); setUrgentReturn(from); setStep('urgent'); setUrgentShown(true);
    await persist({ urgentGuidanceShown: true });
  };

  // ---------- step actions ----------
  const afterSafety = () => {
    const s = assessSafety({ regionIds, sensations, details, redFlags });
    if (s.urgent) goUrgent('body', s.reasons); else setStep('body');
  };
  const afterBody = async () => { await persist({ regionIds }); setStep('symptoms'); };
  const afterSymptoms = async () => { await persist({ sensations, details }); setStep('details'); };

  /** Understand: build the provisional representation from selections + the patient's words. */
  const afterDetails = async () => {
    setStep('understand');
    await persist({ details });
    const text = details.description ?? '';
    setWorking(text && aiState === 'available' ? 'Reading your words with AI…' : 'Organizing what you told us…');
    const ruleSugg = extractByRules(text);
    let aiSugg: typeof ruleSugg = [];
    let hint: Awaited<ReturnType<typeof ai.safetyHint>> = null;
    if (text && aiState === 'available') {
      const ctx = { regions: regionIds.map(regionLabel), sensations: sensations.map((s) => SENSATION_LABELS[s]) };
      [aiSugg, hint] = await Promise.all([ai.extract(text, ctx), ai.safetyHint(text, ctx)]);
      if (aiSugg.length || hint) setAiUsed(true);
    }
    // rules first; AI only fills fields the rules did not find
    const merged = [...ruleSugg, ...aiSugg.filter((a) => !ruleSugg.some((r) => r.field === a.field))];
    const r = build(input, merged);
    setRec(r);
    log('captured', `${r.items.filter((i) => i.value).length} details, ${merged.length} suggestion(s)`);
    await persist({ reconstruction: r });
    const s = assessSafety({ regionIds, sensations, details, aiHint: hint });
    if (s.urgent && !urgentShown) { goUrgent('clarify', s.reasons); return; }
    setStep('clarify');
  };

  const onAnswer = async (a: Answer, shown: string) => {
    if (!rec || !q) return;
    const next = applyAnswer(rec, q, a, input);
    const entry: ClarificationAnswer = { questionId: q.id, question: q.text, status: a.type === 'value' ? 'answered' : a.type === 'unsure' ? 'unsure' : 'skipped', value: a.type === 'value' ? shown : undefined };
    const log2 = [...answersLog.filter((x) => x.questionId !== q.id), entry];
    setAck(a.type === 'value' ? `Got it: ${shown}` : a.type === 'unsure' ? 'Noted: not sure' : 'Skipped — nothing was filled in');
    setTimeout(() => setAck(null), prefs.relaxedPace ? 1600 : 900);
    setRec(next); setAnswersLog(log2);
    await persist({ reconstruction: next, answers: log2 });
    if (q.key === 'associated' && a.type === 'value') {
      const s = assessSafety({ regionIds, sensations, details, associated: next.items.find((i) => i.key === 'associated')?.value });
      if (s.urgent && !urgentShown) { goUrgent('clarify', s.reasons); return; }
    }
    if (!nextQuestion(next, prefs, input)) setStep('verify');
  };

  const makeBrief = async () => {
    if (!rec) return;
    setStep('brief'); setRejected(false); setEdited(false); setEditing(false);
    let main: string | null = null;
    if (aiState === 'available') {
      setWorking('Writing the main concern with AI…');
      const facts = rec.items.filter((i) => i.status === 'confirmed' && i.value && i.field !== 'context').map((i) => `${i.label}: ${i.value}`);
      main = await ai.wordMainConcern(facts);
      if (main) setAiUsed(true);
    }
    setWorking('');
    const b = buildBrief(rec, main ? { mainConcern: main, wordedBy: 'ai' } : {});
    setBrief(b); setSummary(briefText(b));
    log('brief_generated', b.wordedBy === 'ai' ? 'AI wording' : 'template wording');
  };

  const share = async (toDoctor: boolean) => {
    if (!rec || !brief) return;
    setErr(null); setBusy(true);
    const report = toStructuredReport(rec, brief, answersLog, aiUsed ? 'ai-provider' : 'demo-rules');
    const payload = { text: summary, report, editedByPatient: edited };
    try {
      await persist({ audit: [...audit, { at: now(), by: 'patient', action: edited ? 'approved_after_edit' : 'approved' }] });
      if (toDoctor) { await backend.approveAndShare(initial.id, payload); setSharedTo(doctor.data?.fullName ?? 'your doctor'); }
      else { await backend.saveApprovedWithoutDoctor(initial.id, payload); setSharedTo(null); }
      refresh(); setStep('done');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    try { await backend.cancelConsultation(initial.id); refresh(); toast('Consultation cancelled'); nav.back(); }
    catch (e) { toast((e as Error).message); }
  };

  const progress = PROGRESS.indexOf(step === 'understand' ? 'details' : step);
  const title = step === 'verify' ? 'Check our understanding' : step === 'brief' ? 'Approve your report' : step === 'done' ? 'Done' : 'New consultation';
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (step === 'safety') {
    body = (<>
      <div><h2 className="title">First, a quick safety check</h2><p className="muted">Is any of this happening right now? Tap all that apply.</p></div>
      <div className="stack" style={{ gap: 8 }}>
        {RED_FLAG_CHECKS.map((c) => (
          <button key={c.id} className="choice" role="checkbox" aria-checked={redFlags.includes(c.id)}
            onClick={() => setRedFlags((r) => r.includes(c.id) ? r.filter((x) => x !== c.id) : [...r, c.id])}>{c.label}<span className="check" aria-hidden>✓</span></button>
        ))}
      </div>
    </>);
    footer = redFlags.length
      ? <Button variant="danger" big onClick={afterSafety}>Get urgent help</Button>
      : <Button big onClick={afterSafety} data-testid="none-of-these">None of these — continue</Button>;
  }

  if (step === 'urgent') {
    body = <EmergencyContent reasons={urgentReasons.length ? urgentReasons : assessSafety({ regionIds, sensations, details, redFlags }).reasons} />;
    footer = <Button variant="secondary" block onClick={() => setStep(urgentReturn)}>I’ve got help or it’s not urgent — continue</Button>;
  }

  if (step === 'body') {
    body = (<>
      <div><h2 className="title">Where do you feel it?</h2>
        <p className="muted small">Tap one or more areas. Double-tap to zoom in. Left and right mean <b>your</b> left and right.</p></div>
      <BodySelector selected={regionIds} onChange={setRegions} />
    </>);
    footer = <Button big disabled={!regionIds.length} onClick={afterBody} data-testid="body-next">Next</Button>;
  }

  if (step === 'symptoms') {
    body = (<>
      <div className="row between"><h2 className="title">What would you like to tell your doctor about this area?</h2><SpeakButton text="What would you like to tell your doctor about this area?" /></div>
      <p className="small muted">{regionIds.map(regionLabel).join(', ')} · Choose any that fit.</p>
      <div className="choice-grid">
        {(Object.keys(SENSATION_LABELS) as Sensation[]).map((s) => (
          <button key={s} className="choice" aria-pressed={sensations.includes(s)} onClick={() => setSensations((x) => x.includes(s) ? x.filter((y) => y !== s) : [...x, s])}>
            {prefs.visualOptions && <span className="ico" aria-hidden>{SENSATION_ICONS[s]}</span>}{SENSATION_LABELS[s]}<span className="check" aria-hidden>✓</span>
          </button>
        ))}
      </div>
      {sensations.includes('other') && <Field id="other-sensation" label="Describe it (optional)" value={details.otherSensation ?? ''}
        onChange={(v) => setDetails((d) => ({ ...d, otherSensation: v }))} placeholder="e.g. pressure, cramping" maxLength={120} />}
    </>);
    footer = <><Button variant="secondary" onClick={() => setStep('body')}>Back</Button><Button big disabled={!sensations.length} onClick={afterSymptoms}>Next</Button></>;
  }

  if (step === 'details') {
    body = (<>
      <div><h2 className="title">Anything more? (optional)</h2><p className="muted">Answer what you can. You can skip all of this — we’ll ask short questions next.</p></div>
      <div className="stack" style={{ gap: 8 }}>
        <b>How strong is it?</b>
        <div className="scale" role="radiogroup" aria-label="Severity from 1 to 10">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button key={n} role="radio" aria-checked={details.severity === n} onClick={() => setDetails((d) => ({ ...d, severity: d.severity === n ? undefined : n }))}>{n}</button>
          ))}
        </div>
        <div className="scale-labels"><span>Very mild</span><span>Worst</span></div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <b>When did it begin?</b>
        <div className="choice-grid">
          {ONSET.map((o) => <button key={o} className="choice" aria-pressed={details.onset === o} onClick={() => setDetails((d) => ({ ...d, onset: d.onset === o ? undefined : o }))}>{o}</button>)}
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <b>Is it there all the time?</b>
        <div className="grid2">
          <button className="choice" aria-pressed={details.pattern === 'constant'} onClick={() => setDetails((d) => ({ ...d, pattern: d.pattern === 'constant' ? undefined : 'constant' }))}>All the time</button>
          <button className="choice" aria-pressed={details.pattern === 'comes_and_goes'} onClick={() => setDetails((d) => ({ ...d, pattern: d.pattern === 'comes_and_goes' ? undefined : 'comes_and_goes' }))}>Comes and goes</button>
        </div>
      </div>
      <Field id="details-desc" label="In your own words (optional)" multiline value={details.description ?? ''} maxLength={1000}
        onChange={(v) => setDetails((d) => ({ ...d, description: v }))} placeholder="Anything you want your doctor to know" />
      <p className="tiny muted">{aiState === 'available' ? 'AI assistance is on: your words (not your name) are read by Claude to suggest details. You confirm every suggestion.'
        : aiState === 'off' ? 'AI assistance is off — AccessCare rules organize your words. You can turn AI on in Preferences.' : 'AccessCare rules organize your words.'}</p>
    </>);
    footer = <><Button variant="secondary" onClick={() => setStep('symptoms')}>Back</Button>
      <Button big onClick={afterDetails} data-testid="details-next">{details.severity || details.onset || details.pattern || details.description ? 'Next' : 'Skip'}</Button></>;
  }

  if (step === 'understand') {
    body = <div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 60 }}><div className="body-loader"><span /><span /><span /></div><p className="muted">{working}</p></div>;
  }

  if (step === 'clarify' && rec) {
    body = q ? (<>
      <QuestionCard q={q} onAnswer={onAnswer} label={aiState === 'available' ? 'Intent Bridge · AI assisted' : 'Intent Bridge'} />
      {ack && <div className="banner ok" role="status"><LuCheck aria-hidden />{ack}</div>}
      <p className="tiny muted">Questions come from AccessCare rules that look at what is missing or doesn’t match. Skipped questions stay “not answered” — nothing is filled in for you.</p>
    </>) : <Banner kind="ok">No more questions. Check what we understood next.</Banner>;
    footer = <Button variant="ghost" onClick={() => setStep('verify')} data-testid="finish-now">Finish questions</Button>;
  }

  if (step === 'verify' && rec) {
    const m = metrics(rec);
    body = (<>
      <div><h2 className="title">Is this what you mean?</h2><p className="muted small">This is what we understood. Tap any item to change, remove, or mark it unsure. Nothing is sent yet.</p></div>
      <Reconstruction3D rec={rec} />
      <ContradictionList list={rec.contradictions} />
      <ItemsVerifier rec={rec} input={input} onChange={async (r) => { setRec(r); log('corrected'); await persist({ reconstruction: r }); }} />
      <MetricsCard m={m} />
      <Button variant="danger-outline" onClick={() => setSheet('cancel')}>Cancel consultation</Button>
    </>);
    footer = <><Button variant="secondary" onClick={() => { setRec((r) => r ? { ...r, asked: r.asked.filter((x) => x === 'q_context') } : r); setStep('clarify'); }}>Ask again</Button>
      <Button big onClick={makeBrief} data-testid="to-brief"><LuFileText aria-hidden /> Looks right — build report</Button></>;
  }

  if (step === 'brief') {
    const hasDoctor = !!doctor.data;
    body = !brief ? <div className="stack" style={{ alignItems: 'center', paddingTop: 60 }}><div className="body-loader"><span /><span /><span /></div><p className="muted">{working || 'Preparing…'}</p></div> : (<>
      <div><h2 className="title">Your report for the doctor</h2><p className="muted small">Each line shows whether it is your information, wording written for you, or still unknown. Approve, edit, or reject it.</p></div>
      <BriefView brief={brief} />
      <div className="stack" style={{ gap: 8 }}>
        <div className="row between"><b>Exact text your doctor will receive</b>{edited && <span className="chip">Edited by you</span>}</div>
        {editing
          ? <Field id="summary-edit" label="Edit the report" multiline value={summary} onChange={(v) => { setSummary(v); setEdited(true); }} maxLength={4000} hint="Your words are shared exactly as written." />
          : <div className="pre" data-testid="summary-text">{summary}</div>}
        <div className="grid2">
          <Button variant="secondary" onClick={() => setEditing(!editing)}><LuPencil aria-hidden /> {editing ? 'Done editing' : 'Edit Information'}</Button>
          <Button variant="secondary" onClick={() => { setBrief(null); setStep('verify'); }}>Go Back</Button>
        </div>
      </div>
      <div className="banner info small"><LuShieldAlert aria-hidden /><div>{urgentShown ? 'Urgent-help guidance was shown during this report.' : SAFETY_LIMIT_NOTE}</div></div>
      {!hasDoctor && <Banner kind="warn">You aren’t connected to a doctor yet, so this can’t be sent. You can save it and send it after you connect.</Banner>}
      {err && <Banner kind="danger">{err}</Banner>}
      <Button variant="danger-outline" onClick={() => setSheet('reject')} data-testid="reject-report"><LuX aria-hidden /> Reject this report</Button>
    </>);
    footer = brief ? (hasDoctor
      ? <Button big onClick={() => share(true)} busy={busy} disabled={summary.trim().length < 5} data-testid="confirm-share"><LuSend aria-hidden /> Approve and share with {doctor.data!.fullName}</Button>
      : <Button big onClick={() => share(false)} busy={busy}><LuSave aria-hidden /> Approve and save (not sent)</Button>) : null;
  }

  if (step === 'done') {
    body = (<div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 24 }}>
      <LuCircleCheck style={{ fontSize: 64, color: 'var(--ok)' }} aria-hidden />
      <h2 className="title">{sharedTo ? `Shared with ${sharedTo}` : 'Saved — not sent'}</h2>
      <p className="muted">{sharedTo
        ? (backend.shared ? 'Your approved report is now in your doctor’s inbox. They can see it on their own device.' : 'Your approved report is in your doctor’s inbox in this offline demo.')
        : 'Connect with a doctor, then open this consultation to send it.'}</p>
    </div>);
    footer = <Button big onClick={() => nav.replace({ name: 'p.detail', id: initial.id })}>View consultation</Button>;
  }

  return (
    <>
      <TopBar title={title} right={step !== 'done' ? <UrgentHelpButton /> : undefined} onBack={step === 'done' ? () => nav.back() : undefined} />
      <div className="screen screen-in" ref={scrollRef}>
        <div className="pad">
          {progress >= 0 && step !== 'urgent' && <Steps total={PROGRESS.length} current={progress} label={STEP_LABEL[step === 'understand' ? 'details' : step]} />}
          {rejected && step === 'verify' && <Banner kind="info">You rejected that version. Nothing was shared. Change anything you need, then build the report again.</Banner>}
          {body}
        </div>
      </div>
      {footer && <div className="footer-bar">{footer}</div>}
      {sheet === 'cancel' && <ConfirmSheet title="Cancel this consultation?" danger confirmLabel="Yes, cancel and delete" icon={<LuX />}
        body="Your answers for this consultation will be deleted. Nothing has been sent." onConfirm={cancel} onCancel={() => setSheet(null)} />}
      {sheet === 'reject' && <ConfirmSheet title="Reject this report?" icon={<LuX />} confirmLabel="Reject — don’t send"
        body="Nothing will be shared. You’ll go back to check our understanding and can build a new version."
        onConfirm={() => { setSheet(null); setBrief(null); setRejected(true); log('rejected_report'); setStep('verify'); }} onCancel={() => setSheet(null)} />}
    </>
  );
}

export { templateMainConcern };
