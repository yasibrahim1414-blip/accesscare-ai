import React, { useState } from 'react';
import { LuPencil, LuTrash2, LuRotateCcw, LuCircleHelp, LuCheck, LuX, LuHistory, LuSparkles, LuUser, LuCircleDashed, LuStethoscope, LuFileText } from 'react-icons/lu';
import type { BriefSection, ClinicalBrief, Contradiction, Provenance, ReconItem, Reconstruction, VerificationMetrics } from '../../domain/reconstruction';
import { Button, Field, Sheet, fmtDate } from '../../ui/components';
import { correctionOptions, type CaptureInput, correct, remove, restore, markUnsure, acceptSuggestion, rejectSuggestion } from '../../services/intent/ReconstructionEngine';
import { Body3DView } from '../../body/Body3DView';
import { useApp } from '../../app/AppContext';
import { Body2DMap } from '../../body/Body2DMap';

const PROV: Record<Provenance, { label: string; cls: string; icon: React.ReactNode }> = {
  patient: { label: 'Patient', cls: 'prov-patient', icon: <LuUser /> },
  template_wording: { label: 'AccessCare wording', cls: 'prov-template', icon: <LuFileText /> },
  ai_wording: { label: 'AI wording', cls: 'prov-ai', icon: <LuSparkles /> },
  unknown: { label: 'Unknown', cls: 'prov-unknown', icon: <LuCircleDashed /> },
  clinician: { label: 'Clinician', cls: 'prov-clinician', icon: <LuStethoscope /> },
};
export function ProvBadge({ p }: { p: Provenance }) {
  const x = PROV[p];
  return <span className={`prov ${x.cls}`}>{x.icon}{x.label}</span>;
}
export function ProvLegend() {
  return <div className="row wrap" style={{ gap: 6 }} aria-label="Legend">{(['patient', 'template_wording', 'ai_wording', 'unknown'] as Provenance[]).map((p) => <ProvBadge key={p} p={p} />)}</div>;
}

const SOURCE_LABEL: Record<ReconItem['source'], string> = {
  patient_selected: 'Selected by patient', patient_typed: 'Patient’s own words', patient_answer: 'Answered by patient',
  patient_confirmed_suggestion: 'Suggested, confirmed by patient', patient_correction: 'Corrected by patient', none: '—',
};
const STATUS_LABEL: Record<ReconItem['status'], string> = {
  confirmed: 'Confirmed', unanswered: 'Not answered', unsure: 'Unsure', needs_clarification: 'Needs clarification', suggested: 'Suggestion — please check', removed: 'Removed',
};
const STATUS_CLS: Record<ReconItem['status'], string> = {
  confirmed: 'confirmed', unanswered: 'unanswered', unsure: 'unsure', needs_clarification: 'needs_clarification', suggested: 'suggested', removed: 'unanswered',
};
export function ItemStatusTag({ s }: { s: ReconItem['status'] }) { return <span className={`tag ${STATUS_CLS[s]}`}>{STATUS_LABEL[s]}</span>; }

const ACTION_LABEL: Record<string, string> = {
  captured: 'Captured', suggested: 'Suggested', suggestion_accepted: 'Suggestion accepted', suggestion_rejected: 'Suggestion rejected', answered: 'Answered',
  marked_unsure: 'Marked unsure', skipped: 'Skipped', corrected: 'Corrected', removed: 'Removed', restored: 'Restored', clarified: 'Clarified',
};
export function ItemHistory({ item }: { item: ReconItem }) {
  return (
    <div className="timeline">
      {item.history.map((h, i) => (
        <div className="t" key={i}><div className="d" /><div>
          <b>{ACTION_LABEL[h.action] ?? h.action}</b>{h.to ? <> → “{h.to}”</> : null}{h.from && h.action !== 'captured' ? <span className="muted"> (was “{h.from}”)</span> : null}
          <div className="tiny muted">{h.by === 'patient' ? 'Patient' : h.by === 'ai' ? 'AI suggestion' : h.by === 'rules' ? 'AccessCare' : 'Doctor'} · {fmtDate(h.at)}{h.note ? ` · ${h.note}` : ''}</div>
        </div></div>
      ))}
    </div>
  );
}

/** Item-by-item verification: inspect, correct, remove, clarify. */
export function ItemsVerifier({ rec, input, onChange }: { rec: Reconstruction; input: CaptureInput; onChange: (r: Reconstruction) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const it = rec.items.find((i) => i.key === open);
  const groups: [string, (i: ReconItem) => boolean][] = [
    ['Where and what', (i) => i.field === 'region' || i.field === 'sensation' || i.field === 'other_sensation'],
    ['Details', (i) => !['region', 'sensation', 'other_sensation', 'context'].includes(i.field)],
    ['Your words', (i) => i.field === 'context'],
  ];
  return (
    <div className="stack" data-testid="verifier">
      {groups.map(([title, pred]) => {
        const items = rec.items.filter(pred);
        if (!items.length) return null;
        return (
          <div key={title} className="stack" style={{ gap: 8 }}>
            <h3 className="section">{title}</h3>
            <div className="list">
              {items.map((i) => (
                <button key={i.key} className={`list-item recon-item ${i.status}`} onClick={() => setOpen(i.key)} data-testid={`item-${i.key}`}>
                  <div className="grow">
                    <div className="tiny muted strong">{i.label.toUpperCase()}</div>
                    <div className="strong" style={{ textDecoration: i.status === 'removed' ? 'line-through' : undefined, overflowWrap: 'anywhere' }}>
                      {i.status === 'suggested' ? <>“{i.suggestion?.value}”?</> : i.value ?? (i.status === 'unsure' ? 'Not sure' : i.optional ? 'Nothing added' : 'Not specified')}
                    </div>
                    <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                      <ItemStatusTag s={i.status} />
                      {i.value && i.status !== 'removed' && <span className="tiny muted">{SOURCE_LABEL[i.source]}</span>}
                      {i.corrected && <span className="tag corrected">Corrected</span>}
                    </div>
                  </div>
                  <LuPencil className="chev" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {it && <ItemSheet item={it} onClose={() => setOpen(null)} apply={(r) => { onChange(r(rec, input)); setOpen(null); }} />}
    </div>
  );
}

function ItemSheet({ item, onClose, apply }: { item: ReconItem; onClose: () => void; apply: (fn: (r: Reconstruction, i: CaptureInput) => Reconstruction) => void }) {
  const [mode, setMode] = useState<'menu' | 'change' | 'history'>('menu');
  const [text, setText] = useState(item.value ?? '');
  const choices = correctionOptions(item.field);
  const k = item.key;
  return (
    <Sheet title={item.label} onClose={onClose} icon={<LuPencil />}>
      <div className="card tinted" style={{ gap: 6 }}>
        <div className="strong">{item.status === 'suggested' ? `Suggested: “${item.suggestion?.value}”` : item.value ?? 'Not specified'}</div>
        {item.suggestion && <div className="small muted">From your words “{item.suggestion.quote}” · suggested by {item.suggestion.by === 'ai' ? 'AI' : 'AccessCare'}. It only counts if you confirm it.</div>}
        <div className="row wrap" style={{ gap: 6 }}><ItemStatusTag s={item.status} />{item.value && <span className="tiny muted">{SOURCE_LABEL[item.source]}</span>}</div>
      </div>
      {mode === 'menu' && (
        <div className="stack">
          {item.status === 'suggested' && <>
            <Button big block onClick={() => apply((r, i) => acceptSuggestion(r, k, i))}><LuCheck aria-hidden /> Yes, that’s right</Button>
            <Button variant="secondary" block onClick={() => apply((r, i) => rejectSuggestion(r, k, i))}><LuX aria-hidden /> No, that’s not what I meant</Button>
          </>}
          {item.status !== 'removed' && <Button variant="secondary" block onClick={() => setMode('change')} data-testid="change-item"><LuPencil aria-hidden /> {item.value ? 'Change it' : 'Add it'}</Button>}
          {item.status !== 'removed' && item.status !== 'unsure' && item.field !== 'context' && <Button variant="secondary" block onClick={() => apply((r, i) => markUnsure(r, k, i))}><LuCircleHelp aria-hidden /> I’m not sure</Button>}
          {item.status !== 'removed' && (item.value || item.field === 'region') && <Button variant="danger-outline" block onClick={() => apply((r, i) => remove(r, k, i))} data-testid="remove-item"><LuTrash2 aria-hidden /> Remove this</Button>}
          {item.status === 'removed' && <Button block onClick={() => apply((r, i) => restore(r, k, i))}><LuRotateCcw aria-hidden /> Put it back</Button>}
          <Button variant="ghost" block onClick={() => setMode('history')}><LuHistory aria-hidden /> What changed ({item.history.length})</Button>
        </div>
      )}
      {mode === 'change' && (
        <div className="stack">
          {choices.length > 0 && (
            <div className="choice-grid" role="group" aria-label="Choose the right value">
              {choices.map((c) => <button key={c} className="choice" aria-pressed={item.value === c} onClick={() => apply((r, i) => correct(r, k, c, i))}>{c}</button>)}
            </div>
          )}
          {(choices.length === 0 || item.field === 'onset' || item.field === 'associated') && <>
            <Field id="correct-text" label={choices.length ? 'Or say it in your own words' : 'Your words'} value={text} onChange={setText} multiline={item.field === 'context'} maxLength={300} />
            <Button block disabled={!text.trim()} onClick={() => apply((r, i) => correct(r, k, text, i))} data-testid="save-correction">Save</Button>
          </>}
          <Button variant="ghost" onClick={() => setMode('menu')}>Back</Button>
        </div>
      )}
      {mode === 'history' && <><ItemHistory item={item} /><Button variant="ghost" onClick={() => setMode('menu')}>Back</Button></>}
    </Sheet>
  );
}

export function ContradictionList({ list }: { list: Contradiction[] }) {
  if (!list.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {list.map((c) => (
        <div key={c.id} className={`banner ${c.status === 'clarified' ? 'ok' : 'warn'}`}>
          {c.status === 'clarified' ? <LuCheck aria-hidden /> : <LuCircleHelp aria-hidden />}
          <div className="grow"><b>{c.status === 'clarified' ? 'Clarified' : c.status === 'unresolved' ? 'Left unresolved' : 'Possible mismatch'}:</b> {c.description}{c.resolution ? <> → {c.resolution}</> : null}</div>
        </div>
      ))}
    </div>
  );
}

export function MetricsCard({ m, title = 'Verification record' }: { m: VerificationMetrics; title?: string }) {
  const rows: [string, number][] = [
    ['Captured at first', m.initiallyCaptured], ['Missing at first', m.missingAtStart], ['Missing → resolved', m.missingResolved],
    ['Still missing', m.stillMissing], ['Corrected by patient', m.correctedByPatient], ['Removed by patient', m.removedByPatient],
    ['Suggestions offered', m.suggestionsOffered], ['Suggestions accepted', m.suggestionsAccepted], ['Suggestions rejected', m.suggestionsRejected],
    ['Mismatches found', m.contradictionsDetected], ['Mismatches clarified', m.contradictionsClarified], ['Confirmed in final report', m.finalConfirmed],
  ];
  return (
    <div className="card" data-testid="metrics">
      <b>{title}</b>
      <div className="metric-grid">{rows.map(([l, n]) => <div key={l} className="metric"><b className="num">{n}</b><span>{l}</span></div>)}</div>
      <p className="tiny muted">Counts for this report only. They describe what happened during verification; they are not accuracy statistics.</p>
    </div>
  );
}

export function BriefView({ brief, addenda }: { brief: ClinicalBrief; addenda?: { label: string; text: string; at: string }[] }) {
  return (
    <div className="stack" data-testid="brief">
      <ProvLegend />
      <div className="brief">
        {brief.sections.map((s: BriefSection) => (
          <div key={s.id} className="bs">
            <div className="bs-h"><span className="bs-n">{s.id}</span>{s.title}</div>
            <div className="stack" style={{ gap: 4 }}>
              {s.lines.map((l, i) => <div key={i} className="bs-l"><span style={{ overflowWrap: 'anywhere' }}>{l.text}</span><ProvBadge p={l.provenance} /></div>)}
            </div>
          </div>
        ))}
        {addenda && addenda.length > 0 && (
          <div className="bs">
            <div className="bs-h"><span className="bs-n">+</span>Clarified after sharing</div>
            {addenda.map((a, i) => <div key={i} className="bs-l"><span><b>{a.label}:</b> {a.text} <span className="tiny muted">· {fmtDate(a.at)}</span></span><ProvBadge p="patient" /></div>)}
          </div>
        )}
      </div>
      <p className="tiny muted">Main-concern wording: {brief.wordedBy === 'ai' ? 'AI (Claude), checked so that it adds nothing the patient did not confirm' : 'AccessCare template'}. This is the patient’s report, not a diagnosis.</p>
    </div>
  );
}

/** Focused 3D view of the patient's report: the region plus what was said about it. */
export function Reconstruction3D({ rec, height = 300 }: { rec: Reconstruction; height?: number }) {
  const { prefs, force2D } = useApp();
  const [failed, setFailed] = useState(false);
  const regions = rec.items.filter((i) => i.field === 'region' && i.status !== 'removed').map((i) => i.key.slice(7));
  const [focus, setFocus] = useState(regions[0] ?? null);
  const sens = rec.items.filter((i) => (i.field === 'sensation' || i.field === 'other_sensation') && i.status !== 'removed' && i.value).map((i) => i.value!);
  const detail = rec.items.filter((i) => ['onset', 'pattern', 'severity', 'extent', 'associated'].includes(i.field) && i.status === 'confirmed').map((i) => `${i.label}: ${i.value}`);
  const missing = rec.items.filter((i) => !i.optional && ['unanswered', 'unsure', 'suggested', 'needs_clarification'].includes(i.status)).map((i) => i.label);
  const corrected = rec.items.filter((i) => i.corrected || i.status === 'removed').map((i) => i.label);
  return (
    <div className="recon3d" data-testid="recon3d">
      {force2D || failed
        ? <Body2DMap selected={regions} readOnly focus={focus} />
        : <Body3DView selected={regions} readOnly focus={focus} reducedMotion={prefs.reducedMotion} onUnavailable={() => setFailed(true)} height={height} />}
      {regions.length > 1 && (
        <div className="row wrap" style={{ gap: 6 }}>{regions.map((r) => <button key={r} className="chip teal" aria-pressed={focus === r} onClick={() => setFocus(r)}>{rec.items.find((i) => i.key === `region:${r}`)?.value}</button>)}</div>
      )}
      <div className="recon-facts">
        <div><span className="tiny muted strong">Feels like</span><div>{sens.join(', ') || 'Not named'}</div></div>
        <div><span className="tiny muted strong">Details given</span><div>{detail.join(' · ') || 'None yet'}</div></div>
        <div><span className="tiny muted strong">Missing or unconfirmed</span><div>{missing.join(', ') || 'Nothing'}</div></div>
        {corrected.length > 0 && <div><span className="tiny muted strong">Corrected</span><div>{corrected.join(', ')}</div></div>}
      </div>
      <p className="tiny muted">This shows what you reported. It is not a diagnosis.</p>
    </div>
  );
}
