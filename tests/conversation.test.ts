import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startConsult, ruleTurn, summaryLines, reportData, understand, safetyCheck, type ConsultInput, type ConsultTurn } from '../src/services/conversation/Consult';
import { applyAI, buildPrompt, converse, guardReply, CONVERSE_PREFIX } from '../src/services/conversation/ai';

const T = (text: string, via: ConsultInput['via'] = 'voice'): ConsultInput => ({ kind: 'text', text, via });
function talk(lang: 'en', inputs: (string | ConsultInput)[]): ConsultTurn {
  let t = startConsult(lang);
  for (const i of inputs) t = ruleTurn(t.rec, typeof i === 'string' ? T(i) : i);
  return t;
}
const labels = (t: ConsultTurn) => t.options.map((o) => o.label).join(' | ');

// ---------------------------------------------------------------- conversational intelligence (rules, no AI)
test('1. "I have a really bad headache" → headache, severe; follow-up is about the headache, never chest/back', () => {
  const t = talk('en', ['I have a really bad headache']);
  const c = t.rec.complaints[0];
  assert.equal(c.concept, 'headache'); assert.deepEqual(c.regions.map((r) => r.id), ['head']);
  assert.equal(c.facts.severity?.value, 'severe'); assert.equal(c.facts.severity?.quote, 'really bad');
  assert.equal(t.rec.pending?.complaint, c.id); assert.ok(['onset', 'onset_type', 'location'].includes(t.rec.pending!.slot!));
  assert.doesNotMatch(labels(t), /chest|back/i);
  assert.match(t.say.join(' '), /sorry/i);
});

test('2. "my head has been hurting since this morning" → since this morning (patient words kept), not asked again', () => {
  const t = talk('en', ['my head has been hurting since this morning']);
  const c = t.rec.complaints[0];
  assert.deepEqual(c.regions.map((r) => r.id), ['head']); assert.equal(c.facts.onset?.value, 'today'); assert.equal(c.facts.onset?.quote, 'this morning');
  assert.equal(c.quote, 'my head has been hurting since this morning');
  assert.notEqual(t.rec.pending?.slot, 'onset', 'onset is not asked again');
  assert.match(labels(t), /Forehead/); assert.doesNotMatch(labels(t), /chest|belly/i);
});

test('3. "my stomach hurts" → stomach pain; asks which part of the belly', () => {
  const t = talk('en', ['my stomach hurts']);
  assert.equal(t.rec.complaints[0].concept, 'abdominal_pain');
  assert.equal(t.rec.pending?.slot, 'location');
  assert.match(labels(t), /Upper belly/); assert.match(labels(t), /Around the belly button/);
  const r = ruleTurn(t.rec, T('on the right side'));
  assert.equal(r.rec.complaints[0].facts.location?.value, 'right'); assert.ok(r.rec.complaints[0].regions.some((x) => x.id === 'abdomen_r'));
});

test('4. two symptoms in one sentence are both kept and both asked about', () => {
  let t = talk('en', ['I have a headache and I feel dizzy']);
  assert.deepEqual(t.rec.complaints.map((c) => c.concept), ['headache', 'dizziness']);
  assert.match(t.say.join(' '), /a headache and dizziness/);
  t = talk('en', ['I have a headache and I feel dizzy', 'today', 'gradually', 'whole head', 'mild', 'all the time', 'none', 'yesterday']);
  const dz = t.rec.complaints.find((c) => c.concept === 'dizziness')!;
  assert.equal(dz.facts.onset?.value, 'days', 'the second symptom got its own questions');
  const s = summaryLines(t.rec).join('\n');
  assert.match(s, /1\. Headache/); assert.match(s, /2\. Dizziness/);
});

test('5. the patient changes an earlier answer: updated, not duplicated, correction recorded', () => {
  const t = talk('en', ['my back hurts', 'lower', 'since yesterday', 'sorry, I mean it started a week ago']);
  const c = t.rec.complaints[0];
  assert.equal(c.facts.onset?.value, 'week');
  assert.equal(t.rec.corrections.length, 1); assert.match(t.rec.corrections[0].from, /few days/);
  assert.match(t.say.join(' '), /changed/);
  assert.equal(t.rec.complaints.length, 1);
});

test('6. "I don’t know how to describe it" → reassurance and simpler ways, not the same question again', () => {
  const t = talk('en', ["I don't know how to describe the pain"]);
  assert.match(t.say.join(' '), /do not need medical words/);
  assert.ok(t.options.length >= 5, 'simple choices are offered');
  assert.match(labels(t), /Belly/); assert.match(t.say.join(' '), /body map/);
});

test('7. an unrelated question is answered honestly and kept for the doctor', () => {
  const t = talk('en', ['I have a headache', 'is this dangerous?']);
  assert.match(t.say.join(' '), /cannot give medical advice/);
  assert.deepEqual(t.rec.notes.map((n) => n.kind), ['question']);
  assert.match(summaryLines(t.rec).join('\n'), /Your questions for the doctor: "is this dangerous\?"/);
  assert.doesNotMatch(t.say.join(' '), /not serious|nothing to worry|you have/i);
});

test('8. an answer outside the options is kept in the patient’s own words', () => {
  const t = talk('en', ['I have a headache', 'today', 'gradually', 'like a tight band all around it']);
  const f = t.rec.complaints[0].facts.location!;
  assert.equal(f.value, 'other'); assert.equal(f.quote, 'like a tight band all around it'); assert.equal(f.prov, 'said');
});

test('9. "not sure" is recorded as not sure; a contradiction is clarified, not silently overwritten', () => {
  let t = talk('en', ['I have a headache', "I don't know"]);
  assert.deepEqual(t.rec.complaints[0].unknown, ['onset']);
  assert.match(summaryLines(t.rec).join('\n'), /Started: not sure/);
  t = talk('en', ['I have had a headache since yesterday', 'gradually', 'forehead', 'it started this morning']);
  assert.equal(t.rec.pending?.kind, 'clarify_conflict', t.say.join(' | '));
  assert.match(t.say.join(' '), /Earlier you told me "a few days ago", and now "today"/);
  const r = ruleTurn(t.rec, { kind: 'option', id: 'conflict:new', label: 'today', via: 'touch' });
  assert.equal(r.rec.complaints[0].facts.onset?.value, 'today'); assert.equal(r.rec.corrections.length, 1);
  // an unclear reply is never guessed; after two misses other ways are offered
  let u = talk('en', ['I have a headache', 'blue banana']);
  assert.match(u.say.join(' '), /did not quite catch/);
  u = ruleTurn(u.rec, T('zzz qqq'));
  assert.match(u.say.join(' '), /my fault, not yours/); assert.ok(u.options.length);
});

test('10. more than one body region: "from my neck to my head"', () => {
  const t = talk('en', ['the pain goes from my neck to my head']);
  assert.deepEqual(t.rec.complaints[0].regions.map((r) => r.id).sort(), ['head', 'neck']);
  assert.match(t.rec.complaints[0].en, /neck and head/);
});

test('vague: "I just feel strange, not myself" gets an empathetic request for more, with simple options', () => {
  const t = talk('en', ['I just feel strange, not myself']);
  assert.equal(t.rec.pending?.kind, 'clarify_vague'); assert.match(t.say.join(' '), /sorry you are not feeling well/); assert.match(labels(t), /Dizziness/);
  const r = ruleTurn(t.rec, { kind: 'option', id: 'concept:dizziness', label: 'Dizziness', via: 'touch' });
  assert.ok(r.rec.complaints.some((c) => c.concept === 'dizziness' && c.prov === 'chosen'));
});

test('feelings and pauses: worry gets empathy; "wait" does not move on', () => {
  const t = talk('en', ["I'm scared"]);
  assert.match(t.say.join(' '), /you are worried/);
  const w = talk('en', ['I have a headache']);
  const p = ruleTurn(w.rec, T('wait, give me a minute'));
  assert.match(p.say.join(' '), /take your time/i); assert.equal(p.rec.pending?.slot, w.rec.pending?.slot);
});

// ---------------------------------------------------------------- medical workflow
test('28/30. the original complaint is preserved and nothing is invented', () => {
  const t = talk('en', ['I have a headache']);
  const s = summaryLines(t.rec, 'en').join('\n');
  assert.match(s, /you said: "I have a headache"/);
  assert.doesNotMatch(s, /Strength:|Started:|Pattern:/, 'no values the patient did not give');
  assert.match(s, /Not answered: .*Started/);
});

test('32. emergency symptoms are flagged immediately (rules, also from structured answers)', () => {
  assert.ok(talk('en', ['I suddenly have the worst headache of my life']).urgent.includes('a sudden, very severe headache'));
  assert.ok(talk('en', ['my chest feels tight and heavy']).urgent.length);
  assert.ok(talk('en', ["I can't breathe"]).urgent.includes('difficulty breathing'));
  const t = talk('en', ['I have a headache', 'today', { kind: 'option', id: 'v:sudden', label: 'Started suddenly', via: 'touch' }, 'forehead', { kind: 'option', id: 'v:severe', label: 'Severe', via: 'touch' }]);
  assert.ok(t.rec.urgent.includes('a sudden, very severe headache'), 'touch answers are checked too');
  assert.equal(safetyCheck(t.rec, '').length, 0, 'shown once, not repeated');
});

test('body map and spoken inputs feed the same record', () => {
  let t = talk('en', ['it hurts']);
  t = ruleTurn(t.rec, { kind: 'regions', ids: ['knee_r'], via: 'body_map' });
  assert.deepEqual(t.rec.complaints[0].regions.map((r) => [r.id, r.via]), [['knee_r', 'body_map']]);
  t = ruleTurn(t.rec, T('since yesterday', 'voice'));
  assert.equal(t.rec.complaints[0].facts.onset?.via, 'voice');
  const s = summaryLines(t.rec).join('\n');
  assert.match(s, /shown on the body map/);
  const d = reportData(t.rec);
  assert.deepEqual(d.regionIds, ['knee_r']); assert.equal(d.onset, '1–3 days ago');
});

test('numbers and negation are understood; Arabic words switch the conversation to Arabic', () => {
  assert.equal(understand('7 out of 10').number?.value, 7);
  assert.equal(understand('no nausea').concepts[0].negated, true);
  const t = talk('en', ['عندي صداع']);
  assert.equal(t.rec.lang, 'ar'); assert.equal(t.rec.complaints[0].concept, 'headache'); assert.match(t.say.join(' '), /[\u0600-\u06FF]/);
  const hi = talk('ar', ['السلام عليكم']);
  assert.match(hi.say.join(' '), /أهلاً/);
});

// ---------------------------------------------------------------- AI turns (validated)
test('AI turn: details with real quotes are kept; unsupported values and fake quotes are not trusted', () => {
  const t0 = startConsult('en');
  const said = 'I have had a really bad headache since this morning and I cannot focus';
  const raw = {
    reply: 'I am so sorry. That sounds really hard. I understand it is severe and started this morning.',
    updates: [
      { complaint: 'new', concept: 'headache', label: 'headache', field: null, quote: 'headache' },
      { complaint: 'new', concept: 'headache', label: 'headache', field: 'severity', value: 'severe', quote: 'really bad' },
      { complaint: 'new', concept: 'headache', label: 'headache', field: 'onset', value: 'today', quote: 'since this morning' },
      { complaint: 'new', concept: 'headache', label: 'headache', field: 'onset_type', value: 'sudden', quote: 'suddenly' },     // not in the words → interpretation
      { complaint: 'new', concept: 'headache', label: 'headache', field: 'pattern', value: 'sometimes-ish', quote: 'this morning' }, // not an allowed value
      { complaint: 'new', concept: 'headache', field: 'regions', value: ['head', 'kidney'], quote: 'headache' },
    ],
    question: { complaint: 'new', field: 'location', text: 'Where in your head do you feel it most?', options: ['Forehead', 'Back of the head', 'Not sure'] },
    urgent: false,
  };
  const t = applyAI(t0.rec, T(said), raw)!;
  assert.ok(t && t.ai);
  const c = t.rec.complaints[0];
  assert.equal(c.facts.severity?.prov, 'said'); assert.equal(c.facts.onset?.quote, 'since this morning');
  assert.equal(c.facts.onset_type?.prov, 'inferred'); assert.equal(c.facts.onset_type?.confirmed, false);
  assert.equal(c.facts.pattern, undefined);
  assert.deepEqual(c.regions.map((r) => r.id), ['head']);
  assert.equal(t.rec.pending?.kind, 'confirm', 'the interpretation is checked with the patient before anything else');
  assert.match(t.say[0], /so sorry/);
  const yes = ruleTurn(t.rec, { kind: 'option', id: 'yes', label: 'Yes', via: 'touch' });
  assert.equal(yes.rec.complaints[0].facts.onset_type?.confirmed, true);
  assert.match(summaryLines(yes.rec, 'en').join('\n'), /interpretation you confirmed/);
});

test('AI turn: a reply that diagnoses or falsely reassures is refused (rules are used instead)', () => {
  const t0 = startConsult('en');
  assert.equal(applyAI(t0.rec, T('I have a headache'), { reply: 'It sounds like a migraine, take some paracetamol.', updates: [] }), null);
  assert.equal(applyAI(t0.rec, T('I have a headache'), { reply: "Don't worry, it is nothing serious.", updates: [] }), null);
  assert.equal(guardReply('I am sorry you feel this way. When did it start?'), 'I am sorry you feel this way. When did it start?');
});

test('AI turn: urgency can be added by the AI but never removed; a question about known facts is replaced', () => {
  const t0 = ruleTurn(startConsult('en').rec, T('I have a headache since this morning'));
  const t = applyAI(t0.rec, T('my chest is tight too'), { reply: 'Thank you for telling me.', updates: [], urgent: false, question: { complaint: 'c1', field: 'onset', text: 'When did it start?', options: ['Today'] } })!;
  assert.ok(t.urgent.includes('chest pain or pressure'), 'rules still flag it although the AI said urgent: false');
  assert.notEqual(t.rec.pending?.slot, 'onset', 'the AI may not re-ask what the patient already said');
  const t2 = applyAI(t0.rec, T('I feel strange'), { reply: 'Thank you.', updates: [], urgent: true, urgent_reason: 'sudden confusion', question: null })!;
  assert.match(t2.urgent.join(), /AI safety check: sudden confusion/);
});

test('converse(): AI when it answers, honest fallback to rules when it does not', async () => {
  const rec = startConsult('en').rec;
  let prompt = '';
  const ok = await converse(rec, T('I have a stomach ache since yesterday'), async (p) => { prompt = p; return { reply: 'I am sorry your stomach hurts.', updates: [{ complaint: 'new', concept: 'abdominal_pain', label: 'stomach ache', field: 'onset', value: 'days', quote: 'since yesterday' }], question: { complaint: 'new', field: 'location', text: 'Which part of your belly hurts most?', options: ['Upper belly', 'Lower belly', 'Not sure'] } }; });
  assert.ok(prompt.startsWith(CONVERSE_PREFIX)); assert.match(prompt, /I have a stomach ache since yesterday/);
  assert.ok(ok.ai); assert.equal(ok.rec.ai.used, 1); assert.equal(ok.rec.complaints[0].concept, 'abdominal_pain');
  assert.deepEqual(ok.options.map((o) => o.label), ['Upper belly', 'Lower belly', 'Not sure']);
  const fb = await converse(rec, T('I have a stomach ache since yesterday'), async () => { throw new Error('network'); });
  assert.equal(fb.ai, false); assert.equal(fb.rec.ai.failed, 1); assert.equal(fb.rec.complaints[0].concept, 'abdominal_pain', 'rules still understood it');
  const none = await converse(rec, T('I have a stomach ache'), null);
  assert.equal(none.ai, false); assert.equal(none.rec.ai.failed, 0);
  assert.ok(buildPrompt(rec, T('x')).length < 12000);
});

test('AI turn never loses what the rules understood from the same words (body part, time), and never duplicates the symptom', async () => {
  // an AI answer that records "pain" but misses the knee and "since last week"
  const lazy = async () => ({ reply: 'I am sorry to hear that.', updates: [{ complaint: 'new', concept: 'pain', label: 'hurts', field: null, quote: 'hurts' }], question: { text: 'Where does it hurt?', complaint: 'new', field: 'location', options: [] } });
  const t = await converse(startConsult('en').rec, T('my knee hurts since last week'), lazy);
  assert.equal(t.rec.complaints.length, 1);
  const c = t.rec.complaints[0];
  assert.deepEqual(c.regions.map((r) => r.id), ['knee']); assert.equal(c.facts.onset?.value, 'week');
  assert.doesNotMatch(t.say.join(' '), /Where does it hurt/);
});


// ---------------------------------------------------------------- Arabic (restored)
test('1. "عندي صداع جامد" → headache, severe; follow-up is about the headache, never chest/back', () => {
  const t = talk('ar', ['عندي صداع جامد']);
  const c = t.rec.complaints[0];
  assert.equal(c.concept, 'headache'); assert.deepEqual(c.regions.map((r) => r.id), ['head']);
  assert.equal(c.facts.severity?.value, 'severe'); assert.equal(c.facts.severity?.quote, 'جامد');
  assert.equal(t.rec.pending?.complaint, c.id); assert.ok(['onset', 'onset_type', 'location'].includes(t.rec.pending!.slot!));
  assert.doesNotMatch(labels(t), /صدر|ضهر|chest|back/i);
  assert.match(t.say.join(' '), /سلامة|سلامتك/);
});

test('2. "راسي بتوجعني من الصبح" → headache since this morning (patient words kept)', () => {
  const t = talk('ar', ['راسي بتوجعني من الصبح']);
  const c = t.rec.complaints[0];
  assert.equal(c.concept, 'headache'); assert.equal(c.facts.onset?.value, 'today'); assert.equal(c.facts.onset?.quote, 'من الصبح');
  assert.equal(c.quote, 'راسي بتوجعني من الصبح');
  assert.equal(t.rec.pending?.slot, 'onset_type', 'onset is not asked again');
});

test('3. "بطني بتوجعني" → stomach pain; asks which part of the belly', () => {
  const t = talk('ar', ['بطني بتوجعني']);
  assert.equal(t.rec.complaints[0].concept, 'abdominal_pain');
  assert.equal(t.rec.pending?.slot, 'location');
  assert.match(labels(t), /فوق البطن/); assert.match(labels(t), /حوالين السرة/);
  const r = ruleTurn(t.rec, T('في الجنب اليمين'));
  assert.equal(r.rec.complaints[0].facts.location?.value, 'right'); assert.ok(r.rec.complaints[0].regions.some((x) => x.id === 'abdomen_r'));
});

test('vague: "حاسس إني مش طبيعي" gets an empathetic request for more, with simple options', () => {
  const t = talk('ar', ['حاسس إني مش طبيعي']);
  assert.equal(t.rec.pending?.kind, 'clarify_vague'); assert.match(t.say.join(' '), /سلامتك/); assert.match(labels(t), /دوخة/);
  const r = ruleTurn(t.rec, { kind: 'option', id: 'concept:dizziness', label: 'دوخة', via: 'touch' });
  assert.ok(r.rec.complaints.some((c) => c.concept === 'dizziness' && c.prov === 'chosen'));
});

test('language follows the patient: Arabic words switch replies to Arabic', () => {
  const t = talk('en', ['عندي كحة من امبارح']);
  assert.equal(t.rec.lang, 'ar'); assert.match(t.say.join(' '), /[؀-ۿ]/);
  assert.equal(understand('7 out of 10').number?.value, 7);
  assert.equal(understand('مفيش غثيان').concepts[0].negated, true);
});
