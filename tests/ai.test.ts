import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAI, guardSuggestions, guardWording, type SampleFn } from '../src/services/ai/AIAssist';
import { assessSafety } from '../src/services/safety';

const facts = ['Region: Right abdomen', 'Sensation: Pain', 'Pattern: Comes and goes'];

test('wording guard rejects added facts, numbers, body parts, sides and diagnosis language', () => {
  assert.equal(guardWording('Patient reports pain in the right abdomen that comes and goes.', facts), 'Patient reports pain in the right abdomen that comes and goes.');
  assert.equal(guardWording('Patient reports pain for 3 days in the right abdomen.', facts), null, 'invented number');
  assert.equal(guardWording('Patient reports pain in the right abdomen and knee.', facts), null, 'invented body part');
  assert.equal(guardWording('Patient reports pain in the left abdomen.', facts), null, 'wrong side');
  assert.equal(guardWording('Patient reports pain, likely appendicitis.', facts), null, 'diagnosis');
  assert.equal(guardWording('You should see a surgeon.', facts), null, 'advice');
  assert.equal(guardWording(42, facts), null);
});

test('suggestion guard keeps only grounded, allowed values', () => {
  const text = 'It started yesterday and it comes and goes, I feel sick';
  const out = guardSuggestions([
    { field: 'onset', value: '1–3 days ago', quote: 'yesterday' },
    { field: 'pattern', value: 'Comes and goes', quote: 'comes and goes' },
    { field: 'associated', value: 'Nausea', quote: 'feel sick' },
    { field: 'severity', value: 'Severe', quote: 'terrible pain' },     // quote not in text
    { field: 'diagnosis', value: 'Gastritis', quote: 'sick' },          // field not allowed
    { field: 'onset', value: '2 weeks', quote: 'yesterday' },           // value not allowed / duplicate
  ], text);
  assert.deepEqual(out.map((s) => s.field), ['onset', 'pattern', 'associated']);
  assert.ok(out.every((s) => s.by === 'ai'));
});

test('ClaudeAI: respects consent, falls back on errors, stops after a decline', async () => {
  let calls = 0; let consent = false; let mode: 'ok' | 'bad' | 'deny' = 'ok';
  const fake = Object.assign(async () => ({ text: '' }), {
    json: async (prompt: string) => {
      calls++;
      if (mode === 'deny') throw { code: 'not_granted', message: 'declined' };
      if (mode === 'bad') return { sentence: 'Patient reports pain, probably appendicitis.' };
      if (prompt.includes('"sentence"')) return { sentence: 'Patient reports pain in the right abdomen that comes and goes.' };
      return [];
    },
  }) as unknown as SampleFn;
  const ai = new ClaudeAI(fake, () => consent);
  assert.equal(await ai.wordMainConcern(facts), null, 'no consent, no call');
  assert.equal(calls, 0);
  consent = true;
  assert.equal(await ai.wordMainConcern(facts), 'Patient reports pain in the right abdomen that comes and goes.');
  mode = 'bad';
  assert.equal(await ai.wordMainConcern(facts), null, 'guard rejects diagnostic wording');
  mode = 'deny';
  assert.equal(await ai.wordMainConcern(facts), null);
  assert.equal(ai.state(true), 'declined');
  const before = calls;
  await ai.wordMessage(facts);
  assert.equal(calls, before, 'no more calls after the viewer declined');
});

test('safety: rules decide; AI can only add', () => {
  const base = { regionIds: ['knee_l'], sensations: ['pain' as const], details: {} };
  assert.equal(assessSafety(base).urgent, false);
  assert.equal(assessSafety({ ...base, associated: 'Fever, Trouble breathing' }).urgent, true);
  assert.equal(assessSafety({ ...base, aiHint: { concern: true, reason: 'says it is hard to breathe' } }).urgent, true);
  const ruleUrgent = { ...base, redFlags: ['breathing'] };
  assert.equal(assessSafety({ ...ruleUrgent, aiHint: { concern: false, reason: '' } }).urgent, true, 'AI "no concern" cannot remove a rule');
  assert.equal(assessSafety({ regionIds: ['chest'], sensations: ['pain'], details: {}, associated: 'Dizziness' }).urgent, true);
});
