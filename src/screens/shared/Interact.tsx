// "Here?" (doctor points at the body, patient answers) and the teach-back check.
import React, { useMemo, useState } from 'react';
import { LuCrosshair, LuCircleCheck, LuMic, LuMicOff, LuVolume2, LuGraduationCap, LuTriangleAlert, LuCircleHelp } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, Button, fmtDate, speak, ttsSupported } from '../../ui/components';
import { BodySelector } from '../../body/BodySelector';
import { regionLabel, regionLabelIn } from '../../domain/bodyRegions';
import type { Message, MessageMeta } from '../../domain/types';
import type { ProbeAnswer, TBPoint } from '../../domain/interact';
import { useLang, tr, pick, listSep, type Lang } from '../../i18n/lang';
import { Listener, sttSupported, errText } from '../../services/voice/Speech';
import { translateTo } from '../../i18n/dict';
import { AIStatus } from './AIStatus';
import { planPoints, planSource, checkTeachBack } from '../../services/teachback/check';
import { randomId } from '../../services/crypto';

type Send = (body: string, kind: Message['kind'], meta: MessageMeta) => Promise<boolean>;
/** a doctor's question chosen from the list, in the screen's language (a typed question stays as written) */
const qText = (q: string, qAr: string | undefined, lang: Lang) => (lang === 'ar' ? qAr ?? q : lang === 'en' ? q : translateTo(q, lang) ?? q);
const regionsText = (ids: string[], lang: Lang) => ids.map((r) => (lang === 'en' ? regionLabel(r) : regionLabelIn(r, lang))).join(lang === 'ar' ? ' و' : listSep(lang));
const QUESTIONS: { en: string; ar: string }[] = [
  { en: 'Does it hurt here?', ar: 'بيوجعك هنا؟' },
  { en: 'Do you feel numbness or tingling here?', ar: 'حاسس بتنميل هنا؟' },
  { en: 'Is it swollen here?', ar: 'فيه تورم هنا؟' },
  { en: 'Is this where it started?', ar: 'هو بدأ من هنا؟' },
];
const ANS: Record<ProbeAnswer['answer'], { en: string; ar: string }> = { yes: { en: 'Yes', ar: 'أيوه' }, no: { en: 'No', ar: 'لأ' }, not_sure: { en: 'Not sure', ar: 'مش متأكد' } };

// ---------------------------------------------------------------- doctor: point and ask
export function ProbeComposer({ onSend }: { onSend: (body: string, meta: MessageMeta) => Promise<boolean> }) {
  const lang = useLang();
  const [regions, setRegions] = useState<string[]>([]);
  const [q, setQ] = useState(0);
  const [askStrength, setAskStrength] = useState(true);
  const question = QUESTIONS[q].en;
  return (
    <div className="card tinted" style={{ gap: 10 }} data-testid="probe-composer">
      <b><LuCrosshair aria-hidden /> {tr('Point on the body and ask', 'شاور على الجسم واسأل', lang)}</b>
      <p className="small muted">{tr('Tap the area. The same area lights up on the patient’s body map, and they answer with a tap, their voice or signs.', 'المس المنطقة. نفس المنطقة بتنوّر على خريطة جسم المريض، وهو بيرد بلمسة أو بصوته أو بالإشارة.', lang)}</p>
      <BodySelector selected={regions} onChange={(ids) => setRegions(ids.slice(-3))} />
      <div className="field"><label htmlFor="probe-q">{tr('Question', 'السؤال', lang)}</label>
        <select id="probe-q" className="input" value={q} onChange={(e) => setQ(Number(e.target.value))} data-testid="probe-question">
          {QUESTIONS.map((x, k) => <option key={k} value={k}>{pick(x, lang)}</option>)}
        </select></div>
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={askStrength} onChange={(e) => setAskStrength(e.target.checked)} /> {tr('If yes, ask how strong (0–10)', 'لو أيوه، اسأل عن الشدة (٠–١٠)', lang)}</label>
      <Button disabled={!regions.length} data-testid="probe-send"
        onClick={async () => { if (await onSend(`${question} — ${regions.map(regionLabel).join(', ')}`, { probe: { id: randomId('pb_'), regions, question, askStrength } })) setRegions([]); }}>
        <LuCrosshair aria-hidden /> {tr('Send to the patient', 'ابعت للمريض', lang)}{regions.length ? ` (${regionsText(regions, lang)})` : ''}</Button>
    </div>
  );
}

export function ProbeRequestBubble({ m, answer, isDoctor }: { m: Message; answer?: Message; isDoctor: boolean }) {
  const lang = useLang();
  const p = m.meta!.probe!;
  const a = answer?.meta?.probeAnswer;
  const qAr = QUESTIONS.find((x) => x.en === p.question)?.ar;
  return (
    <div className={`bubble ${isDoctor ? 'me' : 'them'} question`} data-kind="body_probe" data-testid="probe-bubble">
      <b className="bubble-tag"><LuCrosshair aria-hidden /> {tr('Here?', 'هنا؟', lang)} · {regionsText(p.regions, lang)}</b>
      <span data-no-tr>{qText(p.question, qAr, lang)}</span>
      <span className="meta">{a ? tr('Answered', 'اتجاوب', lang) : tr('Waiting for the answer', 'مستني الرد', lang)} · {fmtDate(m.createdAt)}</span>
    </div>
  );
}

export function ProbeAnswerBubble({ m, isDoctor }: { m: Message; isDoctor: boolean }) {
  const lang = useLang();
  const a = m.meta!.probeAnswer!;
  return (
    <div className={`card flat ${a.answer === 'yes' && (a.strength ?? 0) >= 7 ? 'cie-warn warn' : ''}`} style={{ gap: 6 }} data-kind="body_probe_answer" data-testid="probe-answer">
      <b className="bubble-tag">{isDoctor ? tr('Answer · approved by the patient', 'الرد · وافق عليه المريض', lang) : tr('Your answer', 'ردك', lang)}</b>
      <div data-no-tr><b>{regionsText(a.regions, lang)}</b>: {pick(ANS[a.answer], lang)}{a.strength !== null ? ` · ${a.strength}/10` : ''}</div>
      <span className="meta">{tr('via', 'عن طريق', lang)} {a.via} · {fmtDate(m.createdAt)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- patient: answer "Here?"
export function ProbeAnswerFlow({ request, onSend }: { request: Message; onSend: Send }) {
  const lang = useLang();
  const p = request.meta!.probe!;
  const qAr = QUESTIONS.find((x) => x.en === p.question)?.ar;
  const question = qText(p.question, qAr, lang);
  const [answer, setAnswer] = useState<ProbeAnswer['answer'] | null>(null);
  const [strength, setStrength] = useState<number | null>(null);
  const [via, setVia] = useState('buttons');
  const needStrength = answer === 'yes' && p.askStrength;
  const ready = answer && (!needStrength || strength !== null);
  const listener = useMemo(() => new Listener(() => {}), []);
  const [listening, setListening] = useState(false);
  const voice = async () => {
    setListening(true);
    const r = await listener.listen(lang, 9000);
    setListening(false);
    if ('error' in r) return;
    const t = r.text.toLowerCase();
    const n = t.match(/\b(10|[0-9])\b/) ?? t.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).match(/(10|[0-9])/);
    if (/\b(yes|yeah|yep)\b|ايوه|أيوه|اه|نعم|ايوة|أيوة/.test(t)) { setAnswer('yes'); setVia('voice'); }
    else if (/\b(no|nope)\b|لأ|لا\b|لاء/.test(t)) { setAnswer('no'); setVia('voice'); }
    else if (/not sure|مش متأكد|مش متاكد|مش عارف/.test(t)) { setAnswer('not_sure'); setVia('voice'); }
    if (n) { setStrength(Number(n[1])); setVia('voice'); }
  };
  return (
    <div className="card raised" style={{ gap: 12 }} data-testid="probe-card">
      <div className="row"><LuCrosshair style={{ color: 'var(--teal-ink)', fontSize: '1.4em' }} aria-hidden />
        <div className="grow"><div className="tiny muted strong">{tr('Your doctor points at', 'دكتورك بيشاور على', lang)}: {regionsText(p.regions, lang)}</div><b style={{ fontSize: '1.15em' }} data-no-tr>{question}</b></div>
        {ttsSupported() && <button className="iconbtn" onClick={() => speak(`${regionsText(p.regions, lang)}. ${question}`)} aria-label={tr('Read aloud', 'اقرا بصوت', lang)}><LuVolume2 /></button>}</div>
      <BodySelector selected={p.regions} readOnly focus={p.regions[0]} />
      <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {(['yes', 'no', 'not_sure'] as const).map((k) => <button key={k} className={`choice yesno${k === 'yes' ? ' yes' : ''}`} aria-pressed={answer === k} data-option={`probe:${k}`} onClick={() => { setAnswer(k); setVia('buttons'); if (k !== 'yes') setStrength(null); }}>{pick(ANS[k], lang)}</button>)}
      </div>
      {needStrength && (
        <div className="stack" style={{ gap: 6 }}>
          <b className="small">{tr('How strong is it, from 0 to 10?', 'قد إيه شديد، من ٠ لـ ١٠؟', lang)}</b>
          <div className="scale" style={{ gridTemplateColumns: 'repeat(11, 1fr)' }} role="radiogroup" aria-label={tr('Strength', 'الشدة', lang)}>{Array.from({ length: 11 }, (_, v) => <button key={v} role="radio" aria-checked={strength === v} onClick={() => setStrength(v)} data-option={`strength:${v}`}>{v}</button>)}</div>
        </div>
      )}
      {sttSupported() && <Button variant="secondary" onClick={voice} disabled={listening}>{listening ? <><LuMicOff aria-hidden /> {tr('Listening…', 'بسمعك…', lang)}</> : <><LuMic aria-hidden /> {tr('Answer by voice (e.g. “yes, 6”)', 'رد بصوتك (مثلًا "أيوه، ٦")', lang)}</>}</Button>}
      {ready && <div className="pre" data-testid="probe-review" data-no-tr>{regionsText(p.regions, lang)}: {pick(ANS[answer!], lang)}{strength !== null && answer === 'yes' ? ` · ${strength}/10` : ''}</div>}
      <Button big disabled={!ready} data-testid="probe-approve" onClick={() => onSend(`${p.question} ${ANS[answer!].en}${strength !== null && answer === 'yes' ? `, ${strength}/10` : ''}`, 'body_probe_answer',
        { probeAnswer: { replyTo: request.id, answer: answer!, strength: answer === 'yes' ? strength : null, regions: p.regions, via, approvedByPatient: true } })}>
        <LuCircleCheck aria-hidden /> {tr('Send my answer', 'ابعت ردي', lang)}</Button>
    </div>
  );
}

// ---------------------------------------------------------------- teach-back
const ST_LABEL = { understood: { en: 'Understood', ar: 'فاهمها' }, different: { en: 'Different from your doctor’s plan', ar: 'مختلف عن خطة دكتورك' }, missing: { en: 'Not mentioned', ar: 'ماتكلمتش عنها' } };
const POINT_AR: Record<string, string> = { 'Which medicine': 'اسم الدوا', 'When to get urgent help': 'إمتى تطلب مساعدة عاجلة', 'How much each time': 'الجرعة كل مرة', 'How often': 'كام مرة في اليوم', 'For how long': 'لمدة قد إيه' };
const pointLabel = (p: TBPoint, lang: Lang) => (lang === 'en' ? p.label : lang !== 'ar' ? translateTo(p.label, lang) ?? p.label : POINT_AR[p.label] ?? p.label.replace(': how much each time', ': الجرعة كل مرة').replace(': how often', ': كام مرة في اليوم').replace(': for how long', ': لمدة قد إيه'));

export function TeachBackFlow({ msgs, onSend }: { msgs: Message[]; onSend: Send }) {
  const { ai, prefs } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const points = useMemo(() => planPoints(msgs), [msgs]);
  const src = planSource(msgs);
  const [text, setText] = useState('');
  const [via, setVia] = useState('text');
  const [res, setRes] = useState<{ points: TBPoint[]; ai: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const listener = useMemo(() => new Listener(() => {}), []);
  const [listening, setListening] = useState(false);
  const [micErr, setMicErr] = useState('');
  const aiOn = ai.state(prefs.aiAssist) === 'available';
  if (!src || !points.length) return null;
  const listen = async () => {
    setMicErr(''); setListening(true);
    const r = await listener.listen(lang, 15000);
    setListening(false);
    if ('error' in r) { if (r.error !== 'aborted') setMicErr(errText(r.error, lang)); return; }
    setText((t) => (t ? `${t} ${r.text}` : r.text)); setVia('voice');
  };
  const check = async () => { setBusy(true); try { setRes(await checkTeachBack(text, points, lang, aiOn ? (p) => ai.converse(p) : null)); } finally { setBusy(false); } };
  const ok = res?.points.filter((p) => p.status === 'understood').length ?? 0;
  const readOut = () => {
    if (!res) return;
    speak(res.points.map((p) => `${pointLabel(p, lang)}: ${L(ST_LABEL[p.status].en, ST_LABEL[p.status].ar)}${p.status !== 'understood' ? `. ${L('Your doctor wrote', 'دكتورك كاتب')}: ${p.correct}` : ''}`).join('. '));
  };
  return (
    <div className="card raised" style={{ gap: 12 }} data-testid="teachback-card">
      <div className="row"><LuGraduationCap style={{ color: 'var(--teal-ink)', fontSize: '1.4em' }} aria-hidden />
        <div className="grow"><b style={{ fontSize: '1.1em' }}>{L('Check that you understood your treatment', 'اتأكد إنك فاهم علاجك')}</b>
          <div className="small muted">{L('In your own words, tell me how you will take your medicine and when to get urgent help. I compare it with what your doctor wrote.', 'قولّي بكلامك هتاخد الدوا إزاي وإمتى تطلب مساعدة عاجلة. هقارنه باللي دكتورك كاتبه.')}</div></div></div>
      {!res ? (
        <>
          <label htmlFor="tb-text" className="strong small">{L('My explanation', 'شرحي')}</label>
          <textarea id="tb-text" className="input" dir="auto" value={text} onChange={(e) => { setText(e.target.value); if (via !== 'voice') setVia('text'); }} maxLength={1000} data-testid="teachback-text"
            placeholder={L('e.g. I take one tablet twice a day with food for 5 days…', 'مثلًا: باخد حباية مرتين في اليوم بعد الأكل لمدة ٥ أيام…')} />
          <div className="row wrap">
            {sttSupported() && <Button variant="secondary" onClick={listen} disabled={listening}>{listening ? <><LuMicOff aria-hidden /> {L('Listening…', 'بسمعك…')}</> : <><LuMic aria-hidden /> {L('Say it', 'قولها')}</>}</Button>}
            <Button className="grow" disabled={!text.trim()} busy={busy} onClick={check} data-testid="teachback-check">{L('Check my understanding', 'راجع فهمي')}</Button>
          </div>
          {micErr && <p className="small danger-text" role="alert">{micErr}</p>}
          <AIStatus on={L('Claude AI helps compare your words with the plan; you see every point.', 'ذكاء Claude بيساعد يقارن كلامك بالخطة؛ وإنت شايف كل نقطة.')} />
        </>
      ) : (
        <>
          <p className="strong" data-testid="teachback-score">{L(`${ok} of ${res.points.length} points match your doctor’s plan.`, `${ok} من ${res.points.length} نقاط مطابقة لخطة دكتورك.`)}</p>
          <ul className="change-list" data-testid="teachback-points">{res.points.map((p) => (
            <li key={p.id} className={`change ${p.status === 'different' ? 'urgent' : p.status === 'missing' ? 'attention' : ''}`} data-status={p.status}>
              <div className="stack" style={{ gap: 2 }}>
                <b className="small">{p.status === 'understood' ? <LuCircleCheck aria-hidden /> : p.status === 'different' ? <LuTriangleAlert aria-hidden /> : <LuCircleHelp aria-hidden />} {pointLabel(p, lang)} — {L(ST_LABEL[p.status].en, ST_LABEL[p.status].ar)}</b>
                {p.quote && <span className="small" data-no-tr>{L('You said', 'إنت قلت')}: “<bdi dir="auto">{p.quote}</bdi>”</span>}
                {p.status !== 'understood' && <span className="small" data-no-tr><b>{L('Your doctor wrote', 'دكتورك كاتب')}:</b> <bdi dir="auto">{p.correct}</bdi></span>}
                {p.by === 'ai' && <span className="prov prov-ai">{L('Judged with AI from your words', 'اتقيّمت بالذكاء الاصطناعي من كلامك')}</span>}
              </div>
            </li>
          ))}</ul>
          {res.points.some((p) => p.status === 'different') && <Banner kind="warn">{L('Something you said is different from your doctor’s plan. Follow what your doctor wrote, and ask them if you are unsure. Sending this lets your doctor see it.', 'فيه حاجة قلتها مختلفة عن خطة دكتورك. امشي على اللي دكتورك كاتبه، واسأله لو مش متأكد. لو بعتّ ده دكتورك هيشوفه.')}</Banner>}
          <div className="row wrap">
            {ttsSupported() && <Button variant="secondary" onClick={readOut}><LuVolume2 aria-hidden /> {L('Read it to me', 'اقراهولي')}</Button>}
            <Button variant="secondary" onClick={() => setRes(null)}>{L('Try again', 'جرّب تاني')}</Button>
            <Button className="grow" data-testid="teachback-send" onClick={() => onSend(text.trim(), 'teachback', { teachback: { replyTo: src.id, text: text.trim(), points: res.points, ai: res.ai, approvedByPatient: true } })}>
              <LuCircleCheck aria-hidden /> {L('Send to my doctor', 'ابعت لدكتوري')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

export function TeachBackBubble({ m, isDoctor }: { m: Message; isDoctor: boolean }) {
  const lang = useLang();
  const t = m.meta!.teachback!;
  const diff = t.points.filter((p) => p.status === 'different');
  const miss = t.points.filter((p) => p.status === 'missing');
  const ok = t.points.filter((p) => p.status === 'understood');
  return (
    <div className={`card flat ${diff.length ? 'cie-warn danger' : miss.length ? 'cie-warn warn' : ''}`} style={{ gap: 6 }} data-kind="teachback" data-testid="teachback-bubble">
      <b className="bubble-tag"><LuGraduationCap aria-hidden /> {isDoctor ? tr('Understanding check · approved by the patient', 'اختبار الفهم · وافق عليه المريض', lang) : tr('Your understanding check', 'اختبار فهمك', lang)}</b>
      <div className="small">{tr(`${ok.length} understood · ${diff.length} different · ${miss.length} not mentioned`, `${ok.length} فاهمها · ${diff.length} مختلفة · ${miss.length} ماتذكرتش`, lang)}</div>
      {diff.map((p) => <div key={p.id} className="small danger-text" data-no-tr><b>{pointLabel(p, lang)}:</b> {tr('patient said', 'المريض قال', lang)} “<bdi dir="auto">{p.quote}</bdi>” — {tr('plan', 'الخطة', lang)}: <bdi dir="auto">{p.correct}</bdi>{p.by === 'ai' ? ' (AI)' : ''}</div>)}
      {miss.length > 0 && <div className="small muted">{tr('Not mentioned', 'ماتذكرش', lang)}: {miss.map((p) => pointLabel(p, lang)).join(', ')}</div>}
      <details className="small"><summary>{tr('Patient’s words', 'كلام المريض', lang)}</summary><p data-no-tr>“{t.text}”</p></details>
      <span className="meta">{fmtDate(m.createdAt)}</span>
    </div>
  );
}
