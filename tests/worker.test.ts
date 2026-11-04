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
    const st = await r.json(); assert.deepEqual(st, { version: 11, db: false, ai: true, model: 'claude-haiku-5-5', tts: true, ttsProvider: 'Azure AI Speech', ttsLangs: ['ar', 'en', 'fr', 'ur', 'hi'], stt: false, sttProvider: null });
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

test('worker v9: Whisper speech-to-text and Workers AI voices through the AI binding (no other account)', async () => {
  const calls: { model: string; input: any }[] = [];
  const mp3 = btoa(String.fromCharCode(...new Array(200).fill(0x49)));
  const AI = { run: async (model: string, input: any) => {
    calls.push({ model, input });
    if (model.includes('whisper')) return { text: '  nouvelle   consultation ' };
    if (model.startsWith('elevenlabs')) { if (input.language_code === 'hi') throw new Error('billing'); return { audio: mp3 }; }
    if (model.includes('melotts')) return { audio: mp3 };
    throw new Error('unknown');
  } };
  const e = { ...env, AI };
  const post = (path: string, body: unknown) => new Request(`https://w${path}`, { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const st = await (await worker.fetch(new Request('https://w/status', { headers: { origin: 'https://app.example' } }), e)).json();
  assert.equal(st.stt, true); assert.equal(st.tts, true); assert.equal(st.ttsProvider, 'Cloudflare Workers AI');
  assert.deepEqual(st.ttsLangs.sort(), ['ar', 'en', 'fr', 'hi'], 'Urdu is not offered by these voices (the device voice is used)');
  // speech to text
  let r = await worker.fetch(post('/stt', { audio: 'data:audio/webm;base64,' + btoa('abc'), lang: 'fr' }), e);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { text: 'nouvelle consultation' });
  assert.equal(calls[0].model, '@cf/openai/whisper-large-v3-turbo'); assert.equal(calls[0].input.language, 'fr'); assert.equal(calls[0].input.audio, btoa('abc'));
  assert.equal((await worker.fetch(post('/stt', { audio: 'not base64 !!' }), e)).status, 400);
  assert.equal((await worker.fetch(post('/stt', { audio: 'A'.repeat(2_000_004) }), e)).status, 400, 'size limit');
  assert.equal((await worker.fetch(post('/stt', { audio: btoa('abc') }), env)).status, 501, 'no binding → the browser keeps its own recognizer');
  // voices
  r = await worker.fetch(post('/tts', { text: 'مرحبا', lang: 'ar' }), e);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.equal((await r.arrayBuffer()).byteLength, 200);
  assert.equal(calls.at(-1)!.model, 'elevenlabs/eleven-multilingual-v2'); assert.equal(calls.at(-1)!.input.language_code, 'ar');
  r = await worker.fetch(post('/tts', { text: 'Bonjour', lang: 'fr' }), e); assert.equal(r.status, 200);
  r = await worker.fetch(post('/tts', { text: 'नमस्ते', lang: 'hi' }), e);
  assert.equal(r.status, 502, 'provider failed → the app falls back to the device voice');
  r = await worker.fetch(post('/tts', { text: 'سلام', lang: 'ur' }), e); assert.equal(r.status, 501);
});

test('AI answers: fenced, wrapped or cut-off JSON is read safely (complete items kept, the unfinished one dropped)', async () => {
  // @ts-ignore plain JS module
  const w = await import('../server/cloudflare-worker.mjs');
  const { extractJson: app } = await import('../src/services/ai/json');
  const full = { considerations: [{ title: 'Migraine to evaluate', supporting: ['F1'] }, { title: 'Tension-type headache', supporting: ['F2'] }], next_steps: [{ text: 'Ask about aura', supporting: ['F1'] }] };
  const cut = JSON.stringify(full).slice(0, JSON.stringify(full).indexOf('Tension') + 8); // stops inside the 2nd item
  for (const fn of [w.extractJson, app]) {
    assert.deepEqual(fn('```json\n' + JSON.stringify(full) + '\n```'), full);
    assert.deepEqual(fn('Here is the JSON: ' + JSON.stringify(full) + ' Hope this helps {not json}'), full);
    assert.deepEqual(fn(cut), { considerations: [{ title: 'Migraine to evaluate', supporting: ['F1'] }] }, 'cut off: only the complete item is kept');
    assert.equal(fn('I cannot help with that.'), null);
    assert.equal(fn(''), null);
    assert.deepEqual(fn('{"a":"he said \\"no, not}\\" ok","b":[1,2'), { a: 'he said "no, not}" ok', b: [1] }, 'brackets and quotes inside strings do not confuse it');
  }
  // the worker says why when nothing could be read
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Sure, here' }] }), { status: 200 })) as typeof fetch;
  try {
    const r = await w.default.fetch(new Request('https://w/ai', { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'You support a licensed doctor reviewing a patient-approved symptom report. x', max_tokens: 9000 }) }), env);
    const b = await r.json(); assert.equal(b.json, null); assert.equal(b.stop, 'max_tokens');
  } finally { globalThis.fetch = orig; }
});

test('worker v11: the downloaded app on the person’s own computer (localhost) is allowed; other sites are not', async () => {
  const st = (origin: string) => worker.fetch(new Request('https://w/status', { headers: { origin } }), env).then((r: Response) => r.status);
  assert.equal(await st('http://localhost:8000'), 200);
  assert.equal(await st('http://127.0.0.1:5500'), 200);
  assert.equal(await st('http://localhost.evil.example'), 403);
  assert.equal(await st('https://evil.example'), 403);
  assert.equal(await st('null'), 403, 'a page opened as a file (or a sandboxed frame) is not allowed by default');
});
