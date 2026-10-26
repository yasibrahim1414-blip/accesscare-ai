// Silent Signal AI — input interpretation and calibration logic (UI-independent).
// The principle: an input only counts when it is unambiguous AND, unless the
// patient turned it off after a clean calibration, explicitly confirmed.

import type { SignalCalibration, SignalMethod, SignalPrefs, Sensation } from '../../domain/types';

export interface SignalOption { id: string; label: string; symbol: string; color?: string }

export interface MethodInfo { id: SignalMethod; title: string; description: string; available: boolean; why?: string }

export function methodCatalog(env: { speech: boolean; tts: boolean }): (MethodInfo | { id: 'camera' | 'eye_gaze'; title: string; description: string; available: false; why: string })[] {
  return [
    { id: 'large_buttons', title: 'Large buttons', description: 'Big targets you tap or click. Works with touch, mouse, or a pointing device.', available: true },
    { id: 'symbols', title: 'Symbol board', description: 'Pictures with short labels in a large grid. No reading needed.', available: true },
    { id: 'yes_no', title: 'Yes / No only', description: 'One option at a time; answer Yes or No. Good when choosing between many is hard.', available: true },
    { id: 'switch_scan', title: 'Single switch (scanning)', description: 'Options light up one by one. Press one big button — or Space / Enter, or an adaptive switch that acts as a key — when the one you want is lit.', available: true },
    { id: 'speech', title: 'Speak your choice', description: 'Say the option out loud. Each match is confirmed before it counts.', available: env.speech, why: env.speech ? undefined : 'Speech recognition isn’t available in this view (microphone access is not allowed here).' },
    { id: 'camera', title: 'Sign language (camera)', description: 'Answer Yes, No and choices with signs: the ASL signs YES and NO, or your own signs that you teach.', available: false, why: 'Set up separately: see “Answer with signs” on the Silent Signal screen.' },
    { id: 'eye_gaze', title: 'Eye-gaze selection', description: 'Choosing by looking at an option.', available: false, why: 'Needs dedicated eye-tracking hardware and software, which this version does not support.' },
  ];
}

/** Two different selections closer together than this are treated as ambiguous. */
export const AMBIGUITY_WINDOW_MS = 700;

export interface Tap { optionId: string; at: number }

/**
 * Interprets a burst of taps: one clear choice, or an ambiguity listing the
 * candidates the patient must choose between.
 */
export function interpretTaps(taps: Tap[]): { kind: 'clear'; optionId: string } | { kind: 'ambiguous'; candidates: string[] } | { kind: 'none' } {
  if (!taps.length) return { kind: 'none' };
  const last = taps[taps.length - 1];
  const recent = taps.filter((t) => last.at - t.at <= AMBIGUITY_WINDOW_MS);
  const ids = [...new Set(recent.map((t) => t.optionId))];
  return ids.length > 1 ? { kind: 'ambiguous', candidates: ids } : { kind: 'clear', optionId: last.optionId };
}

/**
 * Switch scanning: a press very soon after the highlight moved may have been
 * meant for the previous option.
 */
export function interpretScanPress(pressAt: number, movedAt: number, index: number, count: number, graceMs = 350):
  { kind: 'clear'; index: number } | { kind: 'ambiguous'; indices: [number, number] } {
  if (pressAt - movedAt < graceMs && count > 1) return { kind: 'ambiguous', indices: [(index - 1 + count) % count, index] };
  return { kind: 'clear', index };
}

/** Matches a spoken phrase to options; anything unclear is ambiguous, never guessed. */
export function matchSpeech(transcript: string, options: SignalOption[]): { kind: 'clear'; optionId: string } | { kind: 'ambiguous'; candidates: string[] } | { kind: 'none' } {
  const t = ` ${transcript.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
  const hits = options.filter((o) => {
    const words = o.label.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    return words.length > 0 && words.every((w) => t.includes(` ${w} `));
  });
  if (hits.length === 1) return { kind: 'clear', optionId: hits[0].id };
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map((h) => h.id) };
  return { kind: 'none' };
}

// ---------- calibration ----------
export const CALIBRATION_TARGETS: SignalOption[] = [
  { id: 'star', label: 'Star', symbol: '⭐' },
  { id: 'yes', label: 'Yes', symbol: '👍' },
  { id: 'circle', label: 'Blue circle', symbol: '🔵' },
  { id: 'house', label: 'House', symbol: '🏠' },
];
export const CALIBRATION_BOARD: SignalOption[] = [
  { id: 'star', label: 'Star', symbol: '⭐' }, { id: 'house', label: 'House', symbol: '🏠' },
  { id: 'circle', label: 'Blue circle', symbol: '🔵' }, { id: 'yes', label: 'Yes', symbol: '👍' },
  { id: 'no', label: 'No', symbol: '👎' }, { id: 'tree', label: 'Tree', symbol: '🌳' },
];

export interface CalibrationTrial {
  target: string;
  /** the selection the patient finally confirmed */
  registered: string | null;
  /** confirmed on the first registration (false = a registered input was not what they meant) */
  patientConfirmed: boolean;
  ambiguous: boolean;
}

export function scoreCalibration(method: SignalMethod, trials: CalibrationTrial[]): SignalCalibration {
  const correct = trials.filter((t) => t.registered === t.target).length;
  const misregistered = trials.filter((t) => !t.patientConfirmed).length;
  const ambiguous = trials.filter((t) => t.ambiguous).length;
  const passed = trials.length >= CALIBRATION_TARGETS.length && correct >= trials.length - 1 && misregistered <= 1;
  return { method, at: new Date().toISOString(), attempts: trials.length, correct, misregistered, ambiguous, passed };
}

/** Selections must be confirmed unless a calibration with this exact method passed cleanly and the patient opted out. */
export function mustConfirm(p: SignalPrefs): boolean {
  const c = p.calibration;
  if (!c || !c.passed || c.method !== p.method || c.misregistered > 0) return true;
  return p.confirmEachSelection;
}

export function adviceAfterCalibration(c: SignalCalibration, p: SignalPrefs): string[] {
  const tips: string[] = [];
  if (c.passed) tips.push('Your selections were registered reliably. You will still review everything before it is sent.');
  if (c.misregistered > 0) tips.push('Some selections were not what you meant. Keep “confirm each selection” on.');
  if (c.ambiguous > 0 && p.method === 'switch_scan') tips.push('Some presses came right as the highlight moved. Try a slower scanning speed.');
  if (c.ambiguous > 0 && p.method !== 'switch_scan') tips.push('Some taps landed on two options. Try Yes / No only or scanning.');
  if (!c.passed) tips.push('Practice again, or try a different method. You can change it at any time.');
  return tips;
}

// ---------- session vocabulary ----------
export const SENSATION_SYMBOLS: (SignalOption & { sensation: Sensation })[] = [
  { id: 'pain', label: 'Pain', symbol: '⚡', sensation: 'pain' },
  { id: 'burning', label: 'Burning', symbol: '🔥', sensation: 'burning' },
  { id: 'numbness', label: 'Numb', symbol: '🧊', sensation: 'numbness' },
  { id: 'tingling', label: 'Tingling', symbol: '✨', sensation: 'tingling' },
  { id: 'itching', label: 'Itchy', symbol: '🪶', sensation: 'itching' },
  { id: 'swelling', label: 'Swollen', symbol: '🎈', sensation: 'swelling' },
  { id: 'weakness', label: 'Weak', symbol: '🪫', sensation: 'weakness' },
  { id: 'not_sure', label: 'Not sure', symbol: '❔', sensation: 'not_sure' },
];

export interface SignalStep { id: string; question: string; short: string; options: SignalOption[] }

export const SIGNAL_STEPS: SignalStep[] = [
  { id: 'severity', question: 'How strong is it?', short: 'Strength', options: [
    { id: 'Mild', label: 'A little', symbol: '🙂' }, { id: 'Moderate', label: 'Medium', symbol: '😐' }, { id: 'Severe', label: 'A lot', symbol: '😣' }, { id: 'not_sure', label: 'Not sure', symbol: '❔' }] },
  { id: 'onset', question: 'When did it start?', short: 'Started', options: [
    { id: 'Today', label: 'Today', symbol: '⏱️' }, { id: '1–3 days ago', label: 'A few days ago', symbol: '📅' }, { id: 'More than a week ago', label: 'Longer ago', symbol: '⌛' }, { id: 'not_sure', label: 'Not sure', symbol: '❔' }] },
  { id: 'pattern', question: 'Is it there all the time?', short: 'Pattern', options: [
    { id: 'Constant', label: 'All the time', symbol: '➖' }, { id: 'Comes and goes', label: 'Comes and goes', symbol: '〰️' }, { id: 'not_sure', label: 'Not sure', symbol: '❔' }] },
  { id: 'need', question: 'What would you like?', short: 'Request', options: [
    { id: 'help_now', label: 'I need help now', symbol: '🚨' }, { id: 'talk', label: 'Talk with my doctor', symbol: '💬' },
    { id: 'question', label: 'I have a question', symbol: '❓' }, { id: 'inform', label: 'Just letting you know', symbol: '📝' }] },
];

/** Plain list wording — used when AI is off, unavailable, or the patient rejects AI wording. */
export function templateMessage(parts: { regions: string[]; sensation?: string; severity?: string; onset?: string; pattern?: string; need?: string }): string {
  const s: string[] = [];
  const sens = parts.sensation && parts.sensation !== 'Not sure' ? parts.sensation.toLowerCase() : 'something I can’t name';
  s.push(`I feel ${sens} in my ${parts.regions.join(', ').toLowerCase() || 'body'}.`);
  if (parts.severity) s.push(parts.severity === 'Not sure' ? 'I’m not sure how strong it is.' : `Strength: ${parts.severity.toLowerCase()}.`);
  if (parts.onset) s.push(parts.onset === 'Not sure' ? 'I’m not sure when it started.' : `It started: ${parts.onset.toLowerCase()}.`);
  if (parts.pattern) s.push(parts.pattern === 'Not sure' ? 'I’m not sure if it is constant.' : `${parts.pattern === 'All the time' ? 'It is there all the time.' : 'It comes and goes.'}`);
  if (parts.need) s.push(`${parts.need}.`);
  return s.join(' ');
}
