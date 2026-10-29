// The app's language (English, Arabic, French, Urdu or Hindi), chosen by the person
// and remembered on this device. Switching updates the whole interface in place
// (text, reading direction) without leaving the current screen.
import { useEffect, useState } from 'react';
import { translateTo } from './dict';

export type Lang = 'en' | 'ar' | 'fr' | 'ur' | 'hi';
export interface LangInfo { id: Lang; native: string; english: string; dir: 'ltr' | 'rtl'; locale: string }
export const LANGS: LangInfo[] = [
  { id: 'en', native: 'English', english: 'English', dir: 'ltr', locale: 'en-GB' },
  { id: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl', locale: 'ar-EG' },
  { id: 'fr', native: 'Français', english: 'French', dir: 'ltr', locale: 'fr-FR' },
  { id: 'ur', native: 'اردو', english: 'Urdu', dir: 'rtl', locale: 'ur-PK' },
  { id: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr', locale: 'hi-IN' },
];
export const LANG_IDS = LANGS.map((l) => l.id);
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANG_IDS as string[]).includes(v);
export const langInfo = (l: Lang): LangInfo => LANGS.find((x) => x.id === l) ?? LANGS[0];
export const isRtl = (l: Lang) => langInfo(l).dir === 'rtl';
/** locale for dates and times shown in this language */
export const dateLocale = (l: string) => (isLang(l) ? langInfo(l).locale : 'en-GB');
/** list separator for the language ("a, b" / "أ، ب") */
export const listSep = (l: Lang) => (l === 'ar' || l === 'ur' ? '، ' : ', ');

const KEY = 'accesscare.lang.v1';
const subs = new Set<(l: Lang) => void>();

function initial(): Lang {
  try { const v = localStorage.getItem(KEY); if (isLang(v)) return v; } catch { /* storage blocked */ }
  return 'en';
}
let current: Lang = typeof window === 'undefined' ? 'en' : initial();

export const getLang = (): Lang => current;
export function setLang(l: Lang) {
  if (!isLang(l)) return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked: still changes for this visit */ }
  applyDocumentLang();
  subs.forEach((f) => f(l));
}
export function onLang(f: (l: Lang) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dir = langInfo(current).dir;
}

/** React: the current language; re-renders when it changes. */
export function useLang(): Lang {
  const [l, setL] = useState(current);
  useEffect(() => onLang(setL), []);
  return l;
}

/**
 * Text built in code, written in English and Arabic. French, Urdu and Hindi come from
 * their dictionaries (keyed by the English text); with no entry the English is used.
 * `vars` fill {name} placeholders after translation.
 */
export function tr(en: string, ar: string, l: string = current, vars?: Record<string, string | number>): string {
  let s = l === 'ar' ? ar : l === 'fr' || l === 'ur' || l === 'hi' ? (translateTo(en, l) ?? en) : en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** A text pair object ({en, ar}) in the given language. */
export const pick = (p: { en: string; ar: string }, l: string = current, vars?: Record<string, string | number>) => tr(p.en, p.ar, l, vars);

/** ": " — French puts a space before the colon */
export const colon = (l: Lang) => (l === 'fr' ? '\u00a0: ' : ': ');
