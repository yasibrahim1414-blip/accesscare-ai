// FDA drug labels through openFDA (https://open.fda.gov/apis/drug/label/).
// Only the medicine's generic name leaves the app — never patient data.
// The checks here are text matches in the label, shown to the doctor as such:
// they are not a complete allergy or interaction check.

import type { Documented, LabelInfo, LabelMention } from '../../domain/clinical';

export type LabelResult = { status: 'found'; label: Record<string, unknown> } | { status: 'not_found' } | { status: 'unavailable'; error: string };

export interface FdaSource {
  /** https://api.fda.gov (tests point this at a local stand-in) */
  base: string;
  /** optional AccessCare worker URL used when the browser cannot reach openFDA directly */
  proxy?: string;
  fetch?: typeof fetch;
}

export function defaultFdaSource(aiEndpoint: string): FdaSource {
  const override = typeof window !== 'undefined' ? (window as unknown as { __ACCESSCARE_FDA_BASE__?: string }).__ACCESSCARE_FDA_BASE__ : undefined;
  return { base: override || 'https://api.fda.gov', ...(aiEndpoint ? { proxy: aiEndpoint.replace(/\/+$/, '') } : {}) };
}

const GENERIC = /^[a-z][a-z0-9 \-]{2,48}$/i;
export const validGeneric = (g: string) => GENERIC.test(g.trim()) && !/\d\s*(mg|mcg|g|ml|units?)\b/i.test(g);

/** Finds the label for a generic name: prescription label first, then any human label. */
export async function fetchLabel(generic: string, src: FdaSource): Promise<LabelResult> {
  const g = generic.trim().toLowerCase();
  if (!validGeneric(g)) return { status: 'not_found' };
  const f = src.fetch ?? fetch;
  const q = (extra: string) => `${src.base.replace(/\/+$/, '')}/drug/label.json?search=openfda.generic_name:%22${encodeURIComponent(g)}%22${extra}&limit=1`;
  const direct = async (): Promise<LabelResult> => {
    for (const url of [q('+AND+openfda.product_type:%22HUMAN+PRESCRIPTION+DRUG%22'), q('')]) {
      const r = await f(url);
      if (r.status === 404) continue;            // openFDA answers 404 when nothing matches
      if (!r.ok) return { status: 'unavailable', error: `openFDA ${r.status}` };
      const j = (await r.json()) as { results?: Record<string, unknown>[] };
      if (j.results?.[0]) return { status: 'found', label: j.results[0] };
    }
    return { status: 'not_found' };
  };
  try { return await direct(); }
  catch (e) {
    if (!src.proxy) return { status: 'unavailable', error: (e as Error).message || 'network' };
    try {
      const r = await f(`${src.proxy}/fda`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generic: g }) });
      if (!r.ok) return { status: 'unavailable', error: `proxy ${r.status}` };
      const j = (await r.json()) as { label?: Record<string, unknown> | null };
      return j.label ? { status: 'found', label: j.label } : { status: 'not_found' };
    } catch (e2) { return { status: 'unavailable', error: (e2 as Error).message || 'network' }; }
  }
}

const text = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim();
const clip = (t: string, n = 700) => (t.length > n ? `${t.slice(0, n).replace(/\s\S*$/, '')}…` : t);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mention(term: string, sections: [string, string][]): LabelMention | null {
  const t = term.trim();
  if (t.length < 3) return null;
  const re = new RegExp(`\\b${esc(t)}`, 'i');
  for (const [name, body] of sections) {
    const m = body.match(re);
    if (m && m.index !== undefined) {
      const a = Math.max(0, m.index - 160); const b = Math.min(body.length, m.index + t.length + 200);
      return { term: t, section: name, excerpt: `${a > 0 ? '…' : ''}${body.slice(a, b)}${b < body.length ? '…' : ''}` };
    }
  }
  return null;
}

/** Turns an openFDA label into what the doctor sees, with documented-factor text matches. */
export function parseLabel(raw: Record<string, unknown>, d: Documented): LabelInfo {
  const of = (raw.openfda ?? {}) as Record<string, unknown>;
  const generic = text(of.generic_name) || 'unknown';
  const brand = text(of.brand_name);
  const setId = text(raw.set_id);
  const sec = (k: string) => text(raw[k]);
  const name = (k: string) => k.replace(/_/g, ' ');
  const safety: [string, string][] = ['boxed_warning', 'contraindications', 'warnings_and_cautions', 'warnings', 'do_not_use', 'ask_doctor', 'ask_doctor_or_pharmacist', 'drug_interactions', 'precautions']
    .map((k) => [name(k), sec(k)] as [string, string]).filter(([, b]) => b);
  const identity: [string, string][] = [['drug class', text(of.pharm_class_epc)], ['active ingredient', text(of.substance_name) || generic]];
  const allergyMentions: LabelMention[] = [];
  if (d.allergies.status === 'listed') for (const a of d.allergies.items) { const m = mention(a, [...identity, ...safety]); if (m) allergyMentions.push(m); }
  const interactionMentions: LabelMention[] = [];
  if (d.medications.status === 'listed') for (const med of d.medications.items) {
    const word = med.split(/\s+/)[0];
    if (generic.toLowerCase().includes(word.toLowerCase())) interactionMentions.push({ term: med, section: 'same medicine', excerpt: `The patient already takes ${med}; this is the same active ingredient (${generic}).` });
    else { const m = mention(word, safety); if (m) interactionMentions.push({ ...m, term: med }); }
  }
  const factorNotes: LabelMention[] = [];
  const pick = (term: string, keys: string[], re: RegExp) => {
    for (const k of keys) { const b = sec(k); if (!b) continue; const m = b.match(re); if (m && m.index !== undefined) { factorNotes.push({ term, section: name(k), excerpt: clip(b.slice(Math.max(0, m.index - 120)), 420) }); return; } }
  };
  const age = Number(d.age);
  if (d.pregnancy === 'yes') pick('pregnancy', ['pregnancy', 'pregnancy_or_breast_feeding', 'use_in_specific_populations', 'warnings_and_cautions', 'warnings'], /pregnan/i);
  if (d.age && age < 18) pick('child', ['pediatric_use', 'use_in_specific_populations', 'dosage_and_administration', 'do_not_use'], /pediatric|child|under \d+ years/i);
  if (d.age && age >= 65) pick('older adult', ['geriatric_use', 'use_in_specific_populations'], /geriatric|elderly|65 years/i);
  if (d.kidney === 'impaired') pick('kidney', ['use_in_specific_populations', 'warnings_and_cautions', 'warnings', 'dosage_and_administration', 'ask_doctor'], /renal|kidney/i);
  if (d.liver === 'impaired') pick('liver', ['use_in_specific_populations', 'warnings_and_cautions', 'warnings', 'dosage_and_administration', 'ask_doctor'], /hepatic|liver/i);
  return {
    setId, title: brand ? `${generic} (${brand})` : generic, productType: text(of.product_type) || 'not stated', effective: text(raw.effective_time),
    url: setId ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}` : 'https://dailymed.nlm.nih.gov/dailymed/',
    ...(sec('indications_and_usage') ? { indications: clip(sec('indications_and_usage'), 500) } : {}),
    ...(sec('boxed_warning') ? { boxedWarning: clip(sec('boxed_warning')) } : {}),
    ...(sec('contraindications') || sec('do_not_use') ? { contraindications: clip(sec('contraindications') || sec('do_not_use')) } : {}),
    ...(sec('warnings_and_cautions') || sec('warnings') ? { warnings: clip(sec('warnings_and_cautions') || sec('warnings'), 500) } : {}),
    allergyMentions, interactionMentions, factorNotes,
  };
}

/** A documented allergy that names this medicine or its drug class (stronger than a text mention). */
export function allergyConflict(label: LabelInfo, d: Documented): string | null {
  if (d.allergies.status !== 'listed') return null;
  for (const m of label.allergyMentions) if (m.section === 'drug class' || m.section === 'active ingredient') return `${m.term} (${m.section}: ${m.excerpt})`;
  return null;
}
