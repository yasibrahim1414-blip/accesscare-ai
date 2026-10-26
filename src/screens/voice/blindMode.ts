// Blind Mode on this device: remembered locally so the voice guide starts by
// itself next time (before anyone has signed in). Account-level settings are
// saved with the patient's preferences once signed in.
import { DEFAULT_BLIND, cleanBlindPrefs, type BlindPrefs } from '../../domain/voice';

const KEY = 'accesscare.blind.v1';

export function deviceBlind(): BlindPrefs | null {
  try { const raw = localStorage.getItem(KEY); return raw ? cleanBlindPrefs(JSON.parse(raw)) ?? null : (memory ?? null); } catch { return memory ?? null; }
}
let memory: BlindPrefs | null | undefined; // when storage is blocked, Blind Mode still works for this visit
const subs = new Set<(p: BlindPrefs | null) => void>();
export function setDeviceBlind(p: BlindPrefs | null) {
  memory = p;
  try { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  subs.forEach((f) => f(p));
}
/** Called whenever Blind Mode is turned on/off or its settings change (from anywhere in the app). */
export function onDeviceBlind(f: (p: BlindPrefs | null) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export function defaultBlind(): BlindPrefs {
  return { ...DEFAULT_BLIND };
}

const MIC = 'accesscare.blind.mic.v1';
/** Whether the person allowed Blind Mode to listen with the microphone on this device ('yes' | 'no' | null = not asked yet). */
export function micChoice(): 'yes' | 'no' | null { try { const v = localStorage.getItem(MIC); return v === 'yes' || v === 'no' ? v : null; } catch { return null; } }
export function setMicChoice(v: 'yes' | 'no' | null) { try { if (v) localStorage.setItem(MIC, v); else localStorage.removeItem(MIC); } catch { /* */ } }
