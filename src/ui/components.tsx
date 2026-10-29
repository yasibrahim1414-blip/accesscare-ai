import React, { useEffect, useId, useRef, useState } from 'react';
import { LuChevronLeft, LuInfo, LuMic, LuTriangleAlert, LuVolume2, LuCircleCheck, LuEye, LuEyeOff } from 'react-icons/lu';
import { bestVoice, langOfText, LOCALE } from '../services/voice/Speech';
import { getLang } from '../i18n/lang';
import { useApp } from '../app/AppContext';

/** Compact header for pushed screens. */
export function TopBar({ title, onBack, right, bordered }: { title: string; onBack?: () => void; right?: React.ReactNode; bordered?: boolean }) {
  const { nav } = useApp();
  const back = onBack ?? (nav.canGoBack ? nav.back : undefined);
  return (
    <header className={`topbar${bordered ? ' bordered' : ''}`}>
      {back ? <button className="iconbtn" onClick={back} aria-label="Go back"><LuChevronLeft /></button> : <span className="spacer" />}
      <h1>{title}</h1>
      {right ?? <span className="spacer" />}
    </header>
  );
}

/** Large title header for the main tab screens. */
export function LargeBar({ title, eyebrow, right }: { title: string; eyebrow?: string; right?: React.ReactNode }) {
  return (
    <header className="largebar">
      <h1>{eyebrow && <span className="eyebrow">{eyebrow}</span>}{title}</h1>
      {right}
    </header>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'navy' | 'on-navy';
export function Button({ variant = 'primary', block, big, busy, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; block?: boolean; big?: boolean; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}
      className={`btn ${variant}${block ? ' block' : ''}${big ? ' big' : ''} ${rest.className ?? ''}`}>
      {busy ? <><span className="spin" aria-hidden />Please wait…</> : children}
    </button>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: React.ReactNode }) {
  const Icon = kind === 'ok' ? LuCircleCheck : kind === 'info' ? LuInfo : LuTriangleAlert;
  return <div className={`banner ${kind}`} role={kind === 'danger' ? 'alert' : 'status'}><Icon aria-hidden /><div className="grow">{children}</div></div>;
}

export function Empty({ icon, title, children, action }: { icon: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="ei" aria-hidden>{icon}</div>
      <b>{title}</b>
      {children && <p className="small muted" style={{ maxWidth: 280 }}>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3, height = 64 }: { rows?: number; height?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ height }} />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="stack">
      <Banner kind="danger">{message}</Banner>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ---------- speech ----------
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
export function speak(text: string) {
  if (!ttsSupported()) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // the voice of the text's language (Arabic, Urdu, Hindi… are not read by an English voice)
    const l = langOfText(text, getLang()); const v = bestVoice(l);
    u.lang = v?.lang ?? LOCALE[l]; if (v) u.voice = v;
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}
export function SpeakButton({ text }: { text: string }) {
  const { prefs } = useApp();
  if (!prefs.textToSpeech || !ttsSupported()) return null;
  return <button className="speak" onClick={() => speak(text)} aria-label="Read aloud"><LuVolume2 /></button>;
}

type SpeechRec = { start(): void; stop(): void; onresult: (e: any) => void; onerror: (e: any) => void; onend: () => void; lang: string; interimResults: boolean };
const getRecognizer = (): (new () => SpeechRec) | null =>
  (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

function MicButton({ onText }: { onText: (t: string) => void }) {
  const { prefs, toast } = useApp();
  const [on, setOn] = useState(false);
  if (!prefs.speechInput) return null;
  const Rec = getRecognizer();
  const start = () => {
    if (!Rec) { toast('Speech input isn’t available here. Please type or use the choices.'); return; }
    try {
      const r = new Rec();
      r.lang = getLang() === 'en' ? (navigator.language || 'en-US') : LOCALE[getLang()];
      r.interimResults = false;
      r.onresult = (e: any) => onText(Array.from(e.results).map((x: any) => x[0].transcript).join(' '));
      r.onerror = () => { setOn(false); toast('Microphone access was blocked here. Please type instead.'); };
      r.onend = () => setOn(false);
      r.start();
      setOn(true);
    } catch { toast('Speech input isn’t available here.'); }
  };
  return <button type="button" className="speak" aria-pressed={on} aria-label="Speak instead of typing" onClick={start}
    style={on ? { background: 'var(--teal-50)' } : undefined}><LuMic /></button>;
}

export function Field({ label, hint, error, value, onChange, type = 'text', multiline, placeholder, autoComplete, id, inputMode, maxLength, mono }: {
  label: string; hint?: string; error?: string | null; value: string; onChange: (v: string) => void; type?: string; multiline?: boolean;
  placeholder?: string; autoComplete?: string; id?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; maxLength?: number; mono?: boolean;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const [reveal, setReveal] = useState(false);
  const common = {
    id: fid, value, placeholder, maxLength, className: `input${error ? ' bad' : ''}${mono ? ' mono' : ''}`,
    'aria-invalid': !!error || undefined, 'aria-describedby': hint || error ? `${fid}-d` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      <div className="input-wrap">
        {multiline ? <textarea {...common} />
          : type === 'password'
            ? <div className="pw-wrap">
                <input {...common} type={reveal ? 'text' : 'password'} autoComplete={autoComplete} />
                <button type="button" className="iconbtn reveal" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide password' : 'Show password'}>{reveal ? <LuEyeOff /> : <LuEye />}</button>
              </div>
            : <input {...common} type={type} autoComplete={autoComplete} inputMode={inputMode} />}
        {(type === 'text' || multiline) && !mono && <MicButton onText={(t) => onChange(value ? `${value} ${t}` : t)} />}
      </div>
      {(hint || error) && <div id={`${fid}-d`} className={error ? 'err' : 'hint'}>{error ?? hint}</div>}
    </div>
  );
}

export function Toggle({ label, desc, checked, onChange, id }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <div className="toggle-row" onClick={() => onChange(!checked)}>
      <div className="grow">
        <div id={`${id}-l`} style={{ fontWeight: 700 }}>{label}</div>
        {desc && <div className="small muted">{desc}</div>}
      </div>
      <button id={id} role="switch" aria-checked={checked} aria-labelledby={`${id}-l`} className="switch"
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }} />
    </div>
  );
}

/** In-app bottom sheet used for every confirmation (browser dialogs are not used). */
export function Sheet({ title, children, onClose, icon, danger }: { title: string; children: React.ReactNode; onClose: () => void; icon?: React.ReactNode; danger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  const hid = useId();
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={hid} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        {icon && <div className={`sheet-ico${danger ? ' danger' : ''}`} aria-hidden>{icon}</div>}
        <h3 id={hid}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmSheet({ title, body, confirmLabel, danger, onConfirm, onCancel, busy, children, icon }: {
  title: string; body?: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; busy?: boolean; children?: React.ReactNode; icon?: React.ReactNode;
}) {
  return (
    <Sheet title={title} onClose={onCancel} icon={icon} danger={danger}>
      {body && <div className="muted">{body}</div>}
      {children}
      <div className="stack">
        <Button variant={danger ? 'danger' : 'primary'} block big onClick={onConfirm} busy={busy}>{confirmLabel}</Button>
        <Button variant="secondary" block onClick={onCancel}>Cancel</Button>
      </div>
    </Sheet>
  );
}

export function Steps({ total, current, label }: { total: number; current: number; label?: string }) {
  return (
    <div className="stepper">
      {label && <span className="lbl">Step {current + 1} of {total} · {label}</span>}
      <div className="bars" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current + 1} aria-label={`Step ${current + 1} of ${total}`}>
        {Array.from({ length: total }, (_, i) => <i key={i} className={i <= current ? 'on' : ''} />)}
      </div>
    </div>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter((w) => !/^dr\.?$/i.test(w)).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

export function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function fmtRelative(iso?: string) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
