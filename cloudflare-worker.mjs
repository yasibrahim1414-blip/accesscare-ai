// AccessCare AI — server proxy for the web version (Cloudflare Worker).
//
// Why: the web app on GitHub Pages cannot hold an API key (anyone could read
// it). This worker keeps keys as Cloudflare secrets and forwards only
// AccessCare's own requests.
//
//   POST /        → Claude (only AccessCare's fixed prompts; size-limited; a photo only for the medicine-package reader)
//   POST /tts     → natural speech (optional; mp3): Azure AI Speech if configured, otherwise Cloudflare Workers AI
//   POST /stt     → speech to text with Whisper on Cloudflare Workers AI (optional; for browsers that can't do it themselves)
//   POST /fda     → FDA drug label lookup by generic name (openFDA; only a medicine name is sent)
//   POST /db      → shared storage for the web version (optional; needs a D1 database bound to this worker; v12 finds it under any variable name, DB is the usual one).
//                   Stores only what the app already encrypted end to end; each account writes only its own paths.
//   GET  /status  → which services are configured (no secrets)
//
// Setup (Cloudflare dashboard → Workers & Pages → your worker → Edit code → paste this file → Deploy):
//   Settings → Variables and Secrets:
//     ANTHROPIC_API_KEY    (Secret)  your Claude API key
//     ALLOWED_ORIGINS      (Text, optional) defaults to https://yasibrahim1414-blip.github.io
//   optional, for the natural voice:
//     AZURE_SPEECH_KEY     (Secret)  key of an Azure "Speech" resource
//     AZURE_SPEECH_REGION  (Text)    its region, e.g. uaenorth or westeurope
//     TTS_VOICE_AR / _EN / _FR / _UR / _HI (Text) voice names (defaults ar-EG-SalmaNeural, en-US-JennyNeural,
//     fr-FR-DeniseNeural, ur-PK-UzmaNeural, hi-IN-SwaraNeural)
//   optional, for listening in every browser and natural voices without any other account:
//     Settings → Bindings → Add → Workers AI → Variable name: AI → Deploy.
//     Speech to text: Whisper (all five languages). Voices: ElevenLabs multilingual v2 (English, Arabic, French, Hindi)
//     and MeloTTS (English, French) through Workers AI. Audio is turned into text and not stored here.
//     TTS_ELEVEN_VOICE (Text, optional) another ElevenLabs voice id. WORKERS_AI_TTS = off (Text) keeps listening but not the voices.
//   optional: MODEL (default claude-haiku-5-5)
//   optional, to sync patients and doctors across devices on the website:
//     Settings → Bindings → Add → D1 database → Variable name: DB → choose (or create) a database → Deploy.
//     The tables are created automatically on first use.
// Set spending limits in the Anthropic console (and Azure): the origin check stops
// other websites, but not someone calling this URL directly.

const PREFIXES = [
  'You help a patient who has trouble expressing symptoms.',
  'Write ONE short, plain sentence (max 30 words) for a doctor',
  'A patient who cannot type built a message for their doctor',
  'Safety screen for a symptom-reporting app.',
  'A blind patient is answering a question by voice',
  'You are a calm voice assistant helping a blind patient',
  'You are the voice of AccessCare AI',
  'You are AccessCare AI, a warm medical communication assistant',
  'You support a licensed doctor reviewing a patient-approved symptom report.',
  'You read the printed text on a photo of a medicine package for AccessCare AI.',
  'You are the AccessCare AI visit interpreter.',
];
const VISION = 'You read the printed text on a photo of a medicine package for AccessCare AI.';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_B64 = 1_600_000; // about 1.2 MB of image
const CLINICAL = 'You support a licensed doctor reviewing a patient-approved symptom report.';
const MAX_PROMPT = 12000;
const VERSION = 12; // the app checks this to tell you when the worker code is out of date
const MAX_TTS = 1500;
const MAX_AUDIO_B64 = 2_000_000; // about 1.5 MB of recorded speech (a short answer)
const LANGS = ['ar', 'en', 'fr', 'ur', 'hi'];

const DEFAULT_ORIGINS = ['https://yasibrahim1414-blip.github.io'];
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'];

/** The Claude key, whatever name it was saved under, without stray spaces, quotes or line breaks from pasting. */
export function apiKey(env) {
  const raw = env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY || env.CLAUDE_API_KEY || env.API_KEY || '';
  return String(raw).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}

// the app running from a local web server on the person's own computer (the downloaded files)
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
function cors(origin, allowed) {
  const ok = allowed.includes('*') || allowed.includes(origin) || LOCAL.test(origin);
  return { ok, headers: { 'Access-Control-Allow-Origin': ok ? origin || '*' : 'null', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-ac-auth', 'Vary': 'Origin' } };
}
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });

/** First JSON object or array in the model's text. A cut-off answer keeps its complete items (src/services/ai/json.ts has the same function). */
export function extractJson(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  const s = t.slice(start);
  const stack = []; const cuts = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) { try { return JSON.parse(s.slice(0, i + 1)); } catch { return null; } }
      cuts.push({ at: i + 1, closers: [...stack].reverse().join('') });
    } else if (ch === ',') cuts.push({ at: i, closers: [...stack].reverse().join('') });
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 60; k--) {
    try { return JSON.parse(s.slice(0, cuts[k].at) + cuts[k].closers); } catch { /* earlier */ }
  }
  return null;
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function ssml(text, lang, rate, env) {
  const voice = {
    ar: env.TTS_VOICE_AR || 'ar-EG-SalmaNeural', en: env.TTS_VOICE_EN || 'en-US-JennyNeural', fr: env.TTS_VOICE_FR || 'fr-FR-DeniseNeural',
    ur: env.TTS_VOICE_UR || 'ur-PK-UzmaNeural', hi: env.TTS_VOICE_HI || 'hi-IN-SwaraNeural',
  }[lang] || env.TTS_VOICE_EN || 'en-US-JennyNeural';
  const locale = voice.split('-').slice(0, 2).join('-');
  const pct = Math.round((Math.min(1.6, Math.max(0.6, Number(rate) || 1)) - 1) * 100);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${xml(voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${xml(text)}</prosody></voice></speak>`;
}

// ================================================================ shared storage (/db)
// Accounts: the app derives an id and a secret from the login name and password on the device;
// the server keeps only a hash of the secret. Documents are the app's own encrypted records.
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 300_000;
const OWNED = ['pat', 'doc', 'cg'];
const validPath = (p, even) => { const s = String(p || '').split('/'); return s.length >= 1 && s.length <= 16 && s.every((x) => SEG.test(x) && x !== '.' && x !== '..') && (s.length % 2 === 0) === even; };
const owns = (uid, path) => { const s = path.split('/'); if (s[0] === 'data' && s[1] === 'users') return s[2] === uid; if (OWNED.includes(s[0])) return s[1] === uid; return false; };
const mayRead = (uid, path) => { const s = path.split('/'); return !(s[0] === 'data' && s[1] === 'users') || s[2] === uid; };
async function sha256hex(text) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function sameText(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function matches(data, where) {
  for (const [f, op, v] of where) {
    const x = data?.[f];
    if (op === '==' ? x !== v : op === '!=' ? x === v : op === 'array-contains' ? !(Array.isArray(x) && x.includes(v)) : op === 'in' ? !(Array.isArray(v) && v.includes(x)) : true) return false;
  }
  return true;
}

/** The D1 database: the binding named DB, or (version 12) any D1 database bound to this worker under another name. */
function findDb(env) {
  if (env.DB) return { db: env.DB, name: 'DB' };
  for (const [name, v] of Object.entries(env || {})) {
    if (v && typeof v === 'object' && typeof v.prepare === 'function' && typeof v.batch === 'function' && typeof v.exec === 'function') return { db: v, name };
  }
  return null;
}
// in-memory store: only for local tests (env.MEMORY_DB === '1'); a real deployment uses D1
const mem = { docs: new Map(), auth: new Map(), seq: 0 };
export function __resetMemoryDb() { mem.docs.clear(); mem.auth.clear(); mem.seq = 0; }
const memStore = {
  async init() {},
  async get(path) { const d = mem.docs.get(path); return d ? d.data : null; },
  async put(path, coll, data) { mem.docs.set(path, { coll, data }); mem.seq++; },
  async del(path) { mem.docs.delete(path); mem.seq++; },
  async list(coll) { return [...mem.docs.entries()].filter(([, d]) => d.coll === coll).map(([path, d]) => ({ path, data: d.data })); },
  async seq() { return mem.seq; },
  async auth(uid) { return mem.auth.get(uid) ?? null; },
  async setAuth(uid, v1, v2) { mem.auth.set(uid, { v1, v2 }); },
  async delAuth(uid) { mem.auth.delete(uid); },
};
let d1Ready = false;
const d1Store = (DB) => ({
  async init() {
    if (d1Ready) return;
    await DB.batch([
      DB.prepare('CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll)'),
      DB.prepare('CREATE TABLE IF NOT EXISTS auth (uid TEXT PRIMARY KEY, v1 TEXT NOT NULL, v2 TEXT)'),
      DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
      DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)"),
    ]);
    d1Ready = true;
  },
  async get(path) { const r = await DB.prepare('SELECT data FROM docs WHERE path = ?').bind(path).first(); return r ? JSON.parse(r.data) : null; },
  async put(path, coll, data) { await DB.batch([DB.prepare('INSERT INTO docs (path, coll, data) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data').bind(path, coll, JSON.stringify(data)), DB.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'")]); },
  async del(path) { await DB.batch([DB.prepare('DELETE FROM docs WHERE path = ?').bind(path), DB.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'")]); },
  async list(coll) { const r = await DB.prepare('SELECT path, data FROM docs WHERE coll = ? LIMIT 3000').bind(coll).all(); return (r.results || []).map((x) => ({ path: x.path, data: JSON.parse(x.data) })); },
  async seq() { const r = await DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first(); return r ? r.v : 0; },
  async auth(uid) { return await DB.prepare('SELECT v1, v2 FROM auth WHERE uid = ?').bind(uid).first(); },
  async setAuth(uid, v1, v2) { await DB.prepare('INSERT INTO auth (uid, v1, v2) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET v1 = excluded.v1, v2 = excluded.v2').bind(uid, v1, v2 ?? null).run(); },
  async delAuth(uid) { await DB.prepare('DELETE FROM auth WHERE uid = ?').bind(uid).run(); },
});

export async function handleDb(request, body, env, headers) {
  const found = findDb(env);
  const store = found ? d1Store(found.db) : env.MEMORY_DB === '1' ? memStore : null;
  if (!store) return json({ error: 'db_not_configured' }, 501, headers);
  await store.init();
  const op = String(body?.op || '');
  const uid = String(body?.uid || '');
  // account registration: the first device to claim an id sets its secret hash
  if (op === 'register') {
    if (!/^w[0-9a-f]{30}$/.test(uid) || typeof body.secret !== 'string' || body.secret.length < 20) return json({ error: 'bad_request' }, 400, headers);
    if (await store.auth(uid)) return json({ error: 'taken' }, 409, headers);
    await store.setAuth(uid, await sha256hex(body.secret), null);
    return json({ ok: true }, 200, headers);
  }
  // every other call is authenticated: x-ac-auth: <uid>.<secret>
  const [aUid, secret] = String(request.headers.get('x-ac-auth') || '').split('.');
  const rec = aUid ? await store.auth(aUid) : null;
  const h = secret ? await sha256hex(secret) : '';
  const viaMain = !!rec && sameText(h, rec.v1);
  const viaRecovery = !!rec && !!rec.v2 && sameText(h, rec.v2);
  if (!viaMain && !viaRecovery) return json({ error: 'unauthenticated' }, 401, headers);
  const me = aUid;
  if (op === 'seq') return json({ seq: await store.seq() }, 200, headers);
  if (op === 'auth-recovery') { if (!viaMain) return json({ error: 'forbidden' }, 403, headers); await store.setAuth(me, rec.v1, typeof body.verifier === 'string' ? await sha256hex(body.verifier) : null); return json({ ok: true }, 200, headers); }
  if (op === 'auth-set') { if (typeof body.secret !== 'string' || body.secret.length < 20) return json({ error: 'bad_request' }, 400, headers); await store.setAuth(me, await sha256hex(body.secret), null); return json({ ok: true }, 200, headers); }
  if (op === 'auth-delete') { if (!viaMain) return json({ error: 'forbidden' }, 403, headers); await store.delAuth(me); return json({ ok: true }, 200, headers); }
  if (op === 'get') {
    const path = String(body.path || '');
    if (!validPath(path, true)) return json({ error: 'invalid_argument' }, 400, headers);
    return json({ data: mayRead(me, path) ? await store.get(path) : null }, 200, headers);
  }
  if (op === 'query') {
    const coll = String(body.coll || '');
    if (!validPath(coll, false)) return json({ error: 'invalid_argument' }, 400, headers);
    if (!mayRead(me, coll + '/x')) return json({ docs: [] }, 200, headers);
    const where = Array.isArray(body.where) ? body.where.slice(0, 10).filter((w) => Array.isArray(w) && w.length === 3) : [];
    const limit = Math.min(1000, Math.max(1, Number(body.limit) || 500));
    const docs = (await store.list(coll)).filter((d) => matches(d.data, where)).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, limit).map((d) => ({ id: d.path.split('/').pop(), data: d.data }));
    return json({ docs }, 200, headers);
  }
  if (op === 'set' || op === 'update' || op === 'delete') {
    const path = String(body.path || '');
    if (!validPath(path, true) || !owns(me, path)) return json({ error: 'invalid_argument', message: 'write denied' }, 403, headers);
    if (!viaMain && !path.startsWith(`data/users/${me}/`)) return json({ error: 'invalid_argument', message: 'recovery may only change the account record' }, 403, headers);
    const coll = path.split('/').slice(0, -1).join('/');
    if (op === 'delete') { await store.del(path); return json({ ok: true }, 200, headers); }
    const data = body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'invalid_argument' }, 400, headers);
    let next = data;
    if (op === 'update') { const cur = await store.get(path); if (!cur) return json({ error: 'invalid_argument', message: 'update of missing doc' }, 404, headers); next = { ...cur, ...data }; }
    if (JSON.stringify(next).length > MAX_DOC) return json({ error: 'invalid_argument', message: 'too large' }, 413, headers);
    await store.put(path, coll, next);
    return json({ ok: true }, 200, headers);
  }
  return json({ error: 'bad_request' }, 400, headers);
}

// ================================================================ Workers AI speech (optional binding env.AI)
const ELEVEN = 'elevenlabs/eleven-multilingual-v2';
const ELEVEN_LANGS = ['en', 'ar', 'fr', 'hi'];
const MELO_LANGS = ['en', 'fr'];
const azureOn = (env) => !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
/** languages the server can speak, best provider first */
export function ttsPlan(env) {
  if (azureOn(env)) return { provider: 'Azure AI Speech', langs: [...LANGS] };
  if (env.AI && env.WORKERS_AI_TTS !== 'off') return { provider: 'Cloudflare Workers AI', langs: [...new Set([...ELEVEN_LANGS, ...MELO_LANGS])] };
  return { provider: null, langs: [] };
}
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
/** audio from a Workers AI answer, whatever shape it comes in (base64, bytes, stream, or a URL) */
async function audioOf(r) {
  if (!r) return null;
  if (r instanceof ReadableStream || r instanceof ArrayBuffer || r instanceof Uint8Array) return new Response(r).arrayBuffer();
  const a = r.audio ?? r.result?.audio;
  if (typeof a === 'string') {
    if (/^https?:\/\//.test(a)) { const f = await fetch(a); return f.ok ? f.arrayBuffer() : null; }
    return b64ToBytes(a.replace(/^data:audio\/[a-z0-9.+-]+;base64,/, '')).buffer;
  }
  if (a instanceof ReadableStream || a instanceof ArrayBuffer || a instanceof Uint8Array) return new Response(a).arrayBuffer();
  return null;
}
async function workersAiSpeech(env, text, lang) {
  const tries = [];
  if (ELEVEN_LANGS.includes(lang)) tries.push(() => env.AI.run(ELEVEN, { text, voice_id: env.TTS_ELEVEN_VOICE || 'JBFqnCBsd6RMkjVDRZzb', language_code: lang, output_format: 'mp3_44100_128' }));
  if (MELO_LANGS.includes(lang)) tries.push(() => env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang }));
  for (const t of tries) {
    try { const buf = await audioOf(await t()); if (buf && buf.byteLength > 100) return buf; } catch { /* next provider */ }
  }
  return null;
}
async function transcribe(env, audioB64, lang) {
  const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: audioB64, task: 'transcribe', vad_filter: true, ...(LANGS.includes(lang) ? { language: lang } : {}) });
  const text = typeof r?.text === 'string' ? r.text : Array.isArray(r?.segments) ? r.segments.map((x) => x.text).join(' ') : '';
  return text.replace(/\s+/g, ' ').trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = [...DEFAULT_ORIGINS, ...String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)];
    const c = cors(origin, allowed);
    if (request.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (!c.ok) return json({ error: 'origin_not_allowed' }, 403, c.headers);

    if (url.pathname.endsWith('/status') && request.method === 'GET') {
      return json({ version: VERSION, db: !!findDb(env) || env.MEMORY_DB === '1', dbBinding: findDb(env)?.name ?? null, ai: !!apiKey(env), model: env.MODEL || 'claude-haiku-5-5', tts: ttsPlan(env).langs.length > 0, ttsProvider: ttsPlan(env).provider, ttsLangs: ttsPlan(env).langs, stt: !!env.AI, sttProvider: env.AI ? 'Whisper (Cloudflare Workers AI)' : null }, 200, c.headers);
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405, c.headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c.headers); }

    if (url.pathname.endsWith('/db')) return handleDb(request, body, env, c.headers);

    if (url.pathname.endsWith('/stt')) {
      if (!env.AI) return json({ error: 'stt_not_configured' }, 501, c.headers);
      const audio = typeof body?.audio === 'string' ? body.audio.replace(/^data:[^,]*,/, '') : '';
      if (!audio || audio.length > MAX_AUDIO_B64 || !/^[A-Za-z0-9+/=]+$/.test(audio)) return json({ error: 'bad_audio' }, 400, c.headers);
      try { return json({ text: await transcribe(env, audio, body?.lang) }, 200, c.headers); } catch { return json({ error: 'stt_upstream' }, 502, c.headers); }
    }

    if (url.pathname.endsWith('/tts')) {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TTS) return json({ error: 'bad_text' }, 400, c.headers);
      const lang = LANGS.includes(body?.lang) ? body.lang : 'en';
      if (!azureOn(env)) {
        if (!env.AI || !ttsPlan(env).langs.includes(lang)) return json({ error: 'tts_not_configured' }, 501, c.headers);
        const buf = await workersAiSpeech(env, text, lang);
        if (!buf) return json({ error: 'tts_upstream' }, 502, c.headers);
        return new Response(buf, { status: 200, headers: { ...c.headers, 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
      }
      const r = await fetch(env.AZURE_TTS_URL || `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'accesscare-ai' },
        body: ssml(text, lang, body?.rate, env),
      });
      if (!r.ok) return json({ error: 'tts_upstream', status: r.status }, 502, c.headers);
      return new Response(r.body, { status: 200, headers: { ...c.headers, 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
    }

    if (url.pathname.endsWith('/fda')) {
      const g = typeof body?.generic === 'string' ? body.generic.trim().toLowerCase() : '';
      if (!/^[a-z][a-z0-9 \-]{2,48}$/.test(g)) return json({ error: 'bad_name' }, 400, c.headers);
      const base = env.OPENFDA_URL || 'https://api.fda.gov';
      for (const extra of ['+AND+openfda.product_type:%22HUMAN+PRESCRIPTION+DRUG%22', '']) {
        const r = await fetch(`${base}/drug/label.json?search=openfda.generic_name:%22${encodeURIComponent(g)}%22${extra}&limit=1`);
        if (r.status === 404) continue;
        if (!r.ok) return json({ error: 'fda_upstream', status: r.status }, 502, c.headers);
        const d = await r.json();
        if (d?.results?.[0]) return json({ label: d.results[0] }, 200, c.headers);
      }
      return json({ label: null }, 200, c.headers);
    }

    const key = apiKey(env);
    if (!key) return json({ error: 'not_configured' }, 500, c.headers);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt) return json({ error: 'prompt_not_allowed' }, 400, c.headers);
    if (prompt.length > MAX_PROMPT) return json({ error: 'prompt_too_long' }, 400, c.headers);
    if (!PREFIXES.some((p) => prompt.startsWith(p))) return json({ error: 'prompt_not_allowed' }, 400, c.headers);
    let image = null;
    if (body?.image) {
      const t = String(body.image.media_type || ''); const d = String(body.image.data || '');
      if (!prompt.startsWith(VISION)) return json({ error: 'image_not_allowed' }, 400, c.headers);
      if (!IMAGE_TYPES.includes(t) || !/^[A-Za-z0-9+/=]+$/.test(d) || d.length > MAX_IMAGE_B64) return json({ error: 'bad_image' }, 400, c.headers);
      image = { type: 'image', source: { type: 'base64', media_type: t, data: d } };
    }
    const maxTokens = Math.min(prompt.startsWith(CLINICAL) ? 3200 : 1200, Math.max(100, Number(body?.max_tokens) || 400));
    // try the configured model first, then the others, so an unavailable model name never breaks the app
    const models = [...new Set([env.MODEL, ...MODELS].filter(Boolean))];
    let r = null; let detail = '';
    for (const model of models) {
      r = await fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          system: 'You are part of a healthcare communication app. Follow the instructions in the user message exactly and reply with only the JSON it asks for.',
          messages: [{ role: 'user', content: image ? [image, { type: 'text', text: prompt }] : prompt }],
        }),
      });
      if (r.ok) break;
      // Anthropic's own error message (e.g. invalid key, low credit, unknown model) — no secrets in it
      detail = '';
      try { const e = await r.json(); detail = String(e?.error?.message ?? '').slice(0, 200); } catch { /* */ }
      const modelProblem = r.status === 404 || (r.status === 400 && /model/i.test(detail));
      if (!modelProblem) break;
    }
    // 403 'Request not allowed' usually means Anthropic refused the place the worker ran from (request.cf.colo)
    if (!r.ok) return json({ error: 'upstream', status: r.status, detail, colo: request.cf?.colo ?? null }, 502, c.headers);
    const data = await r.json();
    const text = (data?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    const parsed = extractJson(text);
    // when no JSON could be read, say why (cut off at the length limit, or plain text) so the app can show it
    return json(parsed === null ? { json: null, stop: data?.stop_reason ?? null, text: text.slice(0, 300) } : { json: parsed, ...(data?.stop_reason === 'max_tokens' ? { stop: 'max_tokens' } : {}) }, 200, c.headers);
  },
};
