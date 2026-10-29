// Doctor: alerts from what patients shared, the pre-visit brief, and each
// patient's medicine check-ins and photo timeline.
import { dateLocale, pick } from '../../i18n/lang';
import React, { useEffect, useState } from 'react';
import { LuTriangleAlert, LuSparkles, LuPill, LuImages, LuBellRing, LuChevronRight, LuFileText } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ErrorState, Skeleton } from '../../ui/components';
import { useLang, tr } from '../../i18n/lang';
import type { Backend } from '../../services/backend/Backend';
import type { Message } from '../../domain/types';
import type { DiaryEntry } from '../../domain/diary';
import type { DoseData, PatientRecord, PhotoData } from '../../domain/care';
import { adherence, plansFromMessages, timesFromDoses } from '../../services/care/meds';
import { alertsFor, applyBriefAI, briefPrompt, buildBrief, type Brief, type CareAlert } from '../../services/care/brief';
import { PhotoCompare } from '../care/CareScreens';

interface PatientCare {
  diary: DiaryEntry[]; doses: PatientRecord<DoseData>[]; photos: PatientRecord<PhotoData>[];
  threads: { consultationId: string; messages: Message[] }[]; reports: { id: string; at: string; status: string }[];
}

export async function loadPatientCare(backend: Backend, patientId: string): Promise<PatientCare> {
  const consults = (await backend.listConsultations()).filter((v) => v.patient.id === patientId && v.consultation.status !== 'draft');
  const [diary, doses, photos, threads] = await Promise.all([
    backend.listDiary(patientId).catch(() => [] as DiaryEntry[]),
    backend.listRecords('dose', patientId).catch(() => []) as Promise<PatientRecord<DoseData>[]>,
    backend.listRecords('photo', patientId).catch(() => []) as Promise<PatientRecord<PhotoData>[]>,
    Promise.all(consults.map(async (v) => ({ consultationId: v.consultation.id, messages: await backend.listMessages(v.consultation.id).catch(() => [] as Message[]) }))),
  ]);
  return { diary, doses, photos, threads, reports: consults.map((v) => ({ id: v.consultation.id, at: v.consultation.sharedAt ?? v.consultation.updatedAt, status: v.consultation.status })) };
}

const SEEN = 'accesscare.alerts.seen.v1';
const seen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN) || '[]'); } catch { return []; } };

/** Overview: things that need a look in the last 3 days, from what patients shared. */
export function DoctorAlertsCard() {
  const { backend, nav } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const data = useLoad(async () => {
    const pats = await backend.listMyPatients();
    const all: CareAlert[] = [];
    for (const p of pats) {
      const c = await loadPatientCare(backend, p.profile.id);
      all.push(...alertsFor(p.profile.id, p.profile.fullName, c.diary, c.doses, plansFromMessages(c.threads, new Date(), timesFromDoses(c.doses)), new Date()));
    }
    return all.sort((x, y) => (x.level === y.level ? y.at.localeCompare(x.at) : x.level === 'urgent' ? -1 : 1));
  }, []);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  useEffect(() => {
    if (!data.data?.length) return;
    const keys = data.data.map((a) => `${a.patientId}|${a.kind}|${a.at.slice(0, 16)}`);
    const before = new Set(seen());
    const fresh = data.data.filter((_, i) => !before.has(keys[i]));
    try { localStorage.setItem(SEEN, JSON.stringify([...before, ...keys].slice(-200))); } catch { /* */ }
    if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try { new Notification('AccessCare', { body: `${fresh[0].patientName}: ${fresh[0].en}`, tag: 'accesscare-alerts' }); } catch { /* */ }
    }
  }, [data.data]);
  if (data.loading && !data.data) return <Skeleton rows={1} height={64} />;
  if (data.error) return <ErrorState message={data.error} onRetry={data.reload} />;
  const list = data.data ?? [];
  return (
    <section className={`card ${list.some((a) => a.level === 'urgent') ? 'alert-card' : ''}`} aria-labelledby="al-h" data-testid="doctor-alerts">
      <div className="row between"><h3 className="title" id="al-h" style={{ margin: 0 }}><LuBellRing aria-hidden /> {L('Needs a look', 'محتاج تبص عليه')} {list.length ? <span className="status urgent-chip">{list.length}</span> : null}</h3>
        {perm === 'default' && <button className="linkbtn small" onClick={async () => { try { setPerm(await Notification.requestPermission()); } catch { /* */ } }}>{L('Notify me', 'نبّهني')}</button>}</div>
      {list.length === 0 ? <p className="small muted">{L('No urgent check-ins, side effects or missed doses shared in the last 3 days.', 'مفيش تسجيلات عاجلة أو أعراض جانبية أو جرعات فايتة اتشاركت في آخر ٣ أيام.')}</p> : (
        <div className="list">{list.slice(0, 6).map((a, i) => (
          <button key={i} className="list-item" onClick={() => nav.push({ name: 'd.progressOf', id: a.patientId })} data-testid="alert-row">
            <span className={`li-ico ${a.level === 'urgent' ? 'danger' : 'warn'}`}><LuTriangleAlert /></span>
            <div className="grow"><b data-no-tr>{a.patientName}</b><div className={`small ${a.level === 'urgent' ? 'danger-text' : 'warn-text'}`} data-no-tr>{pick(a, lang)}</div></div>
            <LuChevronRight className="chev" aria-hidden />
          </button>
        ))}</div>
      )}
      <p className="tiny muted">{L('Shown while AccessCare is open; it does not replace your usual urgent-care arrangements.', 'بيظهر وAccessCare مفتوح؛ ومش بديل عن ترتيبات الطوارئ المعتادة.')}</p>
    </section>
  );
}

/** Workspace tab: one page before the visit, every line with its source. */
export function BriefPanel({ patientId, aiAllowed }: { patientId: string; aiAllowed: boolean }) {
  const { backend, ai } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const data = useLoad(async () => {
    const c = await loadPatientCare(backend, patientId);
    return buildBrief({ ...c, plans: plansFromMessages(c.threads, new Date(), timesFromDoses(c.doses)) });
  }, [patientId]);
  const [aiB, setAiB] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = aiB ?? data.data;
  const run = async () => {
    if (!data.data) return;
    setBusy(true); setErr('');
    try { const r = await ai.clinical(briefPrompt(data.data), 900); if ('error' in r) setErr(r.error); else setAiB(applyBriefAI(data.data, r.json)); } finally { setBusy(false); }
  };
  if (data.loading && !data.data) return <Skeleton rows={4} />;
  if (data.error) return <ErrorState message={data.error} onRetry={data.reload} />;
  if (!b) return null;
  const src = (r: string) => b.sources.find((s) => s.ref === r);
  return (
    <div className="stack" data-testid="brief">
      <p className="small muted">{L('Built by fixed rules from what the patient shared. Each line shows its source. Descriptive only — not a diagnosis.', 'متجمّع بقواعد ثابتة من اللي المريض شاركه. كل سطر مكتوب مصدره. وصف بس — مش تشخيص.')}</p>
      {b.sections.length === 0 && <p className="small muted">{L('Nothing shared yet beyond this report.', 'مفيش حاجة متشاركة لسه غير التقرير ده.')}</p>}
      {b.ai && b.ai.lines.length > 0 && (
        <section className="card" data-testid="brief-ai"><h3 className="title"><LuSparkles aria-hidden /> {L('AI summary of these lines', 'ملخص بالذكاء الاصطناعي للسطور دي')}</h3>
          <ul className="small">{b.ai.lines.map((l, i) => <li key={i} data-no-tr>{l.text} <span className="ref-chips">{l.refs.map((r) => <span key={r} className="ref" title={src(r)?.en}>{r}</span>)}</span></li>)}</ul>
          {b.ai.rejected > 0 && <p className="tiny muted">{L(`${b.ai.rejected} AI line(s) removed: no valid source, new numbers, or diagnostic wording.`, `${b.ai.rejected} سطر اتشال: من غير مصدر صحيح أو أرقام جديدة أو كلام تشخيصي.`)}</p>}
        </section>
      )}
      {b.sections.map((s) => (
        <section key={s.key} className={`card brief-sec sec-${s.key}`} data-testid={`brief-${s.key}`}>
          <h3 className="title">{s.key === 'urgent' && <LuTriangleAlert aria-hidden />} {L(s.en, s.ar)}</h3>
          <ul className="small">{s.lines.map((l) => (
            <li key={l.id} className={l.level === 'urgent' ? 'danger-text' : l.level === 'attention' ? 'warn-text' : ''}><span data-no-tr>{pick(l, lang)}</span> <span className="ref-chips">{l.refs.map((r) => <span key={r} className="ref" title={src(r)?.en} data-no-tr>{r}</span>)}</span></li>
          ))}</ul>
        </section>
      ))}
      {b.sources.length > 0 && (
        <details className="card"><summary className="small strong"><LuFileText aria-hidden /> {L('Sources', 'المصادر')}</summary>
          <ul className="tiny">{b.sources.map((s) => <li key={s.ref}><b data-no-tr>{s.ref}</b> <span data-no-tr>{pick(s, lang)}</span></li>)}</ul></details>
      )}
      {b.sections.length > 0 && (aiAllowed
        ? <Button variant="secondary" onClick={run} busy={busy} data-testid="brief-ai-run"><LuSparkles aria-hidden /> {L('Condense with AI', 'لخّص بالذكاء الاصطناعي')}</Button>
        : <p className="tiny muted">{L('The patient did not allow AI for this report, so only the rule-based brief is shown.', 'المريض مسمحش بالذكاء الاصطناعي للتقرير ده، فالملخص بالقواعد بس.')}</p>)}
      {err && <Banner kind="warn">{err}</Banner>}
    </div>
  );
}

/** Progress page: medicine check-ins and the photo timeline the patient shared. */
export function PatientCareSection({ patientId }: { patientId: string }) {
  const { backend } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const data = useLoad(() => loadPatientCare(backend, patientId), [patientId]);
  if (data.loading && !data.data) return <Skeleton rows={2} />;
  if (!data.data) return null;
  const plans = plansFromMessages(data.data.threads, new Date(), timesFromDoses(data.data.doses));
  const adh = adherence(plans, data.data.doses, 7);
  const byArea = new Map<string, PatientRecord<PhotoData>[]>();
  for (const p of data.data.photos) byArea.set(p.data.area || 'Other', [...(byArea.get(p.data.area || 'Other') ?? []), p]);
  return (
    <>
      <section className="card" aria-labelledby="pm-h" data-testid="doctor-adherence">
        <h3 className="title" id="pm-h"><LuPill aria-hidden /> {L('Medicine check-ins (7 days)', 'تسجيلات الأدوية (٧ أيام)')}</h3>
        {!plans.length ? <p className="small muted">{L('No prescriptions sent to this patient yet.', 'مفيش روشتات اتبعتت للمريض ده لسه.')}</p> : !adh.planned ? <p className="small muted">{L('No doses due yet.', 'مفيش جرعات ميعادها جه لسه.')}</p> : (
          <>
            <p className="small"><b>{Math.round((adh.taken / adh.planned) * 100)}%</b> · {L(`${adh.taken} of ${adh.planned} scheduled doses checked in as taken`, `${adh.taken} من ${adh.planned} جرعة متسجلة إنها اتاخدت`)}{adh.missed ? L(`, ${adh.missed} missed`, `، ${adh.missed} فاتت`) : ''}{adh.notChecked ? L(`, ${adh.notChecked} not checked in`, `، ${adh.notChecked} مش متسجلة`) : ''}</p>
            <ul className="small">{adh.perMed.map((m) => <li key={m.name} data-no-tr>{m.name}: {m.taken}/{m.planned}</li>)}</ul>
            {adh.sideEffectNotes.map((n, i) => <p key={i} className="small warn-text" data-no-tr><LuTriangleAlert aria-hidden /> {n.medicine}: “{n.text}”{n.by ? ` — ${n.by}` : ''}</p>)}
            <p className="tiny muted">{L('Counted from what the patient (or their caregiver) checked in and shared; not a measurement of what was taken.', 'محسوبة من اللي المريض (أو المرافق) سجّله وشاركه؛ مش قياس فعلي للي اتاخد.')}</p>
          </>
        )}
      </section>
      {byArea.size > 0 && (
        <section className="card" aria-labelledby="pp-h" data-testid="doctor-photos">
          <h3 className="title" id="pp-h"><LuImages aria-hidden /> {L('Photos', 'الصور')}</h3>
          {[...byArea.entries()].map(([area, rows]) => (
            <div key={area} className="stack">
              <b data-no-tr>{area} · {rows.length}</b>
              {rows.length > 1 ? <PhotoCompare first={rows[rows.length - 1]} last={rows[0]} lang={lang} /> : null}
              <div className="photo-strip">{rows.map((r) => (
                <figure key={r.id} className="photo-thumb"><img src={r.data.image} alt={`${area} ${new Date(r.at).toLocaleDateString()}`} />
                  <figcaption className="tiny"><span data-no-tr>{new Date(r.at).toLocaleDateString(dateLocale(lang), { day: 'numeric', month: 'short' })}</span>{r.data.note && <span className="muted" data-no-tr> · {r.data.note}</span>}</figcaption></figure>
              ))}</div>
            </div>
          ))}
          <p className="tiny muted">{L('Photos taken by the patient for comparison by eye; no AI has assessed them.', 'صور خدها المريض للمقارنة بالعين؛ مفيش ذكاء اصطناعي قيّمها.')}</p>
        </section>
      )}
    </>
  );
}
