// Visit explanation for the patient: the doctor's own notes, optionally reworded
// by AI into plain Egyptian Arabic or plain English. The doctor reviews and
// approves the wording before it is sent; the AI may not add anything.

import { PROMPT_PREFIX } from './engine';
import type { Lang } from '../../i18n/lang';
import { AI_LANG } from '../langWords';

const AR_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const numbers = (t: string) => new Set((t.replace(/[٠-٩]/g, (d) => AR_DIGITS[d]).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.')));
const REASSURE = /don'?t worry|nothing (serious|to worry)|you('| wi)ll be (fine|ok|okay)|harmless|متقلقش|ماتقلقش|مفيش حاجة خطيرة|مش خطير|هتبقى كويس|هتكون كويس/i;

export function summaryPrompt(doctorText: string, rxLines: string[], lang: Lang = 'en'): string {
  return `${PROMPT_PREFIX}
Task: rewrite the doctor's explanation of this visit so the patient can understand it. The patient may have trouble reading or understanding complex language.
Language: ${lang === 'ar' ? 'Egyptian Arabic (colloquial, warm, respectful); keep medicine names in Latin letters as written' : lang === 'en' ? 'plain English' : `${AI_LANG[lang]}; keep medicine names in Latin letters as written`}.
Rules: short sentences (at most 12 words each), one idea per sentence; explain any medical word in simple words; keep EVERY instruction, number, medicine name, time and warning exactly; do NOT add any advice, diagnosis, medicine, number, test, reassurance or promise that is not in the doctor's text; do not remove warnings about when to get help. If something is unclear, keep the doctor's words.
DOCTOR'S TEXT:
${doctorText.slice(0, 3000)}
${rxLines.length ? `APPROVED PRESCRIPTIONS (already sent to the patient):\n${rxLines.join('\n').slice(0, 1500)}` : ''}
Reply with only JSON: {"text":"the explanation"}`;
}

/** Checks AI wording against the doctor's text. Returns null when it must be rejected. */
export function checkSummary(source: string, raw: unknown): { text: string; warnings: string[] } | { rejected: string } {
  const text = raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string' ? (raw as { text: string }).text.trim() : '';
  if (text.length < 10) return { rejected: 'The AI returned no usable text.' };
  if (text.length > 1800) return { rejected: 'The AI text was too long.' };
  const src = numbers(source);
  const added = [...numbers(text)].filter((n) => !src.has(n));
  if (added.length) return { rejected: `The AI added numbers that are not in your text (${added.join(', ')}). Nothing from it was used.` };
  if (REASSURE.test(text) && !REASSURE.test(source)) return { rejected: 'The AI added reassurance that is not in your text. Nothing from it was used.' };
  const warnings: string[] = [];
  const meds = [...source.matchAll(/^- ([A-Za-z][A-Za-z \-]{2,40}):/gm)].map((m) => m[1].trim());
  for (const m of meds) if (!text.toLowerCase().includes(m.toLowerCase())) warnings.push(`The AI wording does not mention ${m}. Check it before sending.`);
  if (/\b(call|emergency|999|998|123|طوارئ|اتصل)\b/i.test(source) && !/(call|emergency|999|998|123|طوارئ|اتصل)/i.test(text)) warnings.push('Your text mentions when to get urgent help; the AI wording may have dropped it.');
  return { text, warnings };
}
