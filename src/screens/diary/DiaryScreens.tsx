// Symptom diary (patient) and "What changed?" (doctor).
import React, { useMemo, useRef, useState } from 'react';
import { LuMic, LuMicOff, LuTrash2, LuSparkles, LuChevronRight, LuNotebookPen, LuTrendingUp, LuPlus, LuX, LuVolume2 } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Empty, ErrorState, LargeBar, Skeleton, TopBar, initials, speak, ttsSupported } from '../../ui/components';
import { EmergencyContent } from '../shared/Emergency';
import { PatientCareSection } from '../doctor/CareDoctor';
import { useLang, tr, type Lang } from '../../i18n/lang';
import { Listener, sttSupported, ERROR_TEXT } from '../../services/voice/Speech';
import { AIStatus } from '../shared/AIStatus';
import { readDiary, type DiaryReading } from '../../services/diary/understand';
import { whatChanged, summarizeChanges, seriesOf, type ChangeSummary } from '../../services/diary/changes';
import { CONCEPT_BY_ID } from '../../services/conversation/lexicon';
import { sameDay, type DiaryEntry, type DiaryItem, type Trend } from '../../domain/diary';

const TREND_LABEL: Record<Trend, { en: string; ar: string }> = { better: { en: 'Better', ar: 'أحسن' }, same: { en: 'The same', ar: 'زي ما هو' }, worse: { en: 'Worse', ar: 'أسوأ' } };
const PROV_LABEL: Record<DiaryItem['prov'], { en: string; ar: string; cls: string }> = {
  said: { en: 'Your words', ar: 'بكلامك', cls: 'prov-patient' },
  chosen: { en: 'You chose', ar: 'اخترته', cls: 'prov-template' },
  interpretation: { en: 'Understood from your words — check it', ar: 'مفهوم من كلامك — راجعه', cls: 'prov-ai' },
};
const QUICK = ['headache', 'pain', 'dizziness', 'nausea', 'fever', 'fatigue', 'cough', 'breathing', 'abdominal_pain', 'back_pain', 'numbness', 'rash'];
const fmtDay = (iso: string, lang: Lang) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso: string, lang: Lang) => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: 'numeric', minute: '2-digit' });
const label = (i: { en: string; ar: string }, lang: Lang) => (lang === 'ar' ? i.ar : i.en);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Line chart of strength (0–10) over time, one line per symptom. Readable as a table too. */
export function SeverityChart({ entries, lang }: { entries: DiaryEntry[]; lang: Lang }) {
  const series = seriesOf(entries).slice(0, 4);
  if (!series.length) return null;
  const all = series.flatMap((s) => s.points.map((p) => new Date(p.at).getTime()));
  const t0 = Math.min(...all), t1 = Math.max(...all, t0 + 86400_000);
  const W = 320, H = 150, L = 26, R = 10, T = 10, B = 24;
  const x = (iso: string) => L + ((new Date(iso).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / 10) * (H - T - B);
  const colors = ['var(--teal)', '#B54708', '#6941C6', '#C11574'];
  const dash = ['', '6 4', '2 4', '10 3 2 3'];
  const desc = series.map((s) => `${label(s, lang)}: ${s.points.map((p) => `${fmtDay(p.at, lang)} ${p.v}`).join(', ')}`).join('. ');
  return (
    <figure className="card chart" style={{ margin: 0 }} data-testid="diary-chart">
      <figcaption className="strong small">{tr('Strength over time (0–10)', 'الشدة مع الوقت (٠–١٠)', lang)}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={desc} style={{ width: '100%', height: 'auto', direction: 'ltr' }}>
        {[0, 5, 10].map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{v}</text></g>)}
        <text x={L} y={H - 6} fontSize="10" fill="var(--muted)">{fmtDay(new Date(t0).toISOString(), lang)}</text>
        <text x={W - R} y={H - 6} fontSize="10" fill="var(--muted)" textAnchor="end">{fmtDay(new Date(t1).toISOString(), lang)}</text>
        {series.map((s, k) => (
          <g key={s.key}>
            <polyline fill="none" stroke={colors[k]} strokeWidth="2.5" strokeDasharray={dash[k]} points={s.points.map((p) => `${x(p.at)},${y(p.v)}`).join(' ')} />
            {s.points.map((p, i) => <circle key={i} cx={x(p.at)} cy={y(p.v)} r="3.5" fill={colors[k]} />)}
          </g>
        ))}
      </svg>
      <div className="row wrap small" style={{ gap: 12 }} data-no-tr>
        {series.map((s, k) => <span key={s.key} className="row" style={{ gap: 6 }}><svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={colors[k]} strokeWidth="2.5" strokeDasharray={dash[k]} /></svg>{cap(label(s, lang))}</span>)}
      </div>
      <details className="small"><summary>{tr('Show as a table', 'اعرضها كجدول', lang)}</summary>
        <table className="mini-table" data-no-tr><tbody>{series.flatMap((s) => s.points.map((p, i) => <tr key={s.key + i}><td>{cap(label(s, lang))}</td><td>{fmtDay(p.at, lang)}</td><td>{p.v}/10</td></tr>))}</tbody></table>
      </details>
    </figure>
  );
}

function EntryCard({ e, lang, refId, onDelete }: { e: DiaryEntry; lang: Lang; refId?: string; onDelete?: () => void }) {
  return (
    <article className="card diary-entry" data-testid="diary-entry">
      <div className="row between">
        <b className="small">{refId && <span className="ref-chip">{refId}</span>} {fmtDay(e.at, lang)} · {fmtTime(e.at, lang)}</b>
        <div className="row" style={{ gap: 6 }}>
          {e.feeling && <span className={`status ${e.feeling === 'worse' ? 'urgent-chip' : e.feeling === 'better' ? 'completed' : 'draft'}`}>{label(TREND_LABEL[e.feeling], lang)}</span>}
          {onDelete && <button className="iconbtn" onClick={onDelete} aria-label={tr('Delete this entry', 'امسح التسجيل ده', lang)}><LuTrash2 /></button>}
        </div>
      </div>
      {e.items.length > 0 && <ul className="diary-items" data-no-tr>{e.items.map((i, k) => (
        <li key={k}><b>{cap(label(i, lang))}</b>{i.severity !== null && <span> · {i.severity}/10</span>}{i.trend && <span> · {label(TREND_LABEL[i.trend], lang)}</span>}</li>
      ))}</ul>}
      {e.medicine && <p className="small muted">{tr('Medicine', 'الدوا', lang)}: {e.medicine === 'yes' ? tr('taken', 'اتاخد', lang) : e.medicine === 'some' ? tr('some doses missed', 'فاتت جرعات', lang) : tr('not taken', 'ماتخدش', lang)}</p>}
      {e.text && <p className="small" data-no-tr>“{e.text}”</p>}
      {e.by && <p className="small" data-testid="entry-by"><span className="status ok-chip">{tr('Added by caregiver', 'أضافه المرافق', lang)}</span> <span data-no-tr>{e.by}</span></p>}
      <p className="tiny muted">{e.sharedWith ? tr('Shared with your doctor', 'متشارك مع دكتورك', lang) : tr('Only you can see this', 'إنت بس اللي شايفه', lang)}{e.ai ? ` · ${tr('AI helped understand it', 'الذكاء الاصطناعي ساعد في فهمه', lang)}` : ''}{e.urgent.length ? ` · ${tr('Urgent-help guidance was shown', 'ظهرت إرشادات الطوارئ', lang)}` : ''}</p>
    </article>
  );
}

// ---------------------------------------------------------------- patient: My diary
export function PatientDiary() {
  const { backend, ai, prefs, me, toast } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const list = useLoad(() => backend.listDiary(), []);
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const [text, setText] = useState('');
  const [via, setVia] = useState<'text' | 'voice' | 'touch'>('text');
  const [feeling, setFeeling] = useState<Trend | null>(null);
  const [reading, setReading] = useState<DiaryReading | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(true);
  const [listening, setListening] = useState(false);
  const [micErr, setMicErr] = useState('');
  const listener = useMemo(() => new Listener(({ listening: l }) => setListening(l)), []);
  const aiOn = ai.state(prefs.aiAssist) === 'available';
  const entries = list.data ?? [];
  const doneToday = entries.some((e) => sameDay(e.at));
  const formRef = useRef<HTMLHeadingElement>(null);

  const listen = async () => {
    setMicErr('');
    if (listening) { listener.stop(); return; }
    const r = await listener.listen(lang, 12000);
    if ('error' in r) { if (r.error !== 'aborted') setMicErr(ERROR_TEXT[r.error][lang === 'ar' ? 'ar' : 'en']); return; }
    setText((t) => (t ? `${t} ${r.text}` : r.text)); setVia('voice');
  };

  const understandIt = async () => {
    setBusy(true);
    try {
      const r = await readDiary(text, lang, aiOn ? (p) => ai.converse(p) : null);
      setReading({ ...r, feeling: r.feeling ?? feeling });
      setShare(true);
      window.setTimeout(() => formRef.current?.focus(), 50);
    } finally { setBusy(false); }
  };
  const setItem = (k: number, patch: Partial<DiaryItem>) => setReading((r) => r && { ...r, items: r.items.map((i, j) => (j === k ? { ...i, ...patch } : i)) });
  const addConcept = (id: string) => {
    const c = CONCEPT_BY_ID[id]; if (!c || !reading) return;
    if (reading.items.some((i) => i.concept === id)) return;
    setReading({ ...reading, items: [...reading.items, { concept: id, en: c.en, ar: c.ar, severity: null, trend: null, quote: '', prov: 'chosen' }] });
  };
  const save = async () => {
    if (!reading) return;
    setBusy(true);
    try {
      await backend.addDiaryEntry({ text: text.trim(), via: text.trim() ? via : 'touch', feeling: reading.feeling, items: reading.items, medicine: reading.medicine, urgent: reading.urgent, ai: reading.ai, aiAllowed: !!me?.preferences.aiAssist, share: !!doctor.data && share });
      toast(L('Saved to your diary', 'اتحفظ في يومياتك'));
      setText(''); setFeeling(null); setReading(null); setVia('text'); list.reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const del = async (id: string) => { await backend.deleteDiaryEntry(id); list.reload(); };
  const readBack = () => {
    if (!reading) return;
    const parts = reading.items.map((i) => `${label(i, lang)}${i.severity !== null ? `, ${i.severity} ${L('out of 10', 'من عشرة')}` : ''}${i.trend ? `, ${label(TREND_LABEL[i.trend], lang)}` : ''}`);
    speak([reading.feeling ? `${L('Overall', 'عمومًا')}: ${label(TREND_LABEL[reading.feeling], lang)}.` : '', ...parts].filter(Boolean).join('. '));
  };

  return (
    <>
      <LargeBar eyebrow={L('Symptom diary', 'يوميات الأعراض')} title={L('My diary', 'يومياتي')} />
      <div className="screen screen-in"><div className="pad">
        {!reading ? (
          <section className="card raised" aria-labelledby="dq">
            <h2 className="title" id="dq">{doneToday ? L('Anything new since your last check-in?', 'في جديد من آخر تسجيل؟') : L('How are you today?', 'عامل إيه النهارده؟')}</h2>
            <p className="small muted">{L('Say or type it in your own words — for example “my headache is better, about 4, but I feel dizzy”. You check everything before it is saved.', 'قولها أو اكتبها بكلامك — مثلًا "الصداع خف، حوالي ٤، بس عندي دوخة". هتراجع كل حاجة قبل ما تتحفظ.')}</p>
            <div className="seg" role="group" aria-label={L('Compared with yesterday', 'مقارنة بامبارح')}>
              {(['better', 'same', 'worse'] as Trend[]).map((t) => <button key={t} aria-pressed={feeling === t} onClick={() => setFeeling(feeling === t ? null : t)} data-testid={`diary-feel-${t}`}>{label(TREND_LABEL[t], lang)}</button>)}
            </div>
            <label htmlFor="diary-text" className="strong small">{L('In your words', 'بكلامك')}</label>
            <textarea id="diary-text" className="input" dir="auto" value={text} onChange={(e) => { setText(e.target.value); if (via !== 'voice') setVia('text'); }} data-testid="diary-text" maxLength={600} />
            <div className="row wrap">
              {sttSupported() && <Button variant="secondary" onClick={listen} aria-pressed={listening} data-testid="diary-mic">{listening ? <><LuMicOff aria-hidden /> {L('Stop', 'وقف')}</> : <><LuMic aria-hidden /> {L('Say it', 'قولها')}</>}</Button>}
              <Button className="grow" onClick={understandIt} busy={busy} disabled={!text.trim() && !feeling} data-testid="diary-next">{L('Check what I said', 'راجع اللي قلته')}</Button>
            </div>
            {micErr && <p className="small danger-text" role="alert">{micErr}</p>}
            <AIStatus on={L('Claude AI helps understand your words; AccessCare checks them and you confirm.', 'ذكاء Claude بيساعد يفهم كلامك؛ وأكسس كير بيراجعه وإنت بتأكد.')} />
          </section>
        ) : (
          <section className="card raised" aria-labelledby="dr">
            <h2 className="title" id="dr" tabIndex={-1} ref={formRef}>{L('Is this right?', 'كده صح؟')}</h2>
            {reading.urgent.length > 0 && <EmergencyContent reasons={reading.urgent} />}
            {text && <p className="small" data-no-tr>“{text}”</p>}
            <div className="stack">
              <span className="strong small">{L('Overall, compared with before', 'عمومًا، مقارنة بقبل كده')}</span>
              <div className="seg" role="group">{(['better', 'same', 'worse'] as Trend[]).map((t) => <button key={t} aria-pressed={reading.feeling === t} onClick={() => setReading({ ...reading, feeling: reading.feeling === t ? null : t })}>{label(TREND_LABEL[t], lang)}</button>)}</div>
            </div>
            {reading.items.length === 0 && <p className="small muted">{L('No symptom was recognized. Add one below if you want.', 'متعرفتش على أعراض. ضيف واحد تحت لو حابب.')}</p>}
            {reading.items.map((i, k) => (
              <div key={k} className="diary-edit" data-testid="diary-item">
                <div className="row between">
                  <b data-no-tr>{cap(label(i, lang))}</b>
                  <button className="iconbtn" onClick={() => setReading({ ...reading, items: reading.items.filter((_, j) => j !== k) })} aria-label={L(`Remove ${i.en}`, `امسح ${i.ar}`)}><LuX /></button>
                </div>
                <span className={`prov ${PROV_LABEL[i.prov].cls}`}>{label(PROV_LABEL[i.prov], lang)}{i.quote && i.prov !== 'chosen' ? <span data-no-tr>: “{i.quote}”</span> : null}</span>
                <label className="row small" style={{ gap: 8 }}>{L('Strength', 'الشدة')}
                  <select className="input" style={{ maxWidth: 140, minHeight: 44 }} value={i.severity ?? ''} onChange={(e) => setItem(k, { severity: e.target.value === '' ? null : Number(e.target.value) })} data-testid="diary-sev">
                    <option value="">{L('Not said', 'متقالش')}</option>
                    {Array.from({ length: 11 }, (_, v) => <option key={v} value={v}>{v}/10</option>)}
                  </select>
                </label>
                <div className="seg" role="group" aria-label={L(`${i.en}: compared with before`, `${i.ar}: مقارنة بقبل كده`)}>
                  {(['better', 'same', 'worse'] as Trend[]).map((t) => <button key={t} aria-pressed={i.trend === t} onClick={() => setItem(k, { trend: i.trend === t ? null : t })}>{label(TREND_LABEL[t], lang)}</button>)}
                </div>
              </div>
            ))}
            <details><summary className="small strong">{L('Add a symptom', 'ضيف عرض')}</summary>
              <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>{QUICK.filter((id) => !reading.items.some((i) => i.concept === id)).map((id) => <button key={id} className="chip" onClick={() => addConcept(id)}><LuPlus aria-hidden /> {cap(label(CONCEPT_BY_ID[id], lang))}</button>)}</div>
            </details>
            <label className="row small" style={{ gap: 8 }}>{L('My medicine', 'الدوا بتاعي')}
              <select className="input" style={{ maxWidth: 200, minHeight: 44 }} value={reading.medicine ?? ''} onChange={(e) => setReading({ ...reading, medicine: (e.target.value || null) as DiaryReading['medicine'] })}>
                <option value="">{L('Not said', 'متقالش')}</option><option value="yes">{L('Taken', 'خدته')}</option><option value="some">{L('Missed some doses', 'فاتتني جرعات')}</option><option value="no">{L('Not taken', 'ماخدتهوش')}</option>
              </select>
            </label>
            {doctor.data ? (
              <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} data-testid="diary-share" />
                <span>{L('Share this entry with', 'شارك التسجيل ده مع')} <span data-no-tr>{doctor.data.fullName}</span></span></label>
            ) : <p className="tiny muted">{L('Not connected to a doctor: saved for you only.', 'مش مربوط بدكتور: هيتحفظ ليك بس.')}</p>}
            <div className="row wrap">
              {ttsSupported() && <Button variant="secondary" onClick={readBack}><LuVolume2 aria-hidden /> {L('Read it to me', 'اقراهولي')}</Button>}
              <Button variant="secondary" onClick={() => setReading(null)}>{L('Change my words', 'غيّر كلامي')}</Button>
              <Button className="grow" onClick={save} busy={busy} disabled={!reading.items.length && !reading.feeling && !text.trim()} data-testid="diary-save">{L('Save to my diary', 'احفظ في يومياتي')}</Button>
            </div>
          </section>
        )}

        {list.loading && !list.data ? <Skeleton rows={2} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : entries.length ? (
          <>
            <SeverityChart entries={entries} lang={lang} />
            <h3 className="section">{L('Recent check-ins', 'آخر التسجيلات')}</h3>
            <div className="stack">{entries.slice(0, 20).map((e) => <EntryCard key={e.id} e={e} lang={lang} onDelete={() => void del(e.id)} />)}</div>
          </>
        ) : <Empty icon={<LuNotebookPen />} title={L('No check-ins yet', 'مفيش تسجيلات لسه')}>{L('A short note each day helps your doctor see how things change.', 'ملاحظة صغيرة كل يوم بتساعد دكتورك يشوف الحالة بتتغير إزاي.')}</Empty>}
      </div></div>
    </>
  );
}

/** Small card on the patient home: today's check-in. */
export function DiaryHomeCard() {
  const { backend, nav } = useApp();
  const lang = useLang();
  const list = useLoad(() => backend.listDiary(), []);
  if (!list.data) return null;
  const today = list.data.some((e) => sameDay(e.at));
  return (
    <button className="card button" onClick={() => nav.reset({ name: 'p.diary' })} data-testid="home-diary">
      <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--saffron-soft)', color: 'var(--on-saffron)' }}><LuNotebookPen /></span>
        <div className="grow"><b>{today ? tr('Today’s check-in is done', 'سجّلت النهارده', lang) : tr('Today’s check-in', 'تسجيل النهارده', lang)}</b><div className="small muted">{today ? tr('See how things changed this week', 'شوف حالتك اتغيرت إزاي الأسبوع ده', lang) : tr('30 seconds: how are you today?', '٣٠ ثانية: عامل إيه النهارده؟', lang)}</div></div><LuChevronRight aria-hidden /></div>
    </button>
  );
}

// ---------------------------------------------------------------- doctor: Progress
export function DoctorProgress() {
  const { backend, nav } = useApp();
  const lang = useLang();
  const data = useLoad(async () => {
    const pats = await backend.listMyPatients();
    const consults = await backend.listConsultations();
    return Promise.all(pats.map(async (p) => {
      const entries = await backend.listDiary(p.profile.id).catch(() => []);
      const reports = consults.filter((v) => v.patient.id === p.profile.id && v.consultation.status !== 'draft').map((v) => ({ id: v.consultation.id, at: v.consultation.sharedAt ?? v.consultation.updatedAt, status: v.consultation.status }));
      const s = whatChanged(entries, reports);
      return { p, entries, s };
    }));
  }, []);
  const rows = [...(data.data ?? [])].sort((a, b) => score(b.s) - score(a.s) || (b.entries[0]?.at ?? '').localeCompare(a.entries[0]?.at ?? ''));
  return (
    <>
      <LargeBar eyebrow={tr('Patient check-ins', 'تسجيلات المرضى', lang)} title={tr('Progress', 'التطور', lang)} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{tr('What changed in each patient’s daily check-ins, from the entries they chose to share. Patients needing attention come first. Descriptive only — not a diagnosis.', 'إيه اللي اتغير في تسجيلات كل مريض اليومية، من اللي اختار يشاركه. المحتاجين اهتمام الأول. وصف بس — مش تشخيص.', lang)}</p>
        {data.loading && !data.data ? <Skeleton rows={3} /> : data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : rows.length ? (
          <div className="list">{rows.map(({ p, entries, s }) => {
            const top = s.lines[0];
            return (
              <button key={p.profile.id} className="list-item" onClick={() => nav.push({ name: 'd.progressOf', id: p.profile.id })} data-testid="progress-row">
                <div className="avatar" data-no-tr>{initials(p.profile.fullName)}</div>
                <div className="grow">
                  <b data-no-tr>{p.profile.fullName}</b>
                  <div className="small muted">{entries.length ? `${entries.length} ${tr('check-ins', 'تسجيل', lang)} · ${tr('last', 'آخر واحد', lang)} ${fmtDay(entries[0].at, lang)}` : tr('No shared check-ins yet', 'مفيش تسجيلات متشاركة لسه', lang)}</div>
                  {top && <div className={`small ${top.level === 'urgent' ? 'danger-text' : top.level === 'attention' ? 'warn-text' : 'muted'}`} data-no-tr>{lang === 'ar' ? top.ar : top.en}</div>}
                </div>
                {score(s) > 0 && <span className={`status ${score(s) >= 100 ? 'urgent-chip' : 'warn-chip'}`}>{score(s) >= 100 ? tr('Urgent', 'طارئ', lang) : tr('Attention', 'انتبه', lang)}</span>}
                <LuChevronRight className="chev" aria-hidden />
              </button>
            );
          })}</div>
        ) : <Empty icon={<LuTrendingUp />} title={tr('No connected patients yet', 'مفيش مرضى مربوطين لسه', lang)}>{tr('When patients share their daily check-ins, their progress appears here.', 'لما المرضى يشاركوا تسجيلاتهم اليومية، تطورهم هيظهر هنا.', lang)}</Empty>}
      </div></div>
    </>
  );
}
const score = (s: ChangeSummary) => s.lines.reduce((n, l) => n + (l.level === 'urgent' ? 100 : l.level === 'attention' ? 10 : 0), 0);

export function DoctorPatientProgress({ id }: { id: string }) {
  const { backend, ai } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const data = useLoad(async () => {
    const [entries, consults, pats] = await Promise.all([backend.listDiary(id), backend.listConsultations(), backend.listMyPatients()]);
    const reports = consults.filter((v) => v.patient.id === id && v.consultation.status !== 'draft').map((v) => ({ id: v.consultation.id, at: v.consultation.sharedAt ?? v.consultation.updatedAt, status: v.consultation.status }));
    return { entries, s: whatChanged(entries, reports), name: pats.find((p) => p.profile.id === id)?.profile.fullName ?? '' };
  }, [id]);
  const [aiRes, setAiRes] = useState<ChangeSummary | null>(null);
  const [aiErr, setAiErr] = useState('');
  const [busy, setBusy] = useState(false);
  const s = aiRes ?? data.data?.s;
  const runAI = async () => {
    if (!data.data) return;
    setBusy(true); setAiErr('');
    try {
      const r = await summarizeChanges(data.data.s, (p, n) => ai.clinical(p, n));
      if ('error' in r) setAiErr(r.error); else setAiRes(r);
    } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar title={data.data?.name || L('Progress', 'التطور')} />
      <div className="screen screen-in"><div className="pad">
        {data.loading && !data.data ? <Skeleton rows={4} /> : data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : s && data.data ? (
          <>
            <h2 className="title">{L('What changed?', 'إيه اللي اتغير؟')}</h2>
            <p className="small muted">{L('From the check-ins this patient approved and shared (D1 = oldest) and their shared reports (C1…). Every line shows where it comes from. Descriptive only — not a diagnosis.', 'من التسجيلات اللي المريض وافق عليها وشاركها (D1 = الأقدم) وتقاريره المتشاركة (C1…). كل سطر موضح مصدره. وصف بس — مش تشخيص.')}</p>
            {s.lines.length ? (
              <ul className="change-list" data-testid="changes">{s.lines.map((l) => (
                <li key={l.id} className={`change ${l.level}`}>
                  <span data-no-tr>{lang === 'ar' ? l.ar : l.en}</span>
                  <span className="refs">{l.refs.map((r) => <span key={r} className="ref-chip">{r}</span>)}</span>
                </li>
              ))}</ul>
            ) : <Banner kind="info">{L('Not enough check-ins yet to compare.', 'مفيش تسجيلات كفاية للمقارنة لسه.')}</Banner>}

            <section className="card" aria-labelledby="ai-h">
              <div className="row between"><b id="ai-h"><LuSparkles aria-hidden /> {L('Short summary (AI)', 'ملخص قصير (ذكاء اصطناعي)')}</b>
                <Button variant="secondary" onClick={runAI} busy={busy} disabled={!s.refs.length} data-testid="changes-ai">{s.ai ? L('Summarize again', 'لخّص تاني') : L('Summarize with AI', 'لخّص بالذكاء الاصطناعي')}</Button></div>
              <p className="tiny muted">{L('Claude rewords the facts above into a few lines. Lines without a valid reference, with new numbers, or with diagnostic or treatment wording are removed. Only check-ins written while the patient allowed AI are sent.', 'Claude بيعيد صياغة الحقايق اللي فوق في كام سطر. أي سطر من غير مصدر صحيح، أو فيه أرقام جديدة، أو كلام تشخيص أو علاج بيتشال. بيتبعت بس التسجيلات اللي المريض كان سامح فيها بالذكاء الاصطناعي.')}</p>
              {aiErr && <Banner kind="warn">{aiErr}</Banner>}
              {s.ai && (s.ai.lines.length ? <ul className="change-list" data-testid="changes-ai-lines">{s.ai.lines.map((l, k) => (
                <li key={k} className="change ai"><span data-no-tr>{l.text}</span><span className="refs">{l.refs.map((r) => <span key={r} className="ref-chip">{r}</span>)}</span></li>
              ))}</ul> : <p className="small muted">{L('No AI line passed the checks; use the rule-based lines above.', 'ولا سطر من الذكاء الاصطناعي عدّى المراجعة؛ استخدم السطور اللي فوق.')}</p>)}
              {s.ai && s.ai.rejected > 0 && <p className="tiny muted">{L(`${s.ai.rejected} AI line(s) removed by the checks.`, `${s.ai.rejected} سطر اتشال في المراجعة.`)}</p>}
            </section>

            <SeverityChart entries={data.data.entries} lang={lang} />
            <PatientCareSection patientId={id} />
            <h3 className="section">{L('Check-ins', 'التسجيلات')}</h3>
            {s.refs.length ? <div className="stack">{[...s.refs].reverse().map(({ ref, entry }) => <EntryCard key={entry.id} e={entry} lang={lang} refId={ref} />)}</div>
              : <Empty icon={<LuNotebookPen />} title={L('No shared check-ins', 'مفيش تسجيلات متشاركة')}>{L('The patient has not shared any diary entries with you.', 'المريض لسه مشاركش أي تسجيلات معاك.')}</Empty>}
            {s.reports.length > 0 && <p className="tiny muted">{s.reports.map((r) => `${r.ref}: ${fmtDay(r.at, lang)}`).join(' · ')}</p>}
          </>
        ) : null}
      </div></div>
    </>
  );
}
