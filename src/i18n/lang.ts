// The app's language (English or Arabic), chosen by the person and remembered on
// this device. Switching updates the whole interface in place (text, reading
// direction) without leaving the current screen.
import { useEffect, useState } from 'react';

export type Lang = 'en' | 'ar';
const KEY = 'accesscare.lang.v1';
const subs = new Set<(l: Lang) => void>();

function initial(): Lang {
  try { const v = localStorage.getItem(KEY); if (v === 'ar' || v === 'en') return v; } catch { /* storage blocked */ }
  return 'en';
}
let current: Lang = typeof window === 'undefined' ? 'en' : initial();

export const getLang = (): Lang => current;
export function setLang(l: Lang) {
  if (l !== 'ar' && l !== 'en') return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked: still changes for this visit */ }
  applyDocumentLang();
  subs.forEach((f) => f(l));
}
export function onLang(f: (l: Lang) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.documentElement.dir = current === 'ar' ? 'rtl' : 'ltr';
}

/** React: the current language; re-renders when it changes. */
export function useLang(): Lang {
  const [l, setL] = useState(current);
  useEffect(() => onLang(setL), []);
  return l;
}

/** Inline bilingual text for strings built in code (sentences with values). */
export const tr = (en: string, ar: string, l: Lang = current) => (l === 'ar' ? ar : en);
