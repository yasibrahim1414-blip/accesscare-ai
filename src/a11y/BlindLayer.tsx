// Blind Mode for the whole app.
//
// One controller, mounted once around every screen. It can be turned on from any
// screen (three quick left swipes, three quick taps on an empty part of the
// screen, the Blind Mode button in the header, or Alt+Shift+B), stays on while
// moving between screens, and makes the app usable without sight:
//   • it speaks: the screen's name when it opens, alerts and errors when they
//     appear, and answers to what the person asks;
//   • it listens (after the person allowed the microphone) and carries out real
//     actions: open a page, press a control by its name, fill in a form field by
//     field, read the page, read the latest report or the doctor's reply, change
//     the language, go back, log out (after confirming), turn itself off;
//   • on touch screens, a tap reads what is under the finger and a double tap
//     activates it; swipes right/left move between controls.
// Everything it offers comes from the real screen (screenModel.ts) and the real
// account data the signed-in person may see; nothing is invented. The standard
// screen-reader structure (headings, labels, live regions) keeps working with or
// without it, and without any AI service.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LuMic, LuMicOff, LuRepeat, LuSquare, LuX, LuEar } from 'react-icons/lu';
import { useApp, homeFor, type Route } from '../app/AppContext';
import { useLang, setLang, getLang, tr, dateLocale, isRtl, listSep, type Lang } from '../i18n/lang';
import { foldText, LANG_NAME } from '../services/langWords';
import { Speaker, Listener, sttSupported, ttsAvailable, unlockAudio, errText, type SpeechErr } from '../services/voice/Speech';
import { GestureRecognizer, TripleSwipeDetector, TripleTapDetector, type Gesture } from '../services/voice/Gestures';
import { deviceBlind, setDeviceBlind, onDeviceBlind, defaultBlind, micChoice, setMicChoice } from '../screens/voice/blindMode';
import type { BlindPrefs } from '../domain/voice';
import { interpret, bestMatch, isConsequential, type Cmd, type NavTarget } from './commands';
import { itemsOf, fieldsOf, screenRoot, screenTitle, readableText, setFieldValue, describe, accessibleName, type Item } from './screenModel';
import { STATUS_LABELS } from '../domain/types';
import { aiConsent } from '../services/ai/AIAssist';
import { CONCEPTS, BODY, hasAny } from '../services/conversation/lexicon';
import { loadMedData, shareCareDefault } from '../screens/care/careData';
import { todaySlots } from '../services/care/meds';
import { localDay } from '../domain/care';

const F = (re: RegExp) => new RegExp(foldText(re.source), re.flags); // matched on folded text (French accents, Hindi spellings)
const DOSE_TAKEN_RE = [/\b(i )?(took|have taken|just took|taken)\b.{0,25}\b(medicine|medication|meds|pills?|tablets?|dose)\b|(خدت|اخدت|أخدت|شربت|بلعت)\s*(ال)?(دوا|دواء|علاج|حبايه|حباية|برشامه|برشامة|جرعه|جرعة)/i,
  F(/(j'?\s*ai pris|je viens de prendre)\s+(mon |mes |le |la |les |ma )?(medicament|traitement|comprimes?|cachets?|pilules?|dose)/i),
  /(دوا|دوائی|گولی|خوراک)\s*(لے لی|لی ہے|کھا لی|لی)(\s|$|۔)/, F(/(दवा|दवाई|गोली|खुराक)\s*(ले ली|ली है|खा ली|ली)(\s|$|।)/)];
const DOSE_MISSED_RE = [/\b(i )?(missed|forgot|did ?n[o']t take)\b.{0,25}\b(medicine|medication|meds|pills?|tablets?|dose)\b|(نسيت|فاتتني|ماخدتش|مخدتش)\s*(ال)?(دوا|دواء|علاج|حبايه|حباية|جرعه|جرعة)/i,
  F(/(j'?\s*ai oublie|oublie|pas pris|n'?\s*ai pas pris|rate)\s+(de prendre\s+)?(mon |mes |le |la |les |ma )?(medicament|traitement|comprimes?|cachets?|pilules?|dose)/i),
  /(دوا|دوائی|گولی|خوراک)\s*(لینا بھول|بھول گیا|بھول گئی|نہیں لی|رہ گئی)/, F(/(दवा|दवाई|गोली|खुराक)\s*(लेना भूल|भूल गया|भूल गई|नहीं ली|छूट गई)/)];
const DOSE_ASK_RE = [/\b(what|which) (medicine|medication|pill)s? (now|today|next)\b|\b(read|tell me) my (medicines|medications|pills)\b|(ايه|إيه) (الدوا|الادويه|الأدوية) (دلوقتي|النهارده)|اقرالي (ادويتي|الأدوية|الادويه)|مواعيد الدوا/i,
  F(/quels? medicaments? (maintenant|aujourd'?\s*hui)|lis moi mes medicaments|mes medicaments (d'?\s*)?aujourd'?\s*hui/i),
  /(آج|ابھی)\s*(کون سی|کونسی)\s*دوا|میری دوائیں (بتاؤ|پڑھو)/, F(/(आज|अभी)\s*(कौन सी|कौनसी)\s*दवा|मेरी दवाइयां (बताओ|पढ़ो)/)];
const tests = (list: RegExp[]) => ({ test: (t: string) => { const f = foldText(t.toLowerCase()).replace(/[-–]/g, ' '); return list.some((re) => re.test(t) || re.test(f)); } });
const DOSE_TAKEN = tests(DOSE_TAKEN_RE), DOSE_MISSED = tests(DOSE_MISSED_RE), DOSE_ASK = tests(DOSE_ASK_RE);

const SYMPTOM_FORMS = [...CONCEPTS.flatMap((c) => c.words), ...BODY.flatMap((b) => b.words),
  'pain', 'hurt', 'hurts', 'hurting', 'ache', 'aching', 'sick', 'ill', 'not well', 'unwell', 'tired', 'dizzy', 'fever', 'cough', 'vomit', 'nausea', 'bleeding', 'swollen', 'itchy', 'burning',
  'وجع', 'بيوجعني', 'بتوجعني', 'وجعاني', 'الم', 'تعبان', 'تعبانه', 'عيان', 'عيانه', 'دايخ', 'دوخه', 'سخن', 'سخونيه', 'حراره', 'كحه', 'ترجيع', 'رجعت', 'نزيف', 'ورم', 'هرش', 'حرقان', 'مصدع',
  'mal', "j'ai mal", 'douleur', 'malade', 'fatigué', 'saigne', 'درد', 'تکلیف', 'بیمار', 'بخار', 'خون', 'दर्द', 'तकलीफ', 'बीमार', 'बुखार', 'खून'];
/** Words that describe how the person feels (a symptom), not a command. */
export const soundsLikeSymptom = (text: string) => hasAny(text, SYMPTOM_FORMS);

interface BlindApi { on: boolean; enable(how: 'gesture' | 'button' | 'keyboard'): void; disable(): void }
const BlindCtx = createContext<BlindApi>({ on: false, enable: () => {}, disable: () => {} });
export const useBlind = () => useContext(BlindCtx);

type Status = 'idle' | 'speaking' | 'listening' | 'thinking' | 'paused' | 'mic' | 'error';
type Pending = { question: string; run: () => Promise<string[] | void> };
type FormHelp = { els: HTMLElement[]; i: number };

const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [contenteditable=true]';
// places where taps and swipes already mean something (the 3D body, maps, the camera, the signal board)
const GESTURE_AREAS = 'canvas, svg, video, .body-stage, .body3d, .map2d, .cam-view, .signal-board, .sb-grid, .va, [data-gestures]';
const VOICE_ROUTES = new Set(['va', 'talk']);

/** Each spoken sentence also goes to a polite live region, so screen-reader users hear the same thing. */
function liveRegion(): HTMLElement {
  let el = document.getElementById('blind-live');
  if (!el) { el = document.createElement('div'); el.id = 'blind-live'; el.className = 'sr-only'; el.setAttribute('aria-live', 'polite'); el.setAttribute('data-blind-ui', ''); document.body.appendChild(el); }
  return el;
}

function navTargetRoute(t: NavTarget, role: 'patient' | 'doctor' | 'caregiver' | null): Route | null {
  if (role === 'caregiver') {
    return ({ home: { name: 'c.home' }, welcome: { name: 'c.home' }, profile: { name: 'settings' }, settings: { name: 'settings' }, about: { name: 'about' } } as Partial<Record<NavTarget, Route>>)[t] ?? null;
  }
  if (!role) {
    return ({ home: { name: 'welcome' }, welcome: { name: 'welcome' }, signin: { name: 'signin' }, signup: { name: 'signup' }, about: { name: 'about' } } as Partial<Record<NavTarget, Route>>)[t] ?? null;
  }
  if (role === 'doctor') {
    return ({ interpreter: { name: 'interp' }, progress: { name: 'd.progress' }, home: { name: 'd.overview' }, welcome: { name: 'd.overview' }, profile: { name: 'd.profile' }, settings: { name: 'settings' }, patients: { name: 'd.patients' }, consultations: { name: 'd.consults' }, history: { name: 'd.consults' }, about: { name: 'about' } } as Partial<Record<NavTarget, Route>>)[t] ?? null;
  }
  return ({ care: { name: 'p.care' }, medicines: { name: 'p.meds' }, boxcheck: { name: 'p.boxcheck' }, photos: { name: 'p.photos' }, card: { name: 'p.card' }, caregivers: { name: 'p.caregivers' }, interpreter: { name: 'interp' }, diary: { name: 'p.diary' }, home: { name: 'p.home' }, welcome: { name: 'p.home' }, profile: { name: 'p.profile' }, settings: { name: 'settings' }, preferences: { name: 'p.prefs' }, history: { name: 'p.history' }, consultations: { name: 'p.history' }, doctor: { name: 'p.doctor' }, signal: { name: 'ss.home' }, camera: { name: 'ss.camsetup' }, about: { name: 'about' }, talk: { name: 'talk' } } as Partial<Record<NavTarget, Route>>)[t] ?? null;
}

const STATUS_AR: Record<string, string> = { draft: 'مسودة لم تُرسل', new: 'جديد', in_review: 'قيد المراجعة', completed: 'مكتمل', cancelled: 'ملغي' };

export function BlindProvider({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const { nav, me, backend, ai } = app;
  const lang = useLang();
  const [prefs, setPrefsState] = useState<BlindPrefs | null>(() => deviceBlind());
  // Blind Mode is for patients (and signed-out visitors); doctor accounts never get it
  const isDoctor = me?.profile.role === 'doctor';
  const on = !!prefs?.enabled && !isDoctor;
  const suspended = VOICE_ROUTES.has(nav.route.name);
  const [status, setStatus] = useState<Status>('idle');
  const [heard, setHeard] = useState('');
  const [interim, setInterim] = useState('');
  const [spoken, setSpoken] = useState('');
  const [mic, setMic] = useState(micChoice());
  const [micErr, setMicErr] = useState<SpeechErr | null>(null);

  // latest values for async code
  const R = useRef({ on, suspended, lang, prefs, me, nav, mic });
  R.current = { on, suspended, lang, prefs, me, nav, mic };
  const lastSaid = useRef<string[]>([]);
  const lastExplain = useRef<string[]>([]);
  const pending = useRef<Pending | null>(null);
  const form = useRef<FormHelp | null>(null);
  const cursor = useRef(-1);
  const loopToken = useRef(0);
  const silent = useRef(0);
  const announcedRoute = useRef('');
  const userPaused = useRef(false);

  const speaker = useMemo(() => new Speaker(({ speaking }) => setStatus((s) => (speaking ? 'speaking' : s === 'speaking' ? 'idle' : s))), []);
  const listener = useMemo(() => new Listener(({ listening, interim: i }) => { setInterim(i); setStatus((s) => (listening ? 'listening' : s === 'listening' ? 'idle' : s)); }), []);

  useEffect(() => onDeviceBlind((p) => setPrefsState(p)), []);

  const L = (en: string, ar: string) => tr(en, ar, R.current.lang);

  // ------------------------------------------------------------------ speaking
  const say = useCallback(async (lines: string[], opts: { remember?: boolean; explain?: string[] } = {}) => {
    const text = lines.filter(Boolean);
    if (!text.length) return;
    if (opts.remember !== false) { lastSaid.current = text; lastExplain.current = opts.explain ?? []; }
    listener.stop();
    setSpoken(text.join(' '));
    const live = liveRegion(); live.textContent = ''; window.setTimeout(() => { live.textContent = text.join(' '); }, 30);
    const p = R.current.prefs ?? defaultBlind();
    await speaker.speak(text, { lang: R.current.lang, rate: p.rate, voiceAr: p.voiceAr, voiceEn: p.voiceEn, voices: p.voices, engine: p.engine });
  }, [speaker, listener]);

  const savePrefs = useCallback((patch: Partial<BlindPrefs>) => {
    const next = { ...(deviceBlind() ?? defaultBlind()), ...patch };
    setDeviceBlind(next);
  }, []);

  // ------------------------------------------------------------------ the screen
  /** the controls on the screen, then the main navigation (tab bar or side bar) */
  const navItems = () => Array.from(document.querySelectorAll<HTMLElement>('nav[aria-label="Main"], aside[aria-label="Main"]')).flatMap((n) => itemsOf(n));
  const items = () => [...itemsOf(), ...navItems()];
  const helpLines = (): string[] => {
    const its = itemsOf().filter((i) => !i.disabled);
    const names = its.slice(0, 10).map((i) => i.name);
    const pages = navItems().map((i) => i.name);
    const title = screenTitle();
    const head = L(`You are on ${title}.`, `إنت في صفحة ${title}.`);
    const sep = listSep(R.current.lang);
    const list = names.length ? (its.length > 10
      ? tr('On this screen you can choose: {list}, and {n} more.', 'في الصفحة دي تقدر تختار: {list}، و{n} كمان.', R.current.lang, { list: names.join(sep), n: its.length - 10 })
      : tr('On this screen you can choose: {list}.', 'في الصفحة دي تقدر تختار: {list}.', R.current.lang, { list: names.join(sep) })) : L('There are no buttons on this screen.', 'مفيش زراير في الصفحة دي.');
    const how = L('Say the name of what you want, or say: go back, read the page, help me fill the form, open settings, repeat, stop, or exit Blind Mode. Three quick swipes to the right also turn Blind Mode off.',
      'قول اسم اللي عايزه، أو قول: ارجع، اقرا الصفحة، ساعدني أملى الفورم، افتح الإعدادات، كرر، اسكت، أو اقفل الوضع الصوتي. وتلت سحبات سريعة لليمين بتقفل الوضع الصوتي.');
    const nav = pages.length ? tr('Pages: {list}.', 'الصفحات: {list}.', R.current.lang, { list: pages.join(listSep(R.current.lang)) }) : '';
    return [head, list, nav, how].filter(Boolean);
  };
  const pageLines = (): string[] => {
    const text = readableText();
    const title = screenTitle();
    return [title, ...text.filter((t) => t !== title).slice(0, 25)];
  };
  const alertsNow = (): string[] => Array.from(screenRoot().querySelectorAll<HTMLElement>('[role=alert]')).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 3);

  // ------------------------------------------------------------------ actions
  const press = async (it: Item, confirmFirst = true): Promise<string[]> => {
    if (it.disabled) return [L(`${it.name} is not available right now.`, `${it.name} مش متاح دلوقتي.`)];
    if (it.role === 'field') { it.el.focus(); form.current = { els: [it.el], i: 0 }; return [describe(it, R.current.lang), L('Say what to write, or say skip.', 'قول أكتب إيه، أو قول تخطي.')]; }
    if (confirmFirst && isConsequential(it.name)) {
      pending.current = { question: L(`Do you want me to press "${it.name}"? Say yes or no.`, `عايزني أدوس على "${it.name}"؟ قول أيوه أو لأ.`), run: async () => { await doClick(it.el); return [L(`Done: ${it.name}.`, `تم: ${it.name}.`)]; } };
      return [pending.current.question];
    }
    await doClick(it.el);
    if (it.role === 'checkbox') return [`${it.name}: ${(it.el as HTMLInputElement).checked ? L('checked', 'متعلّم عليه') : L('not checked', 'مش متعلّم عليه')}.`];
    return [L(`Pressed ${it.name}.`, `دوست على ${it.name}.`)];
  };
  const doClick = async (el: HTMLElement) => { el.focus({ preventScroll: false }); el.click(); await new Promise((r) => setTimeout(r, 350)); };

  const go = (t: NavTarget): string[] => {
    const role = (R.current.me?.profile.role ?? null) as 'patient' | 'doctor' | 'caregiver' | null;
    const route = navTargetRoute(t, role);
    if (!route) return [L('That page is not available for your account.', 'الصفحة دي مش متاحة لحسابك.')];
    const n = R.current.nav;
    if (n.route.name === route.name) return [L('You are already on that page.', 'إنت بالفعل في الصفحة دي.')];
    const tab = ['p.care', 'c.home', 'p.diary', 'd.progress', 'p.home', 'p.history', 'p.doctor', 'p.profile', 'ss.home', 'd.overview', 'd.patients', 'd.consults', 'd.profile', 'welcome'].includes(route.name);
    if (tab) n.reset(route); else n.push(route);
    return []; // the new screen is announced when it opens
  };

  const statusName = (s: string) => { const en = STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s; return tr(en, STATUS_AR[s] ?? en, R.current.lang); };
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(R.current.lang), { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

  const readLatestReport = async (): Promise<string[]> => {
    const m = R.current.me;
    if (!m) return [L('Please log in first. Only your own reports can be read.', 'سجّل الدخول الأول. أقدر أقرالك تقاريرك إنت بس.')];
    const list = await backend.listConsultations();
    const withText = list.filter((v) => v.consultation.approved || v.consultation.draftSummaryText).sort((a, b) => (b.consultation.updatedAt ?? '').localeCompare(a.consultation.updatedAt ?? ''));
    const v = withText[0];
    if (!v) return [m.profile.role === 'doctor' ? L('No patient has shared a report with you yet.', 'مفيش مريض بعتلك تقرير لسه.') : L('You have no reports yet.', 'معندكش تقارير لسه.')];
    const c = v.consultation;
    const text = c.approved?.text ?? c.draftSummaryText ?? '';
    const who = m.profile.role === 'doctor' ? L(`from ${v.patient.fullName}`, `من ${v.patient.fullName}`) : '';
    return [L(`Latest report ${who}, ${when(c.updatedAt)}. Status: ${statusName(c.status)}.`, `آخر تقرير ${who}، ${when(c.updatedAt)}. الحالة: ${statusName(c.status)}.`), ...text.split(/\n+/).map((x) => x.trim()).filter(Boolean)];
  };
  const readDoctorReply = async (): Promise<string[]> => {
    const m = R.current.me;
    if (!m) return [L('Please log in first.', 'سجّل الدخول الأول.')];
    const doctor = m.profile.role === 'doctor';
    const list = (await backend.listConsultations()).filter((v) => v.consultation.status !== 'draft').slice(0, 10);
    let best: { body: string; at: string; who: string } | null = null;
    for (const v of list) {
      for (const msg of await backend.listMessages(v.consultation.id)) {
        const fromOther = doctor ? msg.senderRole === 'patient' : msg.senderRole === 'doctor';
        if (fromOther && (!best || msg.createdAt > best.at)) best = { body: msg.body, at: msg.createdAt, who: doctor ? v.patient.fullName : (v.doctor?.fullName ?? L('your doctor', 'دكتورك')) };
      }
    }
    if (!best) return [doctor ? L('No patient messages yet.', 'مفيش رسايل من المرضى لسه.') : L('Your doctor has not replied yet.', 'دكتورك لسه مردّش.')];
    return [L(`Latest message from ${best.who}, ${when(best.at)}:`, `آخر رسالة من ${best.who}، ${when(best.at)}:`), best.body];
  };

  const formStep = (): string[] => {
    const f = form.current; if (!f) return [];
    while (f.i < f.els.length && !document.contains(f.els[f.i])) f.i++;
    if (f.i >= f.els.length) {
      form.current = null;
      const submit = items().find((i) => i.role === 'button' && (i.el as HTMLButtonElement).type === 'submit' && !i.disabled);
      return [L(`That was the last field.${submit ? ` Say submit to press "${submit.name}", or say read the form to check it.` : ''}`, `دي كانت آخر خانة.${submit ? ` قول ابعت علشان أدوس على "${submit.name}"، أو قول اقرا الفورم علشان تراجعه.` : ''}`)];
    }
    const el = f.els[f.i];
    const it = fieldsOf().find((x) => x.el === el) ?? { el, name: accessibleName(el), role: 'field' as const, disabled: false };
    el.focus();
    if (it.secret) return [L(`${it.name}. For your privacy, passwords are not taken by voice: please type it on the keyboard, then say next.`, `${it.name}. علشان خصوصيتك، مش باخد كلمات السر بالصوت: اكتبها بالكيبورد، وبعدين قول التالي.`)];
    if (it.role === 'checkbox' || it.role === 'radio') return [describe(it, R.current.lang), L('Say yes to check it, no to leave it, or skip.', 'قول أيوه علشان أعلّم عليه، أو لأ، أو تخطي.')];
    if (it.role === 'select') {
      const opts = Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()).filter(Boolean).slice(0, 8);
      return [describe(it, R.current.lang), tr('Choices: {list}. Say one, or skip.', 'الاختيارات: {list}. قول واحد منهم، أو تخطي.', R.current.lang, { list: opts.join(listSep(R.current.lang)) })];
    }
    return [describe(it, R.current.lang), L('Say what to write, or say skip.', 'قول أكتب إيه، أو قول تخطي.')];
  };
  const formAnswer = (text: string, cmd: Cmd): string[] => {
    const f = form.current!; const el = f.els[f.i];
    const it = fieldsOf().find((x) => x.el === el);
    if (cmd.type === 'skip' || cmd.type === 'next_item') { f.i++; return formStep(); }
    if (!it) { f.i++; return formStep(); }
    if (it.secret) { f.i++; return formStep(); }
    if (it.role === 'checkbox' || it.role === 'radio') {
      const want = cmd.type === 'yes' ? true : cmd.type === 'no' ? false : null;
      if (want === null) return [L('Please say yes, no, or skip.', 'قول أيوه، أو لأ، أو تخطي.')];
      if ((el as HTMLInputElement).checked !== want) el.click();
      f.i++; return formStep();
    }
    const value = /email/i.test(it.name + (el as HTMLInputElement).type) ? text.replace(/\s+(at|arobase|ایٹ|एट)\s+/gi, '@').replace(/\s+(dot|point|ڈاٹ|डॉट)\s+/gi, '.').replace(/\s+/g, '').toLowerCase() : text;
    if (!setFieldValue(el, value)) return [L('I could not set that choice. Please say one of the choices, or skip.', 'مقدرتش أختار ده. قول اختيار من الموجودين، أو تخطي.')];
    f.i++;
    return [`${it.name}: ${value}.`, ...formStep()];
  };

  const aiInterpret = async (text: string): Promise<string[] | null> => {
    if (!ai.supported || !aiConsent.on) return null;
    const its = items().filter((i) => !i.disabled).slice(0, 40);
    const prompt = `You are the voice of AccessCare AI, the voice control of a healthcare communication app used by a blind person. Decide what app action the person's request means. You can only choose actions that exist.
Screen: ${JSON.stringify(screenTitle().slice(0, 80))}
Controls on this screen (index: name): ${JSON.stringify(its.map((i, k) => `${k}: ${i.name.slice(0, 60)} (${i.role})`))}
Pages that can be opened: ${JSON.stringify(['home', 'profile', 'settings', 'history', 'doctor', 'patients', 'consultations', 'signal', 'camera', 'about'])}
Other actions: back, help, read_page, read_form, fill_form, read_latest_report, read_doctor_reply, new_report, logout, exit_blind_mode, language_en, language_ar, language_fr, language_ur, language_hi, none.
Person said (${LANG_NAME[R.current.lang] ?? 'English'}): ${JSON.stringify(text.slice(0, 300))}
Never give medical advice or diagnosis. If the request is unclear, choose "clarify" with a short question.
Reply with only JSON: {"action":"press"|"open"|"back"|"help"|"read_page"|"read_form"|"fill_form"|"read_latest_report"|"read_doctor_reply"|"new_report"|"logout"|"exit_blind_mode"|"language_en"|"language_ar"|"language_fr"|"language_ur"|"language_hi"|"clarify"|"none","target":<control index or page name or null>,"reply":"<one short sentence in ${R.current.lang === 'ar' ? 'Egyptian Arabic' : R.current.lang === 'ur' ? 'Urdu (Urdu script)' : R.current.lang === 'hi' ? 'Hindi (Devanagari script)' : LANG_NAME[R.current.lang] ?? 'English'}>"}`;
    setStatus('thinking');
    const raw = await Promise.race([ai.voiceCommand(prompt), new Promise<null>((r) => setTimeout(() => r(null), 12000))]);
    setStatus('idle');
    if (!raw || typeof raw !== 'object') return null;
    const j = raw as { action?: string; target?: unknown; reply?: unknown };
    const reply = typeof j.reply === 'string' ? j.reply.replace(/\s+/g, ' ').slice(0, 200) : '';
    const map: Record<string, Cmd> = { back: { type: 'back' }, help: { type: 'help' }, read_page: { type: 'read_page' }, read_form: { type: 'read_form' }, fill_form: { type: 'fill_form' }, read_latest_report: { type: 'read_latest_report' }, read_doctor_reply: { type: 'read_doctor_reply' }, new_report: { type: 'new_report' }, logout: { type: 'logout' }, exit_blind_mode: { type: 'exit' }, language_ar: { type: 'lang', lang: 'ar' }, language_en: { type: 'lang', lang: 'en' }, language_fr: { type: 'lang', lang: 'fr' }, language_ur: { type: 'lang', lang: 'ur' }, language_hi: { type: 'lang', lang: 'hi' } };
    if (j.action === 'press' && typeof j.target === 'number' && its[j.target]) return press(its[j.target]);
    if (j.action === 'open' && typeof j.target === 'string') return run({ type: 'go', to: j.target as NavTarget }, text);
    if (j.action && map[j.action]) return run(map[j.action], text);
    if (j.action === 'clarify' && reply) return [reply];
    return null;
  };

  // ------------------------------------------------------------------ one request
  async function run(cmd: Cmd, text: string): Promise<string[]> {
    const role = R.current.me?.profile.role ?? null;
    switch (cmd.type) {
      case 'stop': speaker.stop(); return [];
      case 'repeat': return lastSaid.current.length ? lastSaid.current : [L('I have not said anything yet.', 'لسه مقلتش حاجة.')];
      case 'explain': return lastExplain.current.length ? lastExplain.current : helpLines();
      case 'resume': {
        // "continue" presses the screen's Continue button when there is one
        const m = bestMatch(text, itemsOf().filter((i) => i.role === 'button' && !i.disabled));
        if (m && m.score >= 0.82) return press(m.item);
        return [L('I am listening.', 'أنا سامعك.')];
      }
      case 'pause_listening': userPaused.current = true; loopToken.current++; listener.stop(); setStatus('paused'); return [L('I stopped listening. Tap the Listen button at the bottom of the screen, or swipe left three times, when you want to talk again.', 'وقفت السماع. دوس على زرار "اسمعني" تحت، أو اسحب لليسار ٣ مرات، لما تحب تتكلم تاني.')];
      case 'slower': case 'faster': case 'normal_speed': {
        const cur = (R.current.prefs ?? defaultBlind()).rate;
        const rate = cmd.type === 'normal_speed' ? 1 : Math.min(1.6, Math.max(0.6, Math.round((cur + (cmd.type === 'slower' ? -0.15 : 0.15)) * 100) / 100));
        savePrefs({ rate }); R.current.prefs = { ...(R.current.prefs ?? defaultBlind()), rate };
        return [cmd.type === 'slower' ? L('Okay, I will speak more slowly.', 'حاضر، هتكلم أبطأ.') : cmd.type === 'faster' ? L('Okay, I will speak faster.', 'حاضر، هتكلم أسرع.') : L('Normal speed.', 'سرعة عادية.')];
      }
      case 'exit': return disableRef.current();
      case 'back': {
        const n = R.current.nav;
        if (n.canGoBack) { n.back(); return []; }
        const home = homeFor(R.current.me);
        if (n.route.name !== home.name) { n.reset(home); return []; }
        return [L('You are on the first page; there is nowhere to go back to.', 'إنت في أول صفحة، مفيش رجوع.')];
      }
      case 'help': return helpLines();
      case 'where': return [L(`You are on ${screenTitle()}.`, `إنت في صفحة ${screenTitle()}.`)];
      case 'read_page': return pageLines();
      case 'read_form': {
        const f = fieldsOf();
        if (!f.length) return [L('There is no form on this screen.', 'مفيش فورم في الصفحة دي.')];
        return [f.length > 1 ? tr('This form has {n} fields:', 'الفورم فيه {n} خانات:', R.current.lang, { n: f.length }) : L('This form has 1 field:', 'الفورم فيه خانة واحدة:'), ...f.map((i) => describe(i, R.current.lang) + '.')];
      }
      case 'fill_form': {
        const f = fieldsOf().filter((i) => !i.disabled);
        if (!f.length) {
          if (!role && (text.match(/log ?in|sign ?in|ادخل|دخول/i))) { R.current.nav.reset({ name: 'signin' }); return [L('Opening the log in page. Say help me fill the form when it opens.', 'بفتح صفحة الدخول. قول ساعدني أملى الفورم لما تفتح.')]; }
          return [L('There is no form on this screen.', 'مفيش فورم في الصفحة دي.')];
        }
        form.current = { els: f.map((i) => i.el), i: 0 };
        return [L(`I will go through the ${f.length} fields with you. Say skip to leave one empty, or stop to finish.`, `هنمشي على الـ${f.length} خانات سوا. قول تخطي علشان تسيب خانة فاضية، أو اسكت علشان نوقف.`), ...formStep()];
      }
      case 'submit': {
        const its = items().filter((i) => i.role === 'button' && !i.disabled);
        const sub = its.find((i) => (i.el as HTMLButtonElement).type === 'submit') ?? null;
        if (!sub) return [L('There is nothing to submit on this screen. Say what you can do to hear the options.', 'مفيش حاجة تتبعت في الصفحة دي. قول ايه الاختيارات علشان تسمعها.')];
        return press(sub, true);
      }
      case 'go': return go(cmd.to);
      case 'read_latest_report': return readLatestReport();
      case 'read_doctor_reply': return readDoctorReply();
      case 'new_report': case 'voice_menu':
        if (role !== 'patient') return [role === 'doctor' ? L('Reporting symptoms is for patient accounts.', 'تسجيل الأعراض لحسابات المرضى بس.') : L('Please log in or create an account first. Say: open sign in, or open sign up.', 'سجّل الدخول أو اعمل حساب الأول. قول: افتح تسجيل الدخول، أو افتح إنشاء حساب.')];
        R.current.nav.push({ name: 'va', consult: cmd.type === 'new_report' });
        return [];
      case 'logout':
        if (!R.current.me) return [L('You are not logged in.', 'إنت مش مسجّل دخول.')];
        pending.current = { question: L('Log out of AccessCare on this device? Say yes or no.', 'تسجّل خروج من أكسس كير على الجهاز ده؟ قول أيوه أو لأ.'), run: async () => {
          await backend.signOut(); app.setMe(null); R.current.nav.reset({ name: 'welcome' });
          return [L('You are logged out. Nothing from your account is shown any more.', 'سجّلت خروج. مفيش أي حاجة من حسابك ظاهرة دلوقتي.')];
        } };
        return [pending.current.question];
      case 'lang':
        if (cmd.lang === getLang()) return [tr('The app is already in English.', 'التطبيق بالعربي بالفعل.', cmd.lang)];
        setLang(cmd.lang); R.current.lang = cmd.lang;
        return [tr('Okay, the app is now in English. Talk to me in English.', 'تمام، التطبيق بقى بالعربي. اتكلم معايا بالعربي.', cmd.lang)];
      case 'press': {
        const its = items();
        const m = bestMatch(cmd.name, its);
        if (m && m.score >= 0.72) return press(m.item);
        const t = interpret(cmd.name); // "open settings" said as "press settings"
        if (t.type === 'go') return go(t.to);
        return (await aiInterpret(text)) ?? [L(`I could not find "${cmd.name}" on this screen.`, `ملقيتش "${cmd.name}" في الصفحة دي.`), ...helpLines().slice(1, 2)];
      }
      case 'fill': {
        const f = fieldsOf();
        const m = bestMatch(cmd.field, f);
        if (!m || m.score < 0.6) return [L(`I could not find a field called ${cmd.field}.`, `ملقيتش خانة اسمها ${cmd.field}.`)];
        if (m.item.secret) return [L('For your privacy, passwords are not taken by voice. Please type it.', 'علشان خصوصيتك، مش باخد كلمات السر بالصوت. اكتبها من فضلك.')];
        setFieldValue(m.item.el, cmd.value);
        return [`${m.item.name}: ${cmd.value}.`];
      }
      case 'next_item': case 'previous_item': return moveCursor(cmd.type === 'next_item' ? 1 : -1);
      case 'activate': {
        const it = items()[cursor.current];
        return it ? press(it) : [L('Nothing is selected. Say next to move to the first control.', 'مفيش حاجة متحددة. قول التالي.')];
      }
      case 'scroll': window.scrollBy({ top: (cmd.dir === 'down' ? 1 : -1) * window.innerHeight * 0.8, behavior: 'smooth' }); return [];
      case 'yes': case 'no': case 'skip':
        return [L('There is nothing to answer right now. Say what can I do to hear the options.', 'مفيش سؤال دلوقتي. قول ايه الاختيارات علشان تسمعها.')];
      case 'unknown': {
        const its = items();
        const m = bestMatch(text, its);
        if (m && m.score >= 0.82) return press(m.item);
        // a free-text box on this screen (diary, teach-back, a reply): what was said is written into it
        const box = fieldsOf().find((f) => !f.secret && f.el instanceof HTMLTextAreaElement && !(f.el as HTMLTextAreaElement).disabled);
        if (box) {
          const el = box.el as HTMLTextAreaElement;
          setFieldValue(el, el.value.trim() ? `${el.value.trim()} ${text}` : text);
          const go = items().find((i) => i.role === 'button' && !i.disabled && /check|راجع|send|ابعت|next|التالي/i.test(i.name));
          return [L(`I wrote: ${text}.`, `كتبت: ${text}.`), go ? L(`Say more, or say: ${go.name}.`, `قول كمان، أو قول: ${go.name}.`) : L('Say more, or say what can I do.', 'قول كمان، أو قول ايه الاختيارات.')];
        }
        // the person is describing how they feel: start a consultation with those words
        if (role === 'patient' && soundsLikeSymptom(text)) {
          R.current.nav.push({ name: 'va', consult: true, say: text });
          return [];
        }
        if (role === null && soundsLikeSymptom(text)) return [L('To report how you feel, please log in or create a patient account first. Say: open sign in.', 'علشان تقول إنت حاسس بإيه، سجّل دخول أو اعمل حساب مريض الأول. قول: افتح تسجيل الدخول.')];
        const viaAi = await aiInterpret(text);
        if (viaAi) return viaAi;
        return [L(`Sorry, I did not understand "${text}".`, `آسف، مفهمتش "${text}".`), L('Say: what can I do, to hear the options on this screen.', 'قول: ايه الاختيارات، علشان تسمع اللي في الصفحة.')];
      }
    }
  }

  const moveCursor = (d: 1 | -1): string[] => {
    const its = items();
    if (!its.length) return [L('There are no controls on this screen.', 'مفيش زراير في الصفحة دي.')];
    cursor.current = (cursor.current + d + its.length) % its.length;
    const it = its[cursor.current];
    it.el.focus({ preventScroll: false }); it.el.scrollIntoView?.({ block: 'nearest' });
    return [describe(it, R.current.lang)];
  };

  /** Handles one thing the person said. */
  const handle = useCallback(async (text: string) => {
    setHeard(text);
    const cmd = interpret(text);
    let out: string[] = [];
    const aiOnOff = /\b(turn|switch|put)\s+(on|off)\s+(the\s+)?ai\b|\bai\s+(on|off)\b|\b(enable|disable)\s+(the\s+)?ai\b|(شغل|شغّل|افتح|اقفل|وقف|طفي|اطفي)\s*(ال)?(ذكاء|الذكاء)|\b(active|activer|desactive|desactiver|allume|eteins)\s+(l'?\s*|la\s+)?(ia|intelligence artificielle)\b|(اے آئی|مصنوعی ذہانت)\s*(چالو|بند|آن|آف)|(एआई|कृत्रिम बुद्धिमत्ता)\s*(चालू|बंद|ऑन|ऑफ)/i.exec(foldText(text));
    if ((DOSE_TAKEN.test(text) || DOSE_MISSED.test(text) || DOSE_ASK.test(text)) && R.current.me?.profile.role === 'patient' && !pending.current) {
      setHeard(text);
      try {
        const md = await loadMedData(app.backend);
        const slots = todaySlots(md.plans, md.doses);
        if (DOSE_ASK.test(text)) {
          out = slots.length ? [L('Today’s medicines:', 'أدوية النهارده:'), ...slots.map((s2) => `${s2.slot}: ${s2.plan.name} ${s2.plan.dose} — ${s2.record ? (s2.state === 'taken' ? L('taken', 'اتاخدت') : s2.state === 'missed' ? L('missed', 'فاتت') : L('side effect noted', 'متسجل عرض جانبي')) : s2.state === 'upcoming' ? L('later', 'بعدين') : L('not checked yet', 'لسه متسجلتش')}.`)] : [L('You have no scheduled medicines today.', 'معندكش أدوية متجدولة النهارده.')];
        } else {
          const target = slots.find((x) => !x.record && x.state === 'due') ?? slots.find((x) => !x.record && x.state === 'not_checked');
          if (!target) out = [md.plans.length ? L('There is no dose due now to check in.', 'مفيش جرعة ميعادها دلوقتي أسجّلها.') : L('You have no prescriptions yet.', 'معندكش روشتات لسه.')];
          else {
            const st = DOSE_MISSED.test(text) ? 'missed' : 'taken';
            await app.backend.addRecord('dose', { medicine: target.plan.name, rxId: target.plan.rxId, dose: target.plan.dose, slot: target.slot, day: localDay(), status: st, sideEffect: '', via: 'voice', urgent: [], times: target.plan.times }, { share: shareCareDefault() });
            app.refresh();
            out = [st === 'taken' ? L(`Saved: ${target.plan.name}, ${target.slot}, taken.`, `اتسجل: ${target.plan.name}، ${target.slot}، اتاخدت.`) : L(`Saved: ${target.plan.name}, ${target.slot}, missed. If you are unsure what to do, ask your doctor or pharmacist.`, `اتسجل: ${target.plan.name}، ${target.slot}، فاتت. لو مش عارف تعمل إيه، اسأل دكتورك أو الصيدلي.`)];
          }
        }
      } catch (e) { out = [L(`I could not do that: ${(e as Error).message}`, `مقدرتش أعمل ده: ${(e as Error).message}`)]; }
      say(out); return;
    }
    if (aiOnOff && R.current.me?.profile.role === 'patient' && !pending.current) {
      const on = !/(off|disable|اقفل|وقف|طفي|اطفي|desactiv|eteins|بند|آف|बंद|ऑफ)/i.test(foldText(text));
      const m = R.current.me;
      try { const saved = await app.backend.savePreferences({ ...m.preferences, aiAssist: on }); app.setMe({ ...m, preferences: saved });
        out = [on ? L('AI assistance is on. Claude will help understand your words; you still confirm everything.', 'مساعدة الذكاء الاصطناعي اشتغلت. Claude هيساعد يفهم كلامك، وإنت بتأكد كل حاجة.') : L('AI assistance is off.', 'مساعدة الذكاء الاصطناعي اتقفلت.')];
      } catch { out = [L('I could not change the AI setting. Please try again.', 'مقدرتش أغيّر إعداد الذكاء الاصطناعي. جرّب تاني.')]; }
      setHeard(text); say(out); return;
    }
    try {
      if (pending.current) {
        const p = pending.current;
        if (cmd.type === 'yes') { pending.current = null; out = (await p.run()) ?? []; }
        else if (cmd.type === 'no' || cmd.type === 'stop') { pending.current = null; out = [L('Okay, I did not do it.', 'تمام، معملتش حاجة.')]; }
        else if (cmd.type === 'repeat') out = [p.question];
        else { pending.current = null; out = await run(cmd, text); }
      } else if (form.current && !['stop', 'exit', 'back', 'help', 'repeat', 'read_form', 'submit', 'go', 'lang', 'logout', 'pause_listening', 'explain'].includes(cmd.type)) {
        out = formAnswer(text, cmd);
      } else {
        if (cmd.type === 'stop' && form.current) { form.current = null; out = [L('Okay, I stopped filling the form.', 'تمام، وقفنا ملي الفورم.')]; }
        else out = await run(cmd, text);
      }
    } catch (e) {
      out = [L(`Sorry, that did not work: ${(e as Error).message || 'unknown problem'}.`, `آسف، ده منفعش: ${(e as Error).message || 'مشكلة غير معروفة'}.`)];
    }
    if (out.length) await say(out);
  }, [say]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ listening loop
  const loop = useCallback(async () => {
    const my = ++loopToken.current;
    silent.current = 0;
    while (my === loopToken.current) {
      const c = R.current;
      if (!c.on || c.suspended || c.mic !== 'yes' || !sttSupported()) return;
      if (speaker.speaking) { await new Promise((r) => setTimeout(r, 250)); continue; }
      setMicErr(null);
      const res = await listener.listen(c.lang, 8000);
      if (my !== loopToken.current) return;
      if ('error' in res) {
        if (res.error === 'no-speech' || res.error === 'aborted') {
          if (++silent.current >= 6) { setStatus('paused'); await say([L('I paused listening because it was quiet. Tap Listen at the bottom of the screen, or swipe left three times, to talk again.', 'وقفت السماع علشان الدنيا هادية. دوس على "اسمعني" تحت، أو اسحب لليسار ٣ مرات، علشان تتكلم تاني.')], { remember: false }); return; }
          continue;
        }
        setMicErr(res.error); setStatus('error');
        await say([errText(res.error, c.lang)], { remember: false });
        return;
      }
      silent.current = 0;
      if (!res.text.trim()) continue;
      setStatus('thinking');
      await handle(res.text);
      if (my === loopToken.current && R.current.on && !R.current.suspended) setStatus('listening');
    }
  }, [listener, speaker, handle, say]); // eslint-disable-line react-hooks/exhaustive-deps

  const startListening = useCallback(() => {
    unlockAudio();
    if (!sttSupported()) { setMicErr('unsupported'); setStatus('error'); void say([errText('unsupported', R.current.lang)], { remember: false }); return; }
    setMicChoice('yes'); setMic('yes'); R.current.mic = 'yes'; userPaused.current = false;
    speaker.stop();
    void loop();
  }, [loop, speaker, say]);
  const stopListening = useCallback(() => { userPaused.current = true; loopToken.current++; listener.stop(); setStatus('paused'); }, [listener]);

  // ------------------------------------------------------------------ on / off
  const enable = useCallback((how: 'gesture' | 'button' | 'keyboard') => {
    if (R.current.me?.profile.role === 'doctor') return;
    unlockAudio();
    const p = { ...(deviceBlind() ?? defaultBlind()), enabled: true };
    setDeviceBlind(p); R.current.prefs = p; R.current.on = true;
    const n = R.current.nav;
    // signed out on the start page: the voice guide does sign-up and log-in step by step
    if (!R.current.me && n.route.name === 'welcome') { n.reset({ name: 'va' }); return; }
    if (VOICE_ROUTES.has(n.route.name)) return;
    announcedRoute.current = JSON.stringify(n.route);
    const lines = [L('Blind Mode is on. To turn it off, swipe right three times.', 'الوضع الصوتي شغال. علشان تقفله اسحب لليمين ٣ مرات.'), L(`You are on ${screenTitle()}.`, `إنت في صفحة ${screenTitle()}.`)];
    const m = R.current.mic ?? micChoice();
    if (m === 'yes' && sttSupported()) lines.push(L('I am listening. Say what you want to do, for example: what can I do here.', 'أنا سامعك. قول عايز تعمل إيه، مثلاً: ايه الاختيارات.'));
    else if (m === null && sttSupported()) { setStatus('mic'); lines.push(L('To talk to me, I need the microphone. Tap the big Allow microphone button at the bottom of the screen. Or tap Not now to use touch only.', 'علشان تكلمني محتاج المايك. دوس على زرار "اسمح بالمايك" الكبير تحت الشاشة. أو دوس "مش دلوقتي" علشان تستخدم اللمس بس.')); }
    else lines.push(L('Tap a control to hear it, double tap to use it, and swipe right or left to move between controls.', 'المس أي زرار علشان تسمعه، ودوس مرتين علشان تستخدمه، واسحب يمين أو شمال علشان تتنقل.'));
    void (async () => { await say(lines); if (m === 'yes' && sttSupported()) void loop(); })();
    void how;
  }, [say, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  const disable = useCallback((): string[] => {
    loopToken.current++; listener.stop(); speaker.stop();
    pending.current = null; form.current = null;
    const p = deviceBlind(); setDeviceBlind(p ? { ...p, enabled: false } : null);
    setStatus('idle');
    const msg = L('Blind Mode is off.', 'الوضع الصوتي اتقفل.');
    window.setTimeout(() => { const live = liveRegion(); live.textContent = msg; void speaker.speak([msg], { lang: R.current.lang, rate: 1 }); }, 50);
    return [];
  }, [listener, speaker]); // eslint-disable-line react-hooks/exhaustive-deps
  const disableRef = useRef(disable); disableRef.current = disable;

  // leaving / entering the voice guide screens: they have their own voice, so this one waits
  useEffect(() => {
    if (suspended) { loopToken.current++; listener.stop(); speaker.stop(); }
  }, [suspended, listener, speaker]);

  // a new screen: say its name (and any alert on it), then keep listening
  const routeKey = JSON.stringify(nav.route);
  useEffect(() => {
    if (!on || suspended) return;
    if (announcedRoute.current === '') { enable('button'); return; } // turned on before this page loaded: resume
    if (announcedRoute.current === routeKey) return;
    announcedRoute.current = routeKey;
    form.current = null; cursor.current = -1;
    const t = window.setTimeout(() => {
      const al = alertsNow();
      void (async () => {
        await say([`${screenTitle()}.`, ...al]);
        if (R.current.mic === 'yes' && !userPaused.current) void loop();
      })();
    }, 450);
    return () => window.clearTimeout(t);
  }, [routeKey, on, suspended]); // eslint-disable-line react-hooks/exhaustive-deps


  // alerts and messages that appear later (errors, "saved", toasts) are spoken
  useEffect(() => {
    if (!on || suspended) return;
    const seen = new WeakSet<Node>();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement) || seen.has(n) || n.closest('[data-blind-ui]')) return;
        const el = n.matches('[role=alert], .toast') ? n : n.querySelector<HTMLElement>('[role=alert]');
        if (!el) return;
        seen.add(n);
        const text = el.innerText.trim();
        if (text && !speaker.speaking) void say([text], { remember: false });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [on, suspended, say, speaker]);

  // logging out clears everything this layer remembered
  const uid = me?.profile.id ?? '';
  useEffect(() => { if (!uid) { lastSaid.current = []; lastExplain.current = []; pending.current = null; form.current = null; setHeard(''); setSpoken(''); } }, [uid]);

  // ------------------------------------------------------------------ gestures and keys (whole app)
  useEffect(() => {
    const rec = new GestureRecognizer(); const swipes = new TripleSwipeDetector('left'); const exits = new TripleSwipeDetector('right'); const taps = new TripleTapDetector();
    let lastType = '';
    const pt = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const down = (e: PointerEvent) => {
      lastType = e.pointerType; rec.down(e.pointerId, pt(e));
      // a touch while speaking stops the voice (so the person can always interrupt)
      if (R.current.on && !R.current.suspended && speaker.speaking && e.pointerType === 'touch' && !(e.target as HTMLElement)?.closest?.('[data-blind-ui]')) speaker.stop();
    };
    const move = (e: PointerEvent) => rec.move(e.pointerId, pt(e));
    const cancel = () => { rec.cancel(); swipes.reset(); exits.reset(); taps.reset(); };
    const up = (e: PointerEvent) => {
      const g: Gesture | null = rec.up(e.pointerId, pt(e));
      if (!g) return;
      const c = R.current;
      // three quick right swipes turn Blind Mode off, from any screen (also the voice guide)
      if (e.pointerType === 'touch' && exits.feed(g) && (c.on || c.nav.route.name === 'va')) {
        if (c.nav.route.name === 'va') c.nav.reset(homeFor(c.me));
        disableRef.current();
        return;
      }
      if (c.suspended || c.nav.route.name === 'welcome') { swipes.reset(); taps.reset(); return; } // those screens handle their own gestures
      const target = e.target as HTMLElement | null;
      const inArea = !!target?.closest?.(GESTURE_AREAS);
      const onEmpty = !inArea && !target?.closest?.(INTERACTIVE) && !target?.closest?.('[data-blind-ui]');
      const tripleSwipe = e.pointerType === 'touch' && !inArea && swipes.feed(g);
      const tripleTap = onEmpty && taps.feed(g);
      if (tripleSwipe || tripleTap) {
        if (!c.on) enableRef.current('gesture');
        else if (c.mic === 'yes') { void say([L('I am listening.', 'أنا سامعك.')], { remember: false }).then(() => void loop()); }
        return;
      }
      if (!c.on || e.pointerType !== 'touch' || c.prefs?.navigation !== 'gestures') return;
      if (g.type === 'swipe' && (g.dir === 'right' || g.dir === 'left')) { const out = moveCursor(g.dir === 'right' ? 1 : -1); void say(out, { remember: false }); }
      else if (g.type === 'doubleTap') { const it = items()[cursor.current]; if (it) void press(it).then((o) => say(o)); }
      else if (g.type === 'longPress') void say(helpLines());
    };
    // on touch screens in Blind Mode, a single tap reads the control instead of pressing it
    const click = (e: MouseEvent) => {
      const c = R.current;
      if (!c.on || c.suspended || !e.isTrusted || lastType !== 'touch' || c.prefs?.navigation !== 'gestures') return;
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('[data-blind-ui]')) return;
      const el = t.closest<HTMLElement>(INTERACTIVE);
      if (!el || el.matches('input, textarea, select')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const its = items(); const k = its.findIndex((i) => i.el === el || i.el.contains(el));
      if (k >= 0) { cursor.current = k; void say([describe(its[k], c.lang), L('Double tap to use it.', 'دوس مرتين علشان تستخدمه.')], { remember: false }); }
    };
    const key = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.key === 'B' || e.key === 'b' || e.code === 'KeyB')) { e.preventDefault(); if (R.current.on) disableRef.current(); else enableRef.current('keyboard'); return; }
      if (!R.current.on || R.current.suspended) return;
      if (e.key === 'Escape' && speaker.speaking) { speaker.stop(); return; }
      if (e.altKey && e.shiftKey && (e.code === 'KeyL')) { e.preventDefault(); startListening(); }
    };
    window.addEventListener('pointerdown', down, { capture: true, passive: true });
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    window.addEventListener('pointerup', up, { capture: true, passive: true });
    window.addEventListener('pointercancel', cancel, { capture: true, passive: true });
    window.addEventListener('click', click, { capture: true });
    window.addEventListener('keydown', key, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      window.removeEventListener('pointercancel', cancel, { capture: true });
      window.removeEventListener('click', click, { capture: true });
      window.removeEventListener('keydown', key, { capture: true });
    };
  }, [speaker, say, loop, startListening]); // eslint-disable-line react-hooks/exhaustive-deps
  const enableRef = useRef(enable); enableRef.current = enable;

  // the "Blind Mode" button in the header and the Settings toggle use this
  const api: BlindApi = useMemo(() => ({ on, enable: (h) => enableRef.current(h), disable: () => { disableRef.current(); } }), [on]);

  const showBar = on && !suspended;
  return (
    <BlindCtx.Provider value={api}>
      {children}
      {showBar && (
        <VoiceBar status={status} heard={interim || heard} spoken={spoken} mic={mic} micErr={micErr} lang={lang}
          onListen={startListening} onPauseListen={stopListening}
          onStopSpeaking={() => speaker.stop()} onRepeat={() => void say(lastSaid.current.length ? lastSaid.current : helpLines())}
          onExit={() => disableRef.current()}
          onMicNo={() => { setMicChoice('no'); setMic('no'); R.current.mic = 'no'; setStatus('idle'); void say([L('Okay. Tap a control to hear it, and double tap to use it. You can turn on the microphone later with the Listen button.', 'تمام. المس أي زرار علشان تسمعه، ودوس مرتين علشان تستخدمه. وتقدر تشغّل المايك بعدين من زرار "اسمعني".')]); }}
        />
      )}
    </BlindCtx.Provider>
  );
}

function VoiceBar(p: { status: Status; heard: string; spoken: string; mic: 'yes' | 'no' | null; micErr: SpeechErr | null; lang: Lang;
  onListen(): void; onPauseListen(): void; onStopSpeaking(): void; onRepeat(): void; onExit(): void; onMicNo(): void }) {
  const L = (en: string, ar: string) => tr(en, ar, p.lang);
  const label = p.status === 'listening' ? L('Listening — microphone on', 'بسمعك — المايك شغال')
    : p.status === 'speaking' ? L('Speaking', 'بتكلم')
    : p.status === 'thinking' ? L('Working…', 'بشتغل…')
    : p.status === 'mic' ? L('Microphone permission needed', 'محتاج إذن المايك')
    : p.status === 'error' || p.micErr ? L('Microphone problem', 'مشكلة في المايك')
    : p.status === 'paused' ? L('Not listening', 'مش بسمع')
    : L('Blind Mode on', 'الوضع الصوتي شغال');
  const listening = p.status === 'listening';
  return (
    <section className="voicebar" data-blind-ui data-no-tr role="region" aria-label={L('Blind Mode voice controls', 'تحكم الوضع الصوتي')} data-testid="blind-bar" data-status={p.status} lang={p.lang} dir={isRtl(p.lang) ? 'rtl' : 'ltr'}>
      <div className={`vb-status ${p.micErr && !listening ? 'error' : p.status}`} role="status" aria-live="off" data-testid="blind-status">
        <span className="vb-dot" aria-hidden>{listening ? <LuMic /> : <LuMicOff />}</span>
        <b>{label}</b>
        {p.heard && <span className="vb-heard" data-testid="blind-heard">“{p.heard}”</span>}
      </div>
      {p.spoken && <p className="vb-said" data-testid="blind-said">{p.spoken}</p>}
      {p.micErr && <p className="vb-err" role="alert">{errText(p.micErr, p.lang)}</p>}
      {(p.mic === null && sttSupported()) ? (
        <div className="vb-consent">
          <p className="vb-note">{L('Blind Mode listens only while the microphone icon is on. Your browser turns speech into text (Chrome: Google; Safari: Apple). AccessCare does not record or keep audio.', 'الوضع الصوتي بيسمع بس والمايك شغال. المتصفح بيحوّل الكلام لنص (كروم: جوجل، سفاري: آبل). أكسس كير مش بيسجّل ولا بيحتفظ بأي صوت.')}</p>
          <div className="vb-row">
            <button className="vb-btn primary big" onClick={p.onListen} data-testid="blind-mic-allow"><LuMic aria-hidden /> {L('Allow microphone', 'اسمح بالمايك')}</button>
            <button className="vb-btn" onClick={p.onMicNo} data-testid="blind-mic-no">{L('Not now', 'مش دلوقتي')}</button>
          </div>
        </div>
      ) : (
        <div className="vb-row">
          {listening
            ? <button className="vb-btn primary" onClick={p.onPauseListen} data-testid="blind-pause"><LuMicOff aria-hidden /> {L('Stop listening', 'وقف السماع')}</button>
            : <button className="vb-btn primary" onClick={p.onListen} disabled={!sttSupported()} data-testid="blind-listen"><LuEar aria-hidden /> {L('Listen', 'اسمعني')}</button>}
          <button className="vb-btn" onClick={p.onStopSpeaking} disabled={p.status !== 'speaking'} data-testid="blind-stop"><LuSquare aria-hidden /> {L('Stop voice', 'اسكت')}</button>
          <button className="vb-btn" onClick={p.onRepeat} data-testid="blind-repeat"><LuRepeat aria-hidden /> {L('Repeat', 'كرر')}</button>
          <button className="vb-btn" onClick={p.onExit} data-testid="blind-exit" aria-label={L('Exit Blind Mode', 'اقفل الوضع الصوتي')}><LuX aria-hidden /> {L('Exit', 'خروج')}</button>
        </div>
      )}
      {!ttsAvailable() && <p className="vb-err">{L('This browser cannot speak. Use a screen reader, or open AccessCare in Safari or Chrome.', 'المتصفح ده مش بيقدر يتكلم. استخدم قارئ الشاشة، أو افتح أكسس كير في سفاري أو كروم.')}</p>}
    </section>
  );
}
