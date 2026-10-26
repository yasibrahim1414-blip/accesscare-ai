import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainAIError, checkAI } from '../src/services/ai/health';
import { startConsult } from '../src/services/conversation/Consult';
import { converse } from '../src/services/conversation/ai';

test('AI errors are explained in plain English with a fix', () => {
  assert.match(explainAIError('400 prompt_not_allowed').problem, /older version/);
  assert.match(explainAIError('500 not_configured').fix, /ANTHROPIC_API_KEY/);
  assert.match(explainAIError('403 origin_not_allowed').fix, /ALLOWED_ORIGINS/);
  assert.match(explainAIError('502 upstream 400 — Your credit balance is too low').problem, /credit/);
  assert.match(explainAIError('502 upstream 401 — invalid x-api-key').problem, /API key/);
  assert.match(explainAIError('502 upstream 404 — model: claude-x').problem, /model/);
  assert.match(explainAIError('network').problem, /cannot reach/);
});

test('connection test: old worker, missing key and a working one', async () => {
  const orig = globalThis.fetch;
  const sample = Object.assign(async () => ({ text: '' }), { json: async () => ({ reply: 'ok' }), remote: true }) as never;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ai: true, tts: false }), { status: 200 })) as typeof fetch;
    let h = await checkAI('https://w.example', sample); assert.equal(h.ok, false); assert.match((h as { problem: string }).problem, /older version/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: 3, ai: false }), { status: 200 })) as typeof fetch;
    h = await checkAI('https://w.example', sample); assert.match((h as { fix: string }).fix, /ANTHROPIC_API_KEY/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: 3, ai: true }), { status: 200 })) as typeof fetch;
    h = await checkAI('https://w.example', sample); assert.equal(h.ok, true);
    const failing = Object.assign(async () => ({ text: '' }), { json: async () => { throw Object.assign(new Error('x'), { code: 'unavailable', detail: '502 upstream 400 — Your credit balance is too low' }); }, remote: true }) as never;
    h = await checkAI('https://w.example', failing); assert.match((h as { problem: string }).problem, /credit/);
  } finally { globalThis.fetch = orig; }
});

test('without AI: greetings get a friendly reply and common typos are asked about, not ignored', async () => {
  const t0 = startConsult('en');
  const hi = await converse(t0.rec, { kind: 'text', text: 'hi' }, null);
  assert.match(hi.say.join(' '), /Hello/);
  const typo = await converse(hi.rec, { kind: 'text', text: 'I have hedeac' }, null);
  assert.match(typo.say.join(' '), /Did you mean a headache/i);
  const yes = await converse(typo.rec, { kind: 'text', text: 'yes' }, null);
  assert.ok(yes.rec.complaints.some((c) => /headache/i.test(c.concept)), JSON.stringify(yes.rec.complaints));
});
