import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import worker, { extractJson } from '../server/cloudflare-worker.mjs';

const env = { ANTHROPIC_API_KEY: 'k', ALLOWED_ORIGINS: 'https://app.example' };
const req = (body: unknown, origin = 'https://app.example') => new Request('https://w/ai', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Claude proxy: origin and prompt allow-lists, key stays server-side, JSON extracted', async () => {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Sure! {"reply": "Hello"}' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    let r = await worker.fetch(req({ prompt: 'You are the voice of AccessCare AI ... Patient said: "hi"' }, 'https://evil.example'), env);
    assert.equal(r.status, 403, 'other websites are refused');
    r = await worker.fetch(req({ prompt: 'Write me a poem about cats' }), env);
    assert.equal(r.status, 400, 'only AccessCare prompts are forwarded');
    r = await worker.fetch(req({ prompt: 'You are the voice of AccessCare AI' + 'x'.repeat(13000) }), env);
    assert.equal(r.status, 400, 'prompt size limit');
    r = await worker.fetch(req({ prompt: 'You are the voice of AccessCare AI. Patient said: "hi"' }), env);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { json: { reply: 'Hello' } });
    assert.equal(sent.length, 1, 'refused requests never reach the Claude API');
    assert.equal(sent[0].headers['x-api-key'], 'k'); assert.equal(sent[0].body.max_tokens, 400);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.equal((await worker.fetch(req({ prompt: 'You are the voice of AccessCare AI' }), { ALLOWED_ORIGINS: '*' })).status, 500, 'no key configured');
  } finally { globalThis.fetch = orig; }
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]); assert.equal(extractJson('no json'), null);
});

test('worker: conversation prompts, answer size, natural voice route and status (keys never returned)', async () => {
  // @ts-ignore plain JS module
  const { ssml } = await import('../server/cloudflare-worker.mjs');
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    if (String(url).includes('tts.speech.microsoft.com')) return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"reply":"ok"}' }] }), { status: 200 });
  }) as typeof fetch;
  const full = { ...env, AZURE_SPEECH_KEY: 'azure-secret', AZURE_SPEECH_REGION: 'uaenorth' };
  const post = (path: string, body: unknown) => new Request(`https://w${path}`, { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await worker.fetch(post('/', { prompt: 'You are AccessCare AI, a warm medical communication assistant. ...', max_tokens: 900 }), env);
    assert.equal(r.status, 200); assert.equal(JSON.parse(sent[0].body).max_tokens, 900);
    r = await worker.fetch(post('/', { prompt: 'You are AccessCare AI, a warm medical communication assistant. ...', max_tokens: 99999 }), env);
    assert.equal(JSON.parse(sent[1].body).max_tokens, 1200, 'answer size is capped');
    // status: tells which services exist, never the keys
    r = await worker.fetch(new Request('https://w/status', { headers: { origin: 'https://app.example' } }), full);
    const st = await r.json(); assert.deepEqual(st, { version: 6, ai: true, model: 'claude-haiku-5-5', tts: true, ttsProvider: 'Azure AI Speech', ttsLangs: ['en', 'ar'] });
    assert.doesNotMatch(JSON.stringify(st), /secret/);
    assert.equal((await (await worker.fetch(new Request('https://w/status', { headers: { origin: 'https://app.example' } }), env)).json()).tts, false);
    // tts
    r = await worker.fetch(post('/tts', { text: 'I am sorry you feel unwell', lang: 'en', rate: 1 }), env);
    assert.equal(r.status, 501, 'not configured → the app uses the device voice');
    r = await worker.fetch(post('/tts', { text: 'I am sorry <script>', lang: 'ar', rate: 0.9 }), full);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    const call = sent[sent.length - 1];
    assert.match(call.url, /uaenorth\.tts\.speech\.microsoft\.com/); assert.equal(call.headers['Ocp-Apim-Subscription-Key'], 'azure-secret');
    assert.match(call.body, /ar-EG-SalmaNeural/); assert.match(call.body, /&lt;script&gt;/); assert.match(call.body, /rate="-10%"/);
    r = await worker.fetch(post('/tts', { text: 'x'.repeat(2000), lang: 'en' }), full);
    assert.equal(r.status, 400, 'text size limit');
    r = await worker.fetch(new Request('https://w/tts', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), full);
    assert.equal(r.status, 403);
  } finally { globalThis.fetch = orig; }
  assert.match(ssml('Hello', 'en', 1.2, {}), /en-US-JennyNeural.*rate="\+20%"/s);
});

test('worker: clinical prompts allowed with a larger answer; /fda sends only a validated medicine name to openFDA', async () => {
  const sent: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push(String(url));
    if (String(url).includes('api.fda.gov')) return String(url).includes('PRESCRIPTION') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ results: [{ set_id: 's1' }] }), { status: 200 });
    void init;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"considerations":[]}' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await worker.fetch(req({ prompt: 'You support a licensed doctor reviewing a patient-approved symptom report. FACTS: ...', max_tokens: 5000 }), env);
    assert.equal(r.status, 200);
    const fr = await worker.fetch(new Request('https://w/ai/fda', { method: 'POST', headers: { origin: 'https://app.example' }, body: JSON.stringify({ generic: 'naproxen' }) }), env);
    assert.deepEqual(await fr.json(), { label: { set_id: 's1' } });
    const bad = await worker.fetch(new Request('https://w/ai/fda', { method: 'POST', headers: { origin: 'https://app.example' }, body: JSON.stringify({ generic: 'x"; drop' }) }), env);
    assert.equal(bad.status, 400);
    assert.ok(sent.filter((u) => u.includes('fda')).every((u) => /generic_name:%22naproxen%22/.test(u)));
  } finally { globalThis.fetch = orig; }
});

test('worker: a photo only for the medicine-box reader, type- and size-checked; interpreter prompts allowed', async () => {
  const sent: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"readable":true,"names":["Naproxen"]}' }] }), { status: 200 }); }) as typeof fetch;
  const img = { media_type: 'image/jpeg', data: 'QUJD' };
  const { boxPrompt } = await import('../src/services/care/boxReader');
  const { interpPrompt } = await import('../src/services/care/interpret');
  try {
    let r = await worker.fetch(req({ prompt: 'You are the voice of AccessCare AI. hi', image: img }), env);
    assert.equal(r.status, 400, 'no photo with other prompts');
    r = await worker.fetch(req({ prompt: boxPrompt(), image: { media_type: 'image/gif', data: 'QUJD' } }), env);
    assert.equal(r.status, 400, 'only jpeg/png/webp');
    r = await worker.fetch(req({ prompt: boxPrompt(), image: { media_type: 'image/jpeg', data: 'A'.repeat(1_700_000) } }), env);
    assert.equal(r.status, 400, 'size limit');
    r = await worker.fetch(req({ prompt: boxPrompt(), image: img }), env);
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    r = await worker.fetch(req({ prompt: interpPrompt('عندي صداع', 'ar', 'en', 'patient') }), env);
    assert.equal(r.status, 200, 'interpreter prompt accepted');
    assert.equal(typeof sent[1].messages[0].content, 'string', 'text-only request stays a string');
  } finally { globalThis.fetch = orig; }
});
