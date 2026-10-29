// Live visit interpreter (patient's phone or the doctor's screen, in the clinic).
// Each side speaks or types; Claude translates one turn at a time; the
// translation is shown large and read aloud in the other language. Nothing is
// recorded: speech becomes text in the browser and only the text is translated.
// A transcript is saved to a consultation only if both people agree.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LuMic, LuMicOff, LuVolume2, LuArrowLeftRight, LuTriangleAlert, LuSave, LuSend, LuLanguages, LuTrash2 } from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Sheet, TopBar } from '../../ui/components';
import { Listener, sttSupported, errText, bestVoice, ttsAvailable, LOCALE } from '../../services/voice/Speech';
import { LANGS, tr, getLang, isRtl } from '../../i18n/lang';
import { applyTranslation, interpPrompt, transcriptText, type ILang } from '../../services/care/interpret';
import { AIStatus } from '../shared/AIStatus';
import { useL } from './MedScreens';

interface Line { id: number; speaker: 'patient' | 'doctor'; from: ILang; to: ILang; source: string; translation: string; unclear: boolean; numbersOk: boolean; at: string; pending?: boolean; failed?: string }

function say(text: string, lang: ILang) {
  if (!ttsAvailable()) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LOCALE[lang];
    const v = bestVoice(lang); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* speech not available */ }
}

export function InterpreterScreen({ cid }: { cid?: string }) {
  const { nav, ai, me, prefs, backend, toast } = useApp();
  const { L } = useL();
  const isDoctor = me?.profile.role === 'doctor';
  // the patient's language starts as the app's language (Arabic when the app is in English); the doctor's as English
  const [pLang, setPLang] = useState<ILang>(() => (getLang() === 'en' ? 'ar' : getLang()));
  const [dLang, setDLang] = useState<ILang>('en');
  const swap = () => { setPLang(dLang); setDLang(pLang); };
  const [lines, setLines] = useState<Line[]>([]);
  const [typed, setTyped] = useState<{ patient: string; doctor: string }>({ patient: '', doctor: '' });
  const [listening, setListening] = useState<'patient' | 'doctor' | null>(null);
  const [micErr, setMicErr] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTo, setSaveTo] = useState(cid ?? '');
  const [both, setBoth] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const listener = useMemo(() => new Listener(() => {}), []);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const consults = useLoad(() => (cid ? Promise.resolve([]) : backend.listConsultations().then((l) => l.filter((v) => v.consultation.status !== 'draft' && v.consultation.status !== 'cancelled'))), [cid]);
  useEffect(() => () => { listener.stop(); try { speechSynthesis.cancel(); } catch { /* */ } }, [listener]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [lines.length]);

  // AI use: the patient's own AI setting; on the doctor's screen, the patient's spoken agreement (checkbox)
  const patientAiOk = !isDoctor && ai.state(prefs.aiAssist) === 'available';
  const ready = ai.supported && (isDoctor ? agreed : patientAiOk);

  const translate = async (speaker: 'patient' | 'doctor', text: string) => {
    const src = text.trim(); if (!src) return;
    const from = speaker === 'patient' ? pLang : dLang, to = speaker === 'patient' ? dLang : pLang;
    const id = ++idRef.current;
    setLines((ls) => [...ls, { id, speaker, from, to, source: src, translation: '', unclear: false, numbersOk: true, at: new Date().toISOString(), pending: true }]);
    const r = await ai.clinical(interpPrompt(src, from, to, speaker), 700);
    const t = 'json' in r ? applyTranslation(src, r.json) : null;
    setLines((ls) => ls.map((l) => (l.id !== id ? l : t ? { ...l, ...t, translation: t.text, pending: false } : { ...l, pending: false, failed: 'error' in r ? r.error : L('The translation was not usable. Say it again.', 'الترجمة مكانتش سليمة. قولها تاني.') })));
    if (t && readAloud) say(t.text, to);
  };

  const listen = async (speaker: 'patient' | 'doctor') => {
    setMicErr('');
    if (listening) { listener.stop(); setListening(null); return; }
    setListening(speaker);
    try { speechSynthesis.cancel(); } catch { /* */ }
    const r = await listener.listen(speaker === 'patient' ? pLang : dLang, 15000);
    setListening(null);
    if ('error' in r) { if (r.error !== 'aborted') setMicErr(errText(r.error, speaker === 'patient' ? pLang : dLang)); return; }
    await translate(speaker, r.text);
  };

  const send = (speaker: 'patient' | 'doctor') => { const t = typed[speaker]; setTyped({ ...typed, [speaker]: '' }); void translate(speaker, t); };
  const done = lines.filter((l) => !l.pending && !l.failed);

  const save = async () => {
    if (!saveTo || !both || !done.length) return;
    setBusySave(true);
    try {
      await backend.sendMessage(saveTo, transcriptText(done, isDoctor ? 'en' : pLang), 'text');
      toast(L('Transcript saved to the consultation', 'نص الترجمة اتحفظ في الاستشارة'));
      setSaveOpen(false);
    } catch (e) { toast((e as Error).message); } finally { setBusySave(false); }
  };

  const side = (who: 'patient' | 'doctor') => {
    const lang = who === 'patient' ? pLang : dLang;
    const label = who === 'patient' ? tr('Patient', 'المريض', lang) : tr('Doctor', 'الطبيب', lang);
    const hint = tr('Speak English', 'اتكلم بالعربي', lang);
    const setL = who === 'patient' ? setPLang : setDLang;
    return (
      <div className={`interp-side side-${who}`} dir={isRtl(lang) ? 'rtl' : 'ltr'} lang={lang} data-testid={`interp-${who}`}>
        <div className="row between"><b data-no-tr>{label}</b>
          <select className="input interp-lang" value={lang} onChange={(e) => setL(e.target.value as ILang)} aria-label={`${label}: ${tr('language', 'اللغة', lang)}`} data-no-tr data-testid={`interp-lang-${who}`}>
            {LANGS.map((x) => <option key={x.id} value={x.id} lang={x.id}>{x.native}</option>)}
          </select></div>
        {sttSupported() && <Button big block variant={who === 'doctor' ? 'navy' : 'primary'} disabled={!ready || (!!listening && listening !== who)} onClick={() => void listen(who)} aria-pressed={listening === who} data-testid={`interp-mic-${who}`}>
          {listening === who ? <><LuMicOff aria-hidden /> <span data-no-tr>{tr('Listening… tap when done', 'بسمعك… دوس لما تخلص', lang)}</span></> : <><LuMic aria-hidden /> <span data-no-tr>{hint}</span></>}
        </Button>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); send(who); }}>
          <input className="input grow" dir="auto" value={typed[who]} onChange={(e) => setTyped({ ...typed, [who]: e.target.value })} placeholder={tr('or type here', 'أو اكتب هنا', lang)} aria-label={`${label}: ${tr('type', 'اكتب', lang)}`} disabled={!ready} maxLength={1200} data-testid={`interp-type-${who}`} data-no-tr />
          <button className="iconbtn" type="submit" disabled={!ready || !typed[who].trim()} aria-label={tr('Translate', 'ترجم', lang)} data-testid={`interp-send-${who}`}><LuSend /></button>
        </form>
      </div>
    );
  };

  return (
    <>
      <TopBar title={L('Visit interpreter', 'مترجم الزيارة')} onBack={nav.back} right={<button className="iconbtn" onClick={swap} aria-label={L('Swap languages', 'بدّل اللغات')} data-testid="interp-swap"><LuArrowLeftRight /></button>} />
      <div className="screen screen-in"><div className="pad">
        <p className="small muted">{L('For a visit in person: each of you speaks in your own language, one at a time. Claude translates; the translation is shown large and read aloud. Nothing is recorded.', 'لزيارة في العيادة: كل واحد يتكلم بلغته، واحد واحد. Claude بيترجم، والترجمة بتظهر كبيرة وبتتقري بصوت. مفيش تسجيل.')}</p>
        {isDoctor ? (
          <label className="row small card" style={{ gap: 8 }}><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="interp-agree" />
            <span>{L('The patient agreed that what we say is sent to Claude (AI) for translation.', 'المريض وافق إن كلامنا يتبعت لـ Claude (ذكاء اصطناعي) للترجمة.')}</span></label>
        ) : <AIStatus on={L('Claude translates; numbers are checked in every translation.', 'Claude بيترجم، والأرقام بتتراجع في كل ترجمة.')} />}
        {!ai.supported && <Banner kind="warn">{L('Translation needs the AI service, which is not available in this view.', 'الترجمة محتاجة خدمة الذكاء الاصطناعي، ومش متاحة في العرض ده.')}</Banner>}
        <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} /><span><LuVolume2 aria-hidden /> {L('Read each translation aloud', 'اقرا كل ترجمة بصوت')}</span></label>
        <div className="interp-sides">{side('patient')}{side('doctor')}</div>
        {micErr && <p className="small danger-text" role="alert">{micErr}</p>}

        <div className="interp-log" aria-live="polite" data-testid="interp-log">
          {lines.map((l) => (
            <div key={l.id} className={`interp-line from-${l.speaker}`} data-testid="interp-line">
              <p className="tiny muted" dir="auto" data-no-tr><b>{l.speaker === 'patient' ? tr('Patient', 'المريض', l.from) : tr('Doctor', 'الطبيب', l.from)}:</b> {l.source}</p>
              {l.pending ? <p className="small" role="status">{L('Translating…', 'بترجم…')}</p> : l.failed ? <p className="small danger-text" data-no-tr>{l.failed}</p> : (
                <>
                  <p className="interp-tr" dir={isRtl(l.to) ? 'rtl' : 'ltr'} lang={l.to} data-no-tr data-testid="interp-tr">{l.translation}</p>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className="linkbtn small" onClick={() => say(l.translation, l.to)}><LuVolume2 aria-hidden /> {L('Say again', 'قولها تاني')}</button>
                    {!l.numbersOk && <span className="small warn-text" data-testid="interp-numbers"><LuTriangleAlert aria-hidden /> {L('Numbers differ — check doses and times together.', 'الأرقام مختلفة — راجعوا الجرعات والمواعيد مع بعض.')}</span>}
                    {l.unclear && <span className="small warn-text"><LuTriangleAlert aria-hidden /> {L('Part was unclear — say it again.', 'جزء مكانش واضح — قولوه تاني.')}</span>}
                  </div>
                </>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {!lines.length && <p className="small muted" style={{ textAlign: 'center' }}><LuLanguages aria-hidden /> {L('The conversation appears here.', 'الكلام هيظهر هنا.')}</p>}
        <p className="tiny muted">{L('AI translation can make mistakes. For consent, diagnosis or anything serious, confirm understanding — and use a professional interpreter when one is available.', 'ترجمة الذكاء الاصطناعي ممكن تغلط. في الموافقات أو التشخيص أو أي حاجة مهمة، اتأكدوا إنكم فاهمين — واستخدموا مترجم متخصص لو موجود.')}</p>
        {done.length > 0 && (
          <div className="row wrap">
            <Button variant="secondary" onClick={() => setSaveOpen(true)} data-testid="interp-save"><LuSave aria-hidden /> {L('Save transcript…', 'احفظ النص…')}</Button>
            <Button variant="secondary" onClick={() => setLines([])} data-testid="interp-clear"><LuTrash2 aria-hidden /> {L('Clear', 'امسح')}</Button>
          </div>
        )}
      </div></div>
      {saveOpen && (
        <Sheet title={L('Save the transcript?', 'تحفظ النص؟')} onClose={() => setSaveOpen(false)} icon={<LuSave />}>
          <p className="small">{L('It is added as a message to the consultation, labelled as an AI translation. Both of you will see it.', 'هيتضاف كرسالة في الاستشارة، ومكتوب إنه ترجمة بالذكاء الاصطناعي. انتو الاتنين هتشوفوه.')}</p>
          {!cid && (
            <label className="stack small"><span className="strong">{L('Consultation', 'الاستشارة')}</span>
              <select className="input" value={saveTo} onChange={(e) => setSaveTo(e.target.value)} data-testid="interp-save-to">
                <option value="">{L('Choose…', 'اختار…')}</option>
                {(consults.data ?? []).map((v) => <option key={v.consultation.id} value={v.consultation.id}>{(v.consultation.approved?.report.regions.join(', ') || L('Consultation', 'استشارة'))} · {new Date(v.consultation.createdAt).toLocaleDateString()}</option>)}
              </select>
              {consults.data && !consults.data.length && <span className="muted">{L('No sent consultation to save it to.', 'مفيش استشارة متبعتة أحفظه فيها.')}</span>}
            </label>
          )}
          <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} data-testid="interp-both" /><span>{L('We both agree to save it.', 'إحنا الاتنين موافقين نحفظه.')}</span></label>
          <Button block big onClick={() => void save()} busy={busySave} disabled={!both || !saveTo} data-testid="interp-save-ok">{L('Save to the consultation', 'احفظه في الاستشارة')}</Button>
          <Button variant="secondary" block onClick={() => setSaveOpen(false)}>{L('Cancel', 'إلغاء')}</Button>
        </Sheet>
      )}
    </>
  );
}
