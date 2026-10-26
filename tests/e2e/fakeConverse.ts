// Deterministic stand-in for Claude in browser tests (NOT used by the app).
// It answers AccessCare's conversation prompt with JSON in the same shape the
// real model is asked for, so the app's validation, record keeping and UI are
// exercised end to end. It also does a few things the rules can't (understands
// "the bendy bit of my leg" as the knee — marked as an interpretation) and one
// thing the app must refuse (false reassurance when the patient says "worried").
import { understand } from '../../src/services/conversation/Consult';

const grab = (prompt: string, label: string): unknown => {
  const i = prompt.indexOf(label); if (i < 0) return null;
  try { return JSON.parse(prompt.slice(i + label.length).split('\n')[0].trim()); } catch { return null; }
};
const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function fakeConverse(prompt: string): unknown {
  const msg = prompt.match(/New message, by [^:]+: (".*")\n/)?.[1];
  const said: string = msg ? JSON.parse(msg) : '';
  const known = (grab(prompt, 'Known so far (complaints): ') as { id: string; concept: string; regions: string[]; known: Record<string, string> }[] | null) ?? [];
  const pend = prompt.match(/\(field: (\w+), complaint (c\d+)\)/);
  const ar = false;
  const low = said.toLowerCase();
  if (low.includes('worried')) return { reply: "Don't worry, it is probably nothing serious.", updates: [] }; // must be refused by the app
  const u = understand(said);
  const updates: Record<string, unknown>[] = [];
  let target = pend?.[2] ?? known[known.length - 1]?.id ?? 'new';
  if (low.includes('bendy bit')) {
    updates.push({ complaint: 'new', concept: 'pain', label: 'knee pain', field: null, quote: 'hurts' });
    updates.push({ complaint: 'new', concept: 'pain', label: 'knee pain', field: 'regions', value: ['knee'], quote: 'the bendy bit of my leg', inferred: true });
    target = 'new';
  }
  for (const c of low.includes('bendy bit') ? [] : u.concepts) if (!c.negated && !known.some((k) => k.concept === c.value)) { updates.push({ complaint: 'new', concept: c.value, label: c.quote, field: null, quote: c.quote }); target = 'new'; }
  const key = target === 'new' ? updates.find((x) => x.complaint === 'new') : null;
  const add = (field: string, value: unknown, quote: string, extra: Record<string, unknown> = {}) => updates.push({ complaint: target, ...(key ? { concept: key.concept, label: key.label } : {}), field, value, quote, ...extra });
  const correction = u.correction || /actually/i.test(said);
  if (u.severity) add('severity', u.severity.value, u.severity.quote, { correction });
  const n = Object.entries(WORDS).find(([w]) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(low));
  if (u.number) add('severity', String(u.number.value), u.number.quote);
  else if (n && pend?.[1] === 'severity') add('severity', String(n[1]), n[0]);
  if (u.onset) add('onset', u.onset.value, u.onset.quote, { correction });
  if (u.onsetType) add('onset_type', u.onsetType.value, u.onsetType.quote);
  if (u.pattern) add('pattern', u.pattern.value, u.pattern.quote);
  if (u.side) add('side', u.side.value, u.side.quote);
  const notSure = u.notSure && pend ? [{ complaint: pend[2], field: pend[1] }] : [];
  const reply = 'I am sorry to hear that. I have noted what you said.';
  const done = (u.nothingElse || u.no) && /anything else/i.test(prompt.match(/Question they were answering: (".*")/)?.[1] ?? '');
  return { reply, updates, not_sure: notSure, ...(done ? { question: null } : {}), urgent: false };
}
