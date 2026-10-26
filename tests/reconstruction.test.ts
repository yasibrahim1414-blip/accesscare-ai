import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  build, nextQuestion, applyAnswer, correct, remove, restore, metrics, buildBrief, briefText, extractByRules, addSuggestions, markUnsure,
  type CaptureInput,
} from '../src/services/intent/ReconstructionEngine';
import { DEFAULT_PREFERENCES } from '../src/domain/types';

const P = DEFAULT_PREFERENCES;
const runAll = (input: CaptureInput, rec = build(input), answer: (q: ReturnType<typeof nextQuestion>) => any = () => ({ type: 'skip' })) => {
  const asked: string[] = [];
  for (let i = 0; i < 20; i++) {
    const q = nextQuestion(rec, P, input);
    if (!q) break;
    asked.push(q.id);
    rec = applyAnswer(rec, q, answer(q), input);
  }
  return { rec, asked };
};

test('spec example: right abdomen, intermittent — asks only what is missing, invents nothing', () => {
  const input: CaptureInput = { regionIds: ['abdomen_r'], sensations: ['pain'], details: { pattern: 'comes_and_goes' } };
  const { rec, asked } = runAll(input);
  assert.ok(!asked.includes('q_pattern'), 'pattern already given, must not be asked');
  assert.ok(asked.includes('q_onset') && asked.includes('q_severity') && asked.includes('q_assoc') && asked.includes('q_context'));
  assert.equal(new Set(asked).size, asked.length, 'no question asked twice');
  const brief = buildBrief(rec);
  const text = briefText(brief);
  assert.match(text, /Selected body regions: Right abdomen/);
  assert.match(text, /Frequency and pattern: Comes and goes/);
  assert.match(text, /Onset and duration: Not specified \[unknown\]/);
  assert.doesNotMatch(text, /\b\d+ (day|hour|week)s?\b/, 'no invented duration');
  const m = metrics(rec);
  assert.equal(m.stillMissing, 3); // onset, severity, associated skipped
  assert.equal(m.missingResolved, 0);
});

test('free-text suggestions are grounded, need confirmation, and can be rejected', () => {
  const input: CaptureInput = { regionIds: ['forearm_l'], sensations: ['numbness'], details: { description: 'It started yesterday and comes and goes' } };
  const sugg = extractByRules(input.details.description);
  assert.deepEqual(sugg.map((s) => [s.field, s.value]), [['onset', '1–3 days ago'], ['pattern', 'Comes and goes']]);
  let rec = build(input, [...sugg, { field: 'severity', value: '9 / 10', quote: 'excruciating', by: 'ai' }]);
  assert.equal(rec.items.find((i) => i.key === 'severity')!.status, 'unanswered', 'ungrounded AI suggestion dropped');
  assert.equal(rec.items.find((i) => i.key === 'onset')!.value, null, 'suggestion is not a value');
  let q = nextQuestion(rec, P, input)!;
  assert.equal(q.kind, 'suggestion');
  rec = applyAnswer(rec, q, { type: 'value', value: 'Yes' }, input); // accept onset
  q = nextQuestion(rec, P, input)!;
  rec = applyAnswer(rec, q, { type: 'value', value: 'No' }, input); // reject pattern
  const onset = rec.items.find((i) => i.key === 'onset')!;
  const pattern = rec.items.find((i) => i.key === 'pattern')!;
  assert.equal(onset.value, '1–3 days ago'); assert.equal(onset.source, 'patient_confirmed_suggestion');
  assert.equal(pattern.value, null); assert.equal(pattern.status, 'unanswered');
  q = nextQuestion(rec, P, input)!;
  assert.equal(q.id, 'q_pattern', 'after rejecting, the system asks directly');
  const m = metrics(rec);
  assert.deepEqual([m.suggestionsOffered, m.suggestionsAccepted, m.suggestionsRejected], [2, 1, 1]);
});

test('contradictions are detected, clarified, and stay on record', () => {
  const input: CaptureInput = { regionIds: ['knee_l'], sensations: ['pain', 'not_sure'], details: { pattern: 'constant', severity: 9, description: 'my right knee, it is mild and comes and goes' } };
  let rec = build(input);
  const ids = rec.contradictions.map((c) => c.id).sort();
  assert.deepEqual(ids, ['c_pattern', 'c_sensation', 'c_severity', 'c_side']);
  assert.equal(rec.items.find((i) => i.key === 'pattern')!.status, 'needs_clarification');
  const q = nextQuestion(rec, P, input)!;
  assert.equal(q.kind, 'contradiction');
  const { rec: done } = runAll(input, rec, (qq) => qq!.kind === 'contradiction' && qq!.id === 'q_c_pattern' ? { type: 'value', value: 'Comes and goes' } : { type: 'skip' });
  const c = done.contradictions.find((x) => x.id === 'c_pattern')!;
  assert.equal(c.status, 'clarified');
  assert.equal(done.items.find((i) => i.key === 'pattern')!.value, 'Comes and goes');
  const m = metrics(done);
  assert.equal(m.contradictionsDetected, 4);
  assert.equal(m.contradictionsClarified, 1);
  const text = briefText(buildBrief(done));
  assert.match(text, /Contradictions requiring clarification: .*LEFT side/);
});

test('verification edits: correct, remove, restore, unsure — all tracked', () => {
  const input: CaptureInput = { regionIds: ['wrist_r', 'hand_r'], sensations: ['tingling'], details: { onset: 'Today' } };
  let rec = build(input);
  rec = correct(rec, 'onset', '1–3 days ago', input);
  rec = remove(rec, 'region:hand_r', input);
  rec = markUnsure(rec, 'pattern', input);
  let m = metrics(rec);
  assert.equal(m.correctedByPatient, 1);
  assert.equal(m.removedByPatient, 1);
  const brief = buildBrief(rec);
  const text = briefText(brief);
  assert.match(text, /Changed when it began from “Today” to “1–3 days ago”/);
  assert.match(text, /Removed body region “Right hand”/);
  assert.match(text, /Frequency and pattern: Patient is not sure \[unknown\]/);
  assert.doesNotMatch(text.split('\n')[1], /Right hand/, 'removed region not listed as selected');
  rec = restore(rec, 'region:hand_r', input);
  m = metrics(rec);
  assert.equal(m.removedByPatient, 0);
  assert.equal(brief.sections[0].lines[0].provenance, 'template_wording');
  const ai = buildBrief(rec, { mainConcern: 'Tingling in the right wrist and hand.', wordedBy: 'ai' });
  assert.equal(ai.sections[0].lines[0].provenance, 'ai_wording');
  assert.match(briefText(ai), /\[wording by AI\]/);
});

test('yes/no-only preference converts questions; multi-select associated symptoms', () => {
  const input: CaptureInput = { regionIds: ['chest'], sensations: ['pain'], details: {} };
  const rec = build(input);
  const q = nextQuestion(rec, { ...P, multipleChoice: false, yesNoQuestions: true }, input)!;
  assert.equal(q.format, 'yes_no');
  let r2 = rec;
  for (let i = 0; i < 10; i++) {
    const qq = nextQuestion(r2, P, input);
    if (!qq) break;
    r2 = applyAnswer(r2, qq, qq.id === 'q_assoc' ? { type: 'value', value: 'Fever|Trouble breathing' } : { type: 'skip' }, input);
  }
  assert.equal(r2.items.find((i) => i.key === 'associated')!.value, 'Fever, Trouble breathing');
});

test('addSuggestions refuses suggestions for fields the patient already answered', () => {
  const input: CaptureInput = { regionIds: ['neck'], sensations: ['pain'], details: { onset: 'Today', description: 'since last week' } };
  const rec = build(input);
  addSuggestions(rec, [{ field: 'onset', value: 'About a week ago', quote: 'last week', by: 'rules' }]);
  assert.equal(rec.items.find((i) => i.key === 'onset')!.value, 'Today');
  assert.equal(rec.items.find((i) => i.key === 'onset')!.suggestion, undefined);
});
