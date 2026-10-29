import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuMic, LuCheck, LuX } from 'react-icons/lu';
import { LOCALE } from '../../services/voice/Speech';
import { getLang } from '../../i18n/lang';
import type { SignalMethod } from '../../domain/types';
import { AMBIGUITY_WINDOW_MS, interpretScanPress, interpretTaps, matchSpeech, type SignalOption, type Tap } from '../../services/signal/SignalEngine';
import { speak } from '../../ui/components';

export interface BoardResult { optionId: string; ambiguous: boolean; rejected: number }

const getRecognizer = (): any => (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
export const speechSupported = () => !!getRecognizer();

/**
 * Collects ONE selection with the patient's chosen input method.
 * Flow: register → (disambiguate if unclear) → (confirm if required) → onResult.
 */
export function SignalBoard({ options, method, scanMs, confirm, prompt, speakOut, onResult, testId }: {
  options: SignalOption[]; method: SignalMethod; scanMs: number; confirm: boolean; prompt: string; speakOut?: boolean;
  onResult: (r: BoardResult) => void; testId?: string;
}) {
  const [phase, setPhase] = useState<'choose' | 'disambiguate' | 'confirm'>('choose');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>('');
  const ambiguous = useRef(false);
  const rejected = useRef(0);
  const byId = (id: string) => options.find((o) => o.id === id)!;

  useEffect(() => { setPhase('choose'); setChosen(null); setFeedback(''); ambiguous.current = false; rejected.current = 0; if (speakOut) speak(prompt); }, [prompt]); // eslint-disable-line

  const registered = useCallback((id: string) => {
    setFeedback(`Registered: ${byId(id).label}`);
    if (speakOut) speak(byId(id).label);
    if (confirm) { setChosen(id); setPhase('confirm'); }
    else onResult({ optionId: id, ambiguous: ambiguous.current, rejected: rejected.current });
  }, [confirm, onResult, options, speakOut]); // eslint-disable-line

  const unclear = (ids: string[]) => {
    ambiguous.current = true;
    setCandidates(ids);
    setPhase('disambiguate');
    setFeedback('That was unclear — please choose one of these.');
  };

  const confirmYes = () => { onResult({ optionId: chosen!, ambiguous: ambiguous.current, rejected: rejected.current }); };
  const confirmNo = () => { rejected.current += 1; setChosen(null); setPhase('choose'); setFeedback('Okay — choose again.'); };

  const current = phase === 'disambiguate' ? candidates.map(byId) : phase === 'confirm' ? [{ id: '__yes', label: 'Yes, that’s right', symbol: '👍' }, { id: '__no', label: 'No, change it', symbol: '👎' }] : options;
  const pick = (id: string) => {
    if (phase === 'confirm') { if (id === '__yes') confirmYes(); else confirmNo(); return; }
    if (phase === 'disambiguate') { setPhase('choose'); registered(id); return; }
  };

  return (
    <div className="signal-board" data-testid={testId ?? 'signal-board'}>
      <div className="sb-prompt" aria-live="polite">
        {phase === 'confirm' && chosen ? <>You chose <b>{byId(chosen).symbol} {byId(chosen).label}</b>. Is that right?</>
          : phase === 'disambiguate' ? 'Which one did you mean?' : prompt}
      </div>
      {method === 'switch_scan'
        ? <ScanInput options={current} scanMs={scanMs} onPick={(id) => phase === 'choose' ? registered(id) : pick(id)} onUnclear={(ids) => phase === 'choose' ? unclear(ids) : setFeedback('That was unclear — wait for the highlight and press again.')} />
        : method === 'yes_no' && phase === 'choose'
          ? <YesNoInput options={options} onPick={(id) => { setFeedback(`Registered: ${byId(id).label}`); if (speakOut) speak(byId(id).label); onResult({ optionId: id, ambiguous: false, rejected: rejected.current }); }} />
          : method === 'speech' && phase === 'choose'
            ? <SpeechInput options={options} onPick={registered} onUnclear={unclear} onNone={() => setFeedback('I didn’t catch a matching option. Try again or tap one below.')} />
            : <TapInput options={current} symbols={method === 'symbols' || phase === 'confirm'} onPick={(id) => phase === 'choose' ? registered(id) : pick(id)} onUnclear={(ids) => phase === 'choose' ? unclear(ids) : setFeedback('Please tap just one.')} />}
      {method === 'speech' && phase === 'choose' && <TapInput options={options} symbols={false} onPick={registered} onUnclear={unclear} small />}
      <div className="sb-feedback" role="status" data-testid="signal-feedback">{feedback}</div>
    </div>
  );
}

/** Large buttons / symbol board. Two different taps within the ambiguity window are not accepted. */
function TapInput({ options, symbols, onPick, onUnclear, small }: { options: SignalOption[]; symbols: boolean; onPick: (id: string) => void; onUnclear: (ids: string[]) => void; small?: boolean }) {
  const taps = useRef<Tap[]>([]);
  const timer = useRef<number>(0);
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { taps.current = []; setPressed(null); }, [options.map((o) => o.id).join()]);
  const tap = (id: string) => {
    taps.current.push({ optionId: id, at: performance.now() });
    setPressed(id);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = interpretTaps(taps.current);
      taps.current = [];
      setPressed(null);
      if (r.kind === 'clear') onPick(r.optionId);
      else if (r.kind === 'ambiguous') onUnclear(r.candidates);
    }, Math.min(AMBIGUITY_WINDOW_MS, 450));
  };
  return (
    <div className={`sb-grid${symbols ? ' symbols' : ''}${small ? ' small' : ''}`} role="group">
      {options.map((o) => (
        <button key={o.id} className="sb-btn" aria-pressed={pressed === o.id} onClick={() => tap(o.id)} data-option={o.id}>
          <span className="sb-sym" aria-hidden>{o.symbol}</span><span className="sb-lbl">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** One option at a time; Yes selects it, No moves on. */
function YesNoInput({ options, onPick }: { options: SignalOption[]; onPick: (id: string) => void }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [options.map((o) => o.id).join()]);
  const o = options[i % options.length];
  return (
    <div className="stack">
      <div className="sb-single" data-testid="yesno-current"><span className="sb-sym" aria-hidden>{o.symbol}</span><b>Is it: {o.label}?</b><span className="tiny muted">{i % options.length + 1} of {options.length}</span></div>
      <div className="grid2">
        <button className="sb-btn yes" onClick={() => onPick(o.id)}><span className="sb-sym" aria-hidden>👍</span><span className="sb-lbl">Yes</span></button>
        <button className="sb-btn" onClick={() => setI(i + 1)}><span className="sb-sym" aria-hidden>👎</span><span className="sb-lbl">No</span></button>
      </div>
    </div>
  );
}

/** Single-switch scanning: options light up in turn; one switch (button, Space or Enter) selects. */
function ScanInput({ options, scanMs, onPick, onUnclear }: { options: SignalOption[]; scanMs: number; onPick: (id: string) => void; onUnclear: (ids: string[]) => void }) {
  const [idx, setIdx] = useState(0);
  const movedAt = useRef(performance.now());
  const idxRef = useRef(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => { setIdx(0); idxRef.current = 0; movedAt.current = performance.now(); }, [options.map((o) => o.id).join()]);
  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => {
      idxRef.current = (idxRef.current + 1) % options.length;
      movedAt.current = performance.now();
      setIdx(idxRef.current);
    }, scanMs);
    return () => window.clearInterval(t);
  }, [options.length, scanMs, paused]);
  const press = useCallback(() => {
    const r = interpretScanPress(performance.now(), movedAt.current, idxRef.current, options.length);
    if (r.kind === 'clear') onPick(options[r.index].id);
    else onUnclear(r.indices.map((i) => options[i].id));
  }, [options, onPick, onUnclear]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);
  return (
    <div className="stack">
      <div className="sb-grid scan" role="listbox" aria-label="Scanning options" aria-activedescendant={`scan-${options[idx]?.id}`}>
        {options.map((o, i) => (
          <div key={o.id} id={`scan-${o.id}`} role="option" aria-selected={i === idx} className={`sb-btn${i === idx ? ' lit' : ''}`} data-option={o.id}>
            <span className="sb-sym" aria-hidden>{o.symbol}</span><span className="sb-lbl">{o.label}</span>
          </div>
        ))}
      </div>
      <button className="switch-btn" onClick={press} data-testid="switch-press">Press when your choice is lit<span className="tiny">Space or Enter also work</span></button>
      <button className="link-btn" onClick={() => setPaused(!paused)}>{paused ? 'Resume scanning' : 'Pause scanning'}</button>
    </div>
  );
}

function SpeechInput({ options, onPick, onUnclear, onNone }: { options: SignalOption[]; onPick: (id: string) => void; onUnclear: (ids: string[]) => void; onNone: () => void }) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const Rec = getRecognizer();
  if (!Rec) return <div className="banner warn small">Speech recognition isn’t available here. Tap your choice below instead.</div>;
  const start = () => {
    try {
      const r = new Rec();
      r.lang = getLang() === 'en' ? (navigator.language || 'en-US') : LOCALE[getLang()];
      r.onresult = (e: any) => {
        const t = Array.from(e.results).map((x: any) => x[0].transcript).join(' ');
        setHeard(t);
        const m = matchSpeech(t, options);
        if (m.kind === 'clear') onPick(m.optionId); else if (m.kind === 'ambiguous') onUnclear(m.candidates); else onNone();
      };
      r.onerror = () => { setListening(false); onNone(); };
      r.onend = () => setListening(false);
      r.start(); setListening(true);
    } catch { onNone(); }
  };
  return (
    <div className="stack" style={{ alignItems: 'center' }}>
      <button className={`switch-btn${listening ? ' live' : ''}`} onClick={start} aria-pressed={listening}>
        <LuMic aria-hidden /> {listening ? 'Listening… (microphone is on)' : 'Tap, then say your choice'}
      </button>
      {heard && <span className="small muted">Heard: “{heard}”</span>}
    </div>
  );
}

export function ConfirmPair({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div className="grid2">
      <button className="sb-btn yes" onClick={onYes}><LuCheck aria-hidden className="sb-sym" /><span className="sb-lbl">Yes</span></button>
      <button className="sb-btn" onClick={onNo}><LuX aria-hidden className="sb-sym" /><span className="sb-lbl">No</span></button>
    </div>
  );
}
