// Caregiver account: the people who linked this caregiver, the summary each
// patient's app shares with them, and recording a dose or a note for them.
import React, { useState } from 'react';
import { LuHeartHandshake, LuCopy, LuPill, LuCircleCheck, LuTriangleAlert, LuNotebookPen, LuStethoscope, LuSiren, LuChevronRight, LuClock, LuPhone } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Button, Empty, ErrorState, LargeBar, Skeleton, TopBar, copyText, initials } from '../../ui/components';
import { localDay, type CareDigest } from '../../domain/care';
import { useL } from '../care/MedScreens';

const fmt = (iso: string, lang: string) => (iso ? new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS: Record<string, [string, string]> = { taken: ['Taken', 'اتاخدت'], missed: ['Missed', 'فاتت'], side_effect: ['Side effect', 'عرض جانبي'], due: ['Due / not checked', 'مستنية / مش متسجلة'], upcoming: ['Later', 'بعدين'] };

export function CaregiverHome() {
  const { backend, me, nav, toast } = useApp();
  const { L, lang } = useL();
  const list = useLoad(() => backend.listCaredPatients(), []);
  const id = me?.caregiverId ?? '';
  return (
    <>
      <LargeBar eyebrow={L('Caregiver', 'مرافق')} title={L('People I help', 'اللي بساعدهم')} />
      <div className="screen screen-in"><div className="pad">
        <section className="card raised cg-id" aria-labelledby="cg-id-h" data-testid="cg-id-card">
          <h2 className="title" id="cg-id-h"><LuHeartHandshake aria-hidden /> {L('My Caregiver ID', 'رقم المرافق بتاعي')}</h2>
          <p className="cg-code" data-no-tr data-testid="cg-id">{id}</p>
          <p className="small muted">{L('Give this ID to the person you help. They add you from “My care → Caregivers” in their app. Knowing this ID gives no one access to anything.', 'ادي الرقم ده للشخص اللي بتساعده. هو يضيفك من "رعايتي ← المرافقين" في تطبيقه. معرفة الرقم ده مش بتدي أي حد صلاحية لأي حاجة.')}</p>
          <Button variant="secondary" onClick={async () => toast((await copyText(id)) ? L('Copied', 'اتنسخ') : L('Could not copy', 'مقدرتش أنسخ'))}><LuCopy aria-hidden /> {L('Copy ID', 'انسخ الرقم')}</Button>
        </section>
        {list.loading && !list.data ? <Skeleton rows={2} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data?.length ? (
          <div className="list">{list.data.map((p) => {
            const d = p.digest;
            const due = d?.medicines.flatMap((m) => m.today).filter((t) => t.status === 'due').length ?? 0;
            return (
              <button key={p.id} className="list-item" onClick={() => nav.push({ name: 'c.patient', id: p.id })} data-testid="cg-patient">
                <div className="avatar" data-no-tr>{initials(p.name)}</div>
                <div className="grow"><b data-no-tr>{p.name}</b>
                  <div className="small muted">{d ? `${L('Updated', 'اتحدّث')} ${fmt(d.updatedAt, lang)}` : L('Waiting for their app to share a summary', 'مستني تطبيقهم يشارك الملخص')}</div>
                  {!!d?.alerts.length && <div className="small danger-text">{L(`${d.alerts.length} alert(s)`, `${d.alerts.length} تنبيه`)}</div>}
                  {!!due && <div className="small warn-text">{L(`${due} dose(s) due or not checked today`, `${due} جرعة النهارده مستنية أو مش متسجلة`)}</div>}
                </div><LuChevronRight className="chev" aria-hidden />
              </button>
            );
          })}</div>
        ) : <Empty icon={<LuHeartHandshake />} title={L('No one has added you yet', 'محدش ضافك لسه')}>{L('When someone adds your Caregiver ID in their app, they appear here.', 'لما حد يضيف رقمك في تطبيقه، هيظهر هنا.')}</Empty>}
      </div></div>
    </>
  );
}

export function CaregiverPatient({ id }: { id: string }) {
  const { backend, nav, toast } = useApp();
  const { L, lang } = useL();
  const list = useLoad(() => backend.listCaredPatients(), [id]);
  const p = list.data?.find((x) => x.id === id);
  const d: CareDigest | null | undefined = p?.digest;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [sent, setSent] = useState<string[]>([]);

  const giveDose = async (m: CareDigest['medicines'][number], slot: string) => {
    setBusy(`${m.name}${slot}`);
    try {
      await backend.caregiverAdd(id, { kind: 'dose', dose: { medicine: m.name, rxId: m.rxId, dose: m.dose, slot, day: localDay(), status: 'taken', sideEffect: '', via: 'touch', urgent: [], times: m.times } });
      setSent((s) => [...s, `${m.name}${slot}`]);
      toast(L('Recorded. It reaches their records when their app opens.', 'اتسجّل. هيوصل لسجلهم لما تطبيقهم يفتح.'));
    } catch (e) { toast((e as Error).message); } finally { setBusy(''); }
  };
  const sendNote = async () => {
    setBusy('note');
    try { await backend.caregiverAdd(id, { kind: 'note', note: note.trim() }); setNote(''); toast(L('Note recorded', 'الملاحظة اتسجلت')); } catch (e) { toast((e as Error).message); } finally { setBusy(''); }
  };

  return (
    <>
      <TopBar title={p?.name ?? L('Person I help', 'الشخص اللي بساعده')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        {list.loading && !list.data ? <Skeleton rows={3} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !p ? (
          <Empty icon={<LuHeartHandshake />} title={L('Not available', 'مش متاح')}>{L('This person removed you as their caregiver.', 'الشخص ده شالك من المرافقين.')}</Empty>
        ) : !d ? (
          <Empty icon={<LuClock />} title={L('No summary yet', 'مفيش ملخص لسه')}>{L('Their summary appears after they open AccessCare.', 'الملخص هيظهر بعد ما يفتحوا AccessCare.')}</Empty>
        ) : (
          <>
            <p className="tiny muted">{L('Shared by their app', 'اتشارك من تطبيقهم')} · <span data-no-tr>{fmt(d.updatedAt, lang)}</span></p>
            {d.alerts.length > 0 && (
              <section className="card alert-card" aria-labelledby="cga-h" data-testid="cg-alerts">
                <h2 className="title" id="cga-h"><LuTriangleAlert aria-hidden /> {L('Alerts', 'تنبيهات')}</h2>
                <ul className="small">{d.alerts.map((a, i) => <li key={i} data-no-tr dir="auto">{lang === 'ar' && a.ar ? a.ar : a.text}</li>)}</ul>
                <p className="tiny muted">{L('If they seem very unwell, call the emergency number.', 'لو باين عليهم تعب شديد، كلّم الطوارئ.')}</p>
              </section>
            )}
            <section className="card" aria-labelledby="cgm-h" data-testid="cg-meds">
              <h2 className="title" id="cgm-h"><LuPill aria-hidden /> {L('Medicines today', 'أدوية النهارده')}</h2>
              {d.adherence7d && <p className="small muted">{L(`Last 7 days: ${d.adherence7d.taken} of ${d.adherence7d.planned} doses taken`, `آخر ٧ أيام: ${d.adherence7d.taken} من ${d.adherence7d.planned} جرعة اتاخدت`)}</p>}
              {d.medicines.length ? d.medicines.map((m) => (
                <div key={m.name} className="stack" style={{ gap: 6, marginBottom: 10 }}>
                  <b data-no-tr>{m.name} {m.dose}</b>
                  {m.today.length ? m.today.map((t) => (
                    <div key={t.slot} className={`dose-row st-${t.status}`}>
                      <span className="dose-time" data-no-tr>{t.slot}</span>
                      <span className="grow small">{L(...STATUS[t.status])}</span>
                      {t.status === 'due' && !sent.includes(`${m.name}${t.slot}`) && <Button variant="secondary" onClick={() => void giveDose(m, t.slot)} busy={busy === `${m.name}${t.slot}`} data-testid="cg-give"><LuCircleCheck aria-hidden /> {L('I gave it', 'إديتها')}</Button>}
                      {sent.includes(`${m.name}${t.slot}`) && <span className="small ok-text">{L('Recorded by you', 'سجّلتها')}</span>}
                    </div>
                  )) : <p className="small muted">{m.times.length ? L('No more doses today', 'مفيش جرعات تانية النهارده') : L('Taken as needed', 'عند اللزوم')}</p>}
                </div>
              )) : <p className="small muted">{L('No active medicines.', 'مفيش أدوية شغالة.')}</p>}
            </section>
            {d.diary.length > 0 && (
              <section className="card" aria-labelledby="cgd-h"><h2 className="title" id="cgd-h"><LuNotebookPen aria-hidden /> {L('How they felt this week', 'حسوا بإيه الأسبوع ده')}</h2>
                <ul className="small">{d.diary.map((e, i) => <li key={i}><span data-no-tr>{fmt(e.at, lang)}</span>{e.feeling && <span> · {L(e.feeling, ({ better: 'أحسن', worse: 'أسوأ', 'about the same': 'زي ما هو' } as Record<string, string>)[e.feeling] ?? e.feeling)}</span>}{e.items.length > 0 && <bdi data-no-tr> · {e.items.join(', ')}</bdi>}{e.by && <> · {L(`note by ${e.by}`, `ملاحظة من ${e.by}`)}: <bdi data-no-tr>“{e.note}”</bdi></>}</li>)}</ul></section>
            )}
            {d.consultations.length > 0 && (
              <section className="card" aria-labelledby="cgc-h"><h2 className="title" id="cgc-h"><LuStethoscope aria-hidden /> {L('Doctor', 'الدكتور')}</h2>
                <div className="stack">{d.consultations.map((c, i) => (
                  <div key={i}><b data-no-tr>{c.title}</b> <span className="status" data-no-tr>{c.status}</span>{c.lastDoctorMessage && <p className="small" data-no-tr>“{c.lastDoctorMessage}”</p>}</div>
                ))}</div></section>
            )}
            {d.card && (
              <section className="card em-card" aria-labelledby="cge-h"><h2 className="title" id="cge-h"><LuSiren aria-hidden /> {L('Emergency card', 'كارت الطوارئ')}</h2>
                <dl className="em-list">
                  {d.card.allergies && <><dt>{L('Allergies', 'الحساسية')}</dt><dd data-no-tr dir="auto">{d.card.allergies}</dd></>}
                  {d.card.medicines && <><dt>{L('Medicines', 'الأدوية')}</dt><dd data-no-tr dir="auto">{d.card.medicines}</dd></>}
                  {d.card.conditions && <><dt>{L('Conditions', 'أمراض مزمنة')}</dt><dd data-no-tr dir="auto">{d.card.conditions}</dd></>}
                  {d.card.bloodType && <><dt>{L('Blood type', 'فصيلة الدم')}</dt><dd data-no-tr dir="auto">{d.card.bloodType}</dd></>}
                  {d.card.contactPhone && <><dt>{L('Emergency contact', 'رقم الطوارئ')}</dt><dd data-no-tr><a href={`tel:${d.card.contactPhone.replace(/[^\d+]/g, '')}`}><LuPhone aria-hidden /> {d.card.contactName} {d.card.contactPhone}</a></dd></>}
                </dl></section>
            )}
            <section className="card" aria-labelledby="cgn-h">
              <h2 className="title" id="cgn-h">{L('Add a note to their diary', 'ضيف ملاحظة ليومياتهم')}</h2>
              <textarea className="input" dir="auto" maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} aria-labelledby="cgn-h" placeholder={L('e.g. Slept badly, ate little today', 'مثلًا: نام وحش وأكل قليل النهارده')} data-testid="cg-note" />
              <Button block onClick={sendNote} busy={busy === 'note'} disabled={note.trim().length < 2} data-testid="cg-note-send">{L('Record note', 'سجّل الملاحظة')}</Button>
              <p className="tiny muted">{L('Your notes and doses appear in their records marked with your name.', 'ملاحظاتك والجرعات بتظهر في سجلهم متعلّمة باسمك.')}</p>
            </section>
          </>
        )}
      </div></div>
    </>
  );
}
