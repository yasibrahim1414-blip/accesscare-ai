// Patient: "My care" hub, medicines (schedule from the doctor's prescriptions,
// dose check-ins, reminders, 7-day adherence) and the medicine-box check.
import React, { useEffect, useMemo, useState } from 'react';
import {
  LuPill, LuScanLine, LuCamera, LuSiren, LuLanguages, LuHeartHandshake, LuChevronRight, LuBell, LuBellOff, LuCircleCheck,
  LuCircleX, LuTriangleAlert, LuMic, LuMicOff, LuVolume2, LuClock, LuPlus, LuX,
} from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, Button, Empty, ErrorState, LargeBar, Sheet, Skeleton, TopBar, speak, ttsSupported } from '../../ui/components';
import { useLang, tr } from '../../i18n/lang';
import { localDay, type DoseData, type DoseStatus } from '../../domain/care';
import {
  adherence, nextDose, readDoseAnswer, remindersOn, saveTimes, setRemindersOn, sideEffectUrgent, todaySlots,
  type MedPlan, type Slot,
} from '../../services/care/meds';
import { boxPrompt, checkBox, cleanBoxReading, shrinkForReading, type BoxVerdict } from '../../services/care/boxReader';
import { Listener, sttSupported, ERROR_TEXT } from '../../services/voice/Speech';
import { EmergencyContent } from '../shared/Emergency';
import { AIStatus } from '../shared/AIStatus';
import { CameraCapture } from './CameraCapture';
import { useMeds, loadMedData, shareCareDefault, setShareCareDefault, type MedData } from './careData';

const STATE_LABEL: Record<string, [string, string]> = {
  taken: ['Taken', 'اتاخدت'], missed: ['Missed', 'فاتت'], side_effect: ['Side effect', 'عرض جانبي'],
  due: ['Due now', 'ميعادها دلوقتي'], upcoming: ['Later', 'بعدين'], not_checked: ['Not checked', 'مش متسجلة'],
};
const STATE_CLS: Record<string, string> = { taken: 'ok-chip', missed: 'warn-chip', side_effect: 'urgent-chip', due: 'due-chip', upcoming: '', not_checked: 'warn-chip' };

export function useL() { const lang = useLang(); return { lang, L: (en: string, ar: string) => tr(en, ar, lang) }; }

/** Records a dose check-in (shared with the doctor when the patient keeps sharing on). */
export function useDoseActions(reload: () => void) {
  const { backend, toast } = useApp();
  const { L } = useL();
  return async (plan: MedPlan, slot: string, status: DoseStatus, opts: { sideEffect?: string; via?: DoseData['via']; day?: string; urgent?: string[] } = {}) => {
    await backend.addRecord('dose', {
      medicine: plan.name, rxId: plan.rxId, dose: plan.dose, slot, day: opts.day ?? localDay(), status, sideEffect: opts.sideEffect ?? '',
      via: opts.via ?? 'touch', urgent: opts.urgent ?? [], times: plan.times,
    }, { share: shareCareDefault() });
    toast(status === 'taken' ? L(`${plan.name}: marked as taken`, `${plan.name}: اتسجلت إنها اتاخدت`) : status === 'missed' ? L(`${plan.name}: marked as missed`, `${plan.name}: اتسجلت إنها فاتت`) : L('Side effect saved', 'العرض الجانبي اتسجل'));
    reload();
  };
}

// ---------------------------------------------------------------- hub
export function PatientCare() {
  const { nav } = useApp();
  const { L } = useL();
  const meds = useMeds();
  const tiles = [
    { r: 'p.meds', Icon: LuPill, t: L('Medicines', 'أدويتي'), d: L('Times, reminders and check-ins', 'المواعيد والتذكير وتسجيل الجرعات'), tone: 'teal' },
    { r: 'p.boxcheck', Icon: LuScanLine, t: L('Check a medicine box', 'اتأكد من علبة الدوا'), d: L('Point the camera; hear if it’s yours', 'وجّه الكاميرا واسمع لو هو دواك'), tone: 'saffron' },
    { r: 'p.photos', Icon: LuCamera, t: L('Wound & skin photos', 'صور الجرح والجلد'), d: L('A dated timeline for your doctor', 'صور بالتاريخ لدكتورك'), tone: 'blue' },
    { r: 'p.card', Icon: LuSiren, t: L('Emergency card', 'كارت الطوارئ'), d: L('Allergies, medicines, contact — as a QR', 'الحساسية والأدوية ورقم الطوارئ — بكود QR'), tone: 'red' },
    { r: 'interp', Icon: LuLanguages, t: L('Visit interpreter', 'مترجم الزيارة'), d: L('Arabic ⇄ English, live in the clinic', 'عربي ⇄ إنجليزي في العيادة'), tone: 'violet' },
    { r: 'p.caregivers', Icon: LuHeartHandshake, t: L('Caregivers', 'المرافقين'), d: L('Let family help, with your permission', 'خلي حد من أهلك يساعد بإذنك'), tone: 'green' },
  ] as const;
  return (
    <>
      <LargeBar eyebrow={L('Between visits', 'بين الزيارات')} title={L('My care', 'رعايتي')} />
      <div className="screen screen-in"><div className="pad">
        {meds.data ? <NextDoseCard data={meds.data} reload={meds.reload} /> : meds.loading ? <Skeleton rows={1} height={96} /> : null}
        <div className="care-grid" role="list">
          {tiles.map((t) => (
            <button key={t.r} role="listitem" className={`care-tile tone-${t.tone}`} onClick={() => nav.push({ name: t.r } as never)} data-testid={`care-${t.r}`}>
              <span className="care-ico"><t.Icon aria-hidden /></span>
              <b>{t.t}</b>
              <span className="small muted">{t.d}</span>
            </button>
          ))}
        </div>
      </div></div>
    </>
  );
}

/** The next dose, with one-tap check-in (home + hub). */
export function NextDoseCard({ data, reload, compact }: { data: MedData; reload: () => void; compact?: boolean }) {
  const { nav } = useApp();
  const { L } = useL();
  const act = useDoseActions(reload);
  const [busy, setBusy] = useState('');
  const slots = todaySlots(data.plans, data.doses);
  const next = nextDose(slots);
  const late = slots.filter((s) => s.state === 'not_checked');
  if (!data.plans.some((p) => p.active)) return compact ? null : (
    <div className="card"><div className="row"><span className="care-ico sm tone-teal"><LuPill aria-hidden /></span>
      <div className="grow small muted">{L('When your doctor sends a prescription, its times appear here.', 'لما دكتورك يبعت روشتة، مواعيدها هتظهر هنا.')}</div></div></div>
  );
  const run = async (s: Slot, st: DoseStatus) => { setBusy(`${s.plan.rxId}${s.slot}${st}`); try { await act(s.plan, s.slot, st); } finally { setBusy(''); } };
  return (
    <section className="card raised next-dose" aria-labelledby="nd-h" data-testid="next-dose">
      <div className="row between"><h2 className="title" id="nd-h" style={{ margin: 0 }}><LuPill aria-hidden /> {next ? (next.state === 'due' ? L('Time for your medicine', 'ميعاد الدوا') : L('Next medicine', 'الدوا الجاي')) : L('Today’s medicines are done', 'أدوية النهارده خلصت')}</h2>
        <button className="linkbtn small" onClick={() => nav.push({ name: 'p.meds' })} data-testid="nd-all">{L('All', 'الكل')} <LuChevronRight className="flip" aria-hidden /></button></div>
      {next && (
        <>
          <p className="next-dose-line"><span className="dose-time" data-no-tr>{next.slot}</span> <b data-no-tr>{next.plan.name}</b> <span className="muted" data-no-tr>{next.plan.dose}</span></p>
          {next.plan.instructions && <p className="small muted" data-no-tr>{next.plan.instructions}</p>}
          <div className="row wrap">
            <Button className="grow" onClick={() => void run(next, 'taken')} busy={busy === `${next.plan.rxId}${next.slot}taken`} data-testid="nd-taken"><LuCircleCheck aria-hidden /> {L('I took it', 'خدتها')}</Button>
            <Button variant="secondary" onClick={() => void run(next, 'missed')} busy={busy === `${next.plan.rxId}${next.slot}missed`} data-testid="nd-missed">{L('Missed it', 'فاتتني')}</Button>
          </div>
        </>
      )}
      {late.length > 0 && <p className="small warn-text" data-testid="nd-late">{L(`${late.length} earlier dose(s) today not checked.`, `${late.length} جرعة النهارده مش متسجلة.`)} <button className="linkbtn" onClick={() => nav.push({ name: 'p.meds' })}>{L('Check them', 'سجّلها')}</button></p>}
    </section>
  );
}

// ---------------------------------------------------------------- medicines
export function MedicinesScreen() {
  const { nav, backend } = useApp();
  const { L, lang } = useL();
  const meds = useMeds();
  const doctor = React.useMemo(() => backend.getMyDoctor().catch(() => null), [backend]);
  const [hasDoctor, setHasDoctor] = useState(false);
  useEffect(() => { void doctor.then((d) => setHasDoctor(!!d)); }, [doctor]);
  const act = useDoseActions(meds.reload);
  const [rem, setRem] = useState(remindersOn());
  const [share, setShare] = useState(shareCareDefault());
  const [side, setSide] = useState<Slot | null>(null);
  const [editing, setEditing] = useState<MedPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [notifNote, setNotifNote] = useState('');

  const toggleRem = async () => {
    const on = !rem;
    setRem(on); setRemindersOn(on); setNotifNote('');
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { const p = await Notification.requestPermission(); if (p !== 'granted') setNotifNote(L('Notifications were not allowed: reminders show inside the app while it is open.', 'الإشعارات مش مسموحة: التذكير هيظهر جوه التطبيق وهو مفتوح.')); } catch { /* */ }
    }
  };

  const data = meds.data;
  const slots = data ? todaySlots(data.plans, data.doses) : [];
  const adh = data ? adherence(data.plans, data.doses, 7) : null;
  const pct = adh && adh.planned ? Math.round((adh.taken / adh.planned) * 100) : null;
  const run = async (s: Slot, st: DoseStatus) => { setBusy(`${s.plan.rxId}${s.slot}${st}`); try { await act(s.plan, s.slot, st); } finally { setBusy(''); } };

  return (
    <>
      <TopBar title={L('Medicines', 'أدويتي')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('Your schedule comes only from prescriptions your doctor sent. Check in each dose so your doctor can see how it is going.', 'جدولك جاي بس من الروشتات اللي دكتورك بعتها. سجّل كل جرعة علشان دكتورك يشوف الأمور ماشية إزاي.')}</p>
        {meds.loading && !data ? <Skeleton rows={3} /> : meds.error ? <ErrorState message={meds.error} onRetry={meds.reload} /> : !data?.plans.length ? (
          <Empty icon={<LuPill />} title={L('No prescriptions yet', 'مفيش روشتات لسه')}>{L('When your doctor sends you a prescription, its times and reminders appear here.', 'لما دكتورك يبعتلك روشتة، مواعيدها والتذكير هيظهروا هنا.')}</Empty>
        ) : (
          <>
            <section className="card" aria-labelledby="today-h">
              <h2 className="title" id="today-h">{L('Today', 'النهارده')}</h2>
              {slots.length ? (
                <div className="stack" data-testid="dose-today">
                  {slots.map((s) => (
                    <div key={`${s.plan.rxId}-${s.slot}`} className={`dose-row st-${s.state}`} data-testid="dose-row" data-state={s.state}>
                      <span className="dose-time" data-no-tr>{s.slot}</span>
                      <div className="grow"><b data-no-tr>{s.plan.name}</b> <span className="small muted" data-no-tr>{s.plan.dose}</span>
                        <div><span className={`status ${STATE_CLS[s.state]}`}>{L(...STATE_LABEL[s.state])}</span>{s.record?.by && <span className="tiny muted"> · {L('by', 'سجّلها')} <span data-no-tr>{s.record.by}</span></span>}</div></div>
                      {!s.record && s.state !== 'upcoming' && (
                        <div className="dose-acts">
                          <button className="iconbtn ok" aria-label={L(`${s.plan.name} at ${s.slot}: taken`, `${s.plan.name} الساعة ${s.slot}: خدتها`)} onClick={() => void run(s, 'taken')} disabled={!!busy} data-testid="dose-taken"><LuCircleCheck /></button>
                          <button className="iconbtn" aria-label={L(`${s.plan.name} at ${s.slot}: missed`, `${s.plan.name} الساعة ${s.slot}: فاتتني`)} onClick={() => void run(s, 'missed')} disabled={!!busy} data-testid="dose-missed"><LuCircleX /></button>
                          <button className="iconbtn warn" aria-label={L(`${s.plan.name}: report a side effect`, `${s.plan.name}: بلّغ عن عرض جانبي`)} onClick={() => setSide(s)} data-testid="dose-side"><LuTriangleAlert /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : <p className="small muted">{L('No scheduled doses today.', 'مفيش جرعات متجدولة النهارده.')}</p>}
              <VoiceDoseCheckin slots={slots} onDone={meds.reload} />
            </section>

            {adh && adh.planned > 0 && (
              <section className="card" aria-labelledby="adh-h" data-testid="adherence">
                <div className="row between"><h2 className="title" id="adh-h" style={{ margin: 0 }}>{L('Last 7 days', 'آخر ٧ أيام')}</h2><b className="big-num" data-testid="adh-pct">{pct}%</b></div>
                <p className="small muted">{L(`${adh.taken} of ${adh.planned} scheduled doses taken`, `${adh.taken} من ${adh.planned} جرعة اتاخدت`)}{adh.missed ? L(` · ${adh.missed} missed`, ` · ${adh.missed} فاتت`) : ''}{adh.notChecked ? L(` · ${adh.notChecked} not checked`, ` · ${adh.notChecked} مش متسجلة`) : ''}</p>
                <div className="adh-bars" role="img" aria-label={adh.days.map((d) => `${d.day}: ${d.taken}/${d.planned}`).join(', ')}>
                  {adh.days.map((d) => (
                    <div key={d.day} className="adh-day"><div className="adh-col"><span style={{ height: `${d.planned ? Math.max(6, (d.taken / d.planned) * 100) : 0}%` }} className={d.planned && d.taken < d.planned ? 'part' : ''} /></div>
                      <span className="tiny muted" data-no-tr>{new Date(`${d.day}T12:00`).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'narrow' })}</span></div>
                  ))}
                </div>
                {adh.sideEffectNotes.length > 0 && <div className="stack" style={{ marginTop: 8 }}>{adh.sideEffectNotes.map((n, i) => <p key={i} className="small warn-text" data-no-tr><LuTriangleAlert aria-hidden /> {n.medicine}: “{n.text}”</p>)}</div>}
              </section>
            )}

            <h3 className="section">{L('My medicines', 'أدويتي')}</h3>
            <div className="stack">
              {data.plans.map((p) => (
                <div key={p.rxId} className={`card med-card ${p.active ? '' : 'ended'}`} data-testid="med-card">
                  <div className="row between"><b data-no-tr>{p.name} {p.dose}</b>{!p.active && <span className="status">{L('Course ended', 'الكورس خلص')}</span>}</div>
                  <p className="small" data-no-tr>{[p.frequency, p.duration, p.instructions].filter(Boolean).join(' · ')}</p>
                  {p.active && (p.asNeeded ? (
                    <div className="row wrap"><span className="small muted">{L('Taken only when needed.', 'بيتاخد عند اللزوم بس.')}</span>
                      <Button variant="secondary" onClick={() => void act(p, '', 'taken')} data-testid="med-prn-taken"><LuPlus aria-hidden /> {L('I took a dose now', 'خدت جرعة دلوقتي')}</Button></div>
                  ) : p.times.length ? (
                    <div className="row wrap" style={{ alignItems: 'center' }}><LuClock aria-hidden /> <span className="small" data-no-tr>{p.times.join(' · ')}</span>
                      <button className="linkbtn small" onClick={() => setEditing(p)} data-testid="med-times">{L('Change times', 'غيّر المواعيد')}</button></div>
                  ) : <p className="small warn-text">{L('How often was not clear in the prescription — ask your doctor.', 'عدد المرات مش واضح في الروشتة — اسأل دكتورك.')} <button className="linkbtn" onClick={() => setEditing(p)}>{L('Set times', 'حدد مواعيد')}</button></p>)}
                  {p.endDay && <p className="tiny muted">{p.active ? L('Until', 'لحد') : L('Ended', 'خلص')} <span data-no-tr>{new Date(`${p.endDay}T12:00`).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' })}</span></p>}
                  {ttsSupported() && <button className="linkbtn small" onClick={() => speak(`${p.name} ${p.dose}. ${p.frequency}. ${p.duration}. ${p.instructions}`)}><LuVolume2 aria-hidden /> {L('Read aloud', 'اقراها بصوت')}</button>}
                </div>
              ))}
            </div>

            <section className="card" aria-labelledby="rem-h">
              <h2 className="title" id="rem-h">{L('Reminders & sharing', 'التذكير والمشاركة')}</h2>
              <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={rem} onChange={() => void toggleRem()} data-testid="rem-toggle" />
                <span>{rem ? <LuBell aria-hidden /> : <LuBellOff aria-hidden />} {L('Remind me at each dose time', 'فكّرني في ميعاد كل جرعة')}</span></label>
              <p className="tiny muted">{L('Reminders work while AccessCare is open on this device (and as phone notifications if you allow them). Keep your usual alarm too.', 'التذكير بيشتغل وAccessCare مفتوح على الجهاز ده (وكإشعار على الموبايل لو سمحت). خلي المنبّه بتاعك كمان.')}</p>
              {notifNote && <p className="small warn-text">{notifNote}</p>}
              {hasDoctor ? (
                <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={share} onChange={(e) => { setShare(e.target.checked); setShareCareDefault(e.target.checked); }} data-testid="share-care" />
                  <span>{L('Share my check-ins and side effects with my doctor', 'شارك تسجيلات الجرعات والأعراض الجانبية مع دكتوري')}</span></label>
              ) : <p className="tiny muted">{L('Not connected to a doctor: check-ins are kept for you only.', 'مش مربوط بدكتور: التسجيلات ليك بس.')}</p>}
            </section>
          </>
        )}
      </div></div>
      {side && <SideEffectSheet slot={side} onClose={() => setSide(null)} onSaved={() => { setSide(null); meds.reload(); }} />}
      {editing && <TimesSheet plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); meds.reload(); }} />}
    </>
  );
}

function SideEffectSheet({ slot, onClose, onSaved }: { slot: Slot; onClose: () => void; onSaved: () => void }) {
  const { L, lang } = useL();
  const act = useDoseActions(onSaved);
  const [text, setText] = useState('');
  const [taken, setTaken] = useState(true);
  const [busy, setBusy] = useState(false);
  const [via, setVia] = useState<DoseData['via']>('text');
  const urgent = useMemo(() => (text.trim().length > 3 ? sideEffectUrgent(text) : []), [text]);
  const listener = useMemo(() => new Listener(() => {}), []);
  const [listening, setListening] = useState(false);
  const [micErr, setMicErr] = useState('');
  const listen = async () => {
    setMicErr(''); setListening(true);
    const r = await listener.listen(lang, 15000); setListening(false);
    if ('error' in r) { if (r.error !== 'aborted') setMicErr(ERROR_TEXT[r.error][lang === 'ar' ? 'ar' : 'en']); return; }
    setText((t) => (t ? `${t} ${r.text}` : r.text)); setVia('voice');
  };
  const save = async () => { setBusy(true); try { await act(slot.plan, slot.slot, taken ? 'side_effect' : 'missed', { sideEffect: text.trim(), via, urgent }); } finally { setBusy(false); } };
  return (
    <Sheet title={L(`Side effect — ${slot.plan.name}`, `عرض جانبي — ${slot.plan.name}`)} onClose={onClose} icon={<LuTriangleAlert />}>
      <label htmlFor="se-text" className="strong small">{L('What happened, in your words', 'إيه اللي حصل، بكلامك')}</label>
      <textarea id="se-text" className="input" dir="auto" maxLength={300} value={text} onChange={(e) => { setText(e.target.value); if (via !== 'voice') setVia('text'); }} data-testid="se-text" />
      <div className="row wrap">
        {sttSupported() && <Button variant="secondary" onClick={listen} disabled={listening}>{listening ? <><LuMicOff aria-hidden /> {L('Listening…', 'بسمعك…')}</> : <><LuMic aria-hidden /> {L('Say it', 'قولها')}</>}</Button>}
      </div>
      {micErr && <p className="small danger-text" role="alert">{micErr}</p>}
      {urgent.length > 0 && <div data-testid="se-urgent"><EmergencyContent reasons={urgent} /></div>}
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={taken} onChange={(e) => setTaken(e.target.checked)} /><span>{L('I took this dose', 'أخدت الجرعة دي')}</span></label>
      <p className="tiny muted">{L('Do not stop a medicine on your own unless it is an emergency — ask your doctor. This is not a diagnosis.', 'متوقفش دوا لوحدك إلا في الطوارئ — اسأل دكتورك. ده مش تشخيص.')}</p>
      <Button block onClick={save} busy={busy} disabled={text.trim().length < 2} data-testid="se-save">{L('Save', 'احفظ')}</Button>
    </Sheet>
  );
}

function TimesSheet({ plan, onClose, onSaved }: { plan: MedPlan; onClose: () => void; onSaved: () => void }) {
  const { L } = useL();
  const [times, setTimes] = useState<string[]>(plan.times.length ? plan.times : ['09:00']);
  return (
    <Sheet title={L(`Times — ${plan.name}`, `المواعيد — ${plan.name}`)} onClose={onClose} icon={<LuClock />}>
      <p className="small muted" data-no-tr>{plan.frequency}</p>
      <p className="tiny muted">{L('Pick times that fit your day. This does not change your prescription; if unsure, ask your doctor or pharmacist.', 'اختار مواعيد تناسب يومك. ده مش بيغيّر الروشتة؛ لو مش متأكد اسأل دكتورك أو الصيدلي.')}</p>
      <div className="stack">
        {times.map((t, i) => (
          <div key={i} className="row"><input type="time" className="input" value={t} onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))} aria-label={L(`Time ${i + 1}`, `ميعاد ${i + 1}`)} data-testid="time-input" />
            {times.length > 1 && <button className="iconbtn" onClick={() => setTimes(times.filter((_, j) => j !== i))} aria-label={L('Remove this time', 'امسح الميعاد ده')}><LuX /></button>}</div>
        ))}
      </div>
      {times.length < 6 && <Button variant="secondary" onClick={() => setTimes([...times, '12:00'])}><LuPlus aria-hidden /> {L('Add a time', 'ضيف ميعاد')}</Button>}
      <Button block onClick={() => { saveTimes(plan.rxId, times); onSaved(); }} data-testid="times-save">{L('Save times', 'احفظ المواعيد')}</Button>
    </Sheet>
  );
}

/** "Say it": "I took it" / "نسيت" / "it made me dizzy" for the dose due now. */
function VoiceDoseCheckin({ slots, onDone }: { slots: Slot[]; onDone: () => void }) {
  const { L, lang } = useL();
  const act = useDoseActions(onDone);
  const listener = useMemo(() => new Listener(() => {}), []);
  const [msg, setMsg] = useState('');
  const [listening, setListening] = useState(false);
  const target = slots.find((s) => !s.record && s.state === 'due') ?? slots.find((s) => !s.record && s.state === 'not_checked');
  if (!target || !sttSupported()) return null;
  const go = async () => {
    setMsg(''); setListening(true);
    const r = await listener.listen(lang, 12000); setListening(false);
    if ('error' in r) { if (r.error !== 'aborted') setMsg(ERROR_TEXT[r.error][lang === 'ar' ? 'ar' : 'en']); return; }
    const a = readDoseAnswer(r.text);
    if (!a) { setMsg(L(`I heard “${r.text}”. Say “I took it”, “I missed it”, or describe a side effect.`, `سمعت "${r.text}". قول "خدتها" أو "فاتتني" أو احكي العرض الجانبي.`)); return; }
    await act(target.plan, target.slot, a.status, { sideEffect: a.sideEffect, via: 'voice', urgent: a.sideEffect ? sideEffectUrgent(a.sideEffect) : [] });
    const t = a.status === 'taken' ? L(`Saved: ${target.plan.name} taken.`, `اتسجل: ${target.plan.name} اتاخدت.`) : a.status === 'missed' ? L(`Saved: ${target.plan.name} missed.`, `اتسجل: ${target.plan.name} فاتت.`) : L('Side effect saved. If it is severe, call your emergency number.', 'العرض الجانبي اتسجل. لو شديد، كلّم الطوارئ.');
    setMsg(t); speak(t);
  };
  return (
    <div className="row wrap" style={{ marginTop: 8 }}>
      <Button variant="secondary" onClick={go} disabled={listening} data-testid="dose-voice">{listening ? <><LuMicOff aria-hidden /> {L('Listening…', 'بسمعك…')}</> : <><LuMic aria-hidden /> {L(`Say it for ${target.plan.name} ${target.slot}`, `قولها لـ ${target.plan.name} ${target.slot}`)}</>}</Button>
      {msg && <p className="small" role="status" data-testid="dose-voice-msg">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- medicine box check
export function BoxCheckScreen() {
  const { nav, ai, prefs, backend } = useApp();
  const { L, lang } = useL();
  const meds = useMeds();
  const act = useDoseActions(meds.reload);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<BoxVerdict | null>(null);
  const [readText, setReadText] = useState('');
  const [err, setErr] = useState('');
  const [canVision, setCanVision] = useState<boolean | null>(null);
  const aiOn = ai.state(prefs.aiAssist) === 'available';
  useEffect(() => { void ai.visionSupported().then(setCanVision); }, [ai]);

  const sayVerdict = (v: BoxVerdict): string => {
    if (v.kind === 'unreadable') return L('I could not read a medicine name. Hold the side with the name close to the camera, in good light, and try again.', 'مقدرتش أقرا اسم الدوا. قرّب الجنب اللي عليه الاسم من الكاميرا في نور كويس وجرّب تاني.');
    if (v.kind === 'not_prescribed') return L(`This does not match any of your prescriptions (I read: ${v.read}). Do not take it before checking with your doctor or pharmacist.`, `ده مش مطابق لأي روشتة عندك (قريت: ${v.read}). متاخدهوش قبل ما تتأكد من دكتورك أو الصيدلي.`);
    const p = v.plan;
    const base = L(`This is your ${p.name}${p.dose ? `, ${p.dose}` : ''}. ${p.frequency}${p.instructions ? `. ${p.instructions}` : ''}.`, `ده دواك ${p.name}${p.dose ? `، ${p.dose}` : ''}. ${p.frequency}${p.instructions ? `. ${p.instructions}` : ''}.`);
    const str = v.strength === 'different' ? L(` Careful: the box says ${v.boxStrength}, your prescription says ${p.dose}. Check with your pharmacist before taking it.`, ` خلي بالك: العلبة مكتوب عليها ${v.boxStrength} والروشتة ${p.dose}. اسأل الصيدلي قبل ما تاخده.`) : '';
    const ended = p.active ? '' : L(' This course has ended.', ' الكورس ده خلص.');
    return base + str + ended;
  };

  const onPhoto = async (src: Blob | HTMLVideoElement) => {
    setErr(''); setVerdict(null); setReadText(''); setBusy(true);
    try {
      const img = await shrinkForReading(src);
      const raw = await ai.vision(boxPrompt(), img);
      if (raw === null) { setErr(ai.lastError ? L(`The AI could not read the photo (${ai.lastError}).`, `الذكاء الاصطناعي مقدرش يقرا الصورة (${ai.lastError}).`) : L('The AI could not read the photo. Try again.', 'الذكاء الاصطناعي مقدرش يقرا الصورة. جرّب تاني.')); return; }
      const reading = cleanBoxReading(raw);
      const plans = meds.data?.plans ?? (await loadMedData(backend)).plans; // never compare against a list that has not loaded yet
      const v = checkBox(reading, plans);
      setVerdict(v); setReadText(reading?.names.join(' · ') || reading?.text || '');
      speak(sayVerdict(v));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const slot = verdict?.kind === 'match' && meds.data ? todaySlots(meds.data.plans, meds.data.doses).find((s) => s.plan.rxId === verdict.plan.rxId && !s.record && (s.state === 'due' || s.state === 'not_checked')) : undefined;

  return (
    <>
      <TopBar title={L('Check a medicine box', 'اتأكد من علبة الدوا')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('Show the box, strip or bottle to the camera. Claude reads only the printed name; AccessCare compares it with your prescriptions and tells you — on screen and out loud.', 'وري العلبة أو الشريط أو الزجاجة للكاميرا. Claude بيقرا الاسم المكتوب بس، وAccessCare بيقارنه بروشتاتك ويقولك — على الشاشة وبصوت.')}</p>
        <AIStatus on={L('Claude reads the printed text; the match uses your doctor’s prescriptions.', 'Claude بيقرا الكلام المكتوب؛ والمقارنة بروشتات دكتورك.')} />
        {aiOn && canVision === false && <Banner kind="warn">{L('Photos cannot be sent to the AI in this view. Open the AccessCare website version to use this.', 'مينفعش تبعت صور للذكاء الاصطناعي في العرض ده. افتح نسخة موقع AccessCare علشان تستخدمها.')}</Banner>}
        {meds.data && !meds.data.plans.length && <Banner kind="info">{L('You have no prescriptions yet, so any box will show as “not in your prescriptions”.', 'معندكش روشتات لسه، فأي علبة هتظهر "مش في روشتاتك".')}</Banner>}
        {aiOn && canVision !== false && <CameraCapture onPhoto={onPhoto} busy={busy} purpose={L('Point at the side with the medicine name.', 'وجّه على الجنب اللي عليه اسم الدوا.')} testid="box-cam" />}
        {busy && <p className="small" role="status">{L('Reading the box…', 'بقرا العلبة…')}</p>}
        {err && <p className="small danger-text" role="alert">{err}</p>}
        {verdict && (
          <section className={`card raised box-verdict v-${verdict.kind}${verdict.kind === 'match' && verdict.strength === 'different' ? ' v-warn' : ''}`} role="status" aria-live="polite" data-testid="box-verdict" data-kind={verdict.kind}>
            <h2 className="title">{verdict.kind === 'match' ? (verdict.strength === 'different' ? <><LuTriangleAlert aria-hidden /> {L('Your medicine — but check the strength', 'دواك — بس اتأكد من التركيز')}</> : <><LuCircleCheck aria-hidden /> {L('This is your medicine', 'ده دواك')}</>) : verdict.kind === 'not_prescribed' ? <><LuCircleX aria-hidden /> {L('Not in your prescriptions', 'مش في روشتاتك')}</> : L('Could not read it', 'مقدرتش أقراها')}</h2>
            <p data-no-tr>{sayVerdict(verdict)}</p>
            {readText && <p className="tiny muted">{L('Read on the box:', 'المكتوب على العلبة:')} <span data-no-tr>{readText}</span></p>}
            <div className="row wrap">
              {ttsSupported() && <Button variant="secondary" onClick={() => speak(sayVerdict(verdict))}><LuVolume2 aria-hidden /> {L('Say it again', 'قولها تاني')}</Button>}
              {slot && verdict.kind === 'match' && verdict.strength !== 'different' && <Button onClick={() => void act(slot.plan, slot.slot, 'taken', { via: 'camera' }).then(() => setVerdict(null))} data-testid="box-taken"><LuCircleCheck aria-hidden /> {L(`Record ${slot.slot} dose as taken`, `سجّل جرعة ${slot.slot} إنها اتاخدت`)}</Button>}
            </div>
            <p className="tiny muted">{L('The AI can misread a photo. If anything seems wrong, ask your pharmacist.', 'الذكاء الاصطناعي ممكن يغلط في قراية الصورة. لو حاجة شكلها غلط، اسأل الصيدلي.')}</p>
          </section>
        )}
      </div></div>
    </>
  );
}
