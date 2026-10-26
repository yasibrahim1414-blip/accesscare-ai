// English/Arabic pairs that already exist in the app's data (symptom words, side
// effects, body areas), so the interface shows them in Arabic without a second copy.
import { CONCEPTS, SEVERITY, ONSET, ONSET_TYPE, PATTERN, SIDE, SENSATIONS } from '../services/conversation/lexicon';
import { SIDE_EFFECTS } from '../domain/clinical';
import { BODY_REGIONS, regionLabelIn } from '../domain/bodyRegions';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function codePairs(): [string, string][] {
  const out: [string, string][] = [];
  for (const c of CONCEPTS) if (c.ar) { out.push([c.en, c.ar], [cap(c.en), c.ar]); }
  for (const list of [SEVERITY, ONSET, ONSET_TYPE, PATTERN, SIDE, SENSATIONS]) for (const v of list) if (v.ar) out.push([v.en, v.ar], [cap(v.en), v.ar]);
  for (const s of SIDE_EFFECTS) out.push([s.en, s.ar]);
  for (const r of BODY_REGIONS) { const ar = regionLabelIn(r.id, 'ar'); if (ar && ar !== r.label) out.push([r.label, ar]); }
  return out;
}
