// French, Urdu and Hindi interface text. Like Arabic (ar.ts), every screen is written
// once in English and these dictionaries give the same text in the chosen language,
// keyed by the English text. A key may contain {0}, {1}… for a part that changes
// (a name, a number, a screen title): "You are on {0}." matches "You are on Home."
// and the changing part is translated too when the dictionary knows it.
// Text with no entry stays in English — never machine-guessed.
import { FR } from './fr';
import { UR } from './ur';
import { HI } from './hi';

export type DictLang = 'fr' | 'ur' | 'hi';
export const DICTS: Record<DictLang, Record<string, string>> = { fr: FR, ur: UR, hi: HI };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Tpl = { re: RegExp; out: string; slots: number[]; weight: number };
const tpls = new Map<DictLang, Tpl[]>();
function templates(l: DictLang): Tpl[] {
  let list = tpls.get(l);
  if (list) return list;
  list = [];
  for (const [k, v] of Object.entries(DICTS[l])) {
    if (!/\{\d\}/.test(k)) continue;
    if ((k.replace(/\{\d\}/g, '').match(/\p{L}/gu) ?? []).length < 4) continue; // "{0}: {1}." would match anything
    const slots: number[] = [];
    const src = k.split(/(\{\d\})/).map((p) => {
      const m = p.match(/^\{(\d)\}$/);
      if (m) { slots.push(Number(m[1])); return '(.+?)'; }
      return esc(p);
    }).join('');
    list.push({ re: new RegExp(`^${src}$`, 's'), out: v, slots, weight: k.replace(/\{\d\}/g, '').length });
  }
  // the most specific (most fixed text) first
  list.sort((a, b) => b.weight - a.weight);
  tpls.set(l, list);
  return list;
}

const cache = new Map<string, string | null>();
const upperFirst = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** The text in French, Urdu or Hindi, or null when the dictionary has no entry for it. */
export function translateTo(text: string, l: DictLang, depth = 0): string | null {
  const k = norm(text);
  if (!k || !/[A-Za-z]/.test(k)) return null;
  const ck = `${l}\u0000${k}`;
  if (depth === 0 && cache.has(ck)) return cache.get(ck)!;
  const r = lookup(k, l, depth);
  if (depth === 0) { if (cache.size > 6000) cache.clear(); cache.set(ck, r); }
  return r;
}

function lookup(k: string, l: DictLang, depth: number): string | null {
  const D = DICTS[l];
  const hit = D[k];
  if (hit !== undefined) return hit;
  // capitals ("WHERE IS THE PAIN?") or a capital first letter for a word written in lower case
  if (k === k.toUpperCase() && k.length > 1) { const sc = k.charAt(0) + k.slice(1).toLowerCase(); if (D[sc] !== undefined) return D[sc]; }
  if (/^[A-Z][a-z]/.test(k)) { const lc = k.charAt(0).toLowerCase() + k.slice(1); if (D[lc] !== undefined) return upperFirst(D[lc]); }
  if (/^[a-z]/.test(k)) { const uc = upperFirst(k); if (D[uc] !== undefined) return D[uc]; }
  // a trailing colon or full stop, or a leading tick
  const m = k.match(/^(.*?)\s*([:.!?])$/);
  if (m && m[1]) { const h = translateTo(m[1], l, depth + 1); if (h) return h + (l === 'ur' && m[2] === '.' ? '۔' : l === 'hi' && m[2] === '.' ? '।' : m[2] === '?' && l === 'ur' ? '؟' : m[2]); }
  const lead = k.match(/^([✓✔•·→←⚠✨]\s*)(.+)$/u);
  if (lead) { const h = translateTo(lead[2], l, depth + 1); if (h) return lead[1] + h; }
  if (depth > 3) return null;
  for (const t of templates(l)) {
    const mm = k.match(t.re);
    if (!mm) continue;
    let out = t.out;
    t.slots.forEach((slot, i) => {
      const part = mm[i + 1];
      const tr = translateTo(part, l, depth + 1) ?? translateTo(part.replace(/^(a|an|the) /i, ''), l, depth + 1) ?? part;
      out = out.split(`{${slot}}`).join(tr);
    });
    return out;
  }
  return null;
}
