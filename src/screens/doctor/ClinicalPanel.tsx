// Doctor-facing clinical decision support (AccessCare AI — Clinical Intelligence Engine).
// Shown inside the existing consultation workspace. Everything here is private
// to the doctor; the patient only ever receives what the doctor sends (questions
// and doctor-approved prescriptions) through the existing messages.

import React, { useEffect, useMemo, useState } from 'react';
import {
  LuSiren, LuTriangleAlert, LuInfo, LuSparkles, LuCircleHelp, LuCheck, LuX, LuHourglass, LuPill, LuExternalLink, LuShieldAlert,
  LuClipboardList, LuFileCheck, LuSend, LuBookOpen, LuStethoscope, LuHistory,
} from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Field, Skeleton, fmtDate } from '../../ui/components';
import type { ConsultationView } from '../../services/backend/Backend';
import type { CommunicationPreferences, Message } from '../../domain/types';
import {
  cleanDocumented, newReview, type CaseFact, type ClinicalAnalysis, type ClinicalReview, type ClinicalWarning, type Decision, type DecisionStatus,
  type Documented, type MedOption, type MissingItem, type Prescription,
} from '../../domain/clinical';
import { ENGINE_NAME, analyze, analyzeRules, citedRefs, medsGate, reportOf, suggestMeds, treatmentGapsOf, type ClinicalAI, type EngineInput } from '../../services/clinical/engine';
import { REF_BY_ID } from '../../services/clinical/references';
import { defaultFdaSource } from '../../services/clinical/openfda';
import { runtimeConfig } from '../../services/config';
import { FollowUpSection, VisitSummarySection } from './FollowUpSections';
import { randomId } from '../../services/crypto';

const SOURCE_LABEL: Record<CaseFact['source'], string> = {
  patient_words: 'Patient’s words', patient_choice: 'Patient’s choice', body_map: 'Body map', silent_signal: 'Silent Signal',
  clarification: 'Answered after sending', clinician: 'Documented by you', system: 'App event',
};
const STATUS_TAG: Record<CaseFact['status'], [string, string]> = {
  confirmed: ['confirmed', 'Patient-reported'], unsure: ['unsure', 'Patient not sure'], interpretation: ['suggested', 'Interpretation — not confirmed'], denied: ['unanswered', 'Patient said no'],
};
const LEVEL: Record<ClinicalWarning['level'], { cls: 'danger' | 'warn' | 'info'; icon: React.ReactNode; label: string }> = {
  emergency: { cls: 'danger', icon: <LuSiren aria-hidden />, label: 'EMERGENCY WARNING' },
  urgent: { cls: 'warn', icon: <LuTriangleAlert aria-hidden />, label: 'URGENT' },
  info: { cls: 'info', icon: <LuInfo aria-hidden />, label: 'FOR INFORMATION' },
};
const now = () => new Date().toISOString();
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function Evidence({ ids, facts }: { ids: string[]; facts: CaseFact[] }) {
  const list = ids.map((id) => facts.find((f) => f.id === id)).filter((f): f is CaseFact => !!f);
  if (!list.length) return null;
  return (
    <ul className="cie-ev" aria-label="Based on">
      {list.map((f) => <li key={f.id}><span className="tiny muted">{f.id}</span> <b>{f.label}:</b> {f.value} <span className="tiny muted">({SOURCE_LABEL[f.source]}{f.status !== 'confirmed' ? ` · ${STATUS_TAG[f.status][1].toLowerCase()}` : ''})</span></li>)}
    </ul>
  );
}
function Refs({ ids }: { ids: string[] }) {
  const list = ids.map((id) => REF_BY_ID[id]).filter(Boolean);
  if (!list.length) return null;
  return <div className="tiny cie-refs"><LuBookOpen aria-hidden /> {list.map((r, i) => <React.Fragment key={r.id}>{i > 0 && ' · '}<a href={r.url} target="_blank" rel="noreferrer">{r.publisher}: {r.title}</a></React.Fragment>)}</div>;
}
function DecisionBar({ id, decision, onDecide, labels }: { id: string; decision?: Decision; onDecide: (id: string, s: DecisionStatus | null) => void; labels?: Partial<Record<DecisionStatus, string>> }) {
  const opts: [DecisionStatus, string, React.ReactNode][] = [['accepted', labels?.accepted ?? 'Accept', <LuCheck aria-hidden />], ['needs_assessment', labels?.needs_assessment ?? 'Needs assessment', <LuHourglass aria-hidden />], ['rejected', labels?.rejected ?? 'Reject', <LuX aria-hidden />]];
  return (
    <div className="row wrap cie-decide" role="group" aria-label="Your review">
      {opts.map(([s, l, ic]) => <button key={s} className={`chip${decision?.status === s ? ` on ${s}` : ''}`} aria-pressed={decision?.status === s} onClick={() => onDecide(id, decision?.status === s ? null : s)} data-testid={`decide-${id}-${s}`}>{ic} {l}</button>)}
      {decision && <span className="tiny muted">Your review: {decision.status.replace('_', ' ')} · {fmtDate(decision.at)}. Recorded as your decision only — not as proof the suggestion was right or wrong.</span>}
    </div>
  );
}

export function ClinicalPanel({ view, messages, reloadMessages, patientPrefs }: {
  view: ConsultationView; messages: Message[]; reloadMessages: () => void; patientPrefs?: CommunicationPreferences;
}) {
  const { backend, ai, me, toast } = useApp();
  void patientPrefs;
  const c = view.consultation;
  const [review, setReview] = useState<ClinicalReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState<Documented | null>(null);
  const [rxEdit, setRxEdit] = useState<Prescription | null>(null);
  const [approveRx, setApproveRx] = useState<Prescription | null>(null);

  useEffect(() => {
    let alive = true;
    backend.getClinicalReview(c.id).then((r) => alive && setReview(r)).catch((e: Error) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [c.id]); // eslint-disable-line

  const documented = review?.documented ?? newReview(c.id).documented;
  const input: EngineInput = useMemo(() => ({ consultation: c, messages, documented }), [c, messages, documented]);
  const live = useMemo(() => analyzeRules(input), [input]);
  const gaps = useMemo(() => treatmentGapsOf(input), [input]);
  const consent = reportOf(c).aiConsent === true;
  const saved = review?.analysis;
  const aiFn: ClinicalAI = (p, n) => ai.clinical(p, n);

  if (err) return <Banner kind="danger">{err}</Banner>;
  if (!review) return <Skeleton rows={4} />;

  const persist = async (next: ClinicalReview, action: string, detail?: string) => {
    const withLog = { ...next, log: [...next.log, { at: now(), action, ...(detail ? { detail } : {}) }] };
    setReview(withLog);
    try { setReview(await backend.saveClinicalReview(c.id, withLog)); }
    catch (e) { toast(`Not saved — ${(e as Error).message}`); }
  };
  const decide = (id: string, s: DecisionStatus | null) => {
    const decisions = { ...review.decisions };
    if (s) decisions[id] = { status: s, at: now() }; else delete decisions[id];
    void persist({ ...review, decisions }, 'review decision', `${id}: ${s ?? 'cleared'}`);
  };
  const runAI = async () => {
    setBusy('ai');
    const a = await analyze(input, ai.supported ? aiFn : null);
    setBusy(null);
    const decisions = Object.fromEntries(Object.entries(review.decisions).filter(([k]) => !k.startsWith('ai:')));
    await persist({ ...review, analysis: a, decisions }, 'AI analysis generated', a.ai.status === 'used' ? `${a.considerations.length} considerations, ${a.nextSteps.filter((s) => s.by === 'ai').length} steps, ${a.ai.rejected ?? 0} rejected by validation` : `${a.ai.status}${a.ai.error ? `: ${a.ai.error}` : ''}`);
  };
  const ask = async (m: MissingItem) => {
    setBusy(`ask:${m.id}`);
    try {
      await backend.sendMessage(c.id, m.question, 'clarification', { itemKey: `clinical:${m.id}`, itemLabel: m.topic.slice(0, 80), format: m.format, ...(m.options ? { options: m.options.filter((o) => o !== 'Not sure') } : {}) });
      toast('Question sent to the patient');
      reloadMessages();
      void persist(review, 'asked patient', m.topic);
    } catch (e) { toast(`Not sent — ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const runMeds = async () => {
    setBusy('meds');
    const base = saved && saved.ai.status === 'used' ? { ...live, considerations: saved.considerations } : live;
    const m = await suggestMeds(base, documented, consent, ai.supported ? aiFn : null, defaultFdaSource(runtimeConfig.aiEndpoint));
    setBusy(null);
    const decisions = Object.fromEntries(Object.entries(review.decisions).filter(([k]) => !k.startsWith('med:')));
    await persist({ ...review, meds: m, decisions }, 'medication options requested', `${m.status}: ${m.options.map((o) => o.generic).join(', ') || m.reasons[0] || ''}`);
  };
  const saveRx = async (p: Prescription, action: string) => {
    const list = review.prescriptions.some((x) => x.id === p.id) ? review.prescriptions.map((x) => (x.id === p.id ? p : x)) : [...review.prescriptions, p];
    await persist({ ...review, prescriptions: list }, action, `${p.medication} ${p.dose}`);
  };
  const sendRx = async (p: Prescription) => {
    if (p.status !== 'approved' || !p.approvedAt || !p.approvedBy) { toast('Approve the prescription first.'); return; }
    setBusy(`rx:${p.id}`);
    try {
      const body = `Prescription from ${p.approvedBy}: ${p.medication} — ${p.dose}, ${p.route}, ${p.frequency}${p.duration ? `, for ${p.duration}` : ''}.${p.instructions ? ` ${p.instructions}` : ''}`;
      const msg = await backend.sendMessage(c.id, body.slice(0, 2000), 'prescription', { rx: { id: p.id, medication: p.medication, dose: p.dose, route: p.route, frequency: p.frequency, duration: p.duration, instructions: p.instructions, approvedAt: p.approvedAt, approvedBy: p.approvedBy, ...(p.labelUrl ? { labelUrl: p.labelUrl } : {}) } });
      await saveRx({ ...p, status: 'sent', sentAt: now(), messageId: msg.id, updatedAt: now() }, 'prescription sent to patient');
      reloadMessages();
      toast('Prescription sent to the patient');
    } catch (e) { toast(`Not sent — ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  const draftFrom = (o?: MedOption): Prescription => ({ id: randomId('rx_'), status: 'draft', medication: o ? o.generic : '', dose: '', route: '', frequency: '', duration: '', instructions: '', ...(o ? { fromOption: o.id, labelUrl: o.label?.url } : {}), createdAt: now(), updatedAt: now() });

  const em = live.warnings.filter((w) => w.level === 'emergency');
  const aiWarnings = saved?.ai.status === 'used' ? saved.warnings.filter((w) => w.by === 'ai') : [];
  const shownWarnings = [...live.warnings, ...aiWarnings];
  const factsForAI = saved?.facts ?? live.facts;
  const staleAI = saved && saved.ai.status === 'used' && JSON.stringify(saved.facts.map((f) => f.label + f.value)) !== JSON.stringify(live.facts.map((f) => f.label + f.value));
  const gate = medsGate(live, documented, consent);
  const followRefs = messages.some((m) => m.kind === 'followup_answer') ? ['nhs_anaphylaxis'] : [];
  const refs = [...new Set([...citedRefs(live), ...(saved ? citedRefs(saved) : []), ...(review.meds?.options.length ? ['openfda_label'] : []), ...followRefs])];
  const logOnly = (a: string, d?: string) => void persist(review, a, d);

  return (
    <div className="stack cie" data-testid="clinical-panel">
      <div className="card tinted" style={{ gap: 6 }}>
        <div className="row"><LuStethoscope aria-hidden style={{ color: 'var(--teal-ink)', fontSize: '1.3em' }} /><b>{ENGINE_NAME}</b></div>
        <p className="small muted" style={{ margin: 0 }}>Decision support for you as the treating clinician. It organizes what the patient reported and approved, flags warning signs and gaps, and — when you ask — offers AI considerations and medication options to review. It is not a diagnosis and is not clinically validated. You make every clinical decision.</p>
      </div>

      {/* A. urgent warnings first */}
      <h3 className="section">Priority and warning signs</h3>
      {shownWarnings.filter((w) => w.level !== 'info').length === 0 && <Banner kind="info">No warning sign from the engine’s rules matched this report. That does not mean the patient is safe — the rules cover a limited set of signs.</Banner>}
      <div className="stack" data-testid="cie-warnings">
        {shownWarnings.map((w) => (
          <div key={w.id} className={`card cie-warn ${LEVEL[w.level].cls}`} data-level={w.level} role={w.level === 'emergency' ? 'alert' : undefined}>
            <div className="row between"><div className="row" style={{ gap: 6 }}>{LEVEL[w.level].icon}<span className="tiny strong">{LEVEL[w.level].label}</span></div>{w.by === 'ai' ? <span className="prov prov-ai"><LuSparkles aria-hidden /> AI-raised</span> : <span className="prov prov-template">Rule</span>}</div>
            <b>{w.title}</b>
            <div className="small">{w.why}</div>
            {w.level !== 'info' && <div className="small"><b>Suggested action:</b> {w.action}</div>}
            <Evidence ids={w.evidence} facts={w.by === 'ai' ? factsForAI : live.facts} />
            <Refs ids={w.refs} />
          </div>
        ))}
      </div>

      {/* B. patient-reported information */}
      <h3 className="section">Patient-reported information</h3>
      <div className="list" data-testid="cie-facts">
        {live.facts.map((f) => (
          <div key={f.id} className="list-item" style={{ display: 'block', cursor: 'default' }}>
            <div className="row between" style={{ gap: 6 }}><span><span className="tiny muted">{f.id}</span> <b>{f.label}</b></span><span className={`tag ${f.source === 'system' ? 'unanswered' : STATUS_TAG[f.status][0]}`}>{f.source === 'clinician' ? 'Documented by you' : f.source === 'system' ? 'App event' : STATUS_TAG[f.status][1]}</span></div>
            <div className="small">{f.value}</div>
            <div className="tiny muted">{SOURCE_LABEL[f.source]}</div>
          </div>
        ))}
        {live.facts.length === 0 && <p className="small muted">No structured information could be extracted. Read the patient’s approved text in the Report tab.</p>}
      </div>

      {/* missing / uncertain */}
      <h3 className="section">Missing or uncertain information</h3>
      {live.missing.length === 0 ? <p className="small muted">Nothing listed for the reported complaints. The list is selected from what the patient reported; it is not exhaustive.</p> : (
        <div className="stack" data-testid="cie-missing">
          {live.missing.map((m) => (
            <div key={m.id} className="card flat" style={{ gap: 6 }} data-missing={m.id}>
              <div className="row between"><b>{m.topic}</b><span className={`tag ${m.status === 'asked' ? 'suggested' : m.status === 'unsure' ? 'unsure' : 'unanswered'}`}>{m.status === 'asked' ? 'Asked — awaiting answer' : m.status === 'unsure' ? 'Patient not sure' : m.importance === 'high' ? 'Missing · important' : 'Missing'}</span></div>
              <div className="small muted">For: {m.for}. {m.why} Unanswered is recorded as unknown — never as “no”.</div>
              <Refs ids={m.refs} />
              {m.status !== 'asked' && <Button variant="secondary" busy={busy === `ask:${m.id}`} onClick={() => ask(m)} data-testid={`ask-${m.id}`}><LuCircleHelp aria-hidden /> Ask the patient: “{m.question}”</Button>}
            </div>
          ))}
        </div>
      )}
      {live.conflicts.length > 0 && <>
        <h3 className="section">Contradictions and corrections</h3>
        <div className="stack">{live.conflicts.map((k) => <div key={k.id} className={`banner ${k.status === 'open' ? 'warn' : 'info'}`}><LuShieldAlert aria-hidden /><div className="grow small">{k.description} <span className="tiny muted">({k.status})</span><Evidence ids={k.evidence} facts={live.facts} /></div></div>)}</div>
      </>}

      {/* C. AI clinical considerations */}
      <h3 className="section">AI clinical considerations</h3>
      <div className="card" style={{ gap: 10 }} data-testid="cie-ai">
        {!consent && <Banner kind="info">The patient did not allow AI assistance for this report, so it is not sent to the AI. The rule-based sections above still apply.</Banner>}
        {consent && !ai.supported && <Banner kind="warn">No AI service is available in this view.</Banner>}
        {saved?.ai.status === 'failed' && <Banner kind="warn">The last AI request did not work: {saved.ai.error}. Nothing from it is shown.</Banner>}
        {staleAI && <Banner kind="info">New answers or documentation arrived after this AI analysis ({fmtDate(saved!.generatedAt)}). Generate again to include them.</Banner>}
        {saved?.ai.status === 'used' && saved.considerations.length === 0 && <p className="small muted">The AI returned no consideration that passed validation{saved.ai.rejected ? ` (${saved.ai.rejected} item(s) rejected: missing evidence, probabilities, doses or unsupported claims)` : ''}.</p>}
        {saved?.ai.status === 'used' && saved.considerations.map((k) => (
          <div key={k.id} className="cie-item" data-testid="cie-consideration">
            <div className="row between"><b>{k.title}</b><span className="prov prov-ai"><LuSparkles aria-hidden /> AI suggestion — not a diagnosis</span></div>
            <div className="tiny strong muted">Supported by</div><Evidence ids={k.supporting} facts={factsForAI} />
            {k.against.length > 0 && <><div className="tiny strong muted">Against</div><Evidence ids={k.against} facts={factsForAI} /></>}
            {k.missing.length > 0 && <div className="small"><b>Missing:</b> {k.missing.join('; ')}</div>}
            <div className="small"><b>Uncertainty:</b> {k.uncertainty}</div>
            {k.refs.length ? <Refs ids={k.refs} /> : <div className="tiny muted">No reference from the checked catalog fits this point — treat it as unverified.</div>}
            <DecisionBar id={`ai:${k.id}`} decision={review.decisions[`ai:${k.id}`]} onDecide={decide} />
          </div>
        ))}
        {consent && ai.supported && <Button variant={saved?.ai.status === 'used' ? 'secondary' : 'primary'} busy={busy === 'ai'} onClick={runAI} data-testid="cie-run-ai"><LuSparkles aria-hidden /> {saved?.ai.status === 'used' ? 'Generate again' : 'Generate AI considerations'}</Button>}
        {saved?.ai.at && <p className="tiny muted">Generated {fmtDate(saved.ai.at)} from the facts listed above. AI items must cite those facts; references can only come from the checked list below.</p>}
      </div>

      {/* D. suggested next steps */}
      <h3 className="section">Suggested next steps</h3>
      <div className="stack" data-testid="cie-steps">
        {[...live.nextSteps, ...(saved?.ai.status === 'used' ? saved.nextSteps.filter((s) => s.by === 'ai') : [])].map((s) => (
          <div key={`${s.by}:${s.id}`} className="card flat" style={{ gap: 6 }}>
            <div className="row between"><b>{s.text}</b>{s.by === 'ai' ? <span className="prov prov-ai"><LuSparkles aria-hidden /> AI</span> : <span className="prov prov-template">Rule</span>}</div>
            <div className="small muted">{s.why}</div>
            <Evidence ids={s.supporting} facts={s.by === 'ai' ? factsForAI : live.facts} />
            <Refs ids={s.refs} />
            <DecisionBar id={`${s.by === 'ai' ? 'ai' : 'step'}:${s.id}`} decision={review.decisions[`${s.by === 'ai' ? 'ai' : 'step'}:${s.id}`]} onDecide={decide} labels={{ accepted: 'Will do', rejected: 'Not needed' }} />
          </div>
        ))}
        {live.nextSteps.length === 0 && !(saved?.ai.status === 'used' && saved.nextSteps.some((s) => s.by === 'ai')) && <p className="small muted">No rule-based next step. Nothing is ordered automatically.</p>}
      </div>

      {/* E. medication options & prescription */}
      <h3 className="section">Medication options for your review</h3>
      <div className="card" style={{ gap: 10 }} data-testid="cie-meds">
        <p className="small muted" style={{ margin: 0 }}>Options come from the AI and are each checked against the manufacturer’s FDA label (openFDA). No doses are suggested. Nothing is prescribed or sent unless you write, approve and send a prescription.</p>
        <DocumentedForm value={docDraft ?? documented} editing={!!docDraft} gaps={gaps} messages={messages}
          onEdit={() => setDocDraft(JSON.parse(JSON.stringify(documented)))} onCancel={() => setDocDraft(null)}
          onChange={setDocDraft} onAsk={ask} busy={busy}
          onSave={async () => { const d = { ...cleanDocumented(docDraft!), updatedAt: now() }; setDocDraft(null); await persist({ ...review, documented: d }, 'patient information documented'); }} />
        {gate.length > 0 && <Banner kind="warn" ><b>Medication options are withheld:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{gate.map((g) => <li key={g}>{g}</li>)}</ul></Banner>}
        {gate.length === 0 && ai.supported && <Button busy={busy === 'meds'} onClick={runMeds} data-testid="cie-run-meds"><LuPill aria-hidden /> {review.meds ? 'Find options again' : 'Find medication options to review'}</Button>}
        {gate.length === 0 && !ai.supported && <Banner kind="warn">No AI service is available in this view, so no options can be generated. You can still write a prescription yourself below.</Banner>}
        {review.meds && <MedList meds={review.meds} facts={live.facts} decisions={review.decisions} onDecide={decide} onUse={(o) => { decide(`med:${o.id}`, 'accepted'); setRxEdit(draftFrom(o)); }} />}
      </div>

      <h3 className="section">Prescriptions</h3>
      <div className="stack" data-testid="cie-rx">
        {review.prescriptions.map((p) => (
          <div key={p.id} className="card flat" style={{ gap: 6 }} data-rx-status={p.status}>
            <div className="row between"><b>{p.medication || 'Untitled'}</b><span className={`tag ${p.status === 'sent' ? 'confirmed' : p.status === 'approved' ? 'suggested' : p.status === 'cancelled' ? 'unanswered' : 'unsure'}`}>{p.status === 'draft' ? 'Draft — not approved' : p.status === 'approved' ? `Approved by you ${fmtDate(p.approvedAt)}` : p.status === 'sent' ? `Sent to patient ${fmtDate(p.sentAt)}` : 'Cancelled'}</span></div>
            <div className="small">{[p.dose, p.route, p.frequency, p.duration && `for ${p.duration}`].filter(Boolean).join(' · ') || 'Dose and directions not written yet'}</div>
            {p.instructions && <div className="small muted">{p.instructions}</div>}
            {p.labelUrl && <a className="tiny" href={p.labelUrl} target="_blank" rel="noreferrer"><LuExternalLink aria-hidden /> FDA label (DailyMed)</a>}
            <div className="row wrap" style={{ gap: 8 }}>
              {p.status === 'draft' && <>
                <Button variant="secondary" onClick={() => setRxEdit(p)} data-testid="rx-edit">Edit</Button>
                <Button onClick={() => setApproveRx(p)} disabled={!p.medication || !p.dose || !p.route || !p.frequency} data-testid="rx-approve"><LuFileCheck aria-hidden /> Approve</Button>
                <Button variant="ghost" onClick={() => saveRx({ ...p, status: 'cancelled', updatedAt: now() }, 'prescription draft cancelled')}>Discard</Button>
              </>}
              {p.status === 'approved' && <>
                <Button busy={busy === `rx:${p.id}`} onClick={() => sendRx(p)} data-testid="rx-send"><LuSend aria-hidden /> Send to patient</Button>
                <Button variant="ghost" onClick={() => saveRx({ ...p, status: 'draft', approvedAt: undefined, approvedBy: undefined, updatedAt: now() }, 'prescription approval withdrawn')}>Withdraw approval and edit</Button>
              </>}
            </div>
          </div>
        ))}
        {review.prescriptions.length === 0 && <p className="small muted">No prescriptions for this consultation.</p>}
        {!rxEdit && <Button variant="secondary" onClick={() => setRxEdit(draftFrom())} data-testid="rx-new"><LuClipboardList aria-hidden /> Write a prescription</Button>}
        {rxEdit && <RxEditor value={rxEdit} onChange={setRxEdit} onCancel={() => setRxEdit(null)} onSave={async () => { await saveRx({ ...rxEdit, updatedAt: now() }, 'prescription draft saved'); setRxEdit(null); }} />}
      </div>

      <h3 className="section">Follow-up after treatment</h3>
      <FollowUpSection consultationId={c.id} messages={messages} prescriptions={review.prescriptions} reloadMessages={reloadMessages} log={logOnly} />

      <h3 className="section">Explain the visit to the patient</h3>
      <VisitSummarySection consultationId={c.id} messages={messages} prescriptions={review.prescriptions} reloadMessages={reloadMessages} log={logOnly} consent={consent} ai={ai.supported ? aiFn : null} />

      {/* evidence and transparency */}
      <h3 className="section">Evidence and references</h3>
      <div className="card flat" style={{ gap: 6 }}>
        {refs.length ? refs.map((id) => REF_BY_ID[id]).filter(Boolean).map((r) => <div key={r.id} className="small"><a href={r.url} target="_blank" rel="noreferrer">{r.publisher}: {r.title}</a> — <span className="muted">{r.covers}</span></div>)
          : <p className="small muted">No reference was cited for this report.</p>}
        <p className="tiny muted" style={{ margin: 0 }}>These are public NHS pages on when to get urgent help (checked October 2026) and FDA drug labels. They are not clinical guidelines, and citing them does not validate this software.</p>
        <ul className="tiny muted" style={{ margin: 0, paddingLeft: 18 }}>{live.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </div>

      <details className="card flat"><summary className="small"><LuHistory aria-hidden /> Audit log ({review.log.length})</summary>
        <ul className="tiny" style={{ paddingLeft: 18 }}>{[...review.log].reverse().map((l, i) => <li key={i}>{fmtDate(l.at)} — {l.action}{l.detail ? `: ${l.detail}` : ''}</li>)}</ul>
      </details>

      {approveRx && <ConfirmSheet title="Approve this prescription?" icon={<LuFileCheck />} confirmLabel="I approve this prescription"
        body={<>You are approving it as the prescribing clinician, {me?.profile.fullName}. It is sent to the patient only when you press “Send to patient”.</>}
        onCancel={() => setApproveRx(null)}
        onConfirm={async () => { const p = approveRx; setApproveRx(null); await saveRx({ ...p, status: 'approved', approvedAt: now(), approvedBy: me?.profile.fullName ?? 'Doctor', updatedAt: now() }, 'prescription approved by doctor'); }}>
        <div className="pre">{approveRx.medication} — {approveRx.dose}, {approveRx.route}, {approveRx.frequency}{approveRx.duration ? `, for ${approveRx.duration}` : ''}{approveRx.instructions ? `\n${approveRx.instructions}` : ''}</div>
      </ConfirmSheet>}
    </div>
  );
}

function DocumentedForm({ value, editing, gaps, messages, onEdit, onCancel, onChange, onSave, onAsk, busy }: {
  value: Documented; editing: boolean; gaps: MissingItem[]; messages: Message[]; onEdit: () => void; onCancel: () => void; onChange: (d: Documented) => void; onSave: () => void; onAsk: (m: MissingItem) => void; busy: string | null;
}) {
  const answers = messages.filter((m) => m.kind === 'clarification_answer' && m.meta?.approvedByPatient && (m.meta.itemKey ?? '').startsWith('clinical:doc:'));
  const show = (d: Documented) => [
    ['Age', d.age ? `${d.age} years` : 'Unknown'], ['Sex', cap(d.sex)], ['Pregnancy', cap(d.pregnancy.replace('_', ' '))],
    ['Allergies', d.allergies.status === 'listed' ? d.allergies.items.join(', ') : d.allergies.status === 'none_known' ? 'No known allergies' : 'Unknown'],
    ['Current medicines', d.medications.status === 'listed' ? d.medications.items.join(', ') : d.medications.status === 'none' ? 'None' : 'Unknown'],
    ['Conditions', d.conditions || 'None documented'], ['Kidney', cap(d.kidney)], ['Liver', cap(d.liver)],
  ];
  if (!editing) return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="tiny strong muted">DOCUMENTED BY YOU (needed before any medication option)</div>
      <div className="report">{show(value).map(([k, v]) => <div className="r" key={k}><dt>{k}</dt><dd>{v}{/unknown/i.test(v) && <span className="tag unanswered">Not documented</span>}</dd></div>)}</div>
      {answers.map((a) => <Banner key={a.id} kind="info"><b>Patient answered ({a.meta?.itemLabel}):</b> “{a.meta?.raw ?? a.body}”. Record it here if you accept it.</Banner>)}
      {gaps.filter((g) => g.status !== 'answered').map((g) => g.status === 'asked'
        ? <p key={g.id} className="tiny muted">Asked the patient about {g.topic.toLowerCase()} — awaiting answer.</p>
        : <Button key={g.id} variant="ghost" busy={busy === `ask:${g.id}`} onClick={() => onAsk(g)} data-testid={`ask-${g.id}`}><LuCircleHelp aria-hidden /> Ask the patient: {g.topic.toLowerCase()}</Button>)}
      <Button variant="secondary" onClick={onEdit} data-testid="doc-edit">Document patient information</Button>
    </div>
  );
  const set = (p: Partial<Documented>) => onChange({ ...value, ...p });
  const sel = (id: string, label: string, v: string, opts: [string, string][], on: (v: string) => void) => (
    <div className="field"><label htmlFor={id}>{label}</label><select id={id} className="input" value={v} onChange={(e) => on(e.target.value)}>{opts.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select></div>
  );
  return (
    <div className="card tinted" style={{ gap: 8 }} data-testid="doc-form">
      <Field id="doc-age" label="Age (years)" value={value.age} onChange={(v) => set({ age: v.replace(/[^0-9]/g, '').slice(0, 3) })} inputMode="numeric" />
      {sel('doc-sex', 'Sex', value.sex, [['unknown', 'Unknown'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']], (v) => set({ sex: v as Documented['sex'] }))}
      {sel('doc-preg', 'Pregnancy', value.pregnancy, [['unknown', 'Unknown'], ['no', 'Not pregnant'], ['yes', 'Pregnant'], ['not_applicable', 'Not applicable']], (v) => set({ pregnancy: v as Documented['pregnancy'] }))}
      {sel('doc-allergy-status', 'Allergies', value.allergies.status, [['unknown', 'Unknown'], ['none_known', 'No known allergies'], ['listed', 'Has allergies (list below)']], (v) => set({ allergies: { ...value.allergies, status: v as Documented['allergies']['status'] } }))}
      {value.allergies.status === 'listed' && <Field id="doc-allergies" label="Allergies (comma-separated)" value={value.allergies.items.join(', ')} onChange={(v) => set({ allergies: { status: 'listed', items: v.split(',').map((x) => x.trimStart()).slice(0, 12) } })} />}
      {sel('doc-med-status', 'Current medicines', value.medications.status, [['unknown', 'Unknown'], ['none', 'None'], ['listed', 'Takes medicines (list below)']], (v) => set({ medications: { ...value.medications, status: v as Documented['medications']['status'] } }))}
      {value.medications.status === 'listed' && <Field id="doc-meds" label="Medicines (comma-separated, generic names)" value={value.medications.items.join(', ')} onChange={(v) => set({ medications: { status: 'listed', items: v.split(',').map((x) => x.trimStart()).slice(0, 20) } })} />}
      <Field id="doc-cond" label="Relevant conditions (optional)" value={value.conditions} onChange={(v) => set({ conditions: v })} maxLength={500} />
      {sel('doc-kidney', 'Kidney function', value.kidney, [['unknown', 'Unknown'], ['normal', 'Normal'], ['impaired', 'Impaired']], (v) => set({ kidney: v as Documented['kidney'] }))}
      {sel('doc-liver', 'Liver function', value.liver, [['unknown', 'Unknown'], ['normal', 'Normal'], ['impaired', 'Impaired']], (v) => set({ liver: v as Documented['liver'] }))}
      <p className="tiny muted">Record only what you know from the patient or their records. “Unknown” keeps medication options withheld.</p>
      <div className="grid2"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button onClick={onSave} data-testid="doc-save">Save</Button></div>
    </div>
  );
}

function MedList({ meds, facts, decisions, onDecide, onUse }: { meds: NonNullable<ClinicalReview['meds']>; facts: CaseFact[]; decisions: Record<string, Decision>; onDecide: (id: string, s: DecisionStatus | null) => void; onUse: (o: MedOption) => void }) {
  return (
    <div className="stack" data-testid="cie-med-list">
      <p className="tiny muted">Requested {fmtDate(meds.generatedAt)} · Source: {meds.source}.</p>
      {meds.status !== 'ok' && <Banner kind={meds.status === 'withheld' ? 'warn' : 'danger'}><b>{meds.status === 'withheld' ? 'No options shown' : 'Options unavailable'}:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{meds.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Banner>}
      {meds.status === 'ok' && meds.reasons.length > 0 && <Banner kind="info"><ul style={{ margin: 0, paddingLeft: 18 }}>{meds.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Banner>}
      {meds.options.map((o) => {
        const l = o.label!;
        return (
          <div key={o.id} className="cie-item" data-testid="cie-med-option" data-generic={o.generic}>
            <div className="row between"><b style={{ textTransform: 'capitalize' }}>{o.generic}</b><span className="prov prov-ai"><LuSparkles aria-hidden /> AI option — requires your approval</span></div>
            <div className="small"><b>Why it might be considered (AI):</b> {o.reason}</div>
            <Evidence ids={o.supporting} facts={facts} />
            {o.checks.length > 0 && <div className="small"><b>Check before prescribing (AI):</b> {o.checks.join('; ')}</div>}
            <div className="cie-label">
              <div className="tiny strong">FDA LABEL (openFDA) · {l.title} · {l.productType} · label date {l.effective.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}</div>
              {l.boxedWarning && <div className="small danger-text"><b>Boxed warning:</b> {l.boxedWarning}</div>}
              {l.allergyMentions.map((m) => <div key={m.term + m.section} className="small danger-text"><b>Label mentions the documented allergy “{m.term}”</b> ({m.section}): {m.excerpt}</div>)}
              {l.interactionMentions.map((m) => <div key={m.term + m.section} className="small warn-text"><b>Label mentions the current medicine “{m.term}”</b> ({m.section}): {m.excerpt}</div>)}
              {l.factorNotes.map((m) => <div key={m.term + m.section} className="small warn-text"><b>Label section relevant to {m.term}</b> ({m.section}): {m.excerpt}</div>)}
              {l.contraindications && <div className="small"><b>Contraindications:</b> {l.contraindications}</div>}
              {l.warnings && <div className="small"><b>Warnings (excerpt):</b> {l.warnings}</div>}
              <a className="small" href={l.url} target="_blank" rel="noreferrer"><LuExternalLink aria-hidden /> Full label on DailyMed (dosing, monitoring, all interactions)</a>
              <div className="tiny muted">Text matches in the label only — not a complete allergy or interaction check. FDA: openFDA must not be relied on for medical decisions.</div>
            </div>
            <DecisionBar id={`med:${o.id}`} decision={decisions[`med:${o.id}`]} onDecide={onDecide} labels={{ accepted: 'Considered' }} />
            <Button variant="secondary" onClick={() => onUse(o)} data-testid={`use-${o.generic}`}><LuClipboardList aria-hidden /> Start a prescription draft with {o.generic}</Button>
          </div>
        );
      })}
    </div>
  );
}

function RxEditor({ value, onChange, onCancel, onSave }: { value: Prescription; onChange: (p: Prescription) => void; onCancel: () => void; onSave: () => void }) {
  const set = (p: Partial<Prescription>) => onChange({ ...value, ...p });
  return (
    <div className="card tinted" style={{ gap: 8 }} data-testid="rx-editor">
      <b>Prescription draft</b>
      <p className="tiny muted" style={{ margin: 0 }}>You write the dose and directions. AccessCare does not suggest doses.</p>
      <Field id="rx-med" label="Medicine" value={value.medication} onChange={(v) => set({ medication: v })} maxLength={120} />
      <Field id="rx-dose" label="Dose / strength" value={value.dose} onChange={(v) => set({ dose: v })} maxLength={120} />
      <Field id="rx-route" label="Route" value={value.route} onChange={(v) => set({ route: v })} maxLength={60} />
      <Field id="rx-freq" label="How often" value={value.frequency} onChange={(v) => set({ frequency: v })} maxLength={120} />
      <Field id="rx-dur" label="For how long" value={value.duration} onChange={(v) => set({ duration: v })} maxLength={120} />
      <Field id="rx-inst" label="Instructions for the patient" multiline value={value.instructions} onChange={(v) => set({ instructions: v })} maxLength={800} />
      <div className="grid2"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button onClick={onSave} disabled={!value.medication.trim()} data-testid="rx-save">Save draft</Button></div>
    </div>
  );
}

/** Highest warning level for a list row (rules only, no AI): used to prioritize the doctor's queue. */
export function urgencyOf(v: ConsultationView): 'emergency' | 'urgent' | null {
  try {
    const a = analyzeRules({ consultation: v.consultation, messages: [], documented: newReview(v.consultation.id).documented });
    return a.warnings.some((w) => w.level === 'emergency') ? 'emergency' : a.warnings.some((w) => w.level === 'urgent') ? 'urgent' : null;
  } catch { return null; }
}
