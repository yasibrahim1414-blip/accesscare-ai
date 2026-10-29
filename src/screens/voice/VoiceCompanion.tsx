// AccessCare AI — Blind Access & Voice Companion screen.
// A full patient workflow without needing the screen: spoken guidance (browser
// text-to-speech), spoken answers (browser speech recognition, with consent),
// large buttons and typing as alternatives, optional swipe navigation, and the
// same backend calls as the visual app (accounts, reports, messages).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuMic, LuMicOff, LuRepeat, LuPause, LuPlay, LuSquare, LuSend, LuKeyboard, LuSparkles, LuLogOut, LuHand, LuEye } from 'react-icons/lu';
import { homeFor, useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Field, TopBar } from '../../ui/components';
import { initialState, step, t, type Ctx, type DialogState, type Effect, type Input, type Msg, type Option, type Turn } from '../../services/voice/VoiceDialog';
import { Listener, Speaker, errText, primeSpeech, sttSupported, ttsAvailable, naturalVoice, unlockAudio, voicesFor, bestVoice, onlyBasicVoices, type SpeechErr } from '../../services/voice/Speech';
import { converse } from '../../services/conversation/ai';
import { startConsult, reportData, summaryLines as consultSummaryLines, type ConsultTurn } from '../../services/conversation/Consult';
import { BodySelector } from '../../body/BodySelector';
import { GestureRecognizer, type Gesture } from '../../services/voice/Gestures';
import { DEFAULT_BLIND, type BlindPrefs } from '../../domain/voice';
import { defaultBlind, deviceBlind, setDeviceBlind } from './blindMode';
import type { Sensation, SymptomDetails, StructuredReport } from '../../domain/types';
import { STATUS_LABELS } from '../../domain/types';
import { build, buildBrief, briefText, toStructuredReport } from '../../services/intent/ReconstructionEngine';
import type { ConsultRecord } from '../../domain/conversation';
import { normalizeDoctorId } from '../../services/crypto';
import { rememberAccount } from '../auth/AuthScreens';
import type { AuthInfo } from '../../services/backend/Backend';
import { remoteStatus } from '../../services/ai/RemoteSample';
import { runtimeConfig } from '../../services/config';
import { useLang, getLang, setLang, tr, isRtl, type Lang } from '../../i18n/lang';
import { chosenVoice, withVoice } from '../../domain/voice';
import { explainAIError, type AIHealth } from '../../services/ai/health';

// one automatic connection test per page load (a real, tiny AI request), shared by Talk and Blind mode
let healthOnce: Promise<AIHealth> | null = null;

type LogLine = { who: 'assistant' | 'patient'; text: string; ai?: boolean };
type Status = 'idle' | 'speaking' | 'listening' | 'thinking';


const L = (lang: Lang, en: string, ar: string) => tr(en, ar, lang);

/** mode 'blind': Blind Mode (spoken guidance, gestures). mode 'talk': the conversation for every patient (speak, type, tap, body map). */
export function VoiceCompanion({ mode = 'blind' }: { mode?: 'blind' | 'talk' } = {}) {
  const talk = mode === 'talk';
  const [panel, setPanel] = useState<'none' | 'body'>('none');
  const [bodySel, setBodySel] = useState<string[]>([]);
  const [lastAi, setLastAi] = useState<{ used: boolean; failed: boolean }>({ used: false, failed: false });
  const { backend, me, setMe, ai, prefs, nav, refresh } = useApp();
  const glang = useLang(); // the app's language: this assistant speaks, listens and shows text in it
  const [bp, setBpState] = useState<BlindPrefs>(() => ({ ...(me?.preferences.blind ?? deviceBlind() ?? defaultBlind()), lang: getLang() }));
  const bpRef = useRef(bp); bpRef.current = bp;
  const lang = bp.lang;
  const doctor = useLoad(() => (me?.profile.role === 'patient' ? backend.getMyDoctor() : Promise.resolve(null)), [me?.profile.id]);
  const auth = useLoad<AuthInfo>(() => backend.authInfo(), []);
  const aiOn = ai.state(prefs.aiAssist) === 'available';
  const [health, setHealth] = useState<AIHealth | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = useCallback(async (fresh: boolean) => {
    setTesting(true);
    if (fresh || !healthOnce) healthOnce = ai.testConnection();
    const h = await healthOnce; setHealth(h); setTesting(false);
  }, [ai]);
  useEffect(() => { if (aiOn && ai.supported) void runTest(false); }, [aiOn, ai, runTest]);
  const ctx: Ctx = {
    signedIn: !!me && me.profile.role === 'patient', shared: backend.shared, claudeAccount: auth.data?.kind === 'claude-account',
    aiSupported: ai.supported, aiOn, doctorName: doctor.data?.fullName ?? null,
  };
  const ctxRef = useRef(ctx); ctxRef.current = ctx;
  const meRef = useRef(me); meRef.current = me;

  const stateRef = useRef<DialogState>({ ...initialState(lang), patientCode: me?.profile.patientCode });
  const [view, setView] = useState<{ phase: DialogState['phase']; options: Option[] }>({ phase: 'pre_welcome', options: [] });
  const [log, setLog] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [paused, setPaused] = useState(false);
  const [interim, setInterim] = useState('');
  const [typed, setTyped] = useState('');
  const [micConsent, setMicConsent] = useState<'ask' | 'yes' | 'no'>('ask');
  const [speechErr, setSpeechErr] = useState<SpeechErr | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ login: '', password: '', confirm: '', code: '', doctorId: '', email: '' });
  const fState = f;
  const voiceInput = bp.input === 'voice' && sttSupported() && micConsent === 'yes';

  const speaker = useMemo(() => new Speaker((s) => { setPaused(s.paused); setStatus((cur) => (s.speaking ? 'speaking' : cur === 'speaking' ? 'idle' : cur)); }), []);
  const listener = useMemo(() => new Listener((s) => { setInterim(s.interim); setStatus((cur) => (s.listening ? 'listening' : cur === 'listening' ? 'idle' : cur)); }), []);
  useEffect(() => () => { speaker.stop(); listener.stop(); }, [speaker, listener]);

  // ---------------------------------------------------------------- turn processing (one at a time)
  const queue = useRef<Input[]>([]);
  const running = useRef(false);
  const lastQuestion = useRef('');
  const noSpeech = useRef(0);
  const feed = useCallback((input: Input) => { queue.current.push(input); void pump(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pump() {
    if (running.current) return;
    running.current = true;
    let wantListen = false;
    try {
      while (queue.current.length) {
        const input = queue.current.shift()!;
        const turn = step(stateRef.current, input, ctxRef.current);
        stateRef.current = turn.state;
        if (turn.state.consult && turn.state.consult.lang !== bpRef.current.lang && input.kind === 'event' && input.name === 'consult_turn') {
          // the patient switched language while talking: the whole app follows
          const nl = turn.state.consult.lang; const next = { ...bpRef.current, lang: nl }; setBpState(next); bpRef.current = next; setLang(nl);
        }
        setView({ phase: turn.state.phase, options: turn.options });
        if (input.kind === 'utterance') setLog((l) => [...l, { who: 'patient', text: input.text }]);
        const say = turn.say;
        const aiTurn = input.kind === 'event' && input.name === 'consult_turn' && !!input.data?.ai;
        if (aiTurn) { say.forEach((x) => setLog((l) => [...l.slice(-30), { who: 'assistant', text: x, ai: true }])); }
        else if (input.kind === 'ai_reply' && say.length) {
          setLog((l) => [...l, { who: 'assistant', text: say[0], ai: true }]); say.slice(1).forEach((s) => pushAssistant(s));
        } else say.forEach((s) => pushAssistant(s));
        if (say.length) lastQuestion.current = say[say.length - 1];
        for (const e of turn.effects) await runEffect(e, input);
        if (say.length) await speak(say);
        if (say.length) { noSpeech.current = 0; wantListen = turn.listen; }
      }
      if (wantListen && autoListenOk()) void listenOnce();
    } finally { running.current = false; }
  }
  const pushAssistant = (text: string) => setLog((l) => [...l.slice(-30), { who: 'assistant', text }]);
  const autoListenOk = () => bpRef.current.autoListen && bpRef.current.input === 'voice' && sttSupported() && micConsentRef.current === 'yes';
  const micConsentRef = useRef(micConsent); micConsentRef.current = micConsent;

  async function speak(say: string[]) {
    if (!ttsAvailable()) return;
    const b = bpRef.current;
    await speaker.speak(say, { lang: stateRef.current.lang ?? b.lang, rate: b.rate, voice: b.voice, voiceAr: b.voiceAr, voiceEn: b.voiceEn, voices: b.voices, engine: b.engine });
  }

  async function listenOnce(byUser = false) {
    if (byUser) noSpeech.current = 0;
    if (!sttSupported()) { setSpeechErr('unsupported'); return; }
    speaker.stop();
    setSpeechErr(null);
    const r = await listener.listen(bpRef.current.lang);
    if ('error' in r) {
      if (r.error === 'aborted') return;
      // silence is announced once per question, never repeated in a loop
      if (r.error === 'no-speech' && ++noSpeech.current > 1) return;
      setSpeechErr(r.error);
      const msg = errText(r.error, bpRef.current.lang);
      pushAssistant(msg);
      if (r.error === 'not-allowed' || r.error === 'audio-capture' || r.error === 'unsupported' || r.error === 'network') { setMicConsent('no'); micConsentRef.current = 'no'; }
      await speak([msg]);
      return;
    }
    feed({ kind: 'utterance', text: r.text });
  }

  // ---------------------------------------------------------------- effects (real backend work)
  async function runEffect(e: Effect, input: Input) {
    const lang = bpRef.current.lang;
    try {
      switch (e.type) {
        case 'show_signup': case 'show_login': case 'show_recover': setFormErr(null); setTimeout(() => document.getElementById(e.type === 'show_signup' ? 'va-password' : e.type === 'show_login' ? (ctxRef.current.claudeAccount ? 'va-password' : 'va-login') : 'va-code')?.focus(), 50); break;
        case 'create_recovery': {
          if (!backend.createRecoveryCode) break;
          const code = await backend.createRecoveryCode();
          queue.current.push({ kind: 'event', name: 'recovery_created', data: { code } });
          break;
        }
        case 'save_recovery_file': {
          const code = stateRef.current.recoveryCode ?? '';
          const text = `AccessCare AI recovery code\nPatient ID: ${stateRef.current.patientCode ?? ''}\nRecovery code: ${code}\nKeep this private. It can set a new password once.\n`;
          let ok = false;
          // inside Claude: the platform's download confirmation; elsewhere: an ordinary browser download
          const claude = (window as unknown as { claude?: { use(n: string): Promise<{ save(r: { filename: string; data: string }): Promise<unknown> } | null> } }).claude;
          const dl = claude?.use ? await withTimeout(claude.use('downloads'), 3000) : null;
          if (dl) { try { await dl.save({ filename: 'accesscare-recovery-code.txt', data: text }); ok = true; } catch { ok = false; } }
          else { try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'accesscare-recovery-code.txt'; document.body.appendChild(a); a.click(); a.remove(); ok = true; } catch { /* */ } }
          try { await navigator.clipboard?.writeText(code); } catch { /* */ }
          { const m = ok ? L(lang, 'I saved a text file with the code and copied it.', 'حفظت ملف فيه الكود ونسخته كمان.') : L(lang, 'The file was not saved. Please write the code down.', 'الملف ما اتحفظش. اكتب الكود في مكان من فضلك.'); pushAssistant(m); await speak([m]); }
          break;
        }
        case 'lookup_doctor': {
          try { const d = await backend.lookupDoctor(normalizeDoctorId(e.code)); queue.current.push({ kind: 'event', name: 'doctor_found', data: { id: d.doctorId, name: d.fullName } }); }
          catch { queue.current.push({ kind: 'event', name: 'doctor_not_found' }); }
          break;
        }
        case 'connect_doctor': {
          await backend.connectToDoctor(e.code); doctor.reload(); refresh();
          const d = await backend.getMyDoctor();
          ctxRef.current = { ...ctxRef.current, doctorName: d?.fullName ?? null };
          queue.current.push({ kind: 'event', name: 'doctor_connected', data: { name: d?.fullName ?? '' } });
          break;
        }
        case 'enable_ai': {
          const m = meRef.current; if (!m) break;
          const saved = await backend.savePreferences({ ...m.preferences, aiAssist: e.on, blind: bpRef.current });
          setMe({ ...m, preferences: saved });
          ctxRef.current = { ...ctxRef.current, aiOn: e.on && ai.supported };
          break;
        }
        case 'consult_start': {
          const t0 = startConsult(stateRef.current.lang, e.change ? stateRef.current.consult : undefined);
          queue.current.push(consultEvent(t0));
          break;
        }
        case 'converse': {
          const rec = stateRef.current.consult ?? startConsult(stateRef.current.lang).rec;
          setStatus('thinking');
          const useAi = ctxRef.current.aiOn ? (p: string) => ai.converse(p) : null;
          const t1 = await converse(rec, e.input, useAi ? (p) => withTimeout(useAi(p), 20000) : null);
          setStatus('idle');
          setLastAi({ used: t1.ai, failed: !!useAi && !t1.ai && e.input.kind === 'text' });
          if (t1.ai) setHealth((h) => (h && !h.ok ? { ok: true, detail: 'Claude answered your last message.' } : h));
          queue.current.push(consultEvent(t1));
          break;
        }
        case 'nomatch': {
          if (!ctxRef.current.aiOn || stateRef.current.misses > 2) break;
          setStatus('thinking');
          const id = await withTimeout(ai.interpretChoice(lastQuestion.current, e.options, e.text, lang), 8000);
          if (id) { setStatus('idle'); queue.current.push({ kind: 'ai_guess', id }); break; }
          // not an answer: let Claude reply briefly, then the question is asked again
          const reply = await withTimeout(ai.chatReply(e.text, lastQuestion.current, lang), 9000);
          setStatus('idle');
          if (reply) queue.current.push({ kind: 'ai_reply', text: reply });
          else queue.current.push({ kind: 'ai_guess', id: null });
          break;
        }
        case 'send_report': {
          setStatus('thinking');
          const res = await submitReport(e.toDoctor);
          setStatus('idle');
          queue.current.push({ kind: 'event', name: e.toDoctor ? 'sent' : 'saved' });
          void res;
          break;
        }
        case 'load_messages': {
          const list = await backend.listConsultations();
          const msgs: Msg[] = [];
          for (const v of list.filter((x) => x.consultation.status !== 'draft').slice(0, 8)) {
            for (const m of await backend.listMessages(v.consultation.id)) {
              msgs.push({ from: m.senderRole === 'doctor' ? 'doctor' : 'patient', body: m.body, at: m.createdAt, cid: m.consultationId });
            }
          }
          msgs.sort((a, b) => b.at.localeCompare(a.at));
          const latest = list.find((x) => x.consultation.status !== 'draft');
          queue.current.push({ kind: 'event', name: 'messages', data: { list: msgs, status: latest ? statusText(latest.consultation.status, !!latest.viewedAt, lang) : '' } });
          break;
        }
        case 'send_reply': await backend.sendMessage(e.cid, e.text); queue.current.push({ kind: 'event', name: 'reply_sent' }); break;
        case 'load_doctor': {
          const d = await backend.getMyDoctor();
          const latest = (await backend.listConsultations()).find((x) => x.consultation.status !== 'draft');
          queue.current.push({ kind: 'event', name: 'doctor_info', data: { name: d ? `${d.fullName}${d.specialty ? `, ${d.specialty}` : ''}` : '', status: latest ? statusText(latest.consultation.status, !!latest.viewedAt, lang) : '' } });
          break;
        }
        case 'settings': {
          const cur = bpRef.current;
          const next: BlindPrefs = e.change === 'reset' ? { ...DEFAULT_BLIND, lang: cur.lang }
            : { ...cur, ...(e.change === 'faster' ? { rate: Math.min(1.6, +(cur.rate + 0.15).toFixed(2)) } : e.change === 'slower' ? { rate: Math.max(0.6, +(cur.rate - 0.15).toFixed(2)) }
              : e.change === 'normal' ? { rate: 1 } : e.change.startsWith('lang_') ? { lang: e.change.slice(5) as Lang }
              : e.change === 'brief' ? { guidance: 'brief' as const } : e.change === 'full' ? { guidance: 'full' as const }
              : e.change === 'gestures_off' ? { navigation: 'screenreader' as const } : { navigation: 'gestures' as const }) };
          await saveBlind(next);
          queue.current.push({ kind: 'event', name: 'settings_changed', data: { lang: next.lang } });
          break;
        }
        case 'logout': {
          speaker.stop(); listener.stop();
          await backend.signOut(); setMe(null); meRef.current = null;
          ctxRef.current = { ...ctxRef.current, signedIn: false, doctorName: null };
          stateRef.current = initialState(bpRef.current.lang);
          setTimeout(() => feed({ kind: 'start' }), 1600);
          break;
        }
        case 'open_signal': setTimeout(() => nav.push({ name: 'ss.home' }), 2500); break;
        default: break;
      }
    } catch (err) {
      setStatus('idle');
      queue.current.push({ kind: 'event', name: e.type === 'send_report' ? 'send_failed' : 'action_failed', data: { error: (err as Error).message } });
    }
    void input;
  }

  async function submitReport(toDoctor: boolean) {
    const st = stateRef.current; const cr = st.consult;
    if (!cr) throw new Error(L(st.lang, 'There is nothing to send yet.', 'لسه مفيش حاجة تتبعت.'));
    const d = reportData(cr);
    const sensations = d.sensations as Sensation[];
    const details: SymptomDetails = {
      ...(d.description ? { description: d.description } : {}),
      ...(d.severityNumber !== undefined ? { severity: d.severityNumber } : {}),
      ...(d.onset ? { onset: d.onset } : {}), ...(d.pattern ? { pattern: d.pattern } : {}),
    };
    const prefill: Record<string, string> = {};
    if (d.severityWord) prefill.severity = d.severityWord;
    if (d.associated.length) prefill.associated = d.associated.join(', ');
    const rec = build({ regionIds: d.regionIds, sensations, details }, [], prefill);
    const brief = buildBrief(rec);
    const report: StructuredReport & { conversation?: ConsultRecord } = { ...toStructuredReport(rec, brief, [], cr.ai.used ? 'ai-provider' : 'demo-rules'), conversation: { ...cr, turns: cr.turns.slice(-40) } };
    const how = [...new Set(cr.turns.filter((x) => x.who === 'patient').map((x) => x.via))].map((v) => ({ voice: 'speech', text: 'typing', touch: 'answer buttons', body_map: 'the body map' } as Record<string, string>)[v ?? 'voice']).filter(Boolean).join(', ');
    const text = `${consultSummaryLines(cr, 'en').join('\n')}`
      + `\n\n[Prepared in a conversation with AccessCare AI (${cr.ai.used ? `Claude AI helped understand the patient's words in ${cr.ai.used} turn(s); ` : 'rule-based understanding; '}patient used: ${how || 'speech'}). The summary was ${talk ? 'shown' : 'read aloud'} to the patient and approved. Lines marked "interpretation" were not the patient's own words.]`
      + `\n\n${briefText(brief)}`;
    const c = await backend.createConsultation('consultation');
    await backend.updateDraft(c.id, { regionIds: d.regionIds, sensations, details, reconstruction: rec });
    const payload = { text, report, editedByPatient: false };
    if (toDoctor) await backend.approveAndShare(c.id, payload); else await backend.saveApprovedWithoutDoctor(c.id, payload);
    refresh();
  }

  async function saveBlind(next: BlindPrefs) {
    setBpState(next); bpRef.current = next;
    if (next.lang !== getLang()) setLang(next.lang);
    // Blind Mode is remembered on the device only from Blind Mode itself; "Talk to AccessCare" saves voice settings without turning Blind Mode on
    if (!talk) setDeviceBlind(next);
    else { const dev = deviceBlind(); if (dev) setDeviceBlind({ ...next, enabled: dev.enabled }); next = { ...next, enabled: meRef.current?.preferences.blind?.enabled ?? false }; }
    const m = meRef.current;
    if (m && m.profile.role === 'patient') { const saved = await backend.savePreferences({ ...m.preferences, blind: next }); setMe({ ...m, preferences: saved }); }
  }

  // the app's language changed (here or anywhere): voice, listening and the conversation follow
  useEffect(() => {
    if (glang === bpRef.current.lang) return;
    speaker.stop(); listener.stop();
    const next = { ...bpRef.current, lang: glang }; setBpState(next); bpRef.current = next;
    stateRef.current = { ...stateRef.current, lang: glang, ...(stateRef.current.consult ? { consult: { ...stateRef.current.consult, lang: glang } } : {}) };
  }, [glang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- start
  const started = useRef(false);
  useEffect(() => {
    if (started.current || auth.loading) return;
    started.current = true;
    if (!talk && !deviceBlind()) setDeviceBlind(bpRef.current);
    if (!sttSupported()) setMicConsent('no');
    stateRef.current = { ...initialState(bpRef.current.lang), patientCode: me?.profile.patientCode };
    if (talk) unlockAudio();
    feed({ kind: 'start', consult: talk || (nav.route.name === 'va' && !!nav.route.consult) });
    // Blind Mode heard the patient describe how they feel on another screen: those words start the conversation
    if (nav.route.name === 'va' && nav.route.consult && nav.route.say) feed({ kind: 'utterance', text: nav.route.say, via: 'voice' });
  }, [auth.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me?.profile.patientCode) stateRef.current = { ...stateRef.current, patientCode: me.profile.patientCode }; }, [me?.profile.patientCode]);

  // ---------------------------------------------------------------- forms (typed, never spoken)
  async function submitForm(kind: 'signup' | 'login' | 'recover' | 'doctor') {
    setFormErr(null); setBusy(true);
    // what is in the fields right now (a password manager or fast typing can submit before the last change is rendered)
    const now = (id: string, v: string) => { const el = document.getElementById(id); return el instanceof HTMLInputElement ? el.value : v; };
    const f = { ...fState, email: now('va-email', fState.email), login: now('va-login', fState.login), code: now('va-code', fState.code), password: now('va-password', fState.password), confirm: now('va-confirm', fState.confirm), doctorId: now('va-doctor', fState.doctorId) };
    try {
      if (kind === 'signup') {
        if (f.password.length < 8) throw new Error(L(lang, 'The password needs at least 8 characters.', 'كلمة السر لازم تكون ٨ حروف على الأقل.'));
        if (f.password !== f.confirm) throw new Error(L(lang, 'The two passwords are different. Please type them again.', 'كلمتين السر مختلفين. اكتبهم تاني.'));
        const m = await backend.signUp({ role: 'patient', fullName: stateRef.current.name ?? 'Patient', password: f.password, ...(backend.mode === 'supabase' ? { email: f.email } : {}) });
        const saved = await backend.savePreferences({ ...m.preferences, onboarded: true, blind: bpRef.current }).catch(() => m.preferences);
        const full = { ...m, preferences: saved };
        setMe(full); meRef.current = full;
        if (m.profile.patientCode) rememberAccount(m.profile.patientCode, m.profile.fullName, 'patient');
        ctxRef.current = { ...ctxRef.current, signedIn: true };
        setF({ login: '', password: '', confirm: '', code: '', doctorId: '', email: '' });
        feed({ kind: 'event', name: 'signed_up', data: { patientCode: m.profile.patientCode ?? '' } });
      } else if (kind === 'login') {
        const m = await backend.signIn({ email: f.login, role: 'patient', password: f.password });
        if (m.profile.role !== 'patient') { await backend.signOut(); throw new Error(L(lang, 'The voice companion is for patient accounts.', 'المساعد الصوتي لحسابات المرضى.')); }
        const blind = m.preferences.blind ?? bpRef.current;
        const full = { ...m, preferences: { ...m.preferences, blind } };
        setMe(full); meRef.current = full; await saveBlind(blind);
        ctxRef.current = { ...ctxRef.current, signedIn: true };
        stateRef.current = { ...stateRef.current, patientCode: m.profile.patientCode, lang: blind.lang };
        setF({ login: '', password: '', confirm: '', code: '', doctorId: '', email: '' });
        feed({ kind: 'event', name: 'logged_in' });
      } else if (kind === 'recover') {
        if (!backend.recoverAccount) throw new Error(L(lang, 'Recovery codes are not available with this server.', 'أكواد الاسترجاع مش متاحة مع السيرفر ده.'));
        if (f.password.length < 8 || f.password !== f.confirm) throw new Error(L(lang, 'Type the same new password twice, at least 8 characters.', 'اكتب كلمة السر الجديدة مرتين، ٨ حروف على الأقل.'));
        const m = await backend.recoverAccount({ login: f.login, role: 'patient', recoveryCode: f.code, newPassword: f.password });
        setMe(m); meRef.current = m;
        ctxRef.current = { ...ctxRef.current, signedIn: true };
        stateRef.current = { ...stateRef.current, patientCode: m.profile.patientCode };
        setF({ login: '', password: '', confirm: '', code: '', doctorId: '', email: '' });
        pushAssistant(L(lang, 'Your password was changed. The old recovery code no longer works.', 'كلمة السر اتغيرت. كود الاسترجاع القديم مبقاش شغال.'));
        await speak([L(lang, 'Your password was changed. The old recovery code no longer works, so I will make a new one.', 'كلمة السر اتغيرت. كود الاسترجاع القديم مبقاش شغال، فهعملك كود جديد.')]);
        feed({ kind: 'event', name: 'signed_up', data: { patientCode: m.profile.patientCode ?? '' } });
      } else if (kind === 'doctor') {
        feed({ kind: 'utterance', text: f.doctorId });
        setF((x) => ({ ...x, doctorId: '' }));
      }
    } catch (e) {
      const msg = (e as Error).message;
      setFormErr(msg); pushAssistant(msg); await speak([msg]);
    } finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- gestures (optional; off for screen-reader users)
  const surface = useRef<HTMLDivElement>(null);
  const focusIdx = useRef(-1);
  const recog = useMemo(() => new GestureRecognizer(), []);
  const lastTouchUp = useRef(0);
  const gesturesOn = !talk && bp.navigation === 'gestures';
  const items = () => Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-va-item]:not([disabled])') ?? []);
  const describeEl = (el: HTMLElement, more = false) => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
    const hint = el.getAttribute('data-va-hint');
    return more && hint ? `${label}. ${hint}` : label;
  };
  const moveFocus = (d: number) => {
    const list = items(); if (!list.length) return;
    // move from whatever is focused now (buttons appear and disappear as the state changes)
    const cur = list.indexOf(document.activeElement as HTMLElement);
    const from = cur >= 0 ? cur : Math.min(focusIdx.current, list.length - 1);
    focusIdx.current = from < 0 ? (d > 0 ? 0 : list.length - 1) : (from + d + list.length) % list.length;
    const el = list[focusIdx.current]; el.focus();
    if (bpRef.current.announce === 'all') { speaker.stop(); void speaker.speak([describeEl(el)], { lang: bpRef.current.lang, rate: bpRef.current.rate }); }
  };
  const onGesture = (g: Gesture, target: EventTarget | null) => {
    const map = bpRef.current.gestures;
    if (surface.current) surface.current.dataset.lastGesture = g.type === 'swipe' ? `swipe-${g.dir}` : g.type;
    const act = g.type === 'swipe' ? (g.dir === 'right' ? map.swipeRight : g.dir === 'left' ? map.swipeLeft : 'none')
      : g.type === 'doubleTap' ? map.doubleTap : g.type === 'longPress' ? map.longPress : 'tap';
    if (act === 'next') moveFocus(1);
    else if (act === 'previous') moveFocus(-1);
    else if (act === 'activate') {
      const list = items(); const el = (list.includes(document.activeElement as HTMLElement) ? document.activeElement as HTMLElement : list[focusIdx.current]) ?? null;
      if (el && surface.current?.contains(el)) { speaker.stop(); el.click(); }
    } else if (act === 'describe') {
      const list = items(); const el = list.includes(document.activeElement as HTMLElement) ? document.activeElement as HTMLElement : list[focusIdx.current]; if (el) void speaker.speak([describeEl(el, true)], { lang: bpRef.current.lang, rate: bpRef.current.rate });
    } else if (act === 'tap') {
      // a single tap selects and reads the item under the finger; it does not press it
      const el = (target as HTMLElement | null)?.closest?.('[data-va-item]') as HTMLElement | null;
      const list = items(); const i = el ? list.indexOf(el) : -1;
      if (i >= 0) { focusIdx.current = i; el!.focus(); speaker.stop(); void speaker.speak([describeEl(el!)], { lang: bpRef.current.lang, rate: bpRef.current.rate }); }
    }
  };
  const pointerHandlers = gesturesOn ? {
    onPointerDown: (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') recog.down(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); },
    onPointerMove: (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') recog.move(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); },
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      lastTouchUp.current = performance.now();
      const g = recog.up(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (g) onGesture(g, e.target);
    },
    onPointerCancel: () => recog.cancel(),
    onClickCapture: (e: React.MouseEvent) => {
      // with gesture navigation, a finger tap only selects; double tap activates (like a screen reader)
      if (e.isTrusted && performance.now() - lastTouchUp.current < 700) { e.preventDefault(); e.stopPropagation(); }
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } : {};

  // ---------------------------------------------------------------- UI
  const phase = view.phase;
  const statusText2 = status === 'listening' ? L(lang, 'Listening — microphone on', 'بسمعك — المايك شغال') : status === 'speaking' ? (paused ? L(lang, 'Paused', 'متوقف مؤقتاً') : L(lang, 'Speaking', 'بتكلم'))
    : status === 'thinking' ? (ctx.aiOn ? L(lang, 'Thinking…', 'بفكر…') : L(lang, 'Working…', 'ثواني…')) : L(lang, 'Ready', 'جاهز');
  const sendTyped = () => { const x = typed.trim(); if (!x) return; setTyped(''); speaker.stop(); listener.stop(); feed({ kind: 'utterance', text: x, via: 'text' }); };
  const choose = (o: Option) => { speaker.stop(); listener.stop(); setLog((l) => [...l, { who: 'patient', text: o.label }]); feed({ kind: 'choice', id: o.id }); };
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [log.length]);
  const showPasswordForm = phase === 'pre_password';
  const showLogin = phase === 'pre_login';
  const showRecover = phase === 'pre_recover';
  const showDoctor = phase === 'doctor_entry';
  const consult = stateRef.current.consult;
  const inConsult = phase === 'consult' || phase === 'review' || phase === 'urgent';
  const devVoices = voicesFor(lang);
  const curVoice = bestVoice(lang, chosenVoice(bp, lang));
  const lastErr = remoteStatus.error || ai.lastError || consult?.ai.lastError || '';
  const aiProblem = !ai.supported || !ctx.aiOn ? null
    : health && !health.ok ? health
    : lastAi.failed ? explainAIError(lastErr || 'no answer')
    : null;
  const aiLine = !ai.supported ? L(lang, 'AI: not set up in this version — I use guided questions and a fixed list of words.', 'الذكاء الاصطناعي: مش متجهز في النسخة دي — بستخدم أسئلة ثابتة وكلمات محددة.')
    : !ctx.aiOn ? L(lang, 'AI: off for your account (turn it on in Settings, or say "settings" then "turn on AI"). I use guided questions meanwhile.', 'الذكاء الاصطناعي: مقفول لحسابك (شغّله من الإعدادات، أو قول "الإعدادات" وبعدين "شغّل الذكاء الاصطناعي"). لحد كده بستخدم أسئلة ثابتة.')
    : lastAi.failed ? tr('AI did not answer the last message{why}, so I used guided questions for it.', 'الذكاء الاصطناعي مردش على آخر رسالة{why}، فاستخدمت أسئلة ثابتة.', lang, { why: remoteStatus.error ? ` (${remoteStatus.error})` : consult?.ai.lastError ? ` (${consult.ai.lastError})` : '' })
    : consult?.ai.used ? tr('AI: on — Claude understood your words in {n} message(s) (marked ✨ AI).', 'الذكاء الاصطناعي: شغال — Claude فهم كلامك في {n} رسالة (عليها علامة ✨ AI).', lang, { n: consult.ai.used })
    : L(lang, 'AI: on (not used yet).', 'الذكاء الاصطناعي: شغال (لسه متستخدمش).');

  return (
    <>
      <TopBar title={talk ? L(lang, 'Talk to AccessCare', 'اتكلم مع أكسس كير') : L(lang, 'Blind Mode', 'الوضع الصوتي')} onBack={meRef.current ? () => { speaker.stop(); listener.stop(); nav.reset(homeFor(meRef.current)); } : () => nav.reset({ name: 'welcome' })} />
      <div className={`screen screen-in va${talk ? ' va-talk' : ''}`} lang={lang} dir={isRtl(lang) ? 'rtl' : 'ltr'} ref={surface} {...pointerHandlers} data-testid="voice-companion" data-phase={phase} data-mode={mode}>
        <div className="pad">
          <div className={`va-status ${status}`} role="status" aria-live="assertive" data-testid="va-status">
            {status === 'listening' ? <LuMic aria-hidden /> : <LuMicOff aria-hidden />} <b>{statusText2}</b>
            {interim && <span className="small"> “{interim}”</span>}
          </div>

          {micConsent === 'ask' && sttSupported() && (
            <div className="card tinted" data-testid="mic-consent">
              <b>{L(lang, 'Answer by speaking?', 'تجاوب بالكلام؟')}</b>
              <p className="small">{L(lang, 'I need the microphone to hear you. Your browser will ask for permission. Your speech is turned into text by your browser’s speech service (Chrome: Google; Safari: Apple). AccessCare does not record or keep audio.',
                'محتاج المايك علشان أسمعك. المتصفح هيطلب الإذن. كلامك بيتحول لنص عن طريق خدمة الكلام في المتصفح (كروم: جوجل، سفاري: آبل). أكسس كير مش بيسجل ولا بيحتفظ بأي صوت.')}</p>
              <div className="grid2">
                <Button big data-va-item onClick={() => { unlockAudio(); setMicConsent('yes'); micConsentRef.current = 'yes'; void listenOnce(); }} data-testid="mic-allow"><LuMic aria-hidden /> {L(lang, 'Allow microphone', 'اسمح بالمايك')}</Button>
                <Button big variant="secondary" data-va-item onClick={() => { setMicConsent('no'); micConsentRef.current = 'no'; void saveBlind({ ...bpRef.current, input: 'touch' }); }} data-testid="mic-deny"><LuHand aria-hidden /> {talk ? L(lang, 'Type or tap instead', 'هكتب أو أدوس') : L(lang, 'Use buttons instead', 'استخدم الزراير')}</Button>
              </div>
            </div>
          )}
          {!sttSupported() && <Banner kind="info">{errText('unsupported', lang)}</Banner>}
          {speechErr && speechErr !== 'no-speech' && speechErr !== 'unsupported' && <Banner kind="warn">{errText(speechErr, lang)}</Banner>}

          {ai.supported && !ctx.aiOn && meRef.current?.profile.role === 'patient' && (
            <div className="banner warn" role="status" data-testid="va-ai-off" style={{ display: 'block' }}>
              <b>{'AI is off for your account.'}</b>{' '}
              {'Without AI I only understand a fixed list of English words. With AI on, Claude understands your own words, greetings and spelling mistakes. Your words are sent to Claude (Anthropic) to be understood; AccessCare checks every answer.'}
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button onClick={() => void (async () => { const m = meRef.current; if (!m) return; const saved = await backend.savePreferences({ ...m.preferences, aiAssist: true, blind: bpRef.current }); setMe({ ...m, preferences: saved }); healthOnce = null; })()} data-testid="va-ai-enable"><LuSparkles aria-hidden /> {'Turn on AI'}</Button>
              </div>
            </div>
          )}
          {aiProblem && (
            <div className="banner danger" role="alert" data-testid="va-ai-problem" style={{ display: 'block' }}>
              <b>{'AI is not working right now — I am using my built-in word list instead.'}</b>
              <p className="small" style={{ margin: '6px 0' }} data-testid="va-ai-problem-why">{aiProblem.problem}</p>
              <p className="small" style={{ margin: '6px 0' }}><b>{'How to fix: '}</b>{aiProblem.fix}</p>
              {runtimeConfig.aiEndpoint && <p className="tiny" style={{ margin: '6px 0' }}>{'Worker code: '}<a href="./cloudflare-worker.mjs" target="_blank" rel="noreferrer">cloudflare-worker.mjs</a></p>}
              <Button variant="secondary" disabled={testing} onClick={() => void runTest(true)} data-testid="va-ai-test">{testing ? 'Testing…' : 'Test AI connection again'}</Button>
            </div>
          )}
          {health?.ok && ctx.aiOn && !aiProblem && <p className="tiny" data-testid="va-ai-ok">{'✨ AI connected: '}{health.detail}</p>}

          {inConsult && (stateRef.current.urgentShown.length > 0) && (
            <div className="banner danger" role="alert" data-testid="va-urgent">
              <b>{L(lang, 'If this could be an emergency, call now:', 'لو ممكن تكون حالة طوارئ، اتصل دلوقتي:')}</b>{' '}
              <a href="tel:998">998</a> · <a href="tel:999">999</a> ({L(lang, 'UAE', 'الإمارات')}) · {lang === 'fr' ? <><a href="tel:15">15</a> · <a href="tel:112">112</a> ({L(lang, 'France and Europe', 'فرنسا وأوروبا')})</>
                : lang === 'ur' ? <><a href="tel:1122">1122</a> · <a href="tel:115">115</a> ({L(lang, 'Pakistan', 'باكستان')})</>
                : lang === 'hi' ? <><a href="tel:112">112</a> · <a href="tel:108">108</a> ({L(lang, 'India', 'الهند')})</>
                : <><a href="tel:123">123</a> ({L(lang, 'Egypt', 'مصر')}) · <a href="tel:112">112</a></>}
            </div>
          )}

          <div className="va-controls" role="group" aria-label={L(lang, 'Voice controls', 'تحكم الصوت')}>
            <Button big data-va-item disabled={!voiceInput || status === 'listening'} onClick={() => { unlockAudio(); void listenOnce(true); }} data-testid="va-speak"
              aria-label={L(lang, 'Speak your answer', 'قول إجابتك')}><LuMic aria-hidden /> {L(lang, 'Speak', 'اتكلم')}</Button>
            <Button variant="secondary" data-va-item onClick={() => { speaker.stop(); listener.stop(); feed({ kind: 'choice', id: 'repeat' }); }} data-testid="va-repeat"><LuRepeat aria-hidden /> {L(lang, 'Repeat', 'كرر')}</Button>
            {paused ? <Button variant="secondary" data-va-item onClick={() => speaker.resume()} data-testid="va-resume"><LuPlay aria-hidden /> {L(lang, 'Resume', 'كمّل الكلام')}</Button>
              : <Button variant="secondary" data-va-item disabled={status !== 'speaking'} onClick={() => speaker.pause()} data-testid="va-pause"><LuPause aria-hidden /> {L(lang, 'Pause', 'إيقاف')}</Button>}
            <Button variant="secondary" data-va-item onClick={() => { speaker.stop(); listener.stop(); }} data-testid="va-stop"><LuSquare aria-hidden /> {L(lang, 'Stop', 'وقّف')}</Button>
          </div>

          {(showPasswordForm || showLogin || showRecover) && (
            <form className="card" onSubmit={(e) => { e.preventDefault(); void submitForm(showPasswordForm ? 'signup' : showLogin ? 'login' : 'recover'); }} data-testid="va-form">
              {showPasswordForm && backend.mode === 'supabase' && <Field id="va-email" label={L(lang, 'Email', 'الإيميل')} value={f.email} onChange={(v) => setF((x) => ({ ...x, email: v }))} autoComplete="email" />}
              {(showLogin || showRecover) && !ctx.claudeAccount && <Field id="va-login" label={L(lang, 'Patient ID or email', 'رقم المريض أو الإيميل')} value={f.login} onChange={(v) => setF((x) => ({ ...x, login: v }))} autoComplete="username" />}
              {showRecover && <Field id="va-code" label={L(lang, 'Recovery code', 'كود الاسترجاع')} value={f.code} onChange={(v) => setF((x) => ({ ...x, code: v }))} autoComplete="one-time-code" mono />}
              <Field id="va-password" label={showRecover ? L(lang, 'New password', 'كلمة السر الجديدة') : L(lang, 'Password', 'كلمة السر')} type="password" value={f.password} onChange={(v) => setF((x) => ({ ...x, password: v }))}
                autoComplete={showLogin ? 'current-password' : 'new-password'} />
              {(showPasswordForm || showRecover) && <Field id="va-confirm" label={L(lang, 'Type the password again', 'اكتب كلمة السر تاني')} type="password" value={f.confirm} onChange={(v) => setF((x) => ({ ...x, confirm: v }))} autoComplete="new-password" />}
              {formErr && <Banner kind="warn">{formErr}</Banner>}
              <Button big type="submit" busy={busy} data-testid="va-form-submit">{showPasswordForm ? L(lang, 'Create my account', 'اعمل حسابي') : showLogin ? L(lang, 'Log in', 'دخول') : L(lang, 'Set new password', 'غيّر كلمة السر')}</Button>
              <Button variant="ghost" type="button" onClick={() => feed({ kind: 'choice', id: 'menu' })}>{L(lang, 'Back', 'رجوع')}</Button>
            </form>
          )}
          {showDoctor && (
            <form className="card" onSubmit={(e) => { e.preventDefault(); void submitForm('doctor'); }}>
              <Field id="va-doctor" label={L(lang, 'Doctor ID', 'رقم الدكتور')} value={f.doctorId} onChange={(v) => setF((x) => ({ ...x, doctorId: v }))} mono placeholder="AC-DOC-XXXXXX" />
              <Button big type="submit" data-testid="va-doctor-submit">{L(lang, 'Check this Doctor ID', 'دوّر على الرقم ده')}</Button>
            </form>
          )}

          <section aria-label={L(lang, 'Conversation', 'المحادثة')}>
            <div className="va-log" role="log" aria-live="polite" data-testid="va-log" ref={logRef}>
              {log.slice(-16).map((x, i) => (
                <div key={i} className={`va-line ${x.who}`}>{x.ai && <span className="prov prov-ai"><LuSparkles /> AI</span>} {x.text}</div>
              ))}
            </div>
          </section>
          {phase === 'review' && consult && (
            <div className="card" data-testid="va-summary">
              <b>{L(lang, 'Summary for your doctor', 'الملخص اللي هيروح للدكتور')}</b>
              <p className="tiny muted">{L(lang, 'Each line says whether it is your own words, something you chose, or an interpretation. Nothing is sent until you approve.', 'كل سطر مكتوب جنبه هل ده كلامك، ولا حاجة اخترتها، ولا تفسير. مفيش حاجة هتتبعت غير لما توافق.')}</p>
              <pre className="va-sum">{consultSummaryLines(consult, lang).join('\n')}</pre>
            </div>
          )}

          {view.options.length > 0 && (
            <div className="va-options" role="group" aria-label={L(lang, 'Answers', 'الإجابات')} data-testid="va-options">
              {view.options.map((o) => (
                <button key={o.id} className="va-opt" data-va-item data-va-hint={o.hint} onClick={() => choose(o)} data-option={o.id}>{o.label}</button>
              ))}
            </div>
          )}

          <form className="va-type" onSubmit={(e) => { e.preventDefault(); sendTyped(); }}>
            <label htmlFor="va-typed" className="strong small"><LuKeyboard aria-hidden /> {inConsult ? L(lang, 'Or type it, in your language', 'أو اكتبه بلغتك') : L(lang, 'Or type your answer', 'أو اكتب إجابتك')}</label>
            <div className="row">
              <input id="va-typed" className="input grow" value={typed} onChange={(e) => setTyped(e.target.value)} data-va-item autoComplete="off" data-testid="va-typed" dir="auto" />
              <Button type="submit" data-va-item aria-label={L(lang, 'Send answer', 'ابعت الإجابة')} data-testid="va-send"><LuSend aria-hidden /></Button>
            </div>
          </form>

          {phase === 'consult' && (
            <div className="va-methods" role="group" aria-label={L(lang, 'Other ways to answer', 'طرق تانية للإجابة')}>
              <Button variant={panel === 'body' ? 'primary' : 'secondary'} data-va-item onClick={() => setPanel(panel === 'body' ? 'none' : 'body')} data-testid="va-method-body">{L(lang, 'Show me on the body', 'وريني على الجسم')}</Button>
            </div>
          )}
          {phase === 'consult' && panel === 'body' && (
            <div className="card" data-testid="va-body-panel">
              <b>{L(lang, 'Tap where you feel it', 'دوس على المكان اللي حاسس فيه')}</b>
              <BodySelector selected={bodySel} onChange={setBodySel} lang={lang} />
              <Button big disabled={!bodySel.length} onClick={() => { const ids = bodySel; setBodySel([]); setPanel('none'); speaker.stop(); listener.stop();
                setLog((l) => [...l, { who: 'patient', text: `${L(lang, 'Body map', 'صورة الجسم')}: ${ids.join(', ')}` }]);
                void (async () => { const rec = stateRef.current.consult; if (!rec) return; const t1 = await converse(rec, { kind: 'regions', ids, via: 'body_map' }, null); feed(consultEvent(t1)); })(); }}
                data-testid="va-body-send">{L(lang, 'Use these areas', 'استخدم الأماكن دي')}</Button>
            </div>
          )}


          <div className="card small" data-testid="va-info">
            <b>{L(lang, 'About this assistant', 'عن المساعد')}</b>
            <span className="muted">{ctx.aiOn ? L(lang, 'Claude AI helps understand your words and talks with you; AccessCare keeps the record, checks every answer, and reads the summary back for your approval.', 'ذكاء Claude بيساعد يفهم كلامك ويتكلم معاك؛ وأكسس كير بيحفظ اللي قلته ويراجع كل إجابة ويقرالك الملخص علشان توافق عليه.')
              : L(lang, 'I ask guided questions that follow what you tell me, and understand set words in English and Arabic.', 'بسأل أسئلة على حسب اللي بتقوله، وبفهم كلمات محددة بالعربي والإنجليزي.')}
              {' '}{backend.shared ? L(lang, 'Your account and reports are saved in the shared database.', 'حسابك وتقاريرك محفوظين في قاعدة البيانات المشتركة.') : L(lang, 'Offline demo: saved on this device only.', 'نسخة تجريبية: محفوظ على الجهاز ده بس.')}
              {' '}{L(lang, 'It does not diagnose. In an emergency call your local emergency number.', 'مش بيشخّص. في الطوارئ اتصل برقم الطوارئ.')}</span>
            <span className="tiny" data-testid="va-ai-status">{aiLine}</span>
            {ai.supported && ctx.aiOn && <Button variant="secondary" disabled={testing} onClick={() => void runTest(true)} data-testid="va-ai-test2">{testing ? 'Testing…' : 'Test AI connection'}</Button>}
            <span className="tiny" data-testid="va-voice-status">{naturalVoice.available && bp.engine !== 'device'
              ? `Voice: natural voice (${naturalVoice.provider || 'server'})${naturalVoice.lastError ? ` — last problem: ${naturalVoice.lastError}, the device voice was used` : ''}.`
              : `Voice: this device’s voice${curVoice ? ` (${curVoice.name})` : ''}.`}</span>
            <details className="small" data-testid="va-voice-settings">
              <summary>{L(lang, 'Voice settings', 'إعدادات الصوت')}</summary>
              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                {naturalVoice.available && (
                  <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={bp.engine !== 'device'} onChange={(e) => void saveBlind({ ...bpRef.current, engine: e.target.checked ? 'natural' : 'device' })} data-testid="va-natural" />
                    {L(lang, 'Use the natural voice (sent to the voice service to be spoken; not stored by AccessCare)', 'استخدم الصوت الطبيعي (الكلام بيتبعت لخدمة الصوت علشان يتنطق؛ أكسس كير مش بيحفظه)')}</label>
                )}
                {devVoices.length > 0 && (
                  <label className="stack" style={{ gap: 4 }}>{L(lang, 'Device voice', 'صوت الجهاز')}
                    <select className="input" value={chosenVoice(bp, lang) ?? ''} data-testid="va-voice-pick"
                      onChange={(e) => void saveBlind(withVoice(bpRef.current, lang, e.target.value || undefined))}>
                      <option value="">{L(lang, 'Best available (automatic)', 'أحسن صوت متاح (تلقائي)')}</option>
                      {devVoices.map((v) => <option key={v.voiceURI} value={v.name}>{v.name} ({v.lang})</option>)}
                    </select>
                  </label>
                )}
                <label className="stack" style={{ gap: 4 }}>{tr('Speed: {n}×', 'السرعة: {n}×', lang, { n: bp.rate.toFixed(2) })}
                  <input type="range" min={0.6} max={1.6} step={0.05} value={bp.rate} onChange={(e) => void saveBlind({ ...bpRef.current, rate: Number(e.target.value) })} data-testid="va-rate" /></label>
                <Button variant="secondary" onClick={() => { unlockAudio(); void speak([L(lang, 'Hello, I am AccessCare. I am here to help you tell your doctor how you feel.', 'أهلاً، أنا أكسس كير. أنا هنا علشان أساعدك تقول للدكتور إنت حاسس بإيه.')]); }} data-testid="va-voice-test">{L(lang, 'Test the voice', 'جرّب الصوت')}</Button>
                {onlyBasicVoices(lang) && !naturalVoice.available && <p className="tiny muted">{L(lang, 'Only a basic voice is installed on this device. For a clearer voice, download an “Enhanced” or “Premium” voice in your phone’s settings (iPhone: Settings → Accessibility → Spoken Content → Voices).', 'الجهاز ده عليه صوت بسيط بس. علشان صوت أوضح، نزّل صوت "Enhanced" أو "Premium" من إعدادات التلفون (آيفون: الإعدادات ← تسهيلات الاستخدام ← المحتوى المنطوق ← الأصوات).')}</p>}
              </div>
            </details>
            {!talk && (
              <div className="grid2">
                <Button variant="secondary" onClick={() => { void saveBlind({ ...bpRef.current, navigation: gesturesOn ? 'screenreader' : 'gestures' }); }} data-testid="va-toggle-gestures">
                  <LuHand aria-hidden /> {gesturesOn ? L(lang, 'Gestures: on', 'الإشارات: شغالة') : L(lang, 'Gestures: off', 'الإشارات: مقفولة')}</Button>
                <Button variant="secondary" onClick={() => { setDeviceBlind(null); speaker.stop(); listener.stop(); nav.reset(meRef.current ? homeFor(meRef.current) : { name: 'welcome' }); }} data-testid="va-exit">
                  <LuEye aria-hidden /> {L(lang, 'Leave Blind Mode', 'اقفل الوضع الصوتي')}</Button>
              </div>
            )}
            {meRef.current && !talk && <Button variant="ghost" onClick={() => feed({ kind: 'choice', id: 'menu' })}><LuLogOut aria-hidden /> {L(lang, 'Main menu', 'القائمة الرئيسية')}</Button>}
          </div>
          {stateRef.current.phase === 'review' && <div className="sr-only">{t('review_intro', lang)}</div>}
        </div>
      </div>
    </>
  );
}

function statusText(s: string, viewed: boolean, lang: Lang) {
  const en: Record<string, string> = { new: viewed ? 'sent and seen by your doctor' : 'sent, not opened yet', in_review: 'your doctor is reviewing it', completed: 'completed by your doctor', cancelled: 'cancelled' };
  const ar: Record<string, string> = { new: viewed ? 'اتبعت والدكتور شافه' : 'اتبعت ولسه متفتحش', in_review: 'الدكتور بيراجعه', completed: 'الدكتور خلّصه', cancelled: 'اتلغى' };
  const e = en[s] ?? STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s;
  return tr(e, ar[s] ?? e, lang);
}

function consultEvent(t: ConsultTurn): Input {
  return { kind: 'event', name: 'consult_turn', data: { rec: t.rec, say: t.say, options: t.options, review: t.review, urgent: t.urgent, ai: t.ai } };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Start Blind Mode from a user action (so the browser allows speech right away). */
export function activateBlindMode() {
  const p = deviceBlind() ?? defaultBlind();
  const next = { ...p, enabled: true, lang: getLang() };
  setDeviceBlind(next);
  primeSpeech(tr('Blind Mode is active.', 'الوضع الصوتي شغال.', next.lang), next.lang);
  return next;
}
