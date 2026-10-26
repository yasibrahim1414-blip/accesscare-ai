// Medicine package check: Claude reads ONLY the printed text on the photo; the
// comparison with the patient's prescriptions is done here by fixed rules, so
// the answer ("this is your Naproxen" / "this is not in your prescriptions") never
// depends on the AI guessing. When the text cannot be read, it says so.

import type { MedPlan } from './meds';

export const VISION_PREFIX = 'You read the printed text on a photo of a medicine package for AccessCare AI.';

export interface BoxReading {
  readable: boolean;
  names: string[];
  strength: string;
  form: string;
  /** printed text, as read */
  text: string;
}

export function boxPrompt(): string {
  return `${VISION_PREFIX}
Task: look at the photo of a medicine box, blister pack or bottle and copy the printed text you can read.
Rules: copy only what is printed (do not guess names from colours or shapes); if you cannot read a medicine name clearly, set "readable": false. Do not give medical advice.
Reply with only JSON: {"readable": true|false, "names": ["medicine names printed, brand and generic, max 4"], "strength": "e.g. 500 mg or ''", "form": "tablet|capsule|syrup|cream|injection|drops|other|''", "text": "the main printed words, max 200 characters"}`;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanBoxReading(raw: unknown): BoxReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const names = Array.isArray(r.names) ? r.names.map((n) => str(n, 60)).filter((n) => n.length >= 2).slice(0, 4) : [];
  const text = str(r.text, 200);
  const readable = r.readable === true && (names.length > 0 || text.length >= 3);
  return { readable, names, strength: str(r.strength, 30), form: str(r.form, 20), text };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9؀-ۿ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Does the printed text name this medicine? (exact word, or one small reading slip for longer names) */
export function namesMedicine(reading: BoxReading, medicine: string): boolean {
  const target = norm(medicine).split(' ').filter((w) => w.length >= 4);
  if (!target.length) return false;
  const words = norm([...reading.names, reading.text].join(' ')).split(' ').filter(Boolean);
  return target.some((t) => words.some((w) => w === t || (t.length >= 6 && w.length >= 5 && lev(w, t) <= 1)));
}

/** "250 mg" from a dose or strength text (number + unit), or null. */
export function strengthOf(text: string): { value: number; unit: string } | null {
  const m = norm(text).match(/(\d+(?:[.,]\d+)?)\s?(mg|mcg|µg|g|ml|iu|%)/);
  return m ? { value: Number(m[1].replace(',', '.')), unit: m[2] === 'µg' ? 'mcg' : m[2] } : null;
}

export type BoxVerdict =
  | { kind: 'match'; plan: MedPlan; strength: 'same' | 'different' | 'unknown'; boxStrength: string }
  | { kind: 'not_prescribed'; read: string }
  | { kind: 'unreadable' };

/** Compares what was read with the patient's prescriptions (active ones first). */
export function checkBox(reading: BoxReading | null, plans: MedPlan[]): BoxVerdict {
  if (!reading || !reading.readable) return { kind: 'unreadable' };
  const ordered = [...plans].sort((a, b) => Number(b.active) - Number(a.active));
  const plan = ordered.find((p) => namesMedicine(reading, p.name));
  if (!plan) return { kind: 'not_prescribed', read: reading.names[0] || reading.text.slice(0, 60) };
  const boxS = strengthOf(`${reading.strength} ${reading.text}`);
  const rxS = strengthOf(plan.dose);
  const strength = !boxS || !rxS || boxS.unit !== rxS.unit ? 'unknown' : boxS.value === rxS.value ? 'same' : 'different';
  return { kind: 'match', plan, strength, boxStrength: boxS ? `${boxS.value} ${boxS.unit}` : '' };
}

/** A smaller JPEG for sending (long side ≤ 1280 px). */
export async function shrinkForReading(src: Blob | HTMLCanvasElement | HTMLVideoElement, maxSide = 1280): Promise<Blob> {
  let w: number, h: number, draw: CanvasImageSource;
  if (src instanceof Blob) {
    const bmp = await createImageBitmap(src);
    w = bmp.width; h = bmp.height; draw = bmp;
  } else if (src instanceof HTMLVideoElement) { w = src.videoWidth; h = src.videoHeight; draw = src; } else { w = src.width; h = src.height; draw = src; }
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(draw, 0, 0, c.width, c.height);
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.85));
}
