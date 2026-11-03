// Live call with the doctor: start buttons (in a consultation's messages), the incoming-call alert
// (on any screen), and the call window. See src/services/call/call.ts for how it works.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LuVideo, LuPhone, LuPhoneOff, LuMic, LuMicOff, LuVideoOff, LuSend, LuMessageSquare } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Button } from '../../ui/components';
import { tr, useLang } from '../../i18n/lang';
import type { Message } from '../../domain/types';
import { CallSession, callState, callsSupported, incomingCall, newCallId, RING_SECONDS, type CallPhase } from '../../services/call/call';

// ---------------------------------------------------------------- one call at a time on this device
type CallStore = {
  phase: CallPhase; consultationId: string; otherName: string; media: 'video' | 'audio'; id: string;
  incoming: Message | null; error: string; texts: { mine: boolean; text: string }[]; startedAt: number; muted: boolean; cameraOff: boolean;
};
const blank: CallStore = { phase: 'idle', consultationId: '', otherName: '', media: 'video', id: '', incoming: null, error: '', texts: [], startedAt: 0, muted: false, cameraOff: false };
let store: CallStore = blank;
let session: CallSession | null = null;
const subs = new Set<() => void>();
const set = (p: Partial<CallStore>) => { store = { ...store, ...p }; subs.forEach((f) => f()); };
const useCall = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => store);
let remoteStream: MediaStream | null = null;

function mediaError(e: unknown, L: (en: string, ar: string) => string) {
  const n = (e as DOMException)?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return L('Camera or microphone permission was not given, so the call could not start.', 'إذن الكاميرا أو المايك مش متاح، فالمكالمة مقدرتش تبدأ.');
  if (n === 'NotFoundError') return L('No camera or microphone was found on this device.', 'ملقيتش كاميرا أو مايك على الجهاز ده.');
  return L('The call could not start on this device.', 'المكالمة مقدرتش تبدأ على الجهاز ده.');
}

function makeSession(id: string, media: 'video' | 'audio') {
  return new CallSession(id, media, {
    state: (s) => {
      if (s === 'connected') set({ phase: 'connected', startedAt: Date.now(), error: '' });
      else if (s === 'failed') set({ error: 'failed' });
    },
    remote: (s) => { remoteStream = s; set({}); },
    text: (t) => set({ texts: [...store.texts, { mine: false, text: t }].slice(-30) }),
  });
}

/** Start buttons for a consultation (patient ↔ their connected doctor). */
export function CallButtons({ consultationId, otherName, canCall }: { consultationId: string; otherName: string; canCall: boolean }) {
  const { backend } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const c = useCall();
  if (!backend.shared) return <p className="tiny muted" data-testid="call-unavailable"><LuVideo aria-hidden /> {L('Live calls need the synced version (the website with the AccessCare server, or the app inside Claude).', 'المكالمات المباشرة محتاجة النسخة المتزامنة (الموقع مع سيرفر أكسس كير، أو التطبيق جوه Claude).')}</p>;
  if (!callsSupported()) return <p className="tiny muted" data-testid="call-unavailable"><LuVideo aria-hidden /> {L('This browser cannot make live calls. Open AccessCare in Chrome, Edge, Safari or Firefox.', 'المتصفح ده مش بيدعم المكالمات المباشرة. افتح أكسس كير على كروم أو إيدج أو سفاري أو فايرفوكس.')}</p>;
  const start = async (media: 'video' | 'audio') => {
    if (store.phase !== 'idle' && store.phase !== 'ended') return;
    const id = newCallId();
    set({ ...blank, phase: 'starting', consultationId, otherName, media, id });
    session = makeSession(id, media);
    try {
      const sdp = await session.offer();
      await backend.sendMessage(consultationId, media === 'video' ? 'Video call' : 'Voice call', 'call', { call: { id, step: 'offer', media, sdp } });
      set({ phase: 'ringing', startedAt: Date.now() });
    } catch (e) {
      session?.close(); session = null;
      set({ phase: 'ended', error: (e as DOMException)?.name ? mediaError(e, L) : (e as Error).message });
    }
  };
  return (
    <div className="row wrap" style={{ gap: 8 }} data-testid="call-buttons">
      <Button variant="secondary" disabled={!canCall || (c.phase !== 'idle' && c.phase !== 'ended')} onClick={() => void start('video')} data-testid="call-video"><LuVideo aria-hidden /> {L('Video call', 'مكالمة فيديو')}</Button>
      <Button variant="secondary" disabled={!canCall || (c.phase !== 'idle' && c.phase !== 'ended')} onClick={() => void start('audio')} data-testid="call-audio"><LuPhone aria-hidden /> {L('Voice call', 'مكالمة صوتية')}</Button>
      <span className="tiny muted">{tr('Calls go directly between your device and {name}’s, encrypted. Nothing is recorded.', 'المكالمة بتروح مباشرة بين جهازك وجهاز {name}، ومشفّرة. مفيش حاجة بتتسجل.', lang, { name: otherName })}</span>
    </div>
  );
}

/** Watches for calls (incoming, answered, ended) and shows the call window. Mounted once for signed-in patients and doctors. */
export function CallLayer() {
  const { backend, me, version } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const c = useCall();
  const busy = useRef(false);
  const [tick, setTick] = useState(0);

  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 2500); return () => window.clearInterval(t); }, []);

  // what the other side did
  useEffect(() => {
    if (!me || !backend.shared || busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        const s = store;
        if (s.phase === 'ringing' || s.phase === 'connecting' || s.phase === 'connected' || s.phase === 'incoming') {
          const st = callState(await backend.listMessages(s.consultationId), s.phase === 'incoming' ? (s.incoming?.meta?.call?.id ?? '') : s.id);
          if (st.end && st.end.senderId !== me.profile.id) { finish(null, st.end.meta.call.reason === 'declined' ? L('The call was declined.', 'المكالمة اترفضت.') : ''); return; }
          if (s.phase === 'ringing' && st.answer?.meta.call.sdp) { set({ phase: 'connecting' }); await session?.accept(st.answer.meta.call.sdp); }
          else if (s.phase === 'ringing' && Date.now() - s.startedAt > RING_SECONDS * 1000) { await finish('missed', L('No answer.', 'محدش رد.')); }
          return;
        }
        if (s.phase !== 'idle' && s.phase !== 'ended') return;
        if (document.visibilityState === 'hidden') return;
        const list = (await backend.listConsultations()).filter((v) => v.consultation.status !== 'draft' && v.consultation.status !== 'cancelled')
          .sort((a, b) => (b.consultation.updatedAt ?? '').localeCompare(a.consultation.updatedAt ?? '')).slice(0, 8);
        for (const v of list) {
          const inc = incomingCall(await backend.listMessages(v.consultation.id), me.profile.id);
          if (inc) {
            const name = me.profile.role === 'patient' ? (v.doctor?.fullName ?? L('Your doctor', 'دكتورك')) : v.patient.fullName;
            set({ ...blank, phase: 'incoming', incoming: inc, consultationId: v.consultation.id, otherName: name, media: inc.meta!.call!.media, id: inc.meta!.call!.id });
            break;
          }
        }
      } catch { /* try again on the next tick */ } finally { busy.current = false; }
    })();
  }, [version, tick, me?.profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // the connection broke
  useEffect(() => { if (c.error === 'failed' && (c.phase === 'connecting' || c.phase === 'connected')) void finish('failed', L('The connection was lost. Some networks block direct calls — try again, or use messages.', 'الاتصال اتقطع. بعض الشبكات بتمنع المكالمات المباشرة — جرّب تاني، أو استخدم الرسايل.')); }, [c.error]); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish(reason: 'hangup' | 'declined' | 'missed' | 'failed' | null, note = '') {
    const s = store; const seconds = session?.seconds() ?? 0;
    session?.close(); session = null; remoteStream = null;
    set({ phase: 'ended', error: note });
    if (reason && s.consultationId && s.id) { try { await backend.sendMessage(s.consultationId, 'Call ended', 'call', { call: { id: s.id, step: 'end', media: s.media, reason, seconds } }); } catch { /* the other side times out */ } }
    window.setTimeout(() => { if (store.phase === 'ended') set({ ...blank }); }, note ? 6000 : 1500);
  }

  const answer = async (media: 'video' | 'audio') => {
    const inc = store.incoming; const sdp = inc?.meta?.call?.sdp; if (!inc || !sdp) return;
    set({ phase: 'connecting', media });
    session = makeSession(store.id, media);
    try {
      const ans = await session.answer(sdp, media);
      await backend.sendMessage(store.consultationId, 'Call answered', 'call', { call: { id: store.id, step: 'answer', media, sdp: ans } });
    } catch (e) { await finish('failed', (e as DOMException)?.name ? mediaError(e, L) : (e as Error).message); }
  };

  if (!me || c.phase === 'idle') return null;
  if (c.phase === 'incoming') return <Incoming name={c.otherName} media={c.media} onAnswer={answer} onDecline={() => void finish('declined')} L={L} />;
  return <CallWindow c={c} onEnd={() => void finish(c.phase === 'ringing' ? 'missed' : 'hangup')} L={L} lang={lang} />;
}

function Incoming({ name, media, onAnswer, onDecline, L }: { name: string; media: 'video' | 'audio'; onAnswer: (m: 'video' | 'audio') => void; onDecline: () => void; L: (en: string, ar: string) => string }) {
  // a soft ring while the call waits (if the browser allows sound)
  useEffect(() => {
    let ctx: AudioContext | null = null;
    try { ctx = new AudioContext(); } catch { return; }
    const ring = () => { try { const o = ctx!.createOscillator(); const g = ctx!.createGain(); o.frequency.value = 660; g.gain.value = 0.08; o.connect(g); g.connect(ctx!.destination); o.start(); o.stop(ctx!.currentTime + 0.4); } catch { /* */ } };
    ring(); const t = window.setInterval(ring, 2000);
    return () => { window.clearInterval(t); void ctx?.close().catch(() => {}); };
  }, []);
  useEffect(() => { document.querySelector<HTMLElement>('[data-testid=call-answer-video], [data-testid=call-answer-audio]')?.focus(); }, []);
  return (
    <div className="call-incoming" role="alertdialog" aria-modal="true" aria-labelledby="call-in-title" aria-describedby="call-in-note" data-testid="call-incoming">
      <div className="call-card">
        <h2 id="call-in-title">{media === 'video' ? <LuVideo aria-hidden /> : <LuPhone aria-hidden />} {tr('{name} is calling you', '{name} بيتصل بيك', undefined, { name })}</h2>
        <p id="call-in-note" className="small">{L('Answering turns on your microphone (and camera for video) only for this call. The call goes directly between the two devices, encrypted. Nothing is recorded.', 'لما ترد، المايك (والكاميرا في الفيديو) بيشتغلوا للمكالمة دي بس. المكالمة بتروح مباشرة بين الجهازين ومشفّرة. مفيش حاجة بتتسجل.')}</p>
        <div className="stack" style={{ gap: 8 }}>
          {media === 'video' && <Button big onClick={() => onAnswer('video')} data-testid="call-answer-video"><LuVideo aria-hidden /> {L('Answer with video', 'رد بالفيديو')}</Button>}
          <Button big variant={media === 'video' ? 'secondary' : 'primary'} onClick={() => onAnswer('audio')} data-testid="call-answer-audio"><LuPhone aria-hidden /> {media === 'video' ? L('Answer with voice only', 'رد بالصوت بس') : L('Answer', 'رد')}</Button>
          <Button variant="danger" onClick={onDecline} data-testid="call-decline"><LuPhoneOff aria-hidden /> {L('Decline', 'ارفض')}</Button>
        </div>
      </div>
    </div>
  );
}

function CallWindow({ c, onEnd, L, lang }: { c: CallStore; onEnd: () => void; L: (en: string, ar: string) => string; lang: string }) {
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now());
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (remote.current && remoteStream && remote.current.srcObject !== remoteStream) { remote.current.srcObject = remoteStream; void remote.current.play().catch(() => {}); } });
  useEffect(() => { if (local.current && session?.local && local.current.srcObject !== session.local) { local.current.srcObject = session.local; void local.current.play().catch(() => {}); } });
  const secs = c.phase === 'connected' ? Math.round((now - c.startedAt) / 1000) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const status = c.phase === 'starting' ? L('Starting…', 'بيبدأ…') : c.phase === 'ringing' ? tr('Calling {name}…', 'بيتصل بـ{name}…', lang, { name: c.otherName })
    : c.phase === 'connecting' ? L('Connecting…', 'بيتوصل…') : c.phase === 'connected' ? tr('Connected with {name} · {t}', 'متوصل مع {name} · {t}', lang, { name: c.otherName, t: clock }) : (c.error || L('Call ended', 'المكالمة خلصت'));
  const send = () => { const t = text.trim(); if (!t) return; if (session?.send(t)) { set({ texts: [...store.texts, { mine: true, text: t }].slice(-30) }); setText(''); } };
  return (
    <div className="call-window" role="dialog" aria-modal="true" aria-label={L('Live call', 'مكالمة مباشرة')} data-testid="call-window" data-phase={c.phase}>
      <p className="call-status" role="status" aria-live="polite" data-testid="call-status">{status}</p>
      <div className="call-stage">
        {c.media === 'video' || remoteStream?.getVideoTracks().length ? <video ref={remote} className="call-remote" autoPlay playsInline data-testid="call-remote" aria-label={tr('Video of {name}', 'فيديو {name}', lang, { name: c.otherName })} />
          : <div className="call-avatar" aria-hidden>{c.otherName.slice(0, 1)}</div>}
        {!(c.media === 'video' || remoteStream?.getVideoTracks().length) && <audio ref={remote as never} autoPlay data-testid="call-remote-audio" />}
        {c.media === 'video' && <video ref={local} className="call-local" autoPlay playsInline muted aria-label={L('Your camera', 'الكاميرا بتاعتك')} />}
      </div>
      {chatOpen && (
        <div className="call-chat" data-testid="call-chat">
          <div className="call-chat-list" aria-live="polite">{c.texts.map((m, i) => <p key={i} className={m.mine ? 'mine' : 'theirs'} data-no-tr>{m.text}</p>)}</div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} aria-label={L('Type a message during the call', 'اكتب رسالة أثناء المكالمة')} data-testid="call-chat-input" />
            <Button onClick={send} disabled={c.phase !== 'connected'} aria-label={L('Send', 'ابعت')} data-testid="call-chat-send"><LuSend aria-hidden /></Button>
          </div>
        </div>
      )}
      {c.phase !== 'ended' && (
        <div className="call-controls">
          <Button variant="secondary" onClick={() => { session?.mute(!c.muted); set({ muted: !c.muted }); }} aria-pressed={c.muted} data-testid="call-mute">{c.muted ? <LuMicOff aria-hidden /> : <LuMic aria-hidden />} {c.muted ? L('Unmute', 'شغّل المايك') : L('Mute', 'اقفل المايك')}</Button>
          {c.media === 'video' && <Button variant="secondary" onClick={() => { session?.camera(c.cameraOff); set({ cameraOff: !c.cameraOff }); }} aria-pressed={c.cameraOff} data-testid="call-camera">{c.cameraOff ? <LuVideoOff aria-hidden /> : <LuVideo aria-hidden />} {c.cameraOff ? L('Camera on', 'شغّل الكاميرا') : L('Camera off', 'اقفل الكاميرا')}</Button>}
          <Button variant="secondary" onClick={() => setChatOpen((o) => !o)} aria-expanded={chatOpen} data-testid="call-chat-toggle"><LuMessageSquare aria-hidden /> {L('Type', 'اكتب')}</Button>
          <Button variant="danger" onClick={onEnd} data-testid="call-end"><LuPhoneOff aria-hidden /> {L('End call', 'إنهاء المكالمة')}</Button>
        </div>
      )}
    </div>
  );
}
