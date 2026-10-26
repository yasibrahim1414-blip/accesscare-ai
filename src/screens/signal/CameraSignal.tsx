// Silent Signal — camera section: answer with SIGN LANGUAGE.
// The camera tracks the patient's hands (MediaPipe Hand Landmarker, on this
// device) and recognizes signs that drive the same commands as before
// (Yes, No, Next, Choose, Not sure):
//   • built-in ASL signs YES and NO (rules from the dictionary form of the signs)
//   • the patient's own signs in any sign language, taught here 3 times each
// It never interprets expressions, pain or illness, never guesses an unclear
// sign, and every answer is shown back for confirmation. Frames are analysed
// in this tab and discarded; nothing is recorded or uploaded.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuCamera, LuCameraOff, LuPause, LuPlay, LuSquare, LuShieldCheck, LuCircleCheck, LuTriangleAlert, LuRotateCcw,
  LuSend, LuSave, LuSparkles, LuCircleX, LuPencil, LuMapPin, LuVolume2, LuHand,
} from 'react-icons/lu';
import { useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, ConfirmSheet, Field, Steps, TopBar, fmtRelative, speak, ttsSupported } from '../../ui/components';
import { DEFAULT_SIGNAL, type Sensation, type SignalPrefs } from '../../domain/types';
import { COMMANDS, type CameraSignalPrefs, type Command, type SignSetting } from '../../domain/camera';
import { HandTracker } from '../../services/sign/HandTracker';
import { CAMERA_ERROR_TEXT, cameraSupport, type CameraError, type TrackerState } from '../../services/camera/camera';
import { Segmenter, compact, framing, loadVocabulary, saveVocabulary, sampleConsistency, sequenceOf, type Framing, type SignFrame, type SignWord, type Vocabulary } from '../../services/sign/SignRecognizer';
import { BUILTIN, COMMAND_LABEL, SignDetector, actionFor, commandOf, confirmAction, isBuiltin, mappingProblems, type Mapping, type SignEvent } from '../../services/sign/SignCommands';
import { SIGNAL_STEPS } from '../../services/signal/SignalEngine';
import { BODY_REGIONS, REGION_GROUPS, regionLabel } from '../../domain/bodyRegions';
import { BodySelector } from '../../body/BodySelector';
import { EmergencyContent, UrgentHelpButton } from '../shared/Emergency';
import { build, buildBrief, briefText, toStructuredReport } from '../../services/intent/ReconstructionEngine';
import type { SignalRecord, SignalSelection } from '../../domain/reconstruction';
import { assessSafety } from '../../services/safety';

// ------------------------------------------------------------------ camera hook + panel

const CONNECTIONS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export function useHandCamera(onFrame?: (f: SignFrame) => void) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tracker = useRef<HandTracker | null>(null);
  const frameCb = useRef(onFrame); frameCb.current = onFrame;
  const last = useRef<SignFrame | null>(null);
  const [state, setState] = useState<TrackerState>('idle');
  const [error, setError] = useState<CameraError | null>(null);
  const [, tick] = useState(0);

  const draw = (f: SignFrame) => {
    const c = canvasRef.current; const v = videoRef.current; if (!c || !v) return;
    const w = v.videoWidth || 640, h = v.videoHeight || 480;
    if (c.width !== w) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); if (!g) return;
    g.clearRect(0, 0, w, h);
    for (const hand of f.hands) {
      g.strokeStyle = '#2bb3a3'; g.lineWidth = 4; g.fillStyle = '#ffffff';
      for (const [a, b] of CONNECTIONS) { g.beginPath(); g.moveTo(hand.lm[a][0] * w, hand.lm[a][1] * h); g.lineTo(hand.lm[b][0] * w, hand.lm[b][1] * h); g.stroke(); }
      for (const p of hand.lm) { g.beginPath(); g.arc(p[0] * w, p[1] * h, 4, 0, Math.PI * 2); g.fill(); }
    }
    c.dataset.hands = String(f.hands.length);
  };
  const start = useCallback(() => {
    if (!videoRef.current) return;
    tracker.current?.stop();
    tracker.current = new HandTracker(videoRef.current, {
      onState: (s, e) => { setState(s); setError(e ?? null); },
      onFrame: (f) => { last.current = f; draw(f); frameCb.current?.(f); },
    });
    void tracker.current.start();
  }, []);
  const stop = useCallback(() => { tracker.current?.stop(); }, []);
  useEffect(() => {
    const id = window.setInterval(() => { if (tracker.current?.state === 'running') tick((x) => x + 1); }, 200);
    const onHide = () => { if (document.visibilityState === 'hidden') tracker.current?.stop(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onHide); tracker.current?.stop(); };
  }, []);
  return {
    videoRef, canvasRef, state, error, start, stop,
    pause: () => tracker.current?.pause(), resume: () => tracker.current?.resume(),
    frame: last.current, framing: (last.current ? framing(last.current) : 'no_hands') as Framing,
    fps: tracker.current?.fps ?? 0,
    on: state === 'running' || state === 'paused' || state === 'loading',
  };
}
export type HandCamera = ReturnType<typeof useHandCamera>;

const STATE_TEXT: Record<TrackerState, string> = {
  idle: 'Camera off', requesting: 'Waiting for permission…', loading: 'Camera on · loading hand tracking…', running: 'Camera on',
  paused: 'Camera on · paused', stopped: 'Camera off', error: 'Camera off',
};
const FRAMING_TEXT: Record<Framing, string> = {
  no_hands: 'Hands not visible', edge: 'Part of your hand is outside the picture', too_close: 'Hand too close — move back a little', too_far: 'Hand too far — come closer', ok: 'Hands found',
};

export function CameraPanel({ cam, flash, onAlternative, compact, children }: {
  cam: HandCamera; flash?: { text: string; kind: 'ok' | 'warn' | 'info' } | null; onAlternative?: () => void; compact?: boolean; children?: React.ReactNode;
}) {
  const live = cam.state === 'running' || cam.state === 'paused' || cam.state === 'loading';
  return (
    <div className={`cam card${compact ? ' compact' : ''}`}>
      <div className="cam-view" data-live={live}>
        <video ref={cam.videoRef} className="cam-video" muted playsInline aria-label="Your camera preview (mirrored)" />
        <canvas ref={cam.canvasRef} className="cam-overlay" aria-hidden data-testid="cam-overlay" />
        {!live && <div className="cam-off" aria-hidden><LuCameraOff /></div>}
        <span className={`cam-badge ${live ? 'on' : ''}`} data-testid="cam-status" role="status">{live && <i className="rec-dot" aria-hidden />}{STATE_TEXT[cam.state]}</span>
        {cam.state === 'running' && (
          <span className={`cam-face ${cam.framing === 'ok' ? 'ok' : 'lost'}`} data-testid="cam-hands" data-framing={cam.framing}>{cam.framing === 'ok' ? <><LuHand aria-hidden /> {FRAMING_TEXT.ok}</> : <><LuTriangleAlert aria-hidden /> {FRAMING_TEXT[cam.framing]}</>}</span>
        )}
        {flash && <div className={`cam-flash ${flash.kind}`} data-testid="cam-flash" role="status" aria-live="assertive">{flash.text}</div>}
      </div>
      {children}
      <div className="cam-controls">
        {(cam.state === 'idle' || cam.state === 'stopped' || cam.state === 'error') && <Button onClick={cam.start} data-testid="cam-start"><LuCamera aria-hidden /> Start camera</Button>}
        {cam.state === 'requesting' && <Button busy>Waiting</Button>}
        {cam.state === 'running' && <Button variant="secondary" onClick={cam.pause} data-testid="cam-pause"><LuPause aria-hidden /> Pause</Button>}
        {cam.state === 'paused' && <Button variant="secondary" onClick={cam.resume} data-testid="cam-resume"><LuPlay aria-hidden /> Resume</Button>}
        {live && <Button variant="danger-outline" onClick={cam.stop} data-testid="cam-stop"><LuSquare aria-hidden /> Stop camera</Button>}
      </div>
      {cam.error && (
        <div className="banner warn" role="alert" data-testid="cam-error" data-error={cam.error}>
          <LuTriangleAlert aria-hidden />
          <div className="grow stack" style={{ gap: 6 }}>
            <span>{CAMERA_ERROR_TEXT[cam.error]}</span>
            {onAlternative && <Button variant="secondary" onClick={onAlternative} data-testid="cam-alt">Answer another way</Button>}
          </div>
        </div>
      )}
      {!compact && <p className="tiny muted cam-privacy"><LuShieldCheck aria-hidden /> Video is analysed on this device only. Nothing is recorded, saved or uploaded. Only your settings, the hand-point numbers of signs you teach (kept on this device) and the answers you confirm are saved.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ settings helper

function useCameraPrefs() {
  const { me, setMe, backend, toast } = useApp();
  const sp: SignalPrefs = me?.preferences.signal ?? DEFAULT_SIGNAL;
  const owner = me?.profile.id ?? 'device';
  const save = async (camera: CameraSignalPrefs) => {
    try { const saved = await backend.savePreferences({ ...me!.preferences, signal: { ...sp, camera } }); setMe({ ...me!, preferences: saved }); return true; }
    catch (e) { toast((e as Error).message); return false; }
  };
  return { cp: sp.camera, save, owner };
}

/** Signs usable on this device: built-in ASL signs everywhere, taught signs only where their examples are stored. */
function available(cp: CameraSignalPrefs | undefined, vocab: Vocabulary): Record<string, { reliable: boolean; label: string }> {
  const out: Record<string, { reliable: boolean; label: string }> = {};
  for (const [id, s] of Object.entries(cp?.signs ?? {})) {
    if (s.kind === 'taught' && !vocab.signs.some((w) => w.id === id && w.samples.length >= 2)) continue;
    out[id] = { reliable: s.reliable, label: s.label };
  }
  return out;
}
const signLabel = (id: string | undefined, signs: Record<string, SignSetting> = {}) => (!id ? '—' : isBuiltin(id) ? BUILTIN[id].label : `your sign “${signs[id]?.label ?? id}”`);

export function cameraReady(cp: CameraSignalPrefs | undefined, vocab: Vocabulary): boolean {
  return !!cp && cp.confirmedByPatient && mappingProblems(cp.mapping, available(cp, vocab)).length === 0;
}

/** Card shown on the Silent Signal home screen. */
export function CameraModeCard() {
  const { nav } = useApp();
  const { cp, owner } = useCameraPrefs();
  const vocab = useMemo(() => loadVocabulary(owner), [owner]);
  const sup = cameraSupport();
  const ready = cameraReady(cp, vocab);
  const missingTaught = !!cp && cp.confirmedByPatient && !ready && Object.values(cp.mapping).some((id) => id && cp.signs[id]?.kind === 'taught' && !vocab.signs.some((w) => w.id === id));
  return (
    <div className="card" data-testid="camera-card">
      <div className="row"><span className="li-ico" style={{ width: 42, height: 42, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--teal-50)', color: 'var(--teal-ink)' }}><LuHand /></span>
        <div className="grow"><div className="tiny muted strong">Sign language with the camera</div><b>Answer with signs</b></div></div>
      <p className="small muted">Answer Yes, No and choices by signing in front of the camera. Built in: the ASL signs YES and NO. You can also teach your own signs (for example Egyptian Sign Language) for each answer.</p>
      {!sup.ok && <Banner kind="warn">{CAMERA_ERROR_TEXT[sup.error]}</Banner>}
      {cp && (ready
        ? <div className="banner ok small"><LuCircleCheck aria-hidden /><div>Set up · {Object.entries(cp.mapping).map(([c, s]) => `${COMMAND_LABEL[c as Command]} = ${signLabel(s, cp.signs)}`).join(' · ')}{cp.confirmedAt ? ` · ${fmtRelative(cp.confirmedAt)}` : ''}</div></div>
        : <div className="banner warn small"><LuTriangleAlert aria-hidden /><div>{missingTaught ? 'Your own signs were taught on another device. Teach them again here.' : 'Setup isn’t finished yet.'}</div></div>)}
      <div className="grid2">
        <Button variant="secondary" onClick={() => nav.push({ name: 'ss.camsetup' })} data-testid="open-camera-setup">{cp ? 'Change signs' : 'Set up'}</Button>
        <Button onClick={() => nav.push({ name: 'ss.camsession' })} disabled={!ready} data-testid="start-camera-session"><LuPlay aria-hidden /> Start</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ setup wizard

type SetupPhase = 'intro' | 'choose' | 'teach' | 'practice' | 'test' | 'confirm';
const PRACTICE = 3;
const TEACH = 3;
const ATTEMPT_MS = 9000;

export function CameraSetup() {
  const { nav, toast } = useApp();
  const { cp, save, owner } = useCameraPrefs();
  const [vocab, setVocab] = useState<Vocabulary>(() => loadVocabulary(owner));
  const [phase, setPhase] = useState<SetupPhase>('intro');
  const [mapping, setMapping] = useState<Mapping>(() => cp?.mapping ?? { yes: 'asl_yes', no: 'asl_no' });
  const [signs, setSigns] = useState<Record<string, SignSetting>>(() => ({ ...(cp?.signs ?? {}) }));
  const [current, setCurrent] = useState<{ cmd: Command; id: string } | null>(null);
  const [examples, setExamples] = useState<number[][][]>([]);
  const [recording, setRecording] = useState(false);
  const [attempt, setAttempt] = useState<{ n: number; ok: number; state: 'ready' | 'go' | 'seen' | 'missed' | 'other' }>({ n: 0, ok: 0, state: 'ready' });
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'warn' | 'info' } | null>(null);
  const [tested, setTested] = useState<Partial<Record<Command, boolean>>>({});
  const [testIdx, setTestIdx] = useState(0);
  const [testHighlight, setTestHighlight] = useState(0);

  const phaseRef = useRef(phase); phaseRef.current = phase;
  const recRef = useRef(recording); recRef.current = recording;
  const attemptRef = useRef(attempt); attemptRef.current = attempt;
  const detector = useRef<SignDetector | null>(null);
  const onEvent = useRef<(e: SignEvent) => void>(() => undefined);
  const teachSeg = useRef<Segmenter | null>(null);
  const attemptTimer = useRef(0);

  const cam = useHandCamera((f) => {
    if (phaseRef.current === 'teach' && recRef.current) teachSeg.current?.push(f);
    if ((phaseRef.current === 'practice' && attemptRef.current.state === 'go') || phaseRef.current === 'test' || phaseRef.current === 'confirm') detector.current?.feed(f);
  });
  useEffect(() => { if (phase === 'intro' && cam.state === 'running') setPhase('choose'); }, [cam.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const taughtWords = (v = vocab): SignWord[] => v.signs;
  const makeDetector = (active: string[]) => { detector.current = new SignDetector(active, taughtWords(), (e) => onEvent.current(e)); };
  const avail = available({ method: 'signs', mapping, signs, tested: {}, confirmedByPatient: false }, vocab);
  const problems = mappingProblems(mapping, avail);

  // ---- teach your own sign (3 examples)
  function startTeach(cmd: Command) {
    const id = `t_${cmd}`;
    setCurrent({ cmd, id }); setExamples([]); setRecording(false); setMsg(null);
    teachSeg.current = new Segmenter((frames) => {
      if (!recRef.current) return;
      setRecording(false);
      setExamples((ex) => { const next = [...ex, compact(sequenceOf(frames))]; setMsg({ text: `Example ${next.length} of ${TEACH} recorded.`, kind: 'ok' }); return next; });
    });
    setPhase('teach');
  }
  function saveTaught() {
    if (!current) return;
    const word: SignWord = { id: current.id, en: COMMAND_LABEL[current.cmd], ar: '', samples: examples };
    const next: Vocabulary = { v: 1, signs: [...vocab.signs.filter((w) => w.id !== current.id), word] };
    if (!saveVocabulary(owner, next)) toast('This browser blocks storage: your sign works only until you close the page.');
    setVocab(next);
    setSigns((s) => ({ ...s, [current.id]: { kind: 'taught', label: `${COMMAND_LABEL[current.cmd]} (my sign)`, practiced: 0, recognized: 0, reliable: false, at: new Date().toISOString() } }));
    setMapping((m) => ({ ...m, [current.cmd]: current.id }));
    startPractice(current.cmd, current.id, next);
  }

  // ---- practise a sign (built-in or taught): 3 attempts
  function startPractice(cmd: Command, id: string, v = vocab) {
    setCurrent({ cmd, id }); setMsg(null);
    const others = Object.values(mapping).filter((x): x is string => !!x && x !== id);
    detector.current = new SignDetector([id, ...others], v.signs, (e) => onEvent.current(e));
    setAttempt({ n: 0, ok: 0, state: 'ready' }); setPhase('practice');
  }
  useEffect(() => {
    if (phase !== 'practice' || attempt.state !== 'ready') return;
    const t = window.setTimeout(() => {
      setAttempt((a) => ({ ...a, state: 'go' }));
      window.clearTimeout(attemptTimer.current);
      attemptTimer.current = window.setTimeout(() => { if (attemptRef.current.state === 'go') endAttempt(false, 'missed'); }, ATTEMPT_MS);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [phase, attempt.state, attempt.n]); // eslint-disable-line react-hooks/exhaustive-deps
  function endAttempt(ok: boolean, state: 'seen' | 'missed' | 'other') {
    window.clearTimeout(attemptTimer.current);
    const a = attemptRef.current; const n = a.n + 1; const okN = a.ok + (ok ? 1 : 0);
    setAttempt({ n, ok: okN, state });
    if (n >= PRACTICE && current) {
      const reliable = okN >= 2;
      const label = isBuiltin(current.id) ? BUILTIN[current.id].label : `${COMMAND_LABEL[current.cmd]} (my sign)`;
      setSigns((s) => ({ ...s, [current.id]: { kind: isBuiltin(current.id) ? 'builtin' : 'taught', label, practiced: n, recognized: okN, reliable, at: new Date().toISOString() } }));
      setMsg({ text: reliable ? `${okN} of ${n} recognized — reliable.` : `Only ${okN} of ${n} recognized. Try again, sign more clearly in good light, or choose another sign.`, kind: reliable ? 'ok' : 'warn' });
      window.setTimeout(() => setPhase('choose'), 1400);
    } else window.setTimeout(() => setAttempt((x) => ({ ...x, state: 'ready' })), 900);
  }

  // ---- sample questions
  const TESTS = useMemo(() => {
    const t: { cmd: Command; text: string }[] = [
      { cmd: 'yes', text: 'Sample question: Is this a star? ⭐  — answer YES' },
      { cmd: 'no', text: 'Sample question: Is this a house? ⭐  — answer NO' },
    ];
    if (mapping.next) t.push({ cmd: 'next', text: 'Move to the next picture with NEXT' });
    if (mapping.select) t.push({ cmd: 'select', text: 'Choose the highlighted picture with CHOOSE' });
    if (mapping.unsure) t.push({ cmd: 'unsure', text: 'Show NOT SURE' });
    return t;
  }, [mapping]);
  const startTest = () => { makeDetector(Object.values(mapping).filter(Boolean) as string[]); setTested({}); setTestIdx(0); setMsg(null); setTestHighlight(0); setPhase('test'); };

  onEvent.current = (e) => {
    const ph = phaseRef.current;
    if (ph === 'practice' && current && attemptRef.current.state === 'go') {
      if (e.type === 'sign' && e.sign === current.id && e.quality === 'clear') { setMsg({ text: '✓ Recognized', kind: 'ok' }); endAttempt(true, 'seen'); }
      else if (e.type === 'sign' && e.sign === current.id) setMsg({ text: 'Almost — please sign it once more, clearly.', kind: 'warn' });
      else if (e.type === 'sign') { setMsg({ text: `That looked like ${signLabel(e.sign, signs)}.`, kind: 'warn' }); endAttempt(false, 'other'); }
      else if (e.type === 'ambiguous') setMsg({ text: 'That looked like two different signs — try again.', kind: 'warn' });
      else setMsg({ text: 'I didn’t recognize that sign — try again.', kind: 'warn' });
      return;
    }
    if (ph === 'confirm') {
      if (e.type !== 'sign' || e.quality !== 'clear') return;
      const cmd = commandOf(e.sign, mapping);
      if (cmd === 'yes') void finish(true);
      if (cmd === 'no') setPhase('choose');
      return;
    }
    if (ph !== 'test') return;
    const want = TESTS[testIdx]; if (!want) return;
    if (e.type === 'ambiguous') { setMsg({ text: 'That looked like two different signs — please try again.', kind: 'warn' }); return; }
    if (e.type === 'unknown') { setMsg({ text: 'I didn’t recognize that sign — please try again.', kind: 'warn' }); return; }
    if (e.quality === 'borderline') { setMsg({ text: 'Not sure I saw that clearly — please sign it again.', kind: 'warn' }); return; }
    const cmd = commandOf(e.sign, mapping);
    if (cmd === want.cmd) {
      setTested((t) => ({ ...t, [want.cmd]: true }));
      if (want.cmd === 'next') setTestHighlight((h) => h + 1);
      setMsg({ text: `✓ ${COMMAND_LABEL[cmd]} — ${signLabel(e.sign, signs)}`, kind: 'ok' });
      window.setTimeout(() => { setMsg(null); setTestIdx((i) => i + 1); }, 900);
    } else {
      setTested((t) => ({ ...t, [want.cmd]: t[want.cmd] ?? false }));
      setMsg({ text: cmd ? `That was ${COMMAND_LABEL[cmd].toUpperCase()}, not ${COMMAND_LABEL[want.cmd].toUpperCase()}. Try again.` : 'That sign isn’t linked to an answer.', kind: 'warn' });
    }
  };
  useEffect(() => { if (phase === 'test' && testIdx >= TESTS.length) setPhase('confirm'); }, [phase, testIdx, TESTS.length]);

  async function finish(works: boolean) {
    if (!works) { setPhase('choose'); return; }
    const ok = await save({ method: 'signs', mapping, signs, tested, confirmedByPatient: true, confirmedAt: new Date().toISOString() });
    if (ok) { cam.stop(); toast('Signs are set up'); nav.back(); }
  }

  const stepNo = { intro: 0, choose: 1, teach: 1, practice: 1, test: 2, confirm: 2 }[phase];
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;
  if (phase === 'intro') {
    body = <>
      <div><h2 className="title">Answer with sign language</h2>
        <p className="muted small">Sign in front of the camera to answer Yes, No and choices. AccessCare recognizes the ASL signs YES and NO, and any sign you teach it.</p></div>
      <div className="card tinted small" style={{ gap: 6 }} data-testid="sign-scope">
        <b>What this can and cannot do</b>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>Built in: two signs of American Sign Language (ASL) — <b>YES</b> and <b>NO</b> — recognized from your hand shape and movement.</li>
          <li>Arabic and Egyptian sign languages are not built in: no suitable recognition model was available. You can teach your own signs (from any sign language) for each answer — 3 examples each, saved on this device.</li>
          <li>It recognizes single signs for answers. It does not translate full signed sentences, and it does not read facial expressions, pain or illness.</li>
          <li>An unclear sign is never guessed. Every answer is shown back for you to confirm, and the buttons always work.</li>
          <li>Nothing is recorded or uploaded. Stop the camera at any time.</li>
        </ul>
      </div>
      <Banner kind="danger">If you need urgent help, don’t set this up now: use the red Urgent button or call your local emergency number.</Banner>
      <p className="small muted">When you press Start camera, your browser asks for permission. Sit so your chest and hands are in the picture, in good light.</p>
    </>;
    footer = <Button variant="secondary" block onClick={() => { cam.stop(); nav.replace({ name: 'ss.calibrate' }); }} data-testid="intro-other-method">Use another method</Button>;
  } else if (phase === 'choose') {
    body = <>
      <div><h2 className="title">Which sign means what?</h2><p className="muted small">Yes and No are needed. Next, Choose and Not sure are optional — without them, in lists, No moves to the next option and Yes chooses it. Practise each sign 3 times.</p></div>
      {msg && <Banner kind={msg.kind === 'ok' ? 'ok' : msg.kind === 'warn' ? 'warn' : 'info'}>{msg.text}</Banner>}
      <div className="list">
        {COMMANDS.map((c) => {
          const builtin = c === 'yes' ? 'asl_yes' : c === 'no' ? 'asl_no' : null;
          const cur = mapping[c];
          const st = cur ? signs[cur] : undefined;
          const taughtHere = vocab.signs.some((w) => w.id === `t_${c}`);
          return (
            <div key={c} className="list-item map-row" data-testid={`sign-row-${c}`}>
              <div className="grow stack" style={{ gap: 4 }}>
                <div><b>{COMMAND_LABEL[c]}</b>{(c === 'yes' || c === 'no') && <span className="tag needs_clarification">Needed</span>}</div>
                <select data-testid={`map-${c}`} value={cur ?? ''} onChange={(e) => setMapping((m) => { const n = { ...m }; if (e.target.value) n[c] = e.target.value; else delete n[c]; return n; })}>
                  <option value="">— not used —</option>
                  {builtin && <option value={builtin}>{BUILTIN[builtin as 'asl_yes'].label} (built in)</option>}
                  {taughtHere && <option value={`t_${c}`}>My own sign</option>}
                </select>
                {cur && isBuiltin(cur) && <span className="tiny muted">How: {BUILTIN[cur].how}</span>}
                {st && <span className={`tiny ${st.reliable ? 'ok-text' : 'warn-text'}`} data-testid={`sign-status-${c}`}>{st.practiced ? `${st.recognized} of ${st.practiced} recognized in practice${st.reliable ? ' — reliable' : ' — not reliable yet'}` : 'Not practised yet'}</span>}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {cur && <Button variant="secondary" disabled={cam.state !== 'running'} onClick={() => startPractice(c, cur)} data-testid={`practise-${c}`}>Practise</Button>}
                <Button variant="ghost" disabled={cam.state !== 'running'} onClick={() => startTeach(c)} data-testid={`teach-${c}`}>Teach my sign</Button>
              </div>
            </div>
          );
        })}
      </div>
      {problems.length > 0 && <Banner kind="warn">{problems.join(' ')}</Banner>}
      <p className="tiny muted">A sign never means anything medical by itself — it only gives the answer you assign here, and every answer is confirmed.</p>
    </>;
    footer = <>
      <Button variant="secondary" onClick={() => { cam.stop(); nav.replace({ name: 'ss.calibrate' }); }} data-testid="use-other-method">Use another method</Button>
      <Button big disabled={problems.length > 0 || cam.state !== 'running'} onClick={startTest} data-testid="map-save">Test with sample questions</Button>
    </>;
  } else if (phase === 'teach' && current) {
    const q = examples.length >= 2 ? sampleConsistency({ id: current.id, en: '', ar: '', samples: examples }) : null;
    body = <>
      <div className="card tinted" style={{ textAlign: 'center' }} data-testid="teach-status">
        <span className="tiny muted strong">TEACH YOUR SIGN FOR “{COMMAND_LABEL[current.cmd].toUpperCase()}” · {examples.length} OF {TEACH}</span>
        <b style={{ fontSize: '1.15em' }}>{recording ? 'Sign it now, then lower your hands' : examples.length >= TEACH ? 'Done — save it' : 'Press Record, sign it once, then lower your hands'}</b>
        <span className="small muted">Use the sign you normally use, in any sign language. Sign it the same way each time.</span>
      </div>
      {msg && <Banner kind={msg.kind === 'ok' ? 'ok' : 'info'}>{msg.text}</Banner>}
      {q === 'poor' && <Banner kind="warn">The examples look quite different from each other — record them again the same way.</Banner>}
    </>;
    footer = <>
      <Button variant="secondary" onClick={() => setPhase('choose')}>Cancel</Button>
      {examples.length < TEACH
        ? <Button big disabled={recording} onClick={() => { setMsg(null); setRecording(true); }} data-testid="teach-record">{recording ? 'Recording…' : 'Record'}</Button>
        : <Button big onClick={saveTaught} data-testid="teach-save">Save and practise</Button>}
    </>;
  } else if (phase === 'practice' && current) {
    const how = isBuiltin(current.id) ? BUILTIN[current.id].how : 'Make your own sign, the way you taught it.';
    body = <>
      <div className="card tinted" style={{ textAlign: 'center' }} data-testid="trial-status" data-phase={attempt.state}>
        <span className="tiny muted strong">PRACTICE {Math.min(attempt.n + 1, PRACTICE)} OF {PRACTICE} · {COMMAND_LABEL[current.cmd].toUpperCase()}</span>
        <b style={{ fontSize: '1.2em' }}>{attempt.state === 'ready' ? 'Get ready…' : attempt.state === 'go' ? `Now: sign ${signLabel(current.id, signs)}` : attempt.state === 'seen' ? '✓ Recognized' : attempt.state === 'other' ? 'Recognized a different sign' : 'Not recognized'}</b>
        <span className="small muted">{how}</span>
      </div>
      {msg && <Banner kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Banner>}
    </>;
    footer = <Button variant="secondary" block onClick={() => setPhase('choose')}>Stop practice</Button>;
  } else if (phase === 'test') {
    const want = TESTS[testIdx];
    body = <>
      <div><h2 className="title">Try your signs</h2><p className="muted small">These sample questions are not about your health.</p></div>
      {want && <div className="card tinted" style={{ textAlign: 'center' }} data-testid="test-step" data-cmd={want.cmd}>
        <span className="tiny muted strong">TEST {testIdx + 1} OF {TESTS.length}</span>
        <b style={{ fontSize: '1.2em' }}>{want.text}</b>
        <span className="small muted">Sign: {signLabel(mapping[want.cmd], signs)}</span>
        {(want.cmd === 'next' || want.cmd === 'select') && <div className="row" style={{ justifyContent: 'center', gap: 8 }}>{['⭐', '🌙', '🏠'].map((x, i) => <span key={x} className={`scan-chip${i === testHighlight % 3 ? ' lit' : ''}`}>{x}</span>)}</div>}
      </div>}
    </>;
    footer = <Button variant="secondary" block onClick={() => setPhase('choose')}>Back</Button>;
  } else if (phase === 'confirm') {
    body = <div className="card" style={{ textAlign: 'center' }} data-testid="confirm-works">
      <LuCircleCheck style={{ fontSize: 44, color: 'var(--ok)', margin: '0 auto' }} aria-hidden />
      <h2 className="title">Did the signs work the way you intended?</h2>
      <p className="small muted">{Object.entries(mapping).map(([c, s]) => `${COMMAND_LABEL[c as Command]}: ${signLabel(s, signs)}`).join(' · ')}</p>
      <p className="small muted">Answer with your Yes or No sign, or the buttons.</p>
    </div>;
    footer = <>
      <Button variant="secondary" onClick={() => finish(false)} data-testid="works-no">No, change them</Button>
      <Button big onClick={() => finish(true)} data-testid="works-yes">Yes, save</Button>
    </>;
  }

  return (
    <>
      <TopBar title="Sign language · camera" right={<UrgentHelpButton />} />
      <div className="screen screen-in"><div className="pad">
        <Steps total={3} current={stepNo} label={['Camera', 'Choose and practise signs', 'Test and confirm'][stepNo]} />
        <CameraPanel cam={cam} flash={phase === 'test' || phase === 'confirm' || phase === 'practice' ? msg : null} compact={phase !== 'intro'} onAlternative={() => { cam.stop(); nav.replace({ name: 'ss.calibrate' }); }} />
        {body}
      </div></div>
      {footer && <div className="footer-bar">{footer}</div>}
    </>
  );
}

// ------------------------------------------------------------------ medical session

type QType = 'yesno' | 'choice';
interface Opt { id: string; label: string; symbol?: string }
interface Q { id: string; type: QType; text: string; short: string; options?: Opt[]; urgentIfYes?: string }
interface Answer { qid: string; question: string; value: string; label: string; status: 'confirmed' | 'not_sure' | 'unanswered'; via?: string; at: string }

const NOT_SURE: Opt = { id: 'not_sure', label: 'Not sure', symbol: '❔' };
const YN: Opt[] = [{ id: 'yes', label: 'Yes', symbol: '👍' }, { id: 'no', label: 'No', symbol: '👎' }, NOT_SURE];
const groupSymbol = (g: string) => (g === 'Head & neck' ? '🙂' : g === 'Torso' ? '👕' : g === 'Arms' ? '💪' : '🦵');

function questionsFor(a: Record<string, Answer>, group: string | null): Q[] {
  const qs: Q[] = [
    { id: 'help_now', type: 'yesno', text: 'Do you need help right now?', short: 'Needs help now', urgentIfYes: 'you need help right now' },
    { id: 'breathing', type: 'yesno', text: 'Are you having trouble breathing?', short: 'Trouble breathing', urgentIfYes: 'trouble breathing' },
    { id: 'stroke', type: 'yesno', text: 'Is your face, an arm or a leg suddenly weak or numb — or is speaking suddenly hard?', short: 'Sudden weakness or speech difficulty', urgentIfYes: 'sudden weakness, numbness or difficulty speaking' },
    { id: 'pain', type: 'yesno', text: 'Are you in pain?', short: 'In pain' },
  ];
  if (a.pain?.value === 'yes') {
    qs.push({ id: 'group', type: 'choice', text: 'Where is the pain? Choose a part of the body.', short: 'Body part', options: [...REGION_GROUPS.map((g) => ({ id: g, label: g, symbol: groupSymbol(g) })), NOT_SURE] });
    const g = group ?? (a.group && a.group.value !== 'not_sure' ? a.group.value : null);
    if (g) qs.push({ id: 'region', type: 'choice', text: 'Which area exactly?', short: 'Area', options: [...BODY_REGIONS.filter((r) => r.group === g).map((r) => ({ id: r.id, label: r.label, symbol: r.side === 'left' ? 'L' : r.side === 'right' ? 'R' : '•' })), NOT_SURE] });
    qs.push({ id: 'severity', type: 'choice', text: 'How strong is the pain?', short: 'Strength', options: [{ id: 'Mild', label: 'Mild', symbol: '🙂' }, { id: 'Moderate', label: 'Moderate', symbol: '😐' }, { id: 'Severe', label: 'Severe', symbol: '😣' }, NOT_SURE] });
    qs.push({ id: 'today', type: 'yesno', text: 'Did the pain begin today?', short: 'Began today' });
    qs.push({ id: 'worse', type: 'yesno', text: 'Is it getting worse?', short: 'Getting worse' });
  }
  const need = SIGNAL_STEPS.find((s) => s.id === 'need')!;
  qs.push({ id: 'need', type: 'choice', text: 'What would you like from your doctor?', short: 'Request', options: need.options.filter((o) => o.id !== 'help_now') });
  return qs;
}

/** Things this session never asks about — listed so silence isn't read as "no". */
const NOT_ASKED = ['What the pain feels like (e.g. burning, sharp)', 'Whether it is constant or comes and goes', 'Other symptoms besides breathing and sudden weakness', 'Medicines taken'];

type SPhase = 'start' | 'ask' | 'confirm' | 'urgent' | 'summary' | 'send_confirm' | 'done';

export function CameraSession() {
  const { backend, ai, prefs, nav, refresh } = useApp();
  const { cp, owner } = useCameraPrefs();
  const vocab = useMemo(() => loadVocabulary(owner), [owner]);
  const doctor = useLoad(() => backend.getMyDoctor(), []);
  const mapping: Mapping = cp?.mapping ?? {};
  const [phase, setPhase] = useState<SPhase>('start');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [qi, setQi] = useState(0);
  const [group, setGroup] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState<{ opt: Opt; via?: string } | null>(null);
  const [flash, setFlash] = useState<{ text: string; kind: 'ok' | 'warn' | 'info' } | null>(null);
  const [urgentReasons, setUrgentReasons] = useState<string[]>([]);
  const [useMap, setUseMap] = useState(false);
  const [note, setNote] = useState('');
  const [wording, setWording] = useState<{ text: string; source: 'template' | 'ai' } | null>(null);
  const [rejectedWordings, setRejected] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [rejectSheet, setRejectSheet] = useState(false);
  const [retries, setRetries] = useState(0);

  const qs = useMemo(() => questionsFor(answers, null), [answers]);
  const q = qs[qi];
  const detector = useRef<SignDetector | null>(null);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const onEvent = useRef<(e: SignEvent) => void>(() => undefined);
  const flashTimer = useRef(0);
  const shownUrgent = useRef(new Set<string>());
  const say = (text: string, kind: 'ok' | 'warn' | 'info' = 'info') => {
    setFlash({ text, kind }); window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2200);
  };

  const cam = useHandCamera((f) => { detector.current?.feed(f); });

  useEffect(() => {
    if (phase === 'start' && cam.state === 'running') {
      detector.current = new SignDetector(Object.values(mapping).filter(Boolean) as string[], vocab.signs, (e) => onEvent.current(e));
      setPhase('ask');
    }
  }, [cam.state, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // the camera turns off when the session ends
  useEffect(() => { if (phase === 'done') cam.stop(); }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHighlight(0); setRetries(0); setUseMap(false); }, [qi, q?.id]);

  const options = q ? (q.type === 'yesno' ? YN : q.options ?? []) : [];

  function record(opt: Opt, via?: string) {
    if (!q) return;
    const status: Answer['status'] = opt.id === 'not_sure' ? 'not_sure' : 'confirmed';
    const a: Answer = { qid: q.id, question: q.text, value: opt.id, label: opt.label, status, via, at: new Date().toISOString() };
    const next = { ...answers, [q.id]: a };
    if (q.id === 'group') { setGroup(opt.id === 'not_sure' ? null : opt.id); delete next.region; }
    if (q.id === 'region' && opt.id !== 'not_sure') setRegions((r) => (r.includes(opt.id) ? r : [...r, opt.id]));
    if (q.id === 'pain' && opt.id !== 'yes') { for (const k of ['group', 'region', 'severity', 'today', 'worse']) delete next[k]; setRegions([]); setGroup(null); }
    setAnswers(next);
    setPending(null);
    // urgent answers stop the questionnaire right away
    const reasons: string[] = [];
    if (q.urgentIfYes && opt.id === 'yes') reasons.push(q.urgentIfYes);
    if (q.id === 'need' && opt.id === 'help_now') reasons.push('you need help now');
    if (q.id === 'severity' || q.id === 'region') {
      const regs = q.id === 'region' && opt.id !== 'not_sure' ? [...new Set([...regions, opt.id])] : regions;
      const sev = q.id === 'severity' ? opt.id : next.severity?.value;
      const r = assessSafety({ regionIds: regs, sensations: ['pain'], details: { severity: sev === 'Severe' ? 9 : undefined, onset: next.today?.value === 'yes' ? 'Today' : undefined }, associated: null }); // breathing has its own question above
      if (r.urgent) reasons.push(...r.reasons);
    }
    const fresh = reasons.filter((r) => !shownUrgent.current.has(r));
    if (fresh.length) { fresh.forEach((r) => shownUrgent.current.add(r)); setUrgentReasons(fresh); setPhase('urgent'); return; }
    advance(next);
  }
  function advance(next: Record<string, Answer>) {
    const nq = questionsFor(next, null);
    const idx = nq.findIndex((x) => !next[x.id]);
    if (idx < 0) { setPhase('summary'); return; }
    setQi(idx); setPhase('ask');
  }
  function skip() {
    if (!q) return;
    const a: Answer = { qid: q.id, question: q.text, value: '', label: 'No answer', status: 'unanswered', at: new Date().toISOString() };
    const next = { ...answers, [q.id]: a };
    setAnswers(next); setPending(null); advance(next);
  }
  function propose(opt: Opt, via?: string) { setPending({ opt, via }); setPhase('confirm'); if (prefs.textToSpeech) speak(`You chose ${opt.label}. Is that right?`); }

  onEvent.current = (e) => {
    const ph = phaseRef.current;
    if (!['ask', 'confirm', 'summary', 'send_confirm'].includes(ph)) return;
    if (e.type === 'ambiguous') { say('That looked like two different signs — please sign it again.', 'warn'); setRetries((n) => n + 1); return; }
    if (e.type === 'unknown') { say(e.reason === 'too_short' ? 'That was too quick — please sign it again a little slower.' : 'I didn’t recognize that sign — please sign it again, or tap an answer.', 'warn'); setRetries((n) => n + 1); return; }
    if (e.quality === 'borderline') { say('I’m not sure I saw that clearly — please sign it again.', 'warn'); setRetries((n) => n + 1); return; }
    const cmd = commandOf(e.sign, mapping);
    if (!cmd) return;
    const via = `${signLabel(e.sign, cp?.signs)} → ${COMMAND_LABEL[cmd]} (sign language, camera; confirmed by patient)`;
    const seen = signLabel(e.sign, cp?.signs);
    if (ph === 'confirm') {
      const c = confirmAction(cmd, mapping);
      if (c === 'confirm' && pending) { say(`✓ Saved: ${pending.opt.label}`, 'ok'); record(pending.opt, pending.via); }
      else if (c === 'change') { say('OK — let’s ask again.', 'info'); setPending(null); setPhase('ask'); }
      return;
    }
    if (ph === 'summary') { if (cmd === 'yes' && doctor.data) setPhase('send_confirm'); return; }
    if (ph === 'send_confirm') { if (cmd === 'yes') void send(true); else if (cmd === 'no') setPhase('summary'); return; }
    if (!q || useMap) return;
    const act = actionFor(cmd, q.type, mapping);
    if (act.kind === 'answer') { const opt = act.value === 'unsure' ? NOT_SURE : YN.find((o) => o.id === act.value)!; say(`Seen: ${seen} → ${opt.label}`, 'info'); propose(opt, via); }
    else if (act.kind === 'next') setHighlight((h) => (h + 1) % options.length);
    else if (act.kind === 'select') { const opt = options[highlight % options.length]; say(`Seen: ${seen} → ${opt.label}`, 'info'); propose(opt, via); }
    else if (act.kind === 'not_sure') propose(NOT_SURE, via);
    else say(`“${COMMAND_LABEL[cmd]}” isn’t used for this question.`, 'info');
  };

  // ---------- summary
  const list = Object.values(answers);
  const confirmed = list.filter((a) => a.status === 'confirmed');
  const notSure = list.filter((a) => a.status === 'not_sure');
  const unanswered = list.filter((a) => a.status === 'unanswered');
  const yes = (id: string) => answers[id]?.status === 'confirmed' && answers[id]?.value === 'yes';
  const no = (id: string) => answers[id]?.status === 'confirmed' && answers[id]?.value === 'no';
  const factLines = confirmed.map((a) => `${(qs.find((x) => x.id === a.qid)?.short ?? a.question)}: ${a.label}`);
  const template = (() => {
    const s: string[] = [];
    if (yes('help_now')) s.push('I need help right now.');
    if (yes('breathing')) s.push('I am having trouble breathing.');
    if (yes('stroke')) s.push('Part of my face, an arm or a leg is suddenly weak or numb, or speaking is suddenly hard.');
    if (yes('pain')) s.push(`I am in pain${regions.length ? ` in my ${regions.map(regionLabel).join(', ').toLowerCase()}` : ''}.`);
    if (no('pain')) s.push('I am not in pain.');
    if (answers.severity?.status === 'confirmed') s.push(`It is ${answers.severity.label.toLowerCase()}.`);
    if (yes('today')) s.push('It began today.'); if (no('today')) s.push('It did not begin today.');
    if (yes('worse')) s.push('It is getting worse.'); if (no('worse')) s.push('It is not getting worse.');
    if (answers.need?.status === 'confirmed') s.push(`${answers.need.label}.`);
    if (notSure.length) s.push(`I’m not sure about: ${notSure.map((a) => (qs.find((x) => x.id === a.qid)?.short ?? a.question).toLowerCase()).join(', ')}.`);
    return s.join(' ') || 'I used Silent Signal but did not confirm any answers.';
  })();
  const message = wording?.text ?? template;
  const notProvided = [...NOT_ASKED, ...(answers.pain?.value === 'yes' ? [] : ['Where any pain is, how strong, when it began (not asked: no pain was confirmed)'])];

  async function send(toDoctor: boolean) {
    setErr(null); setBusy(true);
    try {
      const sensations: Sensation[] = yes('pain') ? ['pain'] : [];
      const sev = answers.severity;
      const prefill: Record<string, string> = {};
      if (sev?.status === 'confirmed') prefill.severity = sev.value; else if (sev?.status === 'not_sure') prefill.severity = 'not_sure';
      if (yes('today')) prefill.onset = 'Today'; else if (no('today')) prefill.onset = 'Before today'; else if (answers.today?.status === 'not_sure') prefill.onset = 'not_sure';
      const rec = build({ regionIds: regions, sensations, details: {} }, [], prefill);
      const assoc = rec.items.find((i) => i.key === 'associated');
      if (assoc && yes('breathing')) { assoc.value = 'Trouble breathing'; assoc.status = 'confirmed'; assoc.source = 'patient_selected'; assoc.initial = { value: assoc.value, status: 'confirmed' }; }
      const ctx = rec.items.find((i) => i.key === 'context');
      const ctxText = [yes('worse') ? 'Getting worse: yes' : no('worse') ? 'Getting worse: no' : '', answers.need?.status === 'confirmed' ? `Request: ${answers.need.label}` : '', note.trim() ? `Typed note: ${note.trim()}` : ''].filter(Boolean).join('. ');
      if (ctx && ctxText) { ctx.value = ctxText; ctx.status = 'confirmed'; ctx.source = note.trim() ? 'patient_typed' : 'patient_selected'; ctx.initial = { value: ctx.value, status: 'confirmed' }; }
      const brief = buildBrief(rec);
      const selections: SignalSelection[] = list.map((a) => ({
        step: a.qid, question: a.question, choice: a.status === 'unanswered' ? 'No answer' : a.label, confirmed: a.status !== 'unanswered', at: a.at, status: a.status, via: a.via,
      }));
      const signal: SignalRecord = { method: 'camera_signs', selections, wording: message, wordingSource: wording?.source ?? 'template', regionIds: regions, rejectedWordings };
      const report = { ...toStructuredReport(rec, brief, [], wording?.source === 'ai' ? 'ai-provider' : 'demo-rules'), signal };
      const lines = (xs: Answer[]) => xs.map((a) => `• ${a.question} ${a.label}${a.via ? ` (${a.via})` : ''}`).join('\n') || '• none';
      const text = `${message}${wording?.source === 'ai' ? ' [wording by AI, approved by patient]' : ' [wording by AccessCare, approved by patient]'}`
        + `\n\nAnswered by the patient with sign language in the Silent Signal camera section (${Object.entries(mapping).map(([c, sg]) => `${COMMAND_LABEL[c as Command]} = ${signLabel(sg, cp?.signs)}`).join(', ')}). Each answer was shown back and confirmed.`
        + `\nConfirmed:\n${lines(confirmed)}\nPatient not sure:\n${lines(notSure)}\nNot answered:\n${lines(unanswered)}`
        + `\nNot asked in this session: ${notProvided.join('; ')}.`
        + (note.trim() ? `\nTyped note: ${note.trim()}` : '')
        + `\n\n${briefText(brief)}`;
      const c = await backend.createConsultation('signal');
      await backend.updateDraft(c.id, { regionIds: regions, sensations, reconstruction: rec });
      const payload = { text, report, editedByPatient: false };
      if (toDoctor) { await backend.approveAndShare(c.id, payload); setSentTo(doctor.data?.fullName ?? 'your doctor'); }
      else { await backend.saveApprovedWithoutDoctor(c.id, payload); setSentTo(null); }
      refresh(); setPhase('done');
    } catch (e) { setErr((e as Error).message); setPhase('summary'); }
    finally { setBusy(false); }
  }

  if (!cameraReady(cp, vocab)) {
    return (<>
      <TopBar title="Camera session" />
      <div className="screen screen-in"><div className="pad">
        <Banner kind="warn">Signs aren’t set up on this device yet. Set them up first, or use another way to answer.</Banner>
        <Button big onClick={() => nav.replace({ name: 'ss.camsetup' })}>Set up signs</Button>
        <Button variant="secondary" onClick={() => nav.replace({ name: 'ss.session' })}>Use buttons or symbols instead</Button>
      </div></div>
    </>);
  }

  const answerBy = (o: Opt) => propose(o, 'Selected on screen (confirmed by patient)');
  const mapHint = Object.entries(mapping).map(([c, sg]) => `${COMMAND_LABEL[c as Command]} = ${signLabel(sg, cp?.signs)}`).join(' · ');
  const choiceHint = q?.type === 'choice' ? `${mapping.next ? COMMAND_LABEL.next : 'No'} moves to the next option · ${mapping.select ? COMMAND_LABEL.select : 'Yes'} chooses it` : 'Answer with your Yes or No sign';
  const showCam = phase !== 'done' && phase !== 'urgent';

  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;
  if (phase === 'start') {
    body = <>
      <div><h2 className="title">Answer your doctor’s questions with signs</h2>
        <p className="muted small">One short question at a time. Every answer is shown back to you to confirm. You approve the summary before anything is sent.</p></div>
      <div className="card tinted small"><b>Your signs</b><span>{mapHint}</span><span className="tiny muted">Sign one answer at a time, then lower your hands.</span></div>
      <Banner kind="info">This helps you communicate. It does not diagnose. If you need urgent help, use the red Urgent button or call emergency services now.</Banner>
    </>;
    footer = <Button variant="secondary" block onClick={() => nav.replace({ name: 'ss.session' })} data-testid="cam-use-buttons">Use buttons or symbols instead</Button>;
  } else if (phase === 'urgent') {
    body = <>
      <EmergencyContent reasons={urgentReasons} />
      <Banner kind="info">Don’t wait for this app. When you are safe, you can finish your message for your doctor.</Banner>
    </>;
    footer = <Button variant="secondary" block onClick={() => advance(answers)} data-testid="urgent-continue">Continue the message</Button>;
  } else if ((phase === 'ask' || phase === 'confirm') && q) {
    const pos = qs.findIndex((x) => x.id === q.id);
    body = <>
      <Steps total={qs.length} current={pos} label={`Question ${pos + 1} of ${qs.length}`} />
      <div className="card qcard" data-testid="cam-question" data-qid={q.id}>
        <b className="qtext">{q.text}</b>
        {ttsSupported() && <button className="iconbtn" onClick={() => speak(q.text)} aria-label="Read the question aloud"><LuVolume2 /></button>}
        <span className="tiny muted">{choiceHint}{mapping.unsure ? ` · ${COMMAND_LABEL.unsure} = ${signLabel(mapping.unsure, cp?.signs)}` : ''}</span>
      </div>
      {phase === 'confirm' && pending ? (
        <div className="card interp" data-testid="cam-interpreted" role="alertdialog" aria-label="Confirm your answer">
          <span className="tiny muted strong">You chose</span>
          <b className="interp-val">{pending.opt.symbol} {pending.opt.label}</b>
          <span className="small muted">Is that right? Sign Yes to confirm, No to change it — or use the buttons.</span>
          <div className="grid2">
            <Button variant="secondary" onClick={() => { setPending(null); setPhase('ask'); }} data-testid="change-answer"><LuRotateCcw aria-hidden /> No, change</Button>
            <Button onClick={() => record(pending.opt, pending.via)} data-testid="confirm-answer"><LuCircleCheck aria-hidden /> Yes, that’s right</Button>
          </div>
        </div>
      ) : (<>
        {(q.id === 'group' || q.id === 'region') && (
          <div className="seg" role="group" aria-label="How to choose the area">
            <button aria-pressed={!useMap} onClick={() => setUseMap(false)}>Signs or buttons</button>
            <button aria-pressed={useMap} onClick={() => setUseMap(true)} data-testid="cam-use-map">Body map</button>
          </div>
        )}
        {useMap ? <>
          <BodySelector selected={regions} onChange={setRegions} />
          <Button big disabled={!regions.length} data-testid="cam-map-done" onClick={() => {
            const regs = regions;
            const now = new Date().toISOString();
            const g = BODY_REGIONS.find((r) => r.id === regs[0])?.group ?? null;
            const next = { ...answers,
              group: { qid: 'group', question: qs.find((x) => x.id === 'group')!.text, value: g ?? 'not_sure', label: g ?? 'Body map', status: 'confirmed' as const, via: 'Selected on the body map (confirmed by patient)', at: now },
              region: { qid: 'region', question: 'Which area exactly?', value: regs.join(','), label: regs.map(regionLabel).join(', '), status: 'confirmed' as const, via: 'Selected on the body map (confirmed by patient)', at: now } };
            setGroup(g); setAnswers(next); setUseMap(false); advance(next);
          }}>These are the areas</Button>
        </> : (
          <div className={`opt-list ${q.type}`} role="list">
            {options.map((o, i) => (
              <button key={o.id} role="listitem" className={`choice opt${q.type === 'choice' && i === highlight % options.length ? ' lit' : ''}`} onClick={() => answerBy(o)} data-testid={`opt-${o.id}`}
                aria-current={q.type === 'choice' && i === highlight % options.length ? 'true' : undefined}>
                {o.symbol && <span className="ico" aria-hidden>{o.symbol}</span>}{o.label}
              </button>
            ))}
          </div>
        )}
        {retries >= 3 && <Banner kind="info">Signs are hard to recognize right now (light, distance or angle). You can tap an answer, choose “Not sure”, skip, or practise your signs again later.</Banner>}
      </>)}
    </>;
    footer = <>
      <Button variant="secondary" onClick={skip} data-testid="skip-question">Skip</Button>
      {pos > 0 && <Button variant="ghost" onClick={() => { const prev = qs[pos - 1]; setQi(pos - 1); setPhase('ask'); setPending(null); const n = { ...answers }; delete n[prev.id]; setAnswers(n); }}>Back</Button>}
    </>;
  } else if (phase === 'summary' || phase === 'send_confirm') {
    const item = (a: Answer) => (
      <button key={a.qid} className="list-item" data-testid={`sum-item-${a.qid}`} onClick={() => {
        const n = { ...answers }; delete n[a.qid];
        if (a.qid === 'group' || a.qid === 'region') { delete n.group; delete n.region; setRegions([]); setGroup(null); }
        setAnswers(n); const nq = questionsFor(n, null); setQi(Math.max(0, nq.findIndex((x) => !n[x.id]))); setPhase('ask');
      }}>
        <div className="grow"><div className="tiny muted strong">{a.question.toUpperCase()}</div><b>{a.label}</b>{a.via && <div className="tiny muted">{a.via}</div>}</div><LuPencil className="chev" aria-label="Change" />
      </button>
    );
    body = <>
      <div><h2 className="title">Is this what you want to tell your doctor?</h2><p className="muted small">Tap anything to change it. Nothing is sent until you approve.</p></div>
      <section className="stack" data-testid="sum-confirmed"><h3 className="section"><LuCircleCheck aria-hidden /> You confirmed</h3>
        {confirmed.length ? <div className="list">{confirmed.map(item)}</div> : <p className="small muted">No confirmed answers.</p>}</section>
      {notSure.length > 0 && <section className="stack" data-testid="sum-unsure"><h3 className="section">You said “not sure” — the doctor may ask again</h3><div className="list">{notSure.map(item)}</div></section>}
      {unanswered.length > 0 && <section className="stack" data-testid="sum-unanswered"><h3 className="section">Not answered</h3><div className="list">{unanswered.map(item)}</div><p className="tiny muted">A missing answer is not treated as “no”.</p></section>}
      <section className="stack" data-testid="sum-notprovided"><h3 className="section">Not asked in this session</h3>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{notProvided.map((x) => <li key={x}>{x}</li>)}</ul></section>
      {regions.length > 0 && <div className="card small"><div className="row"><LuMapPin aria-hidden /><b>{regions.map(regionLabel).join(', ')}</b></div></div>}
      <div className="card">
        <div className="row between"><b>Message</b><span className={`prov ${wording?.source === 'ai' ? 'prov-ai' : 'prov-template'}`}>{wording?.source === 'ai' ? <><LuSparkles /> AI wording</> : 'AccessCare wording'}</span></div>
        <div className="pre" data-testid="cam-message">{message}</div>
        <p className="tiny muted">Built only from the answers you confirmed. The doctor also sees each answer and how you gave it.</p>
        <div className="grid2">
          {ttsSupported() && <Button variant="secondary" onClick={() => speak(message)}><LuVolume2 aria-hidden /> Read aloud</Button>}
          {wording?.source === 'ai'
            ? <Button variant="secondary" onClick={() => { setWording(null); setRejected((n) => n + 1); }} data-testid="cam-reject-ai"><LuCircleX aria-hidden /> Reject AI wording</Button>
            : ai.state(prefs.aiAssist) === 'available' && confirmed.length > 0 && <Button variant="secondary" busy={aiBusy} data-testid="cam-ai-wording" onClick={async () => {
                setAiBusy(true); const w = await ai.wordMessage(factLines); setAiBusy(false);
                setWording(w ? { text: w, source: 'ai' } : null); if (!w) setErr('AI wording wasn’t available or didn’t pass our checks, so the plain wording is kept.');
              }}><LuSparkles aria-hidden /> Natural wording (AI)</Button>}
        </div>
      </div>
      <Field id="cam-note" label="Anything to add in your own words? (optional)" multiline value={note} onChange={setNote} maxLength={500} />
      {phase === 'send_confirm' && <Banner kind="warn"><b>Send this to {doctor.data?.fullName}?</b> Sign Yes again to send, or No to go back.</Banner>}
      {!doctor.data && <Banner kind="warn">You aren’t connected to a doctor yet, so this can’t be sent. You can save it.</Banner>}
      {err && <Banner kind="info">{err}</Banner>}
      <p className="tiny muted">With signs: Yes = send (you’ll be asked once more).</p>
    </>;
    footer = <>
      <Button variant="danger-outline" onClick={() => setRejectSheet(true)} data-testid="reject-camera">Discard</Button>
      {doctor.data
        ? <Button big busy={busy} onClick={() => send(true)} data-testid="approve-camera"><LuSend aria-hidden /> Approve and send</Button>
        : <Button big busy={busy} onClick={() => send(false)} data-testid="approve-camera"><LuSave aria-hidden /> Approve and save</Button>}
    </>;
  } else if (phase === 'done') {
    body = (<div className="stack" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 30 }} data-testid="cam-done">
      <LuCircleCheck style={{ fontSize: 64, color: 'var(--ok)' }} aria-hidden />
      <h2 className="title">{sentTo ? `Sent to ${sentTo}` : 'Saved — not sent'}</h2>
      <p className="muted">{sentTo ? 'Your approved summary and each confirmed answer are with your doctor.' : 'Connect with a doctor to send it.'} The camera is off.</p>
    </div>);
    footer = <Button big onClick={() => nav.reset({ name: 'ss.home' })}>Back to Silent Signal</Button>;
  }

  return (
    <>
      <TopBar title="Silent Signal · signs" right={phase !== 'done' ? <UrgentHelpButton /> : undefined} />
      <div className="screen screen-in"><div className="pad">
        <div hidden={!showCam}><CameraPanel cam={cam} flash={flash} compact={phase !== 'start'} onAlternative={() => { cam.stop(); nav.replace({ name: 'ss.session' }); }}>
          {phase === 'ask' && cam.state === 'running' && <div className="cam-hint small"><LuHand aria-hidden /> {mapHint}</div>}
        </CameraPanel></div>
        {body}
      </div></div>
      {footer && <div className="footer-bar">{footer}</div>}
      {rejectSheet && <ConfirmSheet title="Discard this summary?" danger confirmLabel="Discard" body="Nothing will be sent or saved. The camera will turn off."
        onConfirm={() => { setRejectSheet(false); cam.stop(); nav.reset({ name: 'ss.home' }); }} onCancel={() => setRejectSheet(false)} />}
    </>
  );
}
