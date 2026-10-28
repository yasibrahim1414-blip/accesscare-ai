import { teachBackDue } from '../../services/teachback/check';
import { LuGraduationCap } from 'react-icons/lu';
import { DiaryHomeCard } from '../diary/DiaryScreens';
import { NextDoseCard } from '../care/MedScreens';
import { useMeds } from '../care/careData';
import React, { useState } from 'react';
import {
  LuPlus, LuStethoscope, LuChevronRight, LuAccessibility, LuSettings, LuUnlink, LuSend, LuClipboardList, LuInfo,
  LuLogOut, LuClock, LuPersonStanding, LuMessageCircle, LuShieldCheck, LuLink, LuRadioTower, LuCircleCheck,
} from 'react-icons/lu';
import { LuAudioLines, LuHeartPulse, LuLanguages } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Empty, ErrorState, LargeBar, Skeleton, Steps, Toggle, TopBar, fmtDate, fmtRelative, initials } from '../../ui/components';
import { ConnectDoctorFlow } from '../shared/ConnectDoctorFlow';
import { ReportView } from '../shared/ReportView';
import { BriefView, MetricsCard, Reconstruction3D } from '../shared/Reconstruction';
import { MessagesPanel, clarifiedAddenda } from '../shared/MessagesPanel';
import { BodySelector } from '../../body/BodySelector';
import { UrgentHelpButton } from '../shared/Emergency';
import type { CommunicationPreferences, StatusChange } from '../../domain/types';
import { STATUS_LABELS } from '../../domain/types';
import { regionLabel } from '../../domain/bodyRegions';
import type { ConsultationView } from '../../services/backend/Backend';
import { useLogout } from '../auth/AuthScreens';

export function StatusChip({ status }: { status: keyof typeof STATUS_LABELS }) {
  return <span className={`status ${status}`}>{STATUS_LABELS[status]}</span>;
}

function ConsultRow({ v, onOpen }: { v: ConsultationView; onOpen: () => void }) {
  const c = v.consultation;
  const title = c.regionIds.length ? c.regionIds.map(regionLabel).join(', ') : 'No area chosen yet';
  return (
    <button className="list-item" onClick={onOpen}>
      <span className="li-ico"><LuPersonStanding /></span>
      <div className="grow">
        <div className="strong" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div className="small muted">{fmtRelative(c.sharedAt ?? c.updatedAt)}{c.status === 'draft' && c.approved ? ' · approved, not sent' : ''}</div>
      </div>
      <StatusChip status={c.status} />
      <LuChevronRight className="chev" aria-hidden />
    </button>
  );
}

export function PatientHome() {
  const { me, backend, nav, toast } = useApp();
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const list = useLoad(() => backend.listConsultations(), []);
  const [starting, setStarting] = useState(false);
  const meds = useMeds();
  const first = me!.profile.fullName.split(' ').find((w) => !/^dr\.?$/i.test(w)) ?? me!.profile.fullName;
  const unfinished = (list.data ?? []).find((v) => v.consultation.status === 'draft' && !v.consultation.approved);
  const recent = (list.data ?? []).filter((v) => v !== unfinished).slice(0, 3);
  const latestShared = (list.data ?? []).find((v) => v.consultation.status !== 'draft');
  const questions = useLoad(async () => {
    const shared = (list.data ?? []).filter((v) => v.consultation.status !== 'draft').slice(0, 10);
    const res = await Promise.all(shared.map(async (v) => {
      const ms = await backend.listMessages(v.consultation.id).catch(() => []);
      const open = (k: string) => ms.filter((m) => m.kind === k && !ms.some((x) => x.meta?.replyTo === m.id) && (k !== 'followup' || Date.parse(m.meta?.followup?.dueAt ?? '') <= Date.now())).length;
      return { id: v.consultation.id, open: open('clarification') + open('body_probe'), follow: open('followup'), teach: teachBackDue(ms) ? 1 : 0 };
    }));
    return res.filter((r) => r.open > 0 || r.follow > 0 || r.teach > 0);
  }, [list.data?.map((v) => v.consultation.id + v.consultation.updatedAt).join()]);
  const waiting = (questions.data ?? []).reduce((n, r) => n + r.open, 0);
  const follow = (questions.data ?? []).reduce((n, r) => n + r.follow, 0);
  const waitingId = questions.data?.[0]?.id;
  const followId = questions.data?.find((r) => r.follow > 0)?.id;
  const teachId = questions.data?.find((r) => r.teach > 0)?.id;

  const start = async () => {
    setStarting(true);
    try { const c = await backend.createConsultation(); nav.push({ name: 'p.consult', id: c.id }); }
    catch (e) { toast((e as Error).message); }
    finally { setStarting(false); }
  };

  return (
    <>
      <LargeBar eyebrow="Hello," title={first} right={<UrgentHelpButton />} />
      <div className="screen screen-in"><div className="pad">
        <section className="hero-card">
          <div className="pulse-ring" aria-hidden />
          <h2>How are you feeling today?</h2>
          <p className="muted small">Point to the area, choose what you feel, check the summary. About two minutes.</p>
          <Button big block onClick={start} busy={starting} data-testid="start-consultation"><LuPlus aria-hidden /> Start New Consultation</Button>
        </section>

        {meds.data && <NextDoseCard data={meds.data} reload={meds.reload} compact />}
        <DiaryHomeCard />
        <button className="card button talk-card" onClick={() => nav.push({ name: 'talk' })} data-testid="home-talk" aria-label="Talk to AccessCare: describe how you feel by speaking or typing">
          <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuAudioLines /></span>
            <div className="grow"><b>Talk to AccessCare</b><div className="small muted">Tell me how you feel by speaking or typing. I’ll prepare a clear message for your doctor.</div></div><LuChevronRight aria-hidden /></div>
        </button>
        <button className="card button signal-card" onClick={() => nav.reset({ name: 'ss.home' })} data-testid="home-signal">
          <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuRadioTower /></span>
            <div className="grow"><b>Silent Signal AI</b><div className="small muted">Communicate with pictures, Yes/No or one switch — no typing or speaking.</div></div><LuChevronRight aria-hidden /></div>
        </button>
        {follow > 0 && (
          <button className="card button" onClick={() => followId && nav.push({ name: 'p.detail', id: followId })} data-testid="home-followup">
            <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuHeartPulse /></span>
              <div className="grow"><b>Your doctor asks how you are doing</b><div className="small muted">A few taps — you can have it read aloud</div></div><LuChevronRight aria-hidden /></div>
          </button>
        )}
        {teachId && (
          <button className="card button" onClick={() => nav.push({ name: 'p.detail', id: teachId })} data-testid="home-teachback">
            <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuGraduationCap /></span>
              <div className="grow"><b>Check that you understood your treatment</b><div className="small muted">Explain it in your own words — one minute</div></div><LuChevronRight aria-hidden /></div>
          </button>
        )}
        {waiting > 0 && (
          <button className="card button" onClick={() => waitingId && nav.push({ name: 'p.detail', id: waitingId })} data-testid="home-questions">
            <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--info-soft)', color: 'var(--info)' }}><LuMessageCircle /></span>
              <div className="grow"><b>Your doctor asked {waiting === 1 ? 'a question' : `${waiting} questions`}</b><div className="small muted">Tap to answer</div></div><LuChevronRight aria-hidden /></div>
          </button>
        )}
        {unfinished && (
          <button className="card button" onClick={() => nav.push({ name: 'p.consult', id: unfinished.consultation.id })}>
            <div className="row"><span className="li-ico" style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--warn-soft)', color: 'var(--warn)' }}><LuClock /></span>
              <div className="grow"><b>Continue where you left off</b><div className="small muted">Started {fmtRelative(unfinished.consultation.createdAt)}{unfinished.consultation.regionIds.length ? ` · ${unfinished.consultation.regionIds.map(regionLabel).join(', ')}` : ''}</div></div>
              <LuChevronRight aria-hidden /></div>
          </button>
        )}

        <h3 className="section">My doctor</h3>
        {doctor.loading && !doctor.data ? <Skeleton rows={1} height={76} /> : doctor.error ? <ErrorState message={doctor.error} onRetry={doctor.reload} /> : doctor.data ? (
          <button className="card button" onClick={() => nav.push({ name: 'p.doctor' })} data-testid="home-doctor">
            <div className="row">
              <div className="avatar navy">{initials(doctor.data.fullName)}</div>
              <div className="grow"><b>{doctor.data.fullName}</b><div className="small muted">{doctor.data.specialty ?? 'Doctor'} · Connected</div></div>
              <LuChevronRight aria-hidden />
            </div>
            {latestShared && <div className="row small" style={{ gap: 8 }}><span className="muted">Latest:</span><StatusChip status={latestShared.consultation.status} /><span className="muted">{fmtRelative(latestShared.consultation.updatedAt)}</span></div>}
          </button>
        ) : (
          <div className="card">
            <div className="row"><div className="avatar"><LuStethoscope /></div><div className="grow"><b>No doctor connected</b><div className="small muted">Ask your doctor for their Doctor ID.</div></div></div>
            <Button variant="navy" block onClick={() => nav.push({ name: 'p.connect' })}><LuLink aria-hidden /> Connect with a Doctor</Button>
          </div>
        )}

        <div className="row between"><h3 className="section" style={{ margin: '4px 2px -2px' }}>Recent consultations</h3>
          {(list.data?.length ?? 0) > 3 && <button className="link-btn" onClick={() => nav.reset({ name: 'p.history' })}>See all</button>}</div>
        {list.loading && !list.data ? <Skeleton rows={2} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : recent.length ? (
          <div className="list">{recent.map((v) => <ConsultRow key={v.consultation.id} v={v} onOpen={() => nav.push({ name: 'p.detail', id: v.consultation.id })} />)}</div>
        ) : <Empty icon={<LuClipboardList />} title="No consultations yet">Your consultations and their status will appear here.</Empty>}

        <div className="grid2">
          <button className="card button" onClick={() => nav.push({ name: 'p.prefs' })} style={{ gap: 8 }}><LuAccessibility style={{ fontSize: '1.4em', color: 'var(--teal-ink)' }} aria-hidden /><b className="small">Communication preferences</b></button>
          <button className="card button" onClick={() => nav.push({ name: 'settings' })} style={{ gap: 8 }}><LuSettings style={{ fontSize: '1.4em', color: 'var(--navy-700)' }} aria-hidden /><b className="small">Settings</b></button>
        </div>
      </div></div>
    </>
  );
}

export function PatientHistory() {
  const { backend, nav } = useApp();
  const list = useLoad(() => backend.listConsultations(), []);
  const [filter, setFilter] = useState('all');
  const items = (list.data ?? []).filter((v) => filter === 'all' || (filter === 'open' ? ['draft', 'new', 'in_review'].includes(v.consultation.status) : v.consultation.status === 'completed'));
  return (
    <>
      <LargeBar title="History" />
      <div className="screen screen-in"><div className="pad">
        <div className="seg" role="group" aria-label="Filter">
          {[['all', 'All'], ['open', 'Open'], ['done', 'Completed']].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        {list.loading && !list.data ? <Skeleton rows={4} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : items.length === 0
          ? <Empty icon={<LuClipboardList />} title="Nothing here yet">Start a consultation from Home.</Empty>
          : <div className="list">{items.map((v) => <ConsultRow key={v.consultation.id} v={v}
              onOpen={() => nav.push(v.consultation.status === 'draft' && !v.consultation.approved ? { name: 'p.consult', id: v.consultation.id } : { name: 'p.detail', id: v.consultation.id })} />)}</div>}
      </div></div>
    </>
  );
}

export function StatusTimeline({ items }: { items: StatusChange[] }) {
  const label = (h: StatusChange) => h.to === 'draft' ? 'Started' : h.to === 'new' ? 'Shared with doctor' : `Marked ${STATUS_LABELS[h.to]}`;
  return (
    <div className="timeline">
      {items.map((h) => <div className="t" key={h.id}><div className="d" /><div><b>{label(h)}</b><div className="muted tiny">{fmtDate(h.at)}</div></div></div>)}
    </div>
  );
}

export function PatientDetail({ id }: { id: string }) {
  const { backend, nav, toast, refresh } = useApp();
  const v = useLoad(() => backend.getConsultation(id), [id]);
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const hist = useLoad(() => backend.statusHistory(id), [id]);
  const msgs = useLoad(() => (v.data && v.data.consultation.status !== 'draft' ? backend.listMessages(id) : Promise.resolve([])), [id, v.data?.consultation.status]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'summary' | 'messages'>('summary');
  if (!v.data) return <><TopBar title="Consultation" /><div className="screen"><div className="pad">{v.error ? <ErrorState message={v.error} onRetry={v.reload} /> : <Skeleton rows={4} />}</div></div></>;
  const c = v.data.consultation;
  const sendSaved = async () => {
    if (!c.approved) return;
    setBusy(true);
    try { await backend.approveAndShare(c.id, { text: c.approved.text, report: c.approved.report, editedByPatient: c.approved.editedByPatient }); refresh(); toast('Shared with your doctor'); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const canMessage = c.status !== 'draft';
  const list = msgs.data ?? [];
  const open = list.filter((m) => (m.kind === 'clarification' || m.kind === 'body_probe') && !list.some((x) => x.meta?.replyTo === m.id)).length + (teachBackDue(list) ? 1 : 0);
  const rec = c.approved?.report.reconstruction;
  return (
    <>
      <TopBar title={c.kind === 'signal' ? 'Silent Signal message' : 'Consultation'} right={<UrgentHelpButton />} />
      <div className="screen screen-in"><div className="pad">
        <div className="card">
          <div className="row between"><div className="row" style={{ gap: 6 }}><StatusChip status={c.status} />{c.kind === 'signal' && <span className="chip teal">Silent Signal</span>}</div><span className="small muted">{fmtDate(c.sharedAt ?? c.createdAt)}</span></div>
          <b style={{ fontSize: '1.1em' }}>{c.regionIds.map(regionLabel).join(', ') || 'No area chosen'}</b>
          {c.status !== 'draft' && v.data.doctor && <p className="small muted">Shared with <b>{v.data.doctor.fullName}</b>.{v.data.viewedAt ? ` Seen by your doctor ${fmtRelative(v.data.viewedAt)}.` : ' Not opened by your doctor yet.'}</p>}
          {hist.data && hist.data.length > 0 && <StatusTimeline items={hist.data} />}
          {c.status !== 'draft' && c.status !== 'cancelled' && <Button variant="secondary" onClick={() => nav.push({ name: 'interp', cid: c.id })} data-testid="detail-interp"><LuLanguages aria-hidden /> Visit interpreter</Button>}
        </div>
        {open > 0 && tab !== 'messages' && (
          <button className="card button" onClick={() => setTab('messages')} data-testid="open-questions">
            <div className="row"><LuMessageCircle style={{ color: 'var(--teal-ink)', fontSize: '1.3em' }} aria-hidden /><div className="grow"><b>{open === 1 ? 'Your doctor is waiting for one answer' : `Your doctor is waiting for ${open} answers`}</b><div className="small muted">Answer with the method that suits you.</div></div><LuChevronRight aria-hidden /></div>
          </button>
        )}
        {c.status === 'draft' && c.approved && (doctor.data
          ? <div className="card"><b>Approved but not sent</b><p className="small muted">You can now send this report to {doctor.data.fullName}.</p>
              <Button block onClick={sendSaved} busy={busy}><LuSend aria-hidden /> Send to {doctor.data.fullName}</Button></div>
          : <Banner kind="warn">Approved but not sent — connect with a doctor to send it.</Banner>)}
        {c.status === 'draft' && !c.approved && <Button block onClick={() => nav.replace({ name: 'p.consult', id: c.id })}>Continue this consultation</Button>}
        {canMessage && (
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>Report</button>
            <button role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>Messages{open ? ` · ${open}` : ''}</button>
          </div>
        )}
        {(tab === 'summary' || !canMessage) && <>
          {rec ? <Reconstruction3D rec={rec} /> : <><h3 className="section">Body area</h3><BodySelector selected={c.regionIds} readOnly /></>}
          {c.approved && <>
            {c.approved.report.brief ? <><h3 className="section">Report you approved{c.approved.editedByPatient ? ' · edited by you' : ''}</h3><BriefView brief={c.approved.report.brief} addenda={clarifiedAddenda(list)} /></>
              : <><h3 className="section">Summary you approved</h3><ReportView report={c.approved.report} /></>}
            <h3 className="section">Exact text shared</h3>
            <div className="pre">{c.approved.text}</div>
            {c.approved.report.metrics && <MetricsCard m={c.approved.report.metrics} />}
          </>}
        </>}
        {tab === 'messages' && canMessage && (
          <MessagesPanel consultationId={c.id} canSend={!!doctor.data && doctor.data.doctorId === v.data.doctor?.doctorId}
            disabledReason="You are no longer connected to this doctor, so new messages can’t be sent." />
        )}
      </div></div>
    </>
  );
}

export function MyDoctorScreen() {
  const { backend, toast, refresh } = useApp();
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    setBusy(true);
    try { await backend.disconnectDoctor(); refresh(); toast('Doctor disconnected'); setConfirm(false); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <LargeBar title="My doctor" />
      <div className="screen screen-in"><div className="pad">
        {doctor.loading && !doctor.data ? <Skeleton rows={2} height={90} /> : doctor.error ? <ErrorState message={doctor.error} onRetry={doctor.reload} /> : doctor.data ? (<>
          <div className="card raised" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 24 }}>
            <div className="avatar navy lg">{initials(doctor.data.fullName)}</div>
            <h2 className="title">{doctor.data.fullName}</h2>
            <p className="muted">{[doctor.data.specialty, doctor.data.clinic].filter(Boolean).join(' · ') || 'Doctor'}</p>
            <span className="chip"><span className="mono">{doctor.data.doctorId}</span></span>
          </div>
          <div className="card tinted">
            <div className="row" style={{ alignItems: 'flex-start' }}><LuShieldCheck style={{ color: 'var(--teal-ink)', fontSize: '1.3em', flex: 'none' }} aria-hidden />
              <p className="small">{doctor.data.fullName} can read only the consultations you approve and share, plus your communication preferences if you allow it.{(backend.mode === 'claude-cloud' || backend.mode === 'server') ? ' Shared records are encrypted so only the two of you can read them.' : ''}</p></div>
          </div>
          <Button variant="danger-outline" block onClick={() => setConfirm(true)}><LuUnlink aria-hidden /> Disconnect Doctor</Button>
        </>) : (
          <div className="card"><h2 className="title">Connect with a Doctor</h2><ConnectDoctorFlow onDone={() => doctor.reload()} skipLabel="Not now" /></div>
        )}
      </div></div>
      {confirm && <ConfirmSheet title="Disconnect from your doctor?" danger confirmLabel="Disconnect" icon={<LuUnlink />} busy={busy}
        body="They will lose access to your consultations, including ones you already shared. You keep your own copy, and you can reconnect later with their Doctor ID."
        onConfirm={disconnect} onCancel={() => setConfirm(false)} />}
    </>
  );
}

export function ConnectScreen({ afterSignup, initialId }: { afterSignup?: boolean; initialId?: string }) {
  const { nav } = useApp();
  const done = () => (afterSignup ? nav.reset({ name: 'p.onboard' }) : nav.back());
  return (
    <>
      <TopBar title={afterSignup ? 'Connect your doctor' : 'Connect with a Doctor'} onBack={afterSignup ? done : undefined} />
      <div className="screen screen-in"><div className="pad">
        {afterSignup && <><Steps total={3} current={1} label="Your doctor" /><Banner kind="ok">Your patient account is ready.</Banner></>}
        <ConnectDoctorFlow initialId={initialId} autoLookup={!!initialId} onDone={done} />
      </div></div>
    </>
  );
}

type OnbQ = { id: string; q: string; why?: string; options: { label: string; sub?: string; icon: string; apply: Partial<CommunicationPreferences> }[]; when?: (ctx: { ai: boolean; tts: boolean }) => boolean };
const ONBOARDING: OnbQ[] = [
  { id: 'answer', q: 'How would you like to answer questions?', why: 'We’ll use this for every question. You can change it later.', options: [
    { label: 'Tap from a few choices', icon: '👆', apply: { multipleChoice: true, yesNoQuestions: true, visualOptions: false } },
    { label: 'Choices with pictures', icon: '🖼️', apply: { multipleChoice: true, yesNoQuestions: true, visualOptions: true } },
    { label: 'Yes or No only', icon: '👍', apply: { multipleChoice: false, yesNoQuestions: true } },
  ] },
  { id: 'text', q: 'Which text size is easier to read?', options: [
    { label: 'Standard text', icon: 'Aa', apply: { largerText: false } }, { label: 'Larger text', icon: '🔠', apply: { largerText: true } },
  ] },
  { id: 'buttons', q: 'How big should buttons be?', options: [
    { label: 'Standard buttons', icon: '▫️', apply: { largeButtons: false } }, { label: 'Large buttons', icon: '⬜', apply: { largeButtons: true } },
  ] },
  { id: 'pace', q: 'How fast should the app move?', why: 'Relaxed gives you more time and slower scanning.', options: [
    { label: 'Standard pace', icon: '▶️', apply: { relaxedPace: false, reducedMotion: false } },
    { label: 'Relaxed pace', icon: '🐢', apply: { relaxedPace: true } },
    { label: 'Relaxed, no animation', icon: '⏸️', apply: { relaxedPace: true, reducedMotion: true } },
  ] },
  { id: 'words', q: 'How should questions be written?', options: [
    { label: 'Normal sentences', icon: '📝', apply: { simpleText: false, shortSentences: false } },
    { label: 'Short and simple', icon: '✂️', apply: { simpleText: true, shortSentences: true } },
  ] },
  { id: 'tts', q: 'Should questions be read aloud?', when: (c) => c.tts, options: [
    { label: 'Yes, read them aloud', icon: '🔊', apply: { textToSpeech: true } }, { label: 'No, I’ll read them', icon: '🔇', apply: { textToSpeech: false } },
  ] },
  { id: 'ai', q: 'Use AI to help understand and word your reports?', when: (c) => c.ai,
    why: 'If you say yes, what you choose and type about your symptoms (never your name or account) is sent to Claude, an AI made by Anthropic, using your Claude account. It suggests details from your words and writes clearer sentences. After you send a report, your doctor may also ask the AI for clinical notes about it (for the doctor only). You check and approve everything you send. Safety checks never depend on AI. You can turn this off any time.',
    options: [
      { label: 'Yes, use AI assistance', icon: '✨', apply: { aiAssist: true } },
      { label: 'No, keep it rule-based', icon: '📏', apply: { aiAssist: false } },
    ] },
  { id: 'share', q: 'Share these communication preferences with your doctor?', why: 'It helps your doctor ask questions in a way that works for you. They are not medical information.', options: [
    { label: 'Yes, share them', icon: '🤝', apply: { shareWithDoctor: true } }, { label: 'No, keep them private', icon: '🔒', apply: { shareWithDoctor: false } },
  ] },
];

export function OnboardingScreen() {
  const { me, setMe, backend, nav, toast, ai } = useApp();
  const ctx = { ai: ai.supported, tts: typeof window !== 'undefined' && 'speechSynthesis' in window };
  const qs = ONBOARDING.filter((q) => !q.when || q.when(ctx));
  const [i, setI] = useState(0);
  const [prefs, setPrefs] = useState<CommunicationPreferences>(me!.preferences);
  const [saving, setSaving] = useState(false);
  const save = async (next: CommunicationPreferences) => {
    setSaving(true);
    try { const saved = await backend.savePreferences(next); setMe({ ...me!, preferences: saved }); setPrefs(saved); return true; }
    catch (e) { toast((e as Error).message); return false; }
    finally { setSaving(false); }
  };
  const q = qs[i];
  return (
    <>
      <TopBar title="Set up how we talk" onBack={i > 0 ? () => setI(i - 1) : undefined} />
      <div className="screen screen-in"><div className="pad">
        <Steps total={qs.length + 1} current={Math.min(i, qs.length)} label={q ? `Question ${i + 1} of ${qs.length}` : 'Done'} />
        {q ? (<>
          <div><h2 className="title" data-testid="onboard-question">{q.q}</h2>{q.why && <p className="muted small" style={{ marginTop: 6 }}>{q.why}</p>}</div>
          <div className="stack">
            {q.options.map((o) => (
              <button key={o.label} className="role-card" disabled={saving} data-testid={`onb-${q.id}-${q.options.indexOf(o)}`}
                onClick={async () => { if (await save({ ...prefs, ...o.apply })) setI(i + 1); }}>
                <span className="ri" aria-hidden>{o.icon}</span><span className="stack" style={{ gap: 2 }}><b>{o.label}</b>{o.sub && <span className="small muted">{o.sub}</span>}</span>
              </button>
            ))}
          </div>
          <p className="tiny muted">Your choices change how questions are shown. They say nothing about your health.</p>
        </>) : (<>
          <div className="card" style={{ alignItems: 'center', textAlign: 'center' }}>
            <LuCircleCheck style={{ fontSize: 48, color: 'var(--ok)' }} aria-hidden />
            <h2 className="title">You’re set up</h2>
            <p className="muted small">If speaking, typing or tapping small buttons is hard, Silent Signal AI lets you build messages with pictures, Yes/No, or a single switch.</p>
          </div>
          <Button big block onClick={async () => { await save({ ...prefs, onboarded: true }); nav.reset({ name: 'p.home' }); nav.push({ name: 'ss.calibrate' }); }} data-testid="onboard-signal">Set up Silent Signal now</Button>
          <Button variant="secondary" big block onClick={async () => { await save({ ...prefs, onboarded: true }); nav.reset({ name: 'p.home' }); }} data-testid="onboard-finish">Go to my home screen</Button>
        </>)}
      </div></div>
    </>
  );
}

const PREF_GROUPS: [string, [keyof CommunicationPreferences, string, string][]][] = [
  ['Reading', [
    ['simpleText', 'Simple text', 'Use plain, everyday words.'],
    ['shortSentences', 'Short sentences', 'Keep questions as short as possible.'],
    ['largerText', 'Larger text', 'Increase text size across the app.'],
  ]],
  ['Answering', [
    ['yesNoQuestions', 'Yes/No questions', 'Ask questions I can answer with Yes or No.'],
    ['multipleChoice', 'Multiple-choice questions', 'Offer a few choices to tap. Turn off to get Yes/No only.'],
    ['visualOptions', 'Visual options', 'Show pictures next to choices.'],
    ['largeButtons', 'Large buttons', 'Bigger touch areas for every button.'],
  ]],
  ['Voice, pace & motion', [
    ['textToSpeech', 'Text-to-speech', 'Read questions aloud automatically, with a replay button.'],
    ['speechInput', 'Speech input', 'Show a microphone button on text fields, where the device supports it.'],
    ['relaxedPace', 'Relaxed pace', 'More time after each answer and slower scanning in Silent Signal.'],
    ['reducedMotion', 'Reduced animation', 'Turn off movement and transitions.'],
  ]],
  ['AI assistance', [
    ['aiAssist', 'Use AI to help understand and word my reports', 'Sends your symptom choices and words (never your name) to Claude, an AI by Anthropic. Your doctor may also use it on reports you send, to prepare clinical notes for themselves. You approve everything you send. Safety checks never depend on AI.'],
  ]],
  ['Sharing', [
    ['shareWithDoctor', 'Share these preferences with my doctor', 'Helps your doctor ask questions in a way that works for you.'],
  ]],
];

export function PreferencesScreen({ onboarding }: { onboarding?: boolean }) {
  const { me, setMe, backend, nav, toast, ai } = useApp();
  const [p, setP] = useState<CommunicationPreferences>(me!.preferences);
  const [saving, setSaving] = useState(false);
  const update = async (k: keyof CommunicationPreferences, v: boolean) => {
    const next = { ...p, [k]: v };
    if (k === 'multipleChoice' && !v) next.yesNoQuestions = true;
    setP(next);
    setSaving(true);
    try { const saved = await backend.savePreferences(next); setMe({ ...me!, preferences: saved }); }
    catch (e) { toast((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <>
      <TopBar title={onboarding ? 'Accessibility setup' : 'Communication preferences'} onBack={onboarding ? undefined : nav.back} />
      <div className="screen screen-in"><div className="pad">
        {onboarding && <Steps total={3} current={2} label="How we talk with you" />}
        <p className="muted">Choose how AccessCare AI talks with you. Change these any time. They only change how questions are shown; they say nothing about your health.</p>
        {PREF_GROUPS.map(([g, items]) => (
          <div key={g} className="stack">
            <h3 className="section">{g}</h3>
            <div className="list">{items.map(([k, l, d]) => <Toggle key={k} id={`pref-${k}`} label={l} desc={d} checked={p[k]} onChange={(v) => update(k, v)} />)}</div>
          </div>
        ))}
        <p className="small muted" aria-live="polite">{saving ? 'Saving…' : 'Saved to your account.'}</p>
        <p className="tiny muted">AI status: {ai.state(p.aiAssist) === 'available' ? 'on' : ai.state(p.aiAssist) === 'off' ? 'off' : ai.state(p.aiAssist) === 'declined' ? 'you declined Claude access in this view' : 'not available in this view — rule-based wording is used'}.</p>
        <Button variant="secondary" onClick={() => nav.push({ name: 'ss.home' })}>Silent Signal input method & calibration</Button>
      </div></div>
      {onboarding && <div className="footer-bar"><Button big onClick={() => nav.reset({ name: 'p.home' })}>Finish setup</Button></div>}
    </>
  );
}

/** Profile with a visible Log out, shared by both roles. */
export function LogoutRow() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const logout = useLogout();
  return (
    <>
      <Button variant="danger-outline" block big onClick={() => setOpen(true)} data-testid="logout"><LuLogOut aria-hidden /> Log out</Button>
      {open && <ConfirmSheet title="Log out of AccessCare AI?" icon={<LuLogOut />} confirmLabel="Log out" danger busy={busy}
        body="Your data stays saved. You’ll need your password to open your account again on this device."
        onConfirm={async () => { setBusy(true); await logout(); }} onCancel={() => setOpen(false)} />}
    </>
  );
}

export function PatientProfile() {
  const { me, nav, backend } = useApp();
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const list = useLoad(() => backend.listConsultations(), []);
  return (
    <>
      <LargeBar title="Profile" />
      <div className="screen screen-in"><div className="pad">
        <div className="card">
          <div className="row"><div className="avatar lg">{initials(me!.profile.fullName)}</div>
            <div className="grow"><h2 className="title" style={{ fontSize: '1.25em' }}>{me!.profile.fullName}</h2>
              <p className="small muted">Patient{me!.profile.email ? ` · ${me!.profile.email}` : ''}</p>
              {me!.profile.patientCode && <p className="small">Patient ID: <b className="mono" data-testid="patient-code">{me!.profile.patientCode}</b> <span className="tiny muted">(an identifier, not a password)</span></p>}</div></div>
        </div>
        <div className="list">
          <button className="list-item" onClick={() => nav.push({ name: 'va' })} data-testid="open-voice"><span className="li-ico"><LuAudioLines /></span><div className="grow"><b>Blind Mode</b><div className="small muted">Use the whole app by voice, with large buttons and swipe navigation.</div></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.reset({ name: 'p.doctor' })}><span className="li-ico"><LuStethoscope /></span><div className="grow"><b>Connected doctor</b><div className="small muted">{doctor.data?.fullName ?? (doctor.loading ? '…' : 'None')}</div></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.push({ name: 'p.prefs' })}><span className="li-ico"><LuAccessibility /></span><div className="grow"><b>Communication preferences</b></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.reset({ name: 'p.history' })}><span className="li-ico"><LuClipboardList /></span><div className="grow"><b>Consultation history</b><div className="small muted">{list.data?.length ?? '…'} total</div></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.push({ name: 'settings' })} data-testid="open-settings"><span className="li-ico"><LuSettings /></span><div className="grow"><b>Account settings</b></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.push({ name: 'about' })}><span className="li-ico"><LuInfo /></span><div className="grow"><b>About this prototype</b></div><LuChevronRight className="chev" /></button>
        </div>
        <LogoutRow />
      </div></div>
    </>
  );
}
