// Patient: wound/skin photo timeline, emergency card (with QR), caregivers.
import React, { useEffect, useMemo, useState } from 'react';
import { LuCamera, LuTrash2, LuSiren, LuHeartHandshake, LuUserPlus, LuMaximize, LuX, LuVolume2, LuRefreshCw, LuSave, LuPhone, LuImages } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Empty, ErrorState, Field, Skeleton, TopBar, speak, ttsSupported } from '../../ui/components';
import { BODY_REGIONS, regionLabelIn } from '../../domain/bodyRegions';
import { cleanCard, normalizeCaregiverId, CAREGIVER_ID_PATTERN, type CardData, type PatientRecord, type PhotoData } from '../../domain/care';
import { photoDataUrl } from '../../services/care/photos';
import { qrMatrix, qrPath } from '../../services/care/qr';
import { CameraCapture } from './CameraCapture';
import { useL } from './MedScreens';
import { loadMedData, shareCareDefault } from './careData';

const fmtDay = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// ---------------------------------------------------------------- photos
export function PhotosScreen() {
  const { nav, backend, toast } = useApp();
  const { L, lang } = useL();
  const list = useLoad(() => backend.listRecords('photo') as Promise<PatientRecord<PhotoData>[]>, []);
  const doctor = useLoad(() => backend.getMyDoctor().catch(() => null), []);
  const [draft, setDraft] = useState<{ image: string; w: number; h: number } | null>(null);
  const [area, setArea] = useState('');
  const [note, setNote] = useState('');
  const [share, setShare] = useState(shareCareDefault());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [del, setDel] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);

  const onPhoto = async (src: Blob | HTMLVideoElement) => {
    setErr('');
    try { setDraft(await photoDataUrl(src)); } catch (e) { setErr((e as Error).message); }
  };
  const save = async () => {
    if (!draft || !area.trim()) return;
    setBusy(true); setErr('');
    try {
      await backend.addRecord('photo', { ...draft, area: area.trim(), note: note.trim() }, { share: !!doctor.data && share });
      toast(L('Photo saved', 'الصورة اتحفظت'));
      setDraft(null); setNote(''); list.reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const groups = useMemo(() => {
    const m = new Map<string, PatientRecord<PhotoData>[]>();
    for (const r of list.data ?? []) { const k = r.data.area || L('Other', 'غير ذلك'); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [list.data, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const areas = BODY_REGIONS.map((r) => regionLabelIn(r.id, lang === 'ar' ? 'ar' : 'en'));
  const known = groups.map(([k]) => k);

  return (
    <>
      <TopBar title={L('Wound & skin photos', 'صور الجرح والجلد')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('Take a photo of the same area every day or two, from the same distance and light. Your doctor sees them side by side with the dates. No AI looks at your photos.', 'صوّر نفس المكان كل يوم أو يومين، من نفس المسافة ونفس النور. دكتورك بيشوفهم جنب بعض بالتواريخ. مفيش ذكاء اصطناعي بيبص على صورك.')}</p>
        {!draft ? (
          <section className="card raised" aria-labelledby="ph-new">
            <h2 className="title" id="ph-new">{L('New photo', 'صورة جديدة')}</h2>
            <ul className="small muted guide-list">
              <li>{L('Good light, no flash glare.', 'نور كويس، من غير لمعة فلاش.')}</li>
              <li>{L('About one hand-span away; the whole area in the frame.', 'على بعد شبر تقريبًا، والمكان كله في الصورة.')}</li>
              <li>{L('Same angle as last time — compare with your last photo below.', 'نفس الزاوية زي آخر مرة — قارن بآخر صورة تحت.')}</li>
            </ul>
            <CameraCapture onPhoto={onPhoto} purpose={L('Point at the area you want to follow.', 'وجّه على المكان اللي عايز تتابعه.')} testid="ph-cam" />
          </section>
        ) : (
          <section className="card raised" aria-labelledby="ph-check">
            <h2 className="title" id="ph-check">{L('Keep this photo?', 'تحتفظ بالصورة دي؟')}</h2>
            <img src={draft.image} alt={L('The photo you just took', 'الصورة اللي لسه صورتها')} className="ph-preview" data-testid="ph-preview" />
            <label htmlFor="ph-area" className="strong small">{L('Which area?', 'أنهي مكان؟')}</label>
            <input id="ph-area" className="input" list="ph-areas" dir="auto" value={area} onChange={(e) => setArea(e.target.value)} maxLength={60} placeholder={L('e.g. Left knee', 'مثلًا: الركبة الشمال')} data-testid="ph-area" />
            <datalist id="ph-areas">{[...new Set([...known, ...areas])].map((a) => <option key={a} value={a} />)}</datalist>
            <label htmlFor="ph-note" className="strong small">{L('Note (optional)', 'ملاحظة (اختياري)')}</label>
            <input id="ph-note" className="input" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={L('e.g. less red today', 'مثلًا: الاحمرار أقل النهارده')} data-testid="ph-note" />
            {doctor.data ? <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} data-testid="ph-share" /><span>{L('Share with', 'شارك مع')} <span data-no-tr>{doctor.data.fullName}</span></span></label>
              : <p className="tiny muted">{L('Not connected to a doctor: kept for you only.', 'مش مربوط بدكتور: ليك بس.')}</p>}
            <div className="row wrap">
              <Button variant="secondary" onClick={() => setDraft(null)}>{L('Retake', 'صوّر تاني')}</Button>
              <Button className="grow" onClick={save} busy={busy} disabled={!area.trim()} data-testid="ph-save"><LuSave aria-hidden /> {L('Save photo', 'احفظ الصورة')}</Button>
            </div>
          </section>
        )}
        {err && <p className="small danger-text" role="alert">{err}</p>}

        {list.loading && !list.data ? <Skeleton rows={2} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : groups.length ? groups.map(([k, rows]) => (
          <section key={k} className="card" aria-label={k}>
            <div className="row between"><h3 className="title" style={{ margin: 0 }} data-no-tr>{k}</h3>
              {rows.length > 1 && <button className="linkbtn small" onClick={() => setCompare(compare === k ? null : k)} data-testid="ph-compare">{compare === k ? L('Close comparison', 'اقفل المقارنة') : L('Compare first and latest', 'قارن الأولى بالأخيرة')}</button>}</div>
            {compare === k && <PhotoCompare first={rows[rows.length - 1]} last={rows[0]} lang={lang} />}
            <div className="photo-strip" data-testid="ph-strip">
              {rows.map((r) => (
                <figure key={r.id} className="photo-thumb" data-testid="ph-item">
                  <img src={r.data.image} alt={L(`${k}, ${fmtDay(r.at, lang)}`, `${k}، ${fmtDay(r.at, lang)}`)} />
                  <figcaption className="tiny"><span data-no-tr>{fmtDay(r.at, lang)}</span>{r.data.note && <span className="muted" data-no-tr> · {r.data.note}</span>}{r.sharedWith && <span className="muted"> · {L('shared', 'متشاركة')}</span>}</figcaption>
                  <button className="iconbtn sm" onClick={() => setDel(r.id)} aria-label={L('Delete this photo', 'امسح الصورة دي')}><LuTrash2 /></button>
                </figure>
              ))}
            </div>
          </section>
        )) : <Empty icon={<LuImages />} title={L('No photos yet', 'مفيش صور لسه')}>{L('Photos you take appear here as a timeline.', 'الصور اللي بتاخدها هتظهر هنا بالترتيب.')}</Empty>}
      </div></div>
      {del && <ConfirmSheet danger title={L('Delete this photo?', 'تمسح الصورة دي؟')} confirmLabel={L('Delete', 'امسح')} onCancel={() => setDel(null)} onConfirm={async () => { await backend.deleteRecord(del); setDel(null); list.reload(); }} icon={<LuTrash2 />} />}
    </>
  );
}

export function PhotoCompare({ first, last, lang }: { first: PatientRecord<PhotoData>; last: PatientRecord<PhotoData>; lang: string }) {
  const days = Math.max(0, Math.round((new Date(last.at).getTime() - new Date(first.at).getTime()) / 86400000));
  return (
    <div className="photo-compare" data-testid="ph-compare-view">
      {[first, last].map((r, i) => (
        <figure key={r.id}><img src={r.data.image} alt={`${i ? 'Latest' : 'First'} ${fmtDay(r.at, lang)}`} /><figcaption className="tiny"><b>{i ? (lang === 'ar' ? 'الأخيرة' : 'Latest') : (lang === 'ar' ? 'الأولى' : 'First')}</b> · <span data-no-tr>{fmtDay(r.at, lang)}</span>{r.data.note && <span data-no-tr> · {r.data.note}</span>}</figcaption></figure>
      ))}
      <p className="tiny muted" style={{ gridColumn: '1 / -1' }}>{lang === 'ar' ? `${days} يوم بين الصورتين. للمقارنة بالعين بس — مش تقييم.` : `${days} day(s) apart. For comparing by eye only — not an assessment.`}</p>
    </div>
  );
}

// ---------------------------------------------------------------- emergency card
const SHORT: Partial<Record<keyof CardData, [string, string]>> = { medicines: ['Medicines', 'الأدوية'], bloodType: ['Blood type', 'فصيلة الدم'], notes: ['Notes', 'ملاحظات'] };
const CARD_FIELDS: { k: keyof CardData; en: string; ar: string; multiline?: boolean; hintEn?: string; hintAr?: string }[] = [
  { k: 'allergies', en: 'Allergies', ar: 'الحساسية', multiline: true, hintEn: 'e.g. Penicillin (rash). Write "None known" if none.', hintAr: 'مثلًا: بنسلين (طفح). اكتب "مفيش" لو مفيش.' },
  { k: 'medicines', en: 'Medicines I take', ar: 'الأدوية اللي باخدها', multiline: true },
  { k: 'conditions', en: 'Conditions', ar: 'أمراض مزمنة', multiline: true, hintEn: 'e.g. Diabetes, asthma', hintAr: 'مثلًا: سكر، ربو' },
  { k: 'bloodType', en: 'Blood type (if known)', ar: 'فصيلة الدم (لو عارفها)' },
  { k: 'contactName', en: 'Emergency contact name', ar: 'اسم حد نكلمه في الطوارئ' },
  { k: 'contactPhone', en: 'Emergency contact phone', ar: 'رقم تليفونه' },
  { k: 'notes', en: 'Other notes for paramedics', ar: 'ملاحظات تانية للإسعاف', multiline: true, hintEn: 'e.g. I am blind / deaf; I use a pacemaker', hintAr: 'مثلًا: أنا كفيف / أصم؛ عندي جهاز منظم ضربات' },
];

export function cardText(card: CardData, name: string, lang: 'en' | 'ar'): string {
  const lines = [lang === 'ar' ? 'كارت طوارئ — AccessCare' : 'EMERGENCY CARD — AccessCare', `${lang === 'ar' ? 'الاسم' : 'Name'}: ${name}`];
  for (const f of CARD_FIELDS) if (card[f.k]) lines.push(`${lang === 'ar' ? f.ar : f.en.replace(' (if known)', '')}: ${card[f.k]}`);
  lines.push(lang === 'ar' ? 'كتبه المريض بنفسه. مش سجل طبي.' : 'Written by the patient. Not a medical record.');
  return lines.join('\n');
}

export function EmergencyCardScreen() {
  const { nav, backend, me, toast } = useApp();
  const { L, lang } = useL();
  const rec = useLoad(() => backend.listRecords('card'), []);
  const saved = (rec.data?.[0]?.data as CardData | undefined) ?? null;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<CardData>({ allergies: '', medicines: '', conditions: '', bloodType: '', contactName: '', contactPhone: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  const [qrLang, setQrLang] = useState<'en' | 'ar'>('en');
  useEffect(() => { if (saved) setF(saved); else if (rec.data) setEdit(true); }, [rec.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const fillMeds = async () => {
    const md = await loadMedData(backend);
    const list = md.plans.filter((p) => p.active).map((p) => `${p.name} ${p.dose}`.trim());
    if (!list.length) { toast(L('No active prescriptions to add.', 'مفيش روشتات شغالة أضيفها.')); return; }
    setF((x) => ({ ...x, medicines: [...new Set([...x.medicines.split(/\n|,\s*/).filter(Boolean), ...list])].join(', ') }));
  };
  const save = async () => {
    if (!cleanCard(f)) { toast(L('Fill in at least one field.', 'املا خانة واحدة على الأقل.')); return; }
    setBusy(true);
    try { await backend.addRecord('card', f); toast(L('Emergency card saved', 'كارت الطوارئ اتحفظ')); setEdit(false); rec.reload(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const name = me?.profile.fullName ?? '';
  const text = saved ? cardText(saved, name, qrLang) : '';
  const qr = useMemo(() => { if (!text) return null; try { return qrPath(qrMatrix(text)); } catch { return null; } }, [text]);

  return (
    <>
      <TopBar title={L('Emergency card', 'كارت الطوارئ')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('What paramedics need to know if you cannot tell them. The QR code holds the text itself, so any phone camera can read it — no internet or account needed. Only you can see or change this card; it is not shared with anyone.', 'اللي الإسعاف محتاج يعرفه لو مقدرتش تقوله. كود QR فيه الكلام نفسه، فأي كاميرا موبايل تقراه — من غير نت ولا حساب. إنت بس اللي تشوف الكارت ده أو تغيّره؛ مش متشارك مع حد.')}</p>
        {rec.loading && !rec.data ? <Skeleton rows={2} /> : edit ? (
          <section className="card raised" aria-labelledby="card-edit">
            <h2 className="title" id="card-edit">{L('My emergency information', 'معلومات الطوارئ بتاعتي')}</h2>
            {CARD_FIELDS.map((x) => (
              <Field key={x.k} id={`card-${x.k}`} label={L(x.en, x.ar)} hint={x.hintEn ? L(x.hintEn, x.hintAr!) : undefined} multiline={x.multiline} value={f[x.k]} onChange={(v) => setF((c) => ({ ...c, [x.k]: v }))} inputMode={x.k === 'contactPhone' ? 'tel' : undefined} maxLength={x.k === 'bloodType' ? 8 : 300} />
            ))}
            <Button variant="secondary" onClick={() => void fillMeds()} data-testid="card-fill-meds">{L('Add my prescribed medicines', 'ضيف الأدوية اللي في روشتاتي')}</Button>
            <div className="row wrap">
              {saved && <Button variant="secondary" onClick={() => { setF(saved); setEdit(false); }}>{L('Cancel', 'إلغاء')}</Button>}
              <Button className="grow" onClick={save} busy={busy} data-testid="card-save"><LuSave aria-hidden /> {L('Save card', 'احفظ الكارت')}</Button>
            </div>
          </section>
        ) : saved ? (
          <>
            <section className="card raised em-card" aria-labelledby="em-h" data-testid="em-card">
              <h2 className="title" id="em-h"><LuSiren aria-hidden /> {L('Emergency card', 'كارت الطوارئ')}</h2>
              <dl className="em-list">
                <dt>{L('Name', 'الاسم')}</dt><dd data-no-tr>{name}</dd>
                {CARD_FIELDS.filter((x) => saved[x.k] && x.k !== 'contactName' && x.k !== 'contactPhone').map((x) => <React.Fragment key={x.k}><dt>{L(...(SHORT[x.k] ?? [x.en, x.ar]))}</dt><dd data-no-tr dir="auto">{saved[x.k]}</dd></React.Fragment>)}
                {(saved.contactName || saved.contactPhone) && <><dt>{L('Emergency contact', 'رقم الطوارئ')}</dt><dd data-no-tr dir="auto">{saved.contactName}{saved.contactPhone && <> <a href={`tel:${saved.contactPhone.replace(/[^\d+]/g, '')}`} dir="ltr"><LuPhone aria-hidden /> {saved.contactPhone}</a></>}</dd></>}
              </dl>
              <div className="seg" role="group" aria-label={L('QR code language', 'لغة كود QR')}>
                <button aria-pressed={qrLang === 'en'} onClick={() => setQrLang('en')}>English</button><button aria-pressed={qrLang === 'ar'} onClick={() => setQrLang('ar')}>عربي</button>
              </div>
              {qr ? <QrSvg d={qr.d} size={qr.size} label={L('QR code with this emergency card', 'كود QR فيه كارت الطوارئ')} /> : <p className="small warn-text">{L('The card is too long for a QR code — shorten the notes.', 'الكارت طويل على كود QR — قصّر الملاحظات.')}</p>}
              <Button big block onClick={() => setFull(true)} data-testid="card-full"><LuMaximize aria-hidden /> {L('Show to paramedic', 'وريه للإسعاف')}</Button>
              <div className="grid2">
                {ttsSupported() && <Button variant="secondary" onClick={() => speak(cardText(saved, name, lang === 'ar' ? 'ar' : 'en'))}><LuVolume2 aria-hidden /> {L('Read aloud', 'اقراه بصوت')}</Button>}
                <Button variant="secondary" onClick={() => setEdit(true)} data-testid="card-edit">{L('Edit', 'عدّل')}</Button>
              </div>
            </section>
            <p className="tiny muted">{L('Written by you; it is not checked by a doctor. Keep it up to date.', 'إنت اللي كاتبه؛ ومش متراجع من دكتور. خليه محدّث.')}</p>
          </>
        ) : null}
      </div></div>
      {full && saved && (
        <div className="em-full" role="dialog" aria-modal="true" aria-label={L('Emergency card', 'كارت الطوارئ')} data-testid="em-full">
          <button className="iconbtn em-close" onClick={() => setFull(false)} aria-label={L('Close', 'اقفل')}><LuX /></button>
          <h2>{qrLang === 'ar' ? 'كارت طوارئ' : 'EMERGENCY CARD'}</h2>
          <pre dir="auto" data-no-tr>{text}</pre>
          {qr && <QrSvg d={qr.d} size={qr.size} label="QR" big />}
        </div>
      )}
    </>
  );
}

function QrSvg({ d, size, label, big }: { d: string; size: number; label: string; big?: boolean }) {
  return (
    <svg className={`qr ${big ? 'big' : ''}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" data-testid="em-qr">
      <rect width={size} height={size} fill="#fff" /><path d={d} fill="#000" />
    </svg>
  );
}

// ---------------------------------------------------------------- caregivers
export function CaregiversScreen() {
  const { nav, backend, toast } = useApp();
  const { L } = useL();
  const list = useLoad(() => backend.listMyCaregivers(), []);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<{ name: string; code: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<{ id: string; name: string } | null>(null);

  const find = async () => {
    setErr('');
    const c = normalizeCaregiverId(code);
    if (!CAREGIVER_ID_PATTERN.test(c)) { setErr(L('A Caregiver ID looks like CG-ABCD-2345.', 'رقم المرافق شكله كده: CG-ABCD-2345.')); return; }
    setBusy(true);
    try { setFound({ name: (await backend.lookupCaregiver(c)).name, code: c }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const link = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await backend.connectCaregiver(found.code);
      toast(L(`${found.name} can now help you`, `${found.name} يقدر يساعدك دلوقتي`));
      setFound(null); setCode(''); list.reload();
      window.dispatchEvent(new Event('accesscare:care-changed'));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar title={L('Caregivers', 'المرافقين')} onBack={nav.back} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('A caregiver is someone you trust — family or a helper — with their own AccessCare caregiver account. You decide who; you can remove them any time.', 'المرافق حد بتثق فيه — من عيلتك أو حد بيساعدك — وليه حساب مرافق في AccessCare. إنت اللي بتختار، وتقدر تشيله في أي وقت.')}</p>
        <section className="card" aria-labelledby="cg-what">
          <h2 className="title" id="cg-what">{L('What a caregiver sees and does', 'المرافق بيشوف ويعمل إيه')}</h2>
          <ul className="small guide-list">
            <li>{L('Sees: your medicines and today’s doses, how you felt this week, your doctor’s latest replies, alerts, and your emergency card.', 'بيشوف: أدويتك وجرعات النهارده، حسيت بإيه الأسبوع ده، آخر ردود دكتورك، التنبيهات، وكارت الطوارئ.')}</li>
            <li>{L('Can record: a dose they gave you, or a note — marked with their name in your records.', 'يقدر يسجّل: جرعة إداهالك، أو ملاحظة — متعلّمة باسمه في سجلك.')}</li>
            <li>{L('Cannot: send reports, read your private messages in full, or change anything of yours.', 'مايقدرش: يبعت تقارير، يقرا رسايلك كلها، أو يغيّر أي حاجة بتاعتك.')}</li>
            <li>{L('Their view updates when your AccessCare app is open.', 'اللي بيشوفه بيتحدّث لما تطبيق AccessCare بتاعك يكون مفتوح.')}</li>
          </ul>
        </section>
        <section className="card raised" aria-labelledby="cg-add">
          <h2 className="title" id="cg-add"><LuUserPlus aria-hidden /> {L('Add a caregiver', 'ضيف مرافق')}</h2>
          <Field id="cg-code" label={L('Their Caregiver ID', 'رقم المرافق')} hint={L('They find it on their caregiver account’s home screen.', 'هيلاقيه في الصفحة الرئيسية لحساب المرافق بتاعه.')} value={code} onChange={(v) => { setCode(v); setFound(null); }} mono placeholder="CG-ABCD-2345" />
          {err && <p className="small danger-text" role="alert">{err}</p>}
          <Button block onClick={find} busy={busy && !found} disabled={!code.trim()} data-testid="cg-find">{L('Find', 'دوّر')}</Button>
        </section>
        {list.loading && !list.data ? <Skeleton rows={1} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data?.length ? (
          <>
            <h3 className="section">{L('My caregivers', 'المرافقين بتوعي')}</h3>
            <div className="list">{list.data.map((c) => (
              <div key={c.id} className="list-item" data-testid="cg-row">
                <span className="care-ico sm tone-green"><LuHeartHandshake aria-hidden /></span>
                <div className="grow"><b data-no-tr>{c.name}</b><div className="tiny muted" data-no-tr>{c.caregiverId}</div></div>
                <Button variant="secondary" onClick={() => setRemove({ id: c.id, name: c.name })} data-testid="cg-remove">{L('Remove', 'شيله')}</Button>
              </div>
            ))}</div>
            <Button variant="secondary" onClick={() => { window.dispatchEvent(new Event('accesscare:care-changed')); toast(L('Caregiver view updated', 'اتحدّث اللي بيشوفه المرافق')); }} data-testid="cg-sync"><LuRefreshCw aria-hidden /> {L('Update their view now', 'حدّث اللي بيشوفوه دلوقتي')}</Button>
          </>
        ) : null}
      </div></div>
      {found && (
        <ConfirmSheet title={L(`Let ${found.name} help you?`, `تخلي ${found.name} يساعدك؟`)} confirmLabel={L('Yes, add as my caregiver', 'أيوه، ضيفه كمرافق')} onCancel={() => setFound(null)} onConfirm={() => void link()} busy={busy} icon={<LuHeartHandshake />}
          body={<p>{L('They will see your medicines, this week’s check-ins, your doctor’s latest replies, alerts and your emergency card, and can record doses for you.', 'هيشوف أدويتك وتسجيلات الأسبوع وآخر ردود دكتورك والتنبيهات وكارت الطوارئ، ويقدر يسجّل جرعات ليك.')}</p>} />
      )}
      {remove && (
        <ConfirmSheet danger title={L(`Remove ${remove.name}?`, `تشيل ${remove.name}؟`)} confirmLabel={L('Remove', 'شيله')} onCancel={() => setRemove(null)} icon={<LuTrash2 />}
          body={<p>{L('They will no longer see anything or record anything for you.', 'مش هيشوف أي حاجة ولا يسجّل حاجة ليك بعد كده.')}</p>}
          onConfirm={async () => { await backend.removeCaregiver(remove.id); setRemove(null); list.reload(); }} />
      )}
    </>
  );
}

export function useBanner() { return Banner; }
