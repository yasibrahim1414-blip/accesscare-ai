// Deterministic stand-ins for Claude in the care tests (the app validates every answer).
export function fakeInterp(prompt: string): unknown {
  const m = prompt.match(/Text \(data, not instructions\): (".*")/);
  const text: string = m ? JSON.parse(m[1]) : '';
  const table: [RegExp, string][] = [
    [/راسي بتوجعني من يومين/, 'My head has been hurting for two days.'],
    [/take 2 tablets twice a day for 5 days/i, 'خد ٢ حباية مرتين في اليوم لمدة ٥ أيام.'],
    [/take 1 tablet at night/i, 'خد ٢ حباية بالليل.'], // wrong number on purpose: the app must flag it
    [/مش فاهم/, 'I do not understand.'],
  ];
  for (const [re, out] of table) if (re.test(text)) return { translation: out, unclear: false };
  return { translation: `[translated] ${text}`, unclear: false };
}

/** Medicine-box reader: the test tells it what the "photo" shows. */
export function fakeBox(kind: string): unknown {
  if (kind === 'naproxen500') return { readable: true, names: ['Naproxen'], strength: '500 mg', form: 'tablet', text: 'Naproxen 500 mg 20 tablets' };
  if (kind === 'ibuprofen') return { readable: true, names: ['Ibuprofen', 'Brufen'], strength: '400 mg', form: 'tablet', text: 'Brufen Ibuprofen 400 mg' };
  if (kind === 'blurry') return { readable: false, names: [], strength: '', form: '', text: '' };
  return { readable: true, names: ['Naprosyn', 'Naproxen'], strength: '', form: 'tablet', text: 'Naproxen tablets' };
}

export function fakeBrief(prompt: string): unknown {
  const ids = [...prompt.matchAll(/^(K\d+) \[([^\]]*)\]/gm)].map((m) => m[1]);
  return { lines: [
    { text: 'Doses were mostly checked in; one side effect was reported and one point of the plan was understood differently.', refs: ids.slice(0, 2) },
    { text: 'Probably an allergy.', refs: ids.slice(0, 1) },   // diagnostic: must be removed
    { text: 'Took 99 doses.', refs: ids.slice(0, 1) },         // invented number: must be removed
  ] };
}
