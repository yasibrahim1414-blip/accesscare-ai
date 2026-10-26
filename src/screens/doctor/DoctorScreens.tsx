import React, { useState } from 'react';
import {
  LuCopy, LuSave, LuChevronRight, LuSearch, LuUsers, LuInbox, LuSettings, LuUnlink, LuIdCard, LuInfo, LuBell,
  LuClipboardCheck, LuHourglass, LuCircleCheck, LuFileText, LuPersonStanding, LuNotebookPen, LuMessageCircle, LuSiren, LuRadioTower,
} from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Empty, ErrorState, Field, LargeBar, Skeleton, TopBar, copyText, fmtDate, fmtRelative, initials } from '../../ui/components';
import { BodySelector } from '../../body/BodySelector';
import { ReportView, ClarificationList } from '../shared/ReportView';
import { BriefView, ContradictionList, ItemHistory, MetricsCard, Reconstruction3D } from '../shared/Reconstruction';
import { MessagesPanel, clarifiedAddenda } from '../shared/MessagesPanel';
import { ClinicalPanel, urgencyOf } from './ClinicalPanel';
import { BriefPanel, DoctorAlertsCard } from './CareDoctor';
import { LuLanguages } from 'react-icons/lu';
import { analyzeRules } from '../../services/clinical/engine';
import { EMPTY_DOCUMENTED, followUpFlags } from '../../domain/clinical';
import { StatusChip, StatusTimeline, LogoutRow } from '../patient/PatientScreens';
import type { ConsultationStatus, CommunicationPreferences } from '../../domain/types';
import { STATUS_LABELS } from '../../domain/types';
import { regionLabel } from '../../domain/bodyRegions';
import type { ConsultationView } from '../../services/backend/Backend';

export function DoctorIdCard({ compact }: { compact?: boolean }) {
  const { me, toast } = useApp();
  const [saved, setSaved] = useState(false);
  const id = me!.doctor!.doctorId;
  const copy = async () => toast((await copyText(id)) ? 'Doctor ID copied' : 'Copy is blocked here — press and hold the ID to select it');
  return (
    <div className="idcard" data-testid="doctor-id-card">
      <span className="lbl">Your Doctor ID</span>
      <span className="code" data-testid="doctor-id">{id}</span>
      {!compact && <span className="small" style={{ color: '#c9dcee', position: 'relative' }}>Share this ID with your patients. They enter it to connect with you. It’s an identifier, not a password, and it never changes.</span>}
      <div className="grid2">
        <Button variant="secondary" onClick={copy}><LuCopy aria-hidden /> Copy ID</Button>
        <Button variant="secondary" onClick={() => setSaved(true)}><LuSave aria-hidden /> Save ID</Button>
      </div>
      {saved && <SaveIdSheet id={id} name={me!.profile.fullName} onClose={() => setSaved(false)} />}
    </div>
  );
}

function SaveIdSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { toast } = useApp();
  const text = `${name} — AccessCare AI Doctor ID: ${id}\nPatients: open AccessCare AI, choose “Connect with a Doctor” and enter this ID.`;
  return (
    <ConfirmSheet title="Save your Doctor ID" icon={<LuIdCard />} confirmLabel="Copy this text" onCancel={onClose}
      onConfirm={async () => { toast((await copyText(text)) ? 'Copied — paste it into your notes' : 'Select the text above to copy it'); onClose(); }}
      body="Copy this card into your notes or take a screenshot. Your ID is also always shown on your Dashboard and Profile.">
      <div className="pre" style={{ userSelect: 'all' }}>{text}</div>
    </ConfirmSheet>
  );
}

export function DoctorIdScreen({ justCreated }: { justCreated?: boolean }) {
  const { nav, me, backend } = useApp();
  return (
    <>
      <TopBar title="My Doctor ID" onBack={justCreated ? undefined : nav.back} />
      <div className="screen screen-in"><div className="pad">
        {justCreated && <Banner kind="ok"><b>Welcome, {me!.profile.fullName}.</b> Your doctor account is ready and your Doctor ID has been created.</Banner>}
        <DoctorIdCard />
        <div className="card">
          <b>How patients connect</b>
          <ol className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>You give the patient this ID.</li>
            <li>They enter it when signing up, or later under “My doctor”.</li>
            <li>They see your name and confirm it’s you.</li>
            <li>They appear in your patient list{backend.shared ? ' on every device you log in from' : ''}.</li>
          </ol>
        </div>
        {!backend.shared && <Banner kind="warn">Offline demo: patients must use this same browser to connect, because this copy isn’t connected to the shared database.</Banner>}
      </div></div>
      {justCreated && <div className="footer-bar"><Button big onClick={() => nav.reset({ name: 'd.overview' })}>Go to my dashboard</Button></div>}
    </>
  );
}

function ConsultRowD({ v, onOpen }: { v: ConsultationView; onOpen: () => void }) {
  const c = v.consultation;
  const urg = React.useMemo(() => (c.approved ? urgencyOf(v) : null), [c.id, c.updatedAt]); // eslint-disable-line
  return (
    <button className="list-item" onClick={onOpen}>
      <div className="avatar">{initials(v.patient.fullName)}</div>
      <div className="grow">
        <div className="row" style={{ gap: 6 }}><b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.patient.fullName}</b>
          {c.urgentGuidanceShown && <LuSiren aria-label="Urgent guidance was shown" style={{ color: 'var(--danger)', flex: 'none' }} />}
          {c.kind === 'signal' && <LuRadioTower aria-label="Silent Signal" style={{ color: 'var(--teal-ink)', flex: 'none' }} />}
          {urg && <span className={`status ${urg === 'emergency' ? 'urgent-chip' : 'warn-chip'}`} data-testid="row-urgency">{urg === 'emergency' ? 'Emergency sign' : 'Urgent'}</span>}</div>
        <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.regionIds.map(regionLabel).join(', ')} · {fmtRelative(c.sharedAt)}</div>
      </div>
      <StatusChip status={c.status} />
      <LuChevronRight className="chev" aria-hidden />
    </button>
  );
}

export function DoctorOverview() {
  const { me, backend, nav } = useApp();
  const stats = useLoad(() => backend.doctorStats(), []);
  const list = useLoad(() => backend.listConsultations(), []);
  const s = stats.data;
  const activity = useLoad(async () => {
    const shared = (list.data ?? []).slice(0, 12);
    const rows = await Promise.all(shared.map(async (v) => {
      const ms = await backend.listMessages(v.consultation.id).catch(() => []);
      const out: { id: string; cid: string; patient: string; text: string; open: boolean; at: string }[] = [];
      for (const m of ms) {
        if (m.kind === 'clarification' && !ms.some((x) => x.meta?.replyTo === m.id)) out.push({ id: m.id, cid: v.consultation.id, patient: v.patient.fullName, text: `You asked: ${m.body}`, open: true, at: m.createdAt });
        if (m.senderRole === 'patient') out.push({ id: m.id, cid: v.consultation.id, patient: v.patient.fullName, text: m.kind === 'followup_answer' && m.meta?.followupAnswer ? `Follow-up: ${followUpFlags(m.meta.followupAnswer).filter((f) => f.level !== 'info').map((f) => (f.level === 'emergency' ? '⚠ ' : '') + f.text).join(' ') || 'answered, no warning'}` : m.kind === 'clarification_answer' ? `Answered${m.meta?.itemLabel ? ` (${m.meta.itemLabel})` : ''}: ${m.meta?.raw ?? m.body}` : m.body, open: false, at: m.createdAt });
      }
      return out;
    }));
    return rows.flat().sort((a, b) => b.at.localeCompare(a.at));
  }, [list.data?.map((v) => v.consultation.id + v.consultation.updatedAt).join()]);
  const tiles: [string, number | undefined, React.ReactNode, string, () => void][] = [
    ['Connected patients', s?.connectedPatients, <LuUsers />, 'var(--navy-100)', () => nav.reset({ name: 'd.patients' })],
    ['New requests', s?.newCount, <LuBell />, 'var(--info-soft)', () => nav.reset({ name: 'd.consults', filter: 'new' })],
    ['Pending review', s?.inReviewCount, <LuHourglass />, 'var(--warn-soft)', () => nav.reset({ name: 'd.consults', filter: 'in_review' })],
    ['Completed', s?.completedCount, <LuCircleCheck />, 'var(--ok-soft)', () => nav.reset({ name: 'd.consults', filter: 'completed' })],
  ];
  return (
    <>
      <LargeBar eyebrow="Doctor dashboard" title={me!.profile.fullName} />
      <div className="screen screen-in"><div className="pad">
        <DoctorIdCard compact />
        <DoctorAlertsCard />
        {stats.error && <ErrorState message={stats.error} onRetry={stats.reload} />}
        <div className="stat-grid" data-testid="doctor-stats">
          {tiles.map(([label, n, icon, bg, go]) => (
            <button key={label} className="stat" onClick={go}>
              <span className="si" style={{ background: bg, color: 'var(--navy-800)' }} aria-hidden>{icon}</span>
              <b>{n ?? '–'}</b><span>{label}</span>
            </button>
          ))}
        </div>
        <h3 className="section">Clarifications & patient replies</h3>
        {activity.loading && !activity.data ? <Skeleton rows={1} height={56} /> : (activity.data ?? []).length === 0
          ? <p className="small muted">No open clarification requests or new patient replies.</p>
          : <div className="list" data-testid="doctor-activity">{(activity.data ?? []).slice(0, 6).map((x) => (
              <button key={x.id} className="list-item" onClick={() => nav.push({ name: 'd.workspace', id: x.cid })}>
                <span className="li-ico"><LuMessageCircle /></span>
                <div className="grow"><b>{x.patient}</b><div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.text}</div></div>
                <span className={`status ${x.open ? 'in_review' : 'new'}`}>{x.open ? 'Awaiting reply' : 'Replied'}</span>
              </button>))}</div>}
        <h3 className="section">Recent activity</h3>
        {list.loading && !list.data ? <Skeleton rows={3} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data && list.data.length > 0
          ? <div className="list">{list.data.slice(0, 5).map((v) => <ConsultRowD key={v.consultation.id} v={v} onOpen={() => nav.push({ name: 'd.workspace', id: v.consultation.id })} />)}</div>
          : <Empty icon={<LuInbox />} title="No consultations yet">When a connected patient approves and shares a summary, it appears here{backend.shared ? ' automatically' : ''}.</Empty>}
      </div></div>
    </>
  );
}

export function DoctorConsults({ filter: initialFilter }: { filter?: string }) {
  const { backend, nav } = useApp();
  const list = useLoad(() => backend.listConsultations(), []);
  const [filter, setFilter] = useState<string>(initialFilter ?? 'all');
  const [byUrgency, setByUrgency] = useState(true);
  const rank = (v: ConsultationView) => { const u = v.consultation.approved ? urgencyOf(v) : null; return u === 'emergency' ? 0 : u === 'urgent' ? 1 : 2; };
  const items = (list.data ?? []).filter((v) => filter === 'all' || v.consultation.status === filter)
    .sort((a, b) => (byUrgency ? rank(a) - rank(b) : 0) || (b.consultation.sharedAt ?? '').localeCompare(a.consultation.sharedAt ?? ''));
  const count = (k: string) => (list.data ?? []).filter((v) => v.consultation.status === k).length;
  return (
    <>
      <LargeBar title="Consultations" />
      <div className="screen screen-in"><div className="pad">
        <div className="seg" role="group" aria-label="Filter by status">
          {([['all', 'All'], ['new', `New${count('new') ? ` ${count('new')}` : ''}`], ['in_review', 'In Review'], ['completed', 'Completed']] as const).map(([k, l]) =>
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={byUrgency} onChange={(e) => setByUrgency(e.target.checked)} data-testid="sort-urgency" /> Show emergency and urgent warning signs first <span className="tiny muted">(rule-based, not a risk score)</span></label>
        {list.loading && !list.data ? <Skeleton rows={4} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : items.length
          ? <div className="list">{items.map((v) => <ConsultRowD key={v.consultation.id} v={v} onOpen={() => nav.push({ name: 'd.workspace', id: v.consultation.id })} />)}</div>
          : <Empty icon={<LuInbox />} title="Nothing here">No consultations with this status.</Empty>}
      </div></div>
    </>
  );
}

export function DoctorPatients() {
  const { backend, nav } = useApp();
  const list = useLoad(() => backend.listMyPatients(), []);
  const [q, setQ] = useState('');
  const items = (list.data ?? []).filter((p) => p.profile.fullName.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <LargeBar title="My patients" />
      <div className="screen screen-in"><div className="pad">
        <div className="field">
          <label htmlFor="patient-search" className="sr-only">Search patients</label>
          <div className="pw-wrap">
            <input id="patient-search" className="input" placeholder="Search connected patients" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 44 }} />
            <LuSearch aria-hidden style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          </div>
        </div>
        {list.loading && !list.data ? <Skeleton rows={3} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data && list.data.length === 0
          ? <Empty icon={<LuUsers />} title="No connected patients" action={<Button variant="secondary" onClick={() => nav.push({ name: 'd.id' })}><LuIdCard aria-hidden /> Show my Doctor ID</Button>}>Share your Doctor ID with patients so they can connect.</Empty>
          : items.length === 0 ? <p className="muted small">No patients match “{q}”.</p>
          : <div className="list">{items.map((p) => (
              <button key={p.profile.id} className="list-item" onClick={() => nav.push({ name: 'd.patient', id: p.profile.id })}>
                <div className="avatar">{initials(p.profile.fullName)}</div>
                <div className="grow"><b>{p.profile.fullName}</b><div className="small muted">Connected {fmtRelative(p.connectedAt)} · {p.consultationCount} consultation{p.consultationCount === 1 ? '' : 's'}</div></div>
                <LuChevronRight className="chev" />
              </button>))}</div>}
      </div></div>
    </>
  );
}

const PREF_LABELS: Partial<Record<keyof CommunicationPreferences, string>> = {
  simpleText: 'Simple text', shortSentences: 'Short sentences', largeButtons: 'Large buttons', largerText: 'Larger text',
  yesNoQuestions: 'Yes/No questions', multipleChoice: 'Multiple choice', visualOptions: 'Visual options',
  textToSpeech: 'Text-to-speech', speechInput: 'Speech input', reducedMotion: 'Reduced animation',
};

export function DoctorPatientDetail({ id }: { id: string }) {
  const { backend, nav, toast, refresh } = useApp();
  const pats = useLoad(() => backend.listMyPatients(), []);
  const list = useLoad(() => backend.listConsultations(), []);
  const [confirm, setConfirm] = useState(false);
  const p = pats.data?.find((x) => x.profile.id === id);
  if (pats.data && !p) return <><TopBar title="Patient" /><div className="screen"><div className="pad"><Banner kind="warn">This patient is not connected to you.</Banner></div></div></>;
  if (!p) return <><TopBar title="Patient" /><div className="screen"><div className="pad"><Skeleton rows={3} /></div></div></>;
  const consults = (list.data ?? []).filter((v) => v.patient.id === id);
  const prefs = p.preferences;
  return (
    <>
      <TopBar title="Patient" />
      <div className="screen screen-in"><div className="pad">
        <div className="card">
          <div className="row"><div className="avatar lg">{initials(p.profile.fullName)}</div>
            <div className="grow"><h2 className="title" style={{ fontSize: '1.25em' }}>{p.profile.fullName}</h2><p className="small muted">Connected {fmtDate(p.connectedAt)}</p></div></div>
        </div>
        <h3 className="section">How this patient prefers to communicate</h3>
        {prefs ? <div className="row wrap" style={{ gap: 6 }}>
          {(Object.keys(PREF_LABELS) as (keyof CommunicationPreferences)[]).filter((k) => prefs[k]).map((k) => <span key={k} className="chip teal">{PREF_LABELS[k]}</span>)}
        </div> : <p className="small muted">The patient has not shared their preferences.</p>}
        <h3 className="section">Consultations</h3>
        {consults.length ? <div className="list">{consults.map((v) => <ConsultRowD key={v.consultation.id} v={v} onOpen={() => nav.push({ name: 'd.workspace', id: v.consultation.id })} />)}</div>
          : <Empty icon={<LuFileText />} title="No shared consultations yet" />}
        <Button variant="danger-outline" onClick={() => setConfirm(true)}><LuUnlink aria-hidden /> Disconnect patient</Button>
      </div></div>
      {confirm && <ConfirmSheet title={`Disconnect ${p.profile.fullName}?`} danger confirmLabel="Disconnect" icon={<LuUnlink />}
        body="You will lose access to this patient’s consultations. They can reconnect with your Doctor ID."
        onCancel={() => setConfirm(false)}
        onConfirm={async () => { try { await backend.disconnectPatient(id); refresh(); toast('Patient disconnected'); nav.back(); } catch (e) { toast((e as Error).message); } }} />}
    </>
  );
}

export function DoctorWorkspace({ id }: { id: string }) {
  const { backend, toast, refresh } = useApp();
  const v = useLoad(() => backend.getConsultation(id), [id]);
  const notes = useLoad(() => backend.listNotes(id), [id]);
  const hist = useLoad(() => backend.statusHistory(id), [id]);
  const msgs = useLoad(() => backend.listMessages(id), [id]);
  const pats = useLoad(() => backend.listMyPatients(), []);
  const [tab, setTab] = useState<'report' | 'brief' | 'clinical' | 'body' | 'notes' | 'messages'>('report');
  const { nav } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { backend.markViewed?.(id).catch(() => {}); }, [id]); // eslint-disable-line
  if (!v.data) return <><TopBar title="Consultation" /><div className="screen"><div className="pad">{v.error ? <ErrorState message={v.error} onRetry={v.reload} /> : <Skeleton rows={5} />}</div></div></>;
  const c = v.data.consultation;
  const a = c.approved!;
  const rec = a.report.reconstruction;
  const signal = a.report.signal;
  const prefs = pats.data?.find((p) => p.profile.id === v.data!.patient.id)?.preferences;
  const addenda = clarifiedAddenda(msgs.data ?? []);
  const openQs = (msgs.data ?? []).filter((m) => m.kind === 'clarification' && !(msgs.data ?? []).some((x) => x.meta?.replyTo === m.id)).length;
  const setStatus = async (s: ConsultationStatus) => {
    setBusy(true);
    try { await backend.setStatus(id, s); refresh(); toast(`Marked as ${STATUS_LABELS[s]}`); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const missing = a.report.fields.filter((f) => f.status !== 'confirmed');
  const rules = analyzeRules({ consultation: c, messages: msgs.data ?? [], documented: EMPTY_DOCUMENTED });
  const emergencies = rules.warnings.filter((w) => w.level === 'emergency').length;
  const corrections = rec ? rec.items.filter((i) => i.history.some((h) => h.by === 'patient' && h.action !== 'captured')) : [];
  return (
    <>
      <TopBar title={v.data.patient.fullName} bordered />
      <div className="screen screen-in"><div className="pad" style={{ paddingTop: 16 }}>
        <div className="card">
          <div className="row between"><div className="row" style={{ gap: 6 }}><StatusChip status={c.status} />{c.kind === 'signal' && <span className="chip teal"><LuRadioTower aria-hidden /> Silent Signal</span>}</div><span className="small muted">Shared {fmtDate(c.sharedAt)}</span></div>
          <b style={{ fontSize: '1.08em' }}>{c.regionIds.map(regionLabel).join(', ')}</b>
          <div className="small muted">{a.report.sensations.join(', ') || 'Sensation not named'}</div>
          <div className="seg" role="group" aria-label="Consultation status">
            {(['new', 'in_review', 'completed'] as ConsultationStatus[]).map((s) => (
              <button key={s} aria-pressed={c.status === s} disabled={busy} onClick={() => setStatus(s)} data-testid={`status-${s}`}>{STATUS_LABELS[s]}</button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => nav.push({ name: 'interp', cid: id })} data-testid="ws-interp"><LuLanguages aria-hidden /> Visit interpreter</Button>
        </div>
        {c.urgentGuidanceShown && <Banner kind="danger">During this report the patient was shown urgent-help guidance based on what they reported.</Banner>}
        <div className="seg" role="tablist">
          {([['report', 'Report'], ['brief', 'Brief'], ['clinical', emergencies ? `Clinical support · ${emergencies}⚠` : 'Clinical support'], ['body', '3D body'], ['notes', 'Notes'], ['messages', openQs ? `Messages · ${openQs} open` : 'Messages']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{l}</button>
          ))}
        </div>
        {emergencies > 0 && tab !== 'clinical' && <Banner kind="danger"><b>Clinical Intelligence Engine: {emergencies} emergency warning sign{emergencies > 1 ? 's' : ''}</b> — {rules.warnings.filter((w) => w.level === 'emergency').map((w) => w.title).join('; ')}. <button className="linkish" onClick={() => setTab('clinical')}>Open clinical support</button></Banner>}
        {tab === 'report' && <>
          {signal && (
            <div className="card" data-testid="signal-selections-doctor">
              <div className="row"><LuRadioTower style={{ color: 'var(--teal-ink)' }} aria-hidden /><b>Selected by the patient with Silent Signal</b></div>
              <div className="report">
                {signal.selections.map((s) => <div className="r" key={s.step}><dt>{s.question}</dt><dd>{s.choice}<span className={`tag ${s.status === 'not_sure' ? 'unsure' : s.status === 'unanswered' || !s.confirmed ? 'unanswered' : 'confirmed'}`}>{s.status === 'not_sure' ? 'Patient not sure' : s.status === 'unanswered' ? 'Not answered' : s.confirmed ? 'Confirmed by patient' : 'Unconfirmed'}</span>{s.via && <div className="tiny muted">{s.via}</div>}</dd></div>)}
                <div className="r"><dt>Region</dt><dd>{signal.regionIds.length ? <>{signal.regionIds.map(regionLabel).join(', ')}<span className="tag confirmed">Selected by patient</span></> : <span className="tag unanswered">Not given</span>}</dd></div>
              </div>
              <div className="tiny muted strong">MESSAGE ({signal.wordingSource === 'ai' ? 'AI WORDING' : 'ACCESSCARE WORDING'}, APPROVED BY PATIENT)</div>
              <div className="pre">{signal.wording}</div>
              <p className="tiny muted">The sentence is generated wording; rely on the selections above. Method: {signal.method === 'camera_signs' ? 'sign language on camera (ASL YES/NO or signs the patient taught; each answer confirmed by the patient)' : signal.method === 'camera_movements' ? 'camera movements chosen and calibrated by the patient (not expression analysis)' : signal.method.replace('_', ' ')}{signal.rejectedWordings ? ` · patient rejected ${signal.rejectedWordings} AI wording(s)` : ''}.</p>
            </div>
          )}
          {a.report.brief ? <>
            <h3 className="section">Clinical brief (patient-approved)</h3>
            <BriefView brief={a.report.brief} addenda={addenda} />
          </> : <>
            <h3 className="section">Patient communication report</h3>
            <ReportView report={a.report} />
            {missing.length > 0 && <Banner kind="warn"><b>Missing or unconfirmed:</b> {missing.map((f) => `${f.label} (${f.status.replace('_', ' ')})`).join(', ')}.</Banner>}
          </>}
          <h3 className="section">Exact text approved by the patient{a.editedByPatient ? ' · edited by patient' : ''}</h3>
          <div className="pre" data-testid="approved-text">{a.text}</div>
          <p className="tiny muted">Approved {fmtDate(a.approvedAt)}.</p>
          {a.report.metrics && <MetricsCard m={a.report.metrics} title="Patient verification record" />}
          {rec && <ContradictionList list={rec.contradictions} />}
          {corrections.length > 0 && <>
            <h3 className="section">Uncertainty and correction history</h3>
            <div className="list">{corrections.map((i) => <div key={i.key} className="list-item" style={{ display: 'block', cursor: 'default' }}><b>{i.label}</b><ItemHistory item={i} /></div>)}</div>
          </>}
          {!a.report.brief && <><h3 className="section">Clarification answers</h3><ClarificationList report={a.report} /></>}
          <h3 className="section">Status history</h3>
          {hist.data ? <StatusTimeline items={hist.data} /> : <Skeleton rows={1} height={40} />}
        </>}
        {tab === 'clinical' && <ClinicalPanel view={v.data} messages={msgs.data ?? []} reloadMessages={msgs.reload} patientPrefs={prefs} />}
        {tab === 'body' && (rec ? <Reconstruction3D rec={rec} height={360} /> : <BodySelector selected={c.regionIds} readOnly focus={c.regionIds[0] ?? null} />)}
        {tab === 'notes' && <>
          <Banner kind="info">Clinician notes are private to you. They are stored separately from the patient’s report{backend.mode === 'claude-cloud' ? ', encrypted with your password,' : ''} and are never shown to the patient.</Banner>
          <div className="stack">
            {(notes.data ?? []).map((n) => <div key={n.id} className="card" style={{ gap: 4 }}><div className="row between"><span className="tiny muted">{fmtDate(n.createdAt)}</span><span className="prov prov-clinician">Clinician</span></div><span style={{ whiteSpace: 'pre-wrap' }}>{n.body}</span></div>)}
            {notes.data?.length === 0 && <Empty icon={<LuNotebookPen />} title="No notes yet" />}
          </div>
          <Field id="doctor-note" label="Add a note" multiline value={note} onChange={setNote} maxLength={2000} />
          <Button disabled={!note.trim()} onClick={async () => { try { await backend.addNote(id, note); setNote(''); notes.reload(); } catch (e) { toast((e as Error).message); } }}><LuClipboardCheck aria-hidden /> Save note</Button>
        </>}
        {tab === 'messages' && <MessagesPanel consultationId={id} canSend report={a.report} patientPrefs={prefs} signalSession={c.kind === 'signal'} />}
        {tab === 'brief' && <BriefPanel patientId={v.data.patient.id} aiAllowed={!!a.report.aiConsent} />}
      </div></div>
    </>
  );
}

export function DoctorProfile() {
  const { me, nav, backend, setMe, toast } = useApp();
  const pats = useLoad(() => backend.listMyPatients(), []);
  const list = useLoad(() => backend.listConsultations(), []);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ fullName: me!.profile.fullName, specialty: me!.doctor?.specialty ?? '', clinic: me!.doctor?.clinic ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { setMe(await backend.updateProfile(f)); setEdit(false); toast('Profile saved'); } catch (e) { toast((e as Error).message); } finally { setBusy(false); } };
  return (
    <>
      <LargeBar title="Profile" />
      <div className="screen screen-in"><div className="pad">
        <div className="card">
          <div className="row"><div className="avatar navy lg">{initials(me!.profile.fullName)}</div>
            <div className="grow"><h2 className="title" style={{ fontSize: '1.25em' }}>{me!.profile.fullName}</h2>
              <p className="small muted">{[me!.doctor?.specialty, me!.doctor?.clinic].filter(Boolean).join(' · ') || 'Doctor'}</p></div></div>
          {edit ? (<>
            <Field id="dp-name" label="Full name" value={f.fullName} onChange={(v) => setF((x) => ({ ...x, fullName: v }))} />
            <Field id="dp-spec" label="Specialty" value={f.specialty} onChange={(v) => setF((x) => ({ ...x, specialty: v }))} />
            <Field id="dp-clinic" label="Clinic" value={f.clinic} onChange={(v) => setF((x) => ({ ...x, clinic: v }))} />
            <p className="tiny muted">Your Doctor ID can’t be changed.</p>
            <div className="grid2"><Button variant="secondary" onClick={() => setEdit(false)}>Cancel</Button><Button onClick={save} busy={busy}>Save</Button></div>
          </>) : <Button variant="secondary" onClick={() => setEdit(true)}>Edit profile</Button>}
        </div>
        <DoctorIdCard compact />
        <div className="list">
          <button className="list-item" onClick={() => nav.reset({ name: 'd.patients' })}><span className="li-ico"><LuUsers /></span><div className="grow"><b>Connected patients</b><div className="small muted">{pats.data?.length ?? '…'}</div></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.reset({ name: 'd.consults' })}><span className="li-ico"><LuInbox /></span><div className="grow"><b>Consultation history</b><div className="small muted">{list.data?.length ?? '…'} total</div></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.push({ name: 'settings' })} data-testid="open-settings"><span className="li-ico"><LuSettings /></span><div className="grow"><b>Account settings</b></div><LuChevronRight className="chev" /></button>
          <button className="list-item" onClick={() => nav.push({ name: 'about' })}><span className="li-ico"><LuInfo /></span><div className="grow"><b>About this prototype</b></div><LuChevronRight className="chev" /></button>
        </div>
        <LogoutRow />
      </div></div>
    </>
  );
}
