// AccessCare AI — server proxy for the web version (Cloudflare Worker).
//
// Why: the web app on GitHub Pages cannot hold an API key (anyone could read
// it). This worker keeps keys as Cloudflare secrets and forwards only
// AccessCare's own requests.
//
//   POST /        → Claude (only AccessCare's fixed prompts; size-limited)
//   POST /tts     → natural speech from Azure AI Speech (optional; mp3)
//   POST /fda     → FDA drug label lookup by generic name (openFDA; only a medicine name is sent)
//   GET  /status  → which services are configured (no secrets)
//
// Setup (Cloudflare dashboard → Workers & Pages → your worker → Edit code → paste this file → Deploy):
//   Settings → Variables and Secrets:
//     ANTHROPIC_API_KEY    (Secret)  your Claude API key
//     ALLOWED_ORIGINS      (Text)    https://yasibrahim1414-blip.github.io
//   optional, for the natural voice:
//     AZURE_SPEECH_KEY     (Secret)  key of an Azure "Speech" resource
//     AZURE_SPEECH_REGION  (Text)    its region, e.g. uaenorth or westeurope
//     TTS_VOICE_EN (Text) voice name (default en-US-JennyNeural)
//   optional: MODEL (default claude-haiku-5-5)
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
];
const CLINICAL = 'You support a licensed doctor reviewing a patient-approved symptom report.';
const MAX_PROMPT = 12000;
const MAX_TTS = 1500;

function cors(origin, allowed) {
  const ok = allowed.includes('*') || allowed.includes(origin);
  return { ok, headers: { 'Access-Control-Allow-Origin': ok ? origin || '*' : 'null', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' } };
}
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });

/** First JSON object or array in the model's text. */
export function extractJson(text) {
  const t = String(text ?? '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  return null;
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

export function ssml(text, lang, rate, env) {
  const voice = env.TTS_VOICE_EN || 'en-US-JennyNeural';
  const locale = voice.split('-').slice(0, 2).join('-');
  const pct = Math.round((Math.min(1.6, Math.max(0.6, Number(rate) || 1)) - 1) * 100);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${xml(voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${xml(text)}</prosody></voice></speak>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const c = cors(origin, allowed);
    if (request.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (!c.ok) return json({ error: 'origin_not_allowed' }, 403, c.headers);

    if (url.pathname.endsWith('/status') && request.method === 'GET') {
      return json({ ai: !!env.ANTHROPIC_API_KEY, tts: !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION), ttsProvider: env.AZURE_SPEECH_KEY ? 'Azure AI Speech' : null }, 200, c.headers);
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405, c.headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, c.headers); }

    if (url.pathname.endsWith('/tts')) {
      if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) return json({ error: 'tts_not_configured' }, 501, c.headers);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TTS) return json({ error: 'bad_text' }, 400, c.headers);
      const lang = 'en';
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

    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, c.headers);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt || prompt.length > MAX_PROMPT || !PREFIXES.some((p) => prompt.startsWith(p))) return json({ error: 'prompt_not_allowed' }, 400, c.headers);
    const maxTokens = Math.min(prompt.startsWith(CLINICAL) ? 1600 : 1200, Math.max(100, Number(body?.max_tokens) || 400));
    const r = await fetch(env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-haiku-5-5', max_tokens: maxTokens,
        system: 'You are part of a healthcare communication app. Follow the instructions in the user message exactly and reply with only the JSON it asks for.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) return json({ error: 'upstream', status: r.status }, 502, c.headers);
    const data = await r.json();
    const text = (data?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    return json({ json: extractJson(text) }, 200, c.headers);
  },
};
