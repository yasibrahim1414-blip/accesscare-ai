// Deterministic stand-in for Claude's answers to the Clinical Intelligence
// Engine prompts in browser tests (NOT used by the app). It cites real fact ids
// from the prompt, and also returns items the app must reject (a probability,
// an invented fact id, a dose) so validation is exercised end to end.

export function fakeClinical(prompt: string): unknown {
  const facts = [...prompt.matchAll(/^(F\d+) \[([a-z]+); ([a-z_]+)\] ([^:]+): (.*)$/gm)].map((m) => ({ id: m[1], status: m[2], label: m[4], value: m[5] }));
  const sym = facts.find((f) => f.status !== 'denied' && f.status !== 'unsure') ?? facts[0];
  if (prompt.includes("Task: rewrite the doctor's explanation")) {
    return { text: 'Take naproxen twice a day with food, for 5 days.\nIf your lips or tongue swell, or you cannot breathe: call the emergency number now.' };
  }
  if (prompt.includes('medication OPTIONS')) {
    return { withhold: false, reason: '', options: [
      { generic: 'naproxen', reason: `${sym?.label ?? 'Pain'} reported by the patient`, supporting: sym ? [sym.id] : [], checks: ['kidney function', 'bleeding risk'] },
      { generic: 'amoxicillin', reason: 'test option that must be removed (documented allergy class)', supporting: sym ? [sym.id] : [], checks: [] },
      { generic: 'unknownium', reason: 'test option with no FDA label', supporting: sym ? [sym.id] : [], checks: [] },
    ] };
  }
  return {
    considerations: [
      { title: `Musculoskeletal or mechanical cause of ${sym?.label.toLowerCase() ?? 'the symptom'} to evaluate`, supporting: sym ? [sym.id] : [], against: [], missing: ['examination findings', 'history of injury'], uncertainty: 'Only the patient’s report is available.', refs: ['nhs_headache', 'invented_guideline'] },
      { title: 'Condition X (70% likely)', supporting: sym ? [sym.id] : [] },
      { title: 'Unsupported idea', supporting: ['F999'] },
    ],
    next_steps: [
      { kind: 'examination', text: 'Examine the affected area', why: 'Only the patient’s report is available', supporting: sym ? [sym.id] : [] },
      { kind: 'other', text: 'Start ibuprofen 400 mg', why: 'pain', supporting: sym ? [sym.id] : [] },
    ],
    extra_warnings: [],
  };
}

const LABELS: Record<string, unknown> = {
  naproxen: { set_id: 'test-naproxen-set', effective_time: '20260115', openfda: { generic_name: ['NAPROXEN'], brand_name: ['TESTBRAND'], product_type: ['HUMAN PRESCRIPTION DRUG'], substance_name: ['NAPROXEN'], pharm_class_epc: ['Nonsteroidal Anti-inflammatory Drug [EPC]'] },
    boxed_warning: ['Test label: cardiovascular and gastrointestinal risk.'], contraindications: ['Test label: known hypersensitivity to naproxen.'], drug_interactions: ['Test label: anticoagulants such as warfarin — increased bleeding risk.'] },
  amoxicillin: { set_id: 'test-amoxicillin-set', effective_time: '20260115', openfda: { generic_name: ['AMOXICILLIN'], product_type: ['HUMAN PRESCRIPTION DRUG'], substance_name: ['AMOXICILLIN'], pharm_class_epc: ['Penicillin-class Antibacterial [EPC]'] }, contraindications: ['Test label: history of allergic reaction to penicillins.'] },
};
/** openFDA stand-in: /fda-stub/drug/label.json?search=openfda.generic_name:"x"… (404 when nothing matches, like openFDA). */
export function fakeFda(search: string): { status: number; body: unknown } {
  const g = (search.match(/generic_name:"([^"]+)"/)?.[1] ?? '').toLowerCase();
  const l = LABELS[g];
  return l ? { status: 200, body: { meta: {}, results: [l] } } : { status: 404, body: { error: { code: 'NOT_FOUND' } } };
}
