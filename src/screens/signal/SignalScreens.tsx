import React, { useMemo, useState } from 'react';
import {
  LuRadioTower, LuPlay, LuSlidersHorizontal, LuCircleCheck, LuTriangleAlert, LuChevronRight, LuVolume2, LuSparkles, LuSend, LuSave, LuRotateCcw, LuPencil, LuMapPin, LuCircleX,
} from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Empty, LargeBar, Skeleton, Steps, Toggle, TopBar, fmtRelative, speak, ttsSupported } from '../../ui/components';
import { DEFAULT_SIGNAL, type SignalMethod, type SignalPrefs, type Sensation } from '../../domain/types';
import {
  CALIBRATION_BOARD, CALIBRATION_TARGETS, SENSATION_SYMBOLS, SIGNAL_STEPS, adviceAfterCalibration, methodCatalog, mustConfirm, scoreCalibration, templateMessage,
  type CalibrationTrial, type SignalOption,
} from '../../services/signal/SignalEngine';
import { SignalBoard, speechSupported } from './SignalBoard';
import { BODY_REGIONS, REGION_GROUPS, regionLabel } from '../../domain/bodyRegions';
import { BodySelector } from '../../body/BodySelector';
import { EmergencyContent, UrgentHelpButton } from '../shared/Emergency';
import { StatusChip } from '../patient/PatientScreens';
import { build, buildBrief, briefText, toStructuredReport } from '../../services/intent/ReconstructionEngine';
import type { SignalRecord, SignalSelection } from '../../domain/reconstruction';
import { assessSafety } from '../../services/safety';
import { CameraModeCard } from './CameraSignal';

const METHOD_TITLE: Record<SignalMethod, string> = { large_buttons: 'Large buttons', symbols: 'Symbol board', yes_no: 'Yes / No only', switch_scan: 'Single switch (scanning)', speech: 'Speak your choice' };

function useSignalPrefs() {
  const { me, setMe, backend, toast } = useApp();
  const sp: SignalPrefs = me?.preferences.signal ?? DEFAULT_SIGNAL;
  const save = async (next: SignalPrefs) => {
    try { const saved = await backend.savePreferences({ ...me!.preferences, signal: next }); setMe({ ...me!, preferences: saved }); return true; }
    catch (e) { toast((e as Error).message); return false; }
  };
  return { sp, save };
}

export function SignalHome() {
  const { backend, nav, prefs } = useApp();
  const { sp } = useSignalPrefs();
  const list = useLoad(() => backend.listConsultations(), []);
  const sessions = (list.data ?? []).filter((v) => v.consultation.kind === 'signal');
  const cal = sp.calibration;
  return (
    <>
      <LargeBar eyebrow="Adaptive non-verbal communication" title="Silent Signal AI" right={<UrgentHelpButton />} />
      <div className="screen screen-in"><div className="pad">
        <section className="hero-card signal-hero">
          <div className="pulse-ring" aria-hidden />
          <h2>Tell your doctor without typing or speaking</h2>
          <p className="muted small">Choose from pictures and big buttons with the input method that works for you. You check every choice, and you approve the message before it is sent.</p>
          <Button big block onClick={() => nav.push({ name: 'ss.session' })} data-testid="start-signal"><LuPlay aria-hidden /> Start a session</Button>
        </section>
        <div className="card">
          <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuRadioTower /></span>
            <div className="grow"><div className="tiny muted strong">Your input method</div><b data-testid="signal-method">{METHOD_TITLE[sp.method]}</b></div></div>
          {cal && cal.method === sp.method
            ? <div className={`banner ${cal.passed ? 'ok' : 'warn'} small`}>{cal.passed ? <LuCircleCheck aria-hidden /> : <LuTriangleAlert aria-hidden />}
                <div>{cal.passed ? 'Calibrated' : 'Calibration needs another try'} · {cal.correct} of {cal.attempts} practice selections registered correctly{cal.misregistered ? ` · ${cal.misregistered} misregistered` : ''} · {fmtRelative(cal.at)}</div></div>
            : <div className="banner info small"><LuTriangleAlert aria-hidden /><div>Not calibrated yet. A short practice checks that your selections are registered correctly. You can still start a session — every choice will be confirmed.</div></div>}
          <div className="grid2">
            <Button variant="secondary" onClick={() => nav.push({ name: 'ss.calibrate' })} data-testid="open-calibration"><LuSlidersHorizontal aria-hidden /> {cal ? 'Recalibrate' : 'Set up'}</Button>
            <Button variant="secondary" onClick={() => nav.push({ name: 'p.prefs' })}>Preferences</Button>
          </div>
          <p className="tiny muted">{mustConfirm(sp) ? 'Each selection is confirmed before it counts.' : 'Calibration passed: single selections count; you still review everything before sending.'}{prefs.aiAssist ? ' AI may suggest natural wording; you approve it.' : ''}</p>
        </div>
        <CameraModeCard />
        <h3 className="section">Session history</h3>
        {list.loading && !list.data ? <Skeleton rows={2} /> : sessions.length ? (
          <div className="list">{sessions.map((v) => (
            <button key={v.consultation.id} className="list-item" onClick={() => nav.push({ name: 'p.detail', id: v.consultation.id })}>
              <span className="li-ico"><LuRadioTower /></span>
              <div className="grow"><b>{v.consultation.regionIds.map(regionLabel).join(', ') || 'Message'}</b><div className="small muted">{fmtRelative(v.consultation.sharedAt ?? v.consultation.updatedAt)}</div></div>
              <StatusChip status={v.consultation.status} /><LuChevronRight className="chev" />
            </button>))}</div>
        ) : <Empty icon={<LuRadioTower />} title="No sessions yet">Messages you send with Silent Signal appear here.</Empty>}
      </div></div>
    </>
  );
}

export function SignalCalibrate() {
  const { nav, toast } = useApp();
  const { sp, save } = useSignalPrefs();
  const env = { speech: speechSupported(), tts: ttsSupported() };
  const catalog = methodCatalog(env);
  const [phase, setPhase] = useState<'method' | 'settings' | 'practice' | 'result'>('method');
  const [draft, setDraft] = useState<SignalPrefs>({ ...sp, confirmEachSelection: true });
  const [trials, setTrials] = useState<CalibrationTrial[]>([]);
  const [last, setLast] = useState<CalibrationTrial | null>(null);
  const target = CALIBRATION_TARGETS[trials.length];
  const result = useMemo(() => (phase === 'result' ? scoreCalibration(draft.method, trials) : null), [phase, trials, draft.method]);

  return (
    <>
      <TopBar title="Silent Signal setup" />
      <div className="screen screen-in"><div className="pad">
        <Steps total={4} current={['method', 'settings', 'practice', 'result'].indexOf(phase)} label={phase === 'method' ? 'Choose a method' : phase === 'settings' ? 'Adjust' : phase === 'practice' ? 'Practice' : 'Result'} />
        {phase === 'method' && <>
          <div><h2 className="title">How would you like to choose?</h2><p className="muted small">Pick the method you can use most comfortably. You can change it any time.</p></div>
          <div className="stack" role="radiogroup" aria-label="Input method">
            {catalog.map((m) => (
              <button key={m.id} role="radio" aria-checked={draft.method === m.id} aria-disabled={!m.available} className="role-card" data-testid={`method-${m.id}`}
                onClick={() => m.available && setDraft({ ...draft, method: m.id as SignalMethod })} style={!m.available ? { opacity: .6, cursor: 'not-allowed' } : undefined}>
                <span className="stack" style={{ gap: 2 }}>
                  <b>{m.title}{!m.available && <span className="tag unanswered">Not available here</span>}</b>
                  <span className="small muted">{m.description}</span>
                  {!m.available && m.why && <span className="tiny muted">{m.why}</span>}
                </span>
              </button>
            ))}
          </div>
        </>}
        {phase === 'settings' && <>
          <div><h2 className="title">{METHOD_TITLE[draft.method]}</h2><p className="muted small">Adjust it to your pace.</p></div>
          {draft.method === 'switch_scan' && (
            <div className="card">
              <label htmlFor="scan-speed" className="strong">Scanning speed: {(draft.scanMs / 1000).toFixed(1)} seconds per option</label>
              <input id="scan-speed" type="range" min={800} max={4000} step={100} value={draft.scanMs} onChange={(e) => setDraft({ ...draft, scanMs: Number(e.target.value) })} />
              <div className="scale-labels"><span>Faster</span><span>Slower</span></div>
            </div>
          )}
          <div className="list">
            <Toggle id="sig-confirm" label="Confirm each selection" desc="Ask “Is that right?” after every choice. Stays on until a calibration passes cleanly." checked={draft.confirmEachSelection}
              onChange={(v) => setDraft({ ...draft, confirmEachSelection: v || !(sp.calibration?.passed && sp.calibration.method === draft.method) ? true : v })} />
            <Toggle id="sig-speak" label="Read choices aloud" desc={env.tts ? 'Speak each option and selection.' : 'Text-to-speech isn’t available on this device.'} checked={draft.speakSelections && env.tts} onChange={(v) => setDraft({ ...draft, speakSelections: v })} />
          </div>
          <p className="small muted">Next: a short practice with pictures (not about your health) to check that your choices are registered correctly.</p>
        </>}
        {phase === 'practice' && target && <>
          <div className="card tinted" style={{ alignItems: 'center', textAlign: 'center' }} data-testid="calibration-target">
            <span className="tiny muted strong">PRACTICE {trials.length + 1} OF {CALIBRATION_TARGETS.length}</span>
            <b style={{ fontSize: '1.3em' }}>Select the {target.symbol} {target.label}</b>
          </div>
          {last && <Banner kind={last.registered === last.target && last.patientConfirmed ? 'ok' : 'warn'}>
            {last.registered === last.target ? `Registered correctly: ${CALIBRATION_BOARD.find((o) => o.id === last.registered)?.label}.` : `Registered “${CALIBRATION_BOARD.find((o) => o.id === last.registered)?.label}”, but the target was “${CALIBRATION_BOARD.find((o) => o.id === last.target)?.label}”.`}
            {!last.patientConfirmed ? ' You told us a selection was not what you meant — that is noted.' : ''}{last.ambiguous ? ' One input was unclear and you were asked to choose.' : ''}
          </Banner>}
          <SignalBoard key={trials.length} options={CALIBRATION_BOARD} method={draft.method} scanMs={draft.scanMs} confirm prompt={`Select the ${target.label}`} speakOut={draft.speakSelections}
            onResult={(r) => {
              const t: CalibrationTrial = { target: target.id, registered: r.optionId, patientConfirmed: r.rejected === 0, ambiguous: r.ambiguous };
              const next = [...trials, t];
              setTrials(next); setLast(t);
              if (next.length >= CALIBRATION_TARGETS.length) setPhase('result');
            }} />
        </>}
        {phase === 'result' && result && <>
          <div className="card" style={{ alignItems: 'center', textAlign: 'center' }} data-testid="calibration-result">
            {result.passed ? <LuCircleCheck style={{ fontSize: 48, color: 'var(--ok)' }} aria-hidden /> : <LuTriangleAlert style={{ fontSize: 48, color: 'var(--warn)' }} aria-hidden />}
            <h2 className="title">{result.passed ? 'Your selections were registered reliably' : 'Let’s adjust and try again'}</h2>
            <p className="muted">{result.correct} of {result.attempts} correct · {result.misregistered} not what you meant · {result.ambiguous} unclear</p>
          </div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>{adviceAfterCalibration(result, draft).map((t) => <li key={t}>{t}</li>)}</ul>
        </>}
      </div></div>
      <div className="footer-bar">
        {phase === 'method' && <Button big onClick={() => setPhase('settings')} data-testid="method-next">Continue</Button>}
        {phase === 'settings' && <><Button variant="secondary" onClick={() => setPhase('method')}>Back</Button><Button big onClick={() => { setTrials([]); setLast(null); setPhase('practice'); }} data-testid="start-practice">Start practice</Button></>}
        {phase === 'practice' && <Button variant="secondary" block onClick={() => setPhase('settings')}>Stop practice</Button>}
        {phase === 'result' && result && <>
          <Button variant="secondary" onClick={() => { setTrials([]); setLast(null); setPhase('practice'); }}><LuRotateCcw aria-hidden /> Again</Button>
          <Button big data-testid="save-calibration" onClick={async () => {
            const ok = await save({ ...draft, confirmEachSelection: result.passed && result.misregistered === 0 ? draft.confirmEachSelection : true, calibration: result });
            if (ok) { toast(result.passed ? 'Silent Signal is set up' : 'Saved — each choice will be confirmed'); nav.back(); }
          }}>Save {result.passed ? '' : 'anyway'}</Button>
        </>}
      </div>
    </>
  );
}

type SStep = 'region_group' | 'region' | 'sensation' | 'severity' | 'onset' | 'pattern' | 'need' | 'review' | 'urgent' | 'done';
const ORDER: SStep[] = ['region_group', 'region', 'sensation', 'severity', 'onset', 'pattern', 'need', 'review'];

export function SignalSession() {
  const { backend, ai, prefs, nav, refresh } = useApp();
  const { sp } = useSignalPrefs();
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const confirm = mustConfirm(sp);
  const scanMs = Math.round(sp.scanMs * (prefs.relaxedPace ? 1.4 : 1));
  const [step, setStep] = useState<SStep>('region_group');
  const [group, setGroup] = useState<string | null>(null);
  const [useMap, setUseMap] = useState(false);
  const [regions, setRegions] = useState<string[]>([]);
  const [sel, setSel] = useState<Record<string, SignalSelection>>({});
  const [returnToReview, setReturnToReview] = useState(false);
  const [wording, setWording] = useState<{ text: string; source: 'template' | 'ai' } | null>(null);
  const [rejectedWordings, setRejected] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const aiState = ai.state(prefs.aiAssist);

  const record = (stepId: string, question: string, opt: SignalOption) =>
    setSel((s) => ({ ...s, [stepId]: { step: stepId, question, choice: opt.label, confirmed: true, at: new Date().toISOString() } }));
  const advance = (from: SStep) => {
    if (returnToReview && from !== 'region_group') { setReturnToReview(false); setWording(null); setStep('review'); return; }
    setStep(ORDER[ORDER.indexOf(from) + 1]);
  };
  const choice = (id: string) => sel[id]?.choice;
  const sensation = SENSATION_SYMBOLS.find((s) => s.label === choice('sensation'));
  const template = templateMessage({
    regions: regions.map(regionLabel), sensation: choice('sensation'), severity: choice('severity') === 'Not sure' ? 'Not sure' : choice('severity'),
    onset: choice('onset'), pattern: choice('pattern'), need: choice('need'),
  });
  const message = wording?.text ?? template;
  const facts = [`Region: ${regions.map(regionLabel).join(', ')}`, ...Object.values(sel).map((s) => `${s.question} ${s.choice}`)];

  const send = async (toDoctor: boolean) => {
    setErr(null); setBusy(true);
    try {
      const sensations: Sensation[] = sensation ? [sensation.sensation] : ['not_sure'];
      const optId = (step: string) => SIGNAL_STEPS.find((x) => x.id === step)?.options.find((o) => o.label === choice(step))?.id;
      const input = { regionIds: regions, sensations, details: {} };
      const rec = build(input, [], { severity: optId('severity'), onset: optId('onset'), pattern: optId('pattern') });
      const ctx = rec.items.find((i) => i.key === 'context')!;
      if (choice('need')) { ctx.value = `Request: ${choice('need')}`; ctx.status = 'confirmed'; ctx.source = 'patient_selected'; ctx.initial = { value: ctx.value, status: 'confirmed' }; }
      const brief = buildBrief(rec);
      const signal: SignalRecord = { method: sp.method, selections: Object.values(sel), wording: message, wordingSource: wording?.source ?? 'template', regionIds: regions, rejectedWordings };
      const report = { ...toStructuredReport(rec, brief, [], wording?.source === 'ai' ? 'ai-provider' : 'demo-rules'), signal };
      const text = `${message}${wording?.source === 'ai' ? ' [wording by AI, approved by patient]' : ' [wording by AccessCare, approved by patient]'}\n\nSelected by the patient with Silent Signal (${METHOD_TITLE[sp.method]}):\n${Object.values(sel).map((s) => `• ${s.question} ${s.choice}`).join('\n')}\n• Region: ${regions.map(regionLabel).join(', ')}\n\n${briefText(brief)}`;
      const c = await backend.createConsultation('signal');
      await backend.updateDraft(c.id, { regionIds: regions, sensations, reconstruction: rec });
      const payload = { text, report, editedByPatient: false };
      if (toDoctor) { await backend.approveAndShare(c.id, payload); setSentTo(doctor.data?.fullName ?? 'your doctor'); }
      else { await backend.saveApprovedWithoutDoctor(c.id, payload); setSentTo(null); }
      refresh(); setStep('done');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const STEP_Q: Record<string, string> = { region_group: 'Where is it? Choose a part of the body', region: 'Which area exactly?', sensation: 'What does it feel like?' };
  const boardFor = (s: SStep) => {
    if (s === 'region_group') return { options: REGION_GROUPS.map((g) => ({ id: g, label: g, symbol: g === 'Head & neck' ? '🙂' : g === 'Torso' ? '👕' : g === 'Arms' ? '💪' : '🦵' })), q: STEP_Q.region_group };
    if (s === 'region') return { options: BODY_REGIONS.filter((r) => r.group === group).map((r) => ({ id: r.id, label: r.label, symbol: r.side === 'left' ? 'L' : r.side === 'right' ? 'R' : '•' })), q: STEP_Q.region };
    if (s === 'sensation') return { options: SENSATION_SYMBOLS.map(({ id, label, symbol }) => ({ id, label, symbol })), q: STEP_Q.sensation };
    const st = SIGNAL_STEPS.find((x) => x.id === s)!;
    return { options: st.options, q: st.question };
  };
  const onBoard = (s: SStep, optId: string) => {
    const b = boardFor(s);
    const opt = b.options.find((o) => o.id === optId)!;
    if (s === 'region_group') { setGroup(optId); setStep('region'); return; }
    if (s === 'region') { setRegions((r) => (r.includes(optId) ? r : [...r, optId])); advance('region'); return; }
    record(s, b.q, opt);
    if (s === 'need' && optId === 'help_now') { setStep('urgent'); return; }
    if (s === 'sensation' && assessSafety({ regionIds: regions, sensations: [], details: {} }).urgent) { setStep('urgent'); return; }
    advance(s);
  };

  const idx = ORDER.indexOf(step);
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;
  if (step === 'urgent') {
    body = <EmergencyContent reasons={['you chose “I need help now”']} />;
    footer = <Button variant="secondary" block onClick={() => setStep(regions.length ? 'review' : 'region_group')}>Continue the message</Button>;
  } else if (step === 'done') {
    body = (<div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 30 }}>
      <LuCircleCheck style={{ fontSize: 64, color: 'var(--ok)' }} aria-hidden />
      <h2 className="title">{sentTo ? `Sent to ${sentTo}` : 'Saved — not sent'}</h2>
      <p className="muted">{sentTo ? 'Your approved message and the choices you made are with your doctor. Replies appear in your history.' : 'Connect with a doctor to send it.'}</p>
    </div>);
    footer = <Button big onClick={() => nav.reset({ name: 'ss.home' })}>Back to Silent Signal</Button>;
  } else if (step === 'review') {
    body = (<>
      <div><h2 className="title">Is this your message?</h2><p className="muted small">Check each choice. Tap one to change it. Nothing is sent until you approve.</p></div>
      <div className="list" data-testid="signal-selections">
        <button className="list-item" onClick={() => { setRegions([]); setReturnToReview(true); setStep('region_group'); }}>
          <span className="li-ico"><LuMapPin /></span><div className="grow"><div className="tiny muted strong">WHERE</div><b>{regions.map(regionLabel).join(', ')}</b><div className="tiny muted">Selected by you · confirmed</div></div><LuPencil className="chev" />
        </button>
        {Object.values(sel).map((s) => (
          <button key={s.step} className="list-item" onClick={() => { setReturnToReview(true); setStep(s.step as SStep); }} data-testid={`sel-${s.step}`}>
            <span className="li-ico"><LuCircleCheck /></span><div className="grow"><div className="tiny muted strong">{s.question.toUpperCase()}</div><b>{s.choice}</b><div className="tiny muted">Selected by you · confirmed</div></div><LuPencil className="chev" />
          </button>
        ))}
      </div>
      <div className="card">
        <div className="row between"><b>Message</b><span className={`prov ${wording?.source === 'ai' ? 'prov-ai' : 'prov-template'}`}>{wording?.source === 'ai' ? <><LuSparkles /> AI wording</> : 'AccessCare wording'}</span></div>
        <div className="pre" data-testid="signal-message">{message}</div>
        <p className="tiny muted">The choices above are yours. The sentence is wording built from them{wording?.source === 'ai' ? ' by AI, checked so it adds nothing you didn’t choose' : ''}.</p>
        <div className="grid2">
          {ttsSupported() && <Button variant="secondary" onClick={() => speak(message)}><LuVolume2 aria-hidden /> Read aloud</Button>}
          {wording?.source === 'ai'
            ? <Button variant="secondary" onClick={() => { setWording(null); setRejected((n) => n + 1); }} data-testid="reject-ai-wording"><LuCircleX aria-hidden /> Reject AI wording</Button>
            : aiState === 'available' && <Button variant="secondary" busy={aiBusy} data-testid="ai-wording" onClick={async () => {
                setAiBusy(true); const w = await ai.wordMessage(facts); setAiBusy(false);
                setWording(w ? { text: w, source: 'ai' } : null); if (!w) setErr('AI wording wasn’t available or didn’t pass our checks, so the plain wording is kept.');
              }}><LuSparkles aria-hidden /> Natural wording (AI)</Button>}
        </div>
      </div>
      {!doctor.data && <Banner kind="warn">You aren’t connected to a doctor yet, so this can’t be sent. You can save it.</Banner>}
      {err && <Banner kind="info">{err}</Banner>}
    </>);
    footer = doctor.data
      ? <Button big busy={busy} onClick={() => send(true)} data-testid="approve-signal"><LuSend aria-hidden /> Approve and send to {doctor.data.fullName}</Button>
      : <Button big busy={busy} onClick={() => send(false)}><LuSave aria-hidden /> Approve and save</Button>;
  } else {
    const b = boardFor(step);
    body = (<>
      {(step === 'region_group' || step === 'region') && (
        <div className="seg" role="group" aria-label="How to choose the area">
          <button aria-pressed={!useMap} onClick={() => setUseMap(false)}>With my method</button>
          <button aria-pressed={useMap} onClick={() => setUseMap(true)}>Body map</button>
        </div>
      )}
      {(step === 'region_group' || step === 'region') && useMap
        ? <><BodySelector selected={regions} onChange={setRegions} /></>
        : <SignalBoard key={step + (group ?? '')} options={b.options} method={sp.method} scanMs={scanMs} confirm={confirm} prompt={b.q} speakOut={sp.speakSelections}
            onResult={(r) => onBoard(step, r.optionId)} />}
    </>);
    if ((step === 'region_group' || step === 'region') && useMap) footer = <Button big disabled={!regions.length} onClick={() => advance('region')} data-testid="signal-map-next">Next</Button>;
    else if (idx > 0) footer = <Button variant="secondary" block onClick={() => setStep(step === 'region' ? 'region_group' : ORDER[idx - 1])}>Back</Button>;
  }

  return (
    <>
      <TopBar title="Silent Signal" right={step !== 'done' ? <UrgentHelpButton /> : undefined} />
      <div className="screen screen-in"><div className="pad">
        {idx >= 0 && <Steps total={ORDER.length - 1} current={Math.min(idx, ORDER.length - 2)} label={step === 'review' ? 'Review' : METHOD_TITLE[sp.method]} />}
        {body}
      </div></div>
      {footer && <div className="footer-bar">{footer}</div>}
    </>
  );
}
