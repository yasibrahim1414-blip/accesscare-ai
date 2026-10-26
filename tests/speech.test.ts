import { test } from 'node:test';
import assert from 'node:assert/strict';

import { V, state, spoken } from './support/speechStub';
import { bestVoice, speechChunks, speakable, Speaker, onlyBasicVoices } from '../src/services/voice/Speech';

test('voice choice: never a novelty/Eloquence voice; downloaded high-quality voices first; the patient’s choice wins', () => {
  state.voices = [V('Albert', 'en-US'), V('Eddy (English (US))', 'en-US'), V('Grandma (English (US))', 'en-US'), V('Samantha', 'en-US', { default: true })];
  assert.equal(bestVoice('en')?.name, 'Samantha');
  state.voices.push(V('Ava (Premium)', 'en-US'));
  assert.equal(bestVoice('en')?.name, 'Ava (Premium)');
  assert.equal(bestVoice('en', 'Albert')?.name, 'Albert', 'a voice the patient picked is respected');
  state.voices = [V('Microsoft Jenny Online (Natural) - English (United States)', 'en-US'), V('Microsoft David - English (United States)', 'en-US'), V('Google US English', 'en-US')];
  assert.match(bestVoice('en')!.name, /Jenny Online/);
  state.voices = [V('Eddy (English (US))', 'en-US')];
  assert.equal(onlyBasicVoices('en'), true);
});

test('spoken text: one item per message (no choppy splitting), symbols not read aloud, long text split at sentence ends', () => {
  assert.deepEqual(speechChunks(['Blind Mode is active. Welcome to AccessCare AI. I will guide you using voice.']), ['Blind Mode is active. Welcome to AccessCare AI. I will guide you using voice.']);
  assert.equal(speakable('✓ Seen ⭐ — Yes → confirmed 👍'), 'Seen, Yes confirmed');
  assert.equal(speakable('I am sorry — I will ask a question'), 'I am sorry, I will ask a question');
  const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a long reply.`).join(' ');
  const parts = speechChunks([long]);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 300 && /\.$/.test(p)));
});

test('playback: each message spoken once, in order, with the chosen voice and speed; stop ends it', async () => {
  state.voices = [V('Samantha', 'en-US'), V('Daniel', 'en-GB')];
  spoken.length = 0;
  const sp = new Speaker(() => {});
  await sp.speak(['Hello.', 'I am sorry you feel unwell.', 'When did it start?'], { lang: 'en', rate: 0.9 });
  assert.deepEqual(spoken.map((s) => [s.text, s.voice, s.rate]), [['Hello.', 'Samantha', 0.9], ['I am sorry you feel unwell.', 'Samantha', 0.9], ['When did it start?', 'Samantha', 0.9]]);
  spoken.length = 0;
  const p = sp.speak(['one', 'two', 'three'], { lang: 'en', rate: 1 });
  sp.stop(); await p;
  assert.ok(spoken.length <= 1, 'nothing more is spoken after stop');
});


// ---------------------------------------------------------------- Arabic (restored)
test('playback: each message spoken once, in order, with the right voice per language and the chosen speed; stop ends it', async () => {
  state.voices = [V('Samantha', 'en-US'), V('Majed', 'ar-001')];
  spoken.length = 0;
  const sp = new Speaker(() => {});
  await sp.speak(['Hello.', 'ألف سلامة عليك.', 'When did it start?'], { lang: 'ar', rate: 0.9 });
  assert.deepEqual(spoken.map((s) => [s.text, s.voice, s.rate]), [['Hello.', 'Samantha', 0.9], ['ألف سلامة عليك.', 'Majed', 0.9], ['When did it start?', 'Samantha', 0.9]]);
  spoken.length = 0;
  const p = sp.speak(['one', 'two', 'three'], { lang: 'en', rate: 1 });
  sp.stop(); await p;
  assert.ok(spoken.length <= 1, 'nothing more is spoken after stop');
});
