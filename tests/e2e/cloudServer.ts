// Local stand-in for Claude's shared artifact database, for end-to-end tests.
// Serves the built app at /app?uid=<id>&name=<name> with a window.claude shim
// whose db/user calls go to this server, which enforces the same access rules
// as the platform (see tests/support/mockCloud.ts). Each browser context is a
// separate device; each uid a separate Claude account.
// Run: tsx tests/e2e/cloudServer.ts [port]

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { MockCloud } from '../support/mockCloud';
import { fakeClinical, fakeFda } from './fakeClinical';
import { fakeInterp, fakeBox, fakeBrief } from './fakeCare';
import { fakeConverse } from './fakeConverse';

const port = Number(process.argv[2] ?? 8787);
const cloud = new MockCloud('owner-uid');
const readPage = () => readFileSync('dist/accesscare-ai.html', 'utf8'); // re-read on each request so rebuilds are picked up

const shim = (uid: string, name: string) => `<script>
(() => {
  const uid = ${JSON.stringify(uid)}, name = ${JSON.stringify(name)};
  const call = async (body) => {
    const r = await fetch('/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, ...body }) });
    const j = await r.json();
    if (j.error) throw j.error;
    return j.result;
  };
  const snap = (d) => ({ id: d.id, exists: d.exists, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } });
  const poll = (fn, next) => { let last = '', live = true;
    const tick = async () => { if (!live) return; try { const r = await fn(); const k = JSON.stringify(r); if (k !== last) { last = k; next(r); } } catch {} if (live) setTimeout(tick, 400); };
    tick(); return () => { live = false; }; };
  const query = (path, filters = [], lim = 1000) => ({
    where: (f, op, v) => query(path, [...filters, [f, op, v]], lim),
    orderBy: () => query(path, filters, lim),
    limit: (n) => query(path, filters, n),
    get: async () => { const r = await call({ op: 'query', path, filters, lim }); const docs = r.map(snap); return { docs, size: docs.length, empty: !docs.length }; },
    onSnapshot: (next) => poll(() => call({ op: 'query', path, filters, lim }), (r) => { const docs = r.map(snap); next({ docs, size: docs.length, empty: !docs.length, docChanges: () => [] }); }),
  });
  const coll = (path) => Object.assign(query(path), { path, doc: (id) => doc(path + '/' + (id || Math.random().toString(36).slice(2))) });
  const doc = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => snap(await call({ op: 'get', path })),
    set: (data) => call({ op: 'set', path, data }),
    update: (data) => call({ op: 'update', path, data }),
    delete: () => call({ op: 'delete', path }),
    onSnapshot: (next) => poll(() => call({ op: 'get', path }), (d) => next(snap(d))),
    collection: (sub) => coll(path + '/' + sub),
  });
  const db = Object.freeze({ doc, collection: coll });
  const user = Object.freeze({ id: async () => uid, me: async () => ({ id: uid, name, email: null, avatarUrl: '', color: '', isOwner: false, canEdit: false }), can: async () => true, isOwner: async () => false, canEdit: async () => false, profiles: async () => ({}) });
  // Stand-in for Claude's \`sample\` capability (deterministic; logs every call). ?ai=0 disables it.
  window.__aiCalls = [];
  const grab = (prompt, label) => { const i = prompt.indexOf(label); if (i < 0) return null; try { return JSON.parse(prompt.slice(i + label.length).split('\\n')[0].trim()); } catch { return null; } };
  const sample = Object.assign(async () => ({ text: '' }), {
    json: async (prompt, opts) => {
      window.__aiCalls.push(prompt.slice(0, 60));
      await new Promise((r) => setTimeout(r, 120));
      if (prompt.includes('find ONLY details')) {
        const words = (grab(prompt, "Patient's words: ") || '').toLowerCase();
        const out = [];
        if (words.includes('feel sick')) out.push({ field: 'associated', value: 'Nausea', quote: 'feel sick' });
        out.push({ field: 'severity', value: 'Severe', quote: 'unbearable agony' }); // invented: guards must drop it
        return out;
      }
      if (prompt.includes('"sentence"')) {
        const facts = grab(prompt, 'Facts: ') || [];
        const sens = facts.filter((f) => f.startsWith('Sensation: ')).map((f) => f.slice(11).toLowerCase());
        const reg = facts.filter((f) => f.startsWith('Body region: ')).map((f) => f.slice(13).toLowerCase());
        return { sentence: 'Patient reports ' + (sens.join(' and ') || 'a sensation') + ' in the ' + reg.join(' and ') + '.' };
      }
      if (prompt.includes('"message"')) {
        const sel = grab(prompt, 'Selections: ') || [];
        const reg = (sel.find((f) => f.startsWith('Region: ')) || 'Region: body').slice(8).toLowerCase();
        const feel = (sel.find((f) => f.startsWith('What does it feel like?')) || '').replace('What does it feel like? ', '').toLowerCase();
        return { message: 'I feel ' + (feel || 'something') + ' in my ' + reg + '.' };
      }
      if (prompt.includes('Pick the ONE option')) {
        const said = (grab(prompt, 'Patient said: ') || '').toLowerCase();
        const opts = grab(prompt, 'Options: ') || [];
        if (said.includes('bendy') && opts.some((o) => o.id === 'area_legs')) return { choice: 'area_legs' };
        if (said.includes('bendy') && opts.some((o) => o.id === 'p_knee')) return { choice: 'p_knee' };
        return { choice: null };
      }
      if (prompt.includes('acknowledging what they said')) {
        const said = (grab(prompt, 'Patient said: ') || '').toLowerCase();
        if (said.includes('worried')) return { reply: "Don't worry, it is probably nothing serious." }; // guards must reject this
        return { reply: 'Thank you for telling me. That sounds hard.' };
      }
      if (prompt.includes('Safety screen')) return { concern: /breathe/i.test(prompt), reason: /breathe/i.test(prompt) ? 'mentions trouble breathing' : '' };
      if (prompt.includes('Task: teach-back check')) { window.__teachAi = (window.__teachAi || 0) + 1; return (await fetch('/fake-teach', { method: 'POST', body: prompt })).json(); }
      if (prompt.includes('Task: daily symptom diary') || prompt.includes('Task: what changed')) { window.__diaryAi = (window.__diaryAi || 0) + 1; return (await fetch('/fake-diary', { method: 'POST', body: prompt })).json(); }
      if (prompt.includes('Controls on this screen')) { window.__voiceAi = (window.__voiceAi || 0) + 1; return (await fetch('/fake-voice', { method: 'POST', body: prompt })).json(); }
      if (prompt.startsWith('You are AccessCare AI, a warm medical communication assistant')) return (await fetch('/fake-converse', { method: 'POST', body: prompt })).json();
      if (prompt.startsWith('You read the printed text on a photo of a medicine package')) { window.__boxCalls = (window.__boxCalls || 0) + 1; if (!(opts && opts.images)) throw Object.assign(new Error('no image'), { code: 'invalid_request' }); return (await fetch('/fake-box?k=' + encodeURIComponent(window.__boxKind || 'naproxen'))).json(); }
      if (prompt.startsWith('You are the AccessCare AI visit interpreter.')) { window.__interpCalls = (window.__interpCalls || 0) + 1; return (await fetch('/fake-interp', { method: 'POST', body: prompt })).json(); }
      if (prompt.includes('Task: pre-visit brief')) { window.__briefAi = (window.__briefAi || 0) + 1; return (await fetch('/fake-brief', { method: 'POST', body: prompt })).json(); }
      if (prompt.startsWith('You support a licensed doctor reviewing')) { window.__clinicalPrompts = (window.__clinicalPrompts || []).concat([prompt]); return (await fetch('/fake-clinical', { method: 'POST', body: prompt })).json(); }
      return null;
    },
    limits: async () => (/[?&]noimg=1/.test(location.search) ? {} : { images: { maxCount: 4, maxBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png'] } }),
  });
  const aiOn = !/[?&]ai=0/.test(location.search);
  // FDA label stand-in (same origin); ?fda=down imitates openFDA being unreachable
  window.__ACCESSCARE_FDA_BASE__ = /[?&]fda=down/.test(location.search) ? 'http://127.0.0.1:9' : location.origin + '/fda-stub';
  window.claude = { use: (n) => new Promise((res) => setTimeout(() => res(n === 'db' ? db : n === 'user' ? user : n === 'sample' && aiOn ? sample : null), 50)) };
})();
</script>`;

// translation work only (COLLECT_TEXT=1): records the interface text the tests see
const COLLECT = `<script>(()=>{const seen=new Set(),q=[];const add=(t)=>{t=(t||'').replace(/\\s+/g,' ').trim();if(t&&/[A-Za-z]{2}/.test(t)&&!seen.has(t)){seen.add(t);q.push(t)}};
const scan=(r)=>{if(!r||!r.querySelectorAll)return;const w=document.createTreeWalker(r,NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){const p=n.parentElement;if(p&&!p.closest('[data-no-tr],textarea,script,style'))add(n.nodeValue)}
r.querySelectorAll('[aria-label],[placeholder],[title]').forEach(e=>{if(!e.closest('[data-no-tr]'))['aria-label','placeholder','title'].forEach(a=>add(e.getAttribute(a)))})};
setInterval(()=>{scan(document.body);if(q.length){const b=JSON.stringify(q.splice(0));fetch('/collect',{method:'POST',body:b}).catch(()=>{})}},700)})()</script>`;
const collected = new Set<string>();
// stand-in for Claude interpreting a Blind Mode request (only real pages/controls can be chosen; the app validates)
function fakeVoice(prompt: string): unknown {
  const said = (prompt.match(/Person said \([^)]*\): (".*")/)?.[1] ?? '""');
  const s = JSON.parse(said).toLowerCase();
  if (/who .*connected|my physician|who is treating/.test(s)) return { action: 'open', target: 'doctor', reply: 'Opening your doctor page.' };
  if (/what (illness|disease)|diagnos/.test(s)) return { action: 'clarify', target: null, reply: 'I cannot say what illness it is. Would you like to tell your doctor how you feel?' };
  if (/press the moon/.test(s)) return { action: 'press', target: 999, reply: 'Pressing it.' }; // a control that does not exist: the app must refuse
  return { action: 'none', target: null, reply: '' };
}
// stand-ins for Claude on the diary prompts (the app validates everything they return)
function fakeDiary(prompt: string): unknown {
  if (prompt.includes('Task: what changed')) {
    const refs = [...prompt.matchAll(/^(D\d+) /gm)].map((m) => m[1]);
    const first = refs[0] ?? 'D1', last = refs[refs.length - 1] ?? 'D1';
    return { lines: [
      { text: 'The headache was described as stronger over the last days.', refs: [first, last] },
      { text: 'This is likely a migraine.', refs: [last] },          // diagnosis: must be removed
      { text: 'Strength reached 9 out of 10.', refs: [last] },       // a number not in the facts: must be removed
      { text: 'Medicine was missed.', refs: ['D99'] },               // invented reference: must be removed
    ] };
  }
  const said = JSON.parse(prompt.match(/Patient's words: (".*")/)?.[1] ?? '""') as string;
  const items: unknown[] = [];
  if (/tired|exhausted|تعبان/i.test(said)) items.push({ concept: 'fatigue', label: null, severity: null, trend: null, quote: said.match(/tired|exhausted|تعبان/i)![0] });
  items.push({ concept: 'fever', label: null, severity: 6, trend: 'worse', quote: 'burning up' }); // not in the words: must be dropped
  return { items, feeling: null, medicine: null };
}
// stand-in for Claude on the teach-back prompt: one judgement quoting the patient, one with words they never said
function fakeTeach(prompt: string): unknown {
  const said = JSON.parse(prompt.match(/Patient's words \([^)]*\): (".*")/)?.[1] ?? '""') as string;
  const points: unknown[] = [];
  const q = said.match(/باروح للدكتور[^،,.]*|go to my doctor[^,.]*/);
  if (q) points.push({ id: 'visit:urgent', status: 'different', quote: q[0] });
  points.push({ id: 'visit:frequency', status: 'understood', quote: 'I take it twice a day' }); // not the patient's words: must be ignored
  return { points };
}
let aiProxyCalls = 0;
let aiMode = 'ok';
let boxKind = '';
let webDb = true; // the website's shared storage (worker /db, memory store here)
const fdaCalls: string[] = [];
createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  if (url.pathname === '/app') {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style>
${shim(url.searchParams.get('uid') ?? 'anon', url.searchParams.get('name') ?? '')}${process.env.COLLECT_TEXT ? COLLECT : ''}</head><body>${readPage()}</body></html>`;
    // ?nocam=1 imitates a host that forbids the camera (like an embedded preview)
    res.writeHead(200, { 'content-type': 'text/html', ...(url.searchParams.get('nocam') ? { 'permissions-policy': 'camera=()' } : {}) }); res.end(html); return;
  }
  if (url.pathname.startsWith('/fx/')) { // camera-test still frames (see tests/e2e/make_face_fixtures.py)
    const f = url.pathname.slice(4).replace(/[^a-z0-9_.]/gi, '');
    try { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(readFileSync(`${process.env.FACE_FIXTURES ?? '/tmp/claude-0/facefx'}/${f}`)); } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (url.pathname.startsWith('/hx/')) { // sign-test still frames of hands (not shipped; see tests/e2e/talk_flow.py)
    const f = url.pathname.slice(4).replace(/[^a-z0-9_.]/gi, '');
    try { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(readFileSync(`${process.env.HAND_FIXTURES ?? '/tmp/claude-0/handfx'}/${f}`)); } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (url.pathname.startsWith('/mp/')) { // face-tracking files, published next to the page
    const f = url.pathname.slice(4).replace(/[^a-z0-9_.]/gi, '');
    try { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(readFileSync(`dist/mp/${f}`)); } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (url.pathname === '/db' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { uid, op, path, data, filters, lim } = JSON.parse(body);
    const { db } = cloud.clientFor(uid);
    try {
      let result: unknown = null;
      if (op === 'get') { const s = await db.doc(path).get(); result = { id: s.id, exists: s.exists, data: s.data() ?? null }; }
      else if (op === 'set') await db.doc(path).set(data);
      else if (op === 'update') await db.doc(path).update(data);
      else if (op === 'delete') await db.doc(path).delete();
      else if (op === 'query') {
        let q = db.collection(path) as any;
        for (const [f, o, v] of filters) q = q.where(f, o, v);
        const s = await q.limit(lim).get();
        result = s.docs.map((d: any) => ({ id: d.id, exists: d.exists, data: d.data() }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
    } catch (e: any) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: e.code ?? 'unavailable', message: e.message } }));
    }
    return;
  }
  // the web build's Claude proxy (server/cloudflare-worker.mjs) running here, with a fake Claude API behind it
  if (url.pathname === '/collect') { let b = ''; for await (const c of req) b += c; try { for (const t of JSON.parse(b)) collected.add(t); } catch { /* */ } if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([...collected])); return; } res.writeHead(204); res.end(); return; }
  if (url.pathname === '/ai-mode') { aiMode = url.searchParams.get('m') ?? 'ok'; res.writeHead(200); res.end(aiMode); return; }
  if (url.pathname === '/ai' || url.pathname === '/ai/status' || url.pathname === '/ai/db' || url.pathname === '/fake-anthropic') {
    let body = ''; for await (const c of req) body += c;
    if (url.pathname === '/fake-anthropic') {
      aiProxyCalls++;
      if (aiMode === 'credit') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } })); return; }
      const content = JSON.parse(body).messages[0].content;
      const prompt: string = typeof content === 'string' ? content : content.find((c: { type: string }) => c.type === 'text').text;
      const hasImage = Array.isArray(content) && content.some((c: { type: string }) => c.type === 'image');
      const said = (prompt.match(/Patient said: (".*")/)?.[1] ?? '""');
      const s2 = JSON.parse(said).toLowerCase();
      let out: unknown = null;
      if (prompt.startsWith('You are a calm voice assistant')) out = { reply: 'Thank you for telling me, that sounds difficult.' };
      else if (prompt.includes('Task: teach-back check')) out = fakeTeach(prompt);
      else if (prompt.includes('Task: daily symptom diary') || prompt.includes('Task: what changed')) out = fakeDiary(prompt);
      else if (prompt.includes('Controls on this screen')) out = fakeVoice(prompt);
      else if (prompt.startsWith('You are the voice of AccessCare AI')) out = { reply: 'AccessCare helps you prepare a message for your doctor. Let us continue.' };
      else if (prompt.startsWith('A blind patient is answering')) out = { choice: s2.includes('bendy') ? 'area_legs' : null };
      else if (prompt.startsWith('Safety screen')) out = { concern: false, reason: '' };
      else if (prompt.startsWith('You help a patient')) out = [];
      else if (prompt.startsWith('You are AccessCare AI, a warm medical communication assistant')) out = fakeConverse(prompt);
      else if (prompt.startsWith('You read the printed text on a photo')) out = hasImage ? fakeBox(boxKind) : null;
      else if (prompt.startsWith('You are the AccessCare AI visit interpreter.')) out = fakeInterp(prompt);
      else if (prompt.includes('Task: pre-visit brief')) out = fakeBrief(prompt);
      else if (prompt.startsWith('You support a licensed doctor reviewing')) out = fakeClinical(prompt);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Here you go: ' + JSON.stringify(out) }] })); return;
    }
    const worker = (await import('../../server/cloudflare-worker.mjs')).default;
    if (aiMode === 'old' && url.pathname === '/ai/status') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ ai: true, tts: false })); return; }
    const r: Response = await worker.fetch(new Request('http://x' + url.pathname, { method: req.method, headers: { origin: String(req.headers.origin ?? ''), 'content-type': 'application/json', ...(req.headers['x-ac-auth'] ? { 'x-ac-auth': String(req.headers['x-ac-auth']) } : {}) }, body: req.method === 'POST' ? body : undefined }),
      { ...(aiMode === 'nokey' ? {} : { ANTHROPIC_API_KEY: 'test-key' }), ...(webDb ? { MEMORY_DB: '1' } : {}), ALLOWED_ORIGINS: '*', ANTHROPIC_URL: `http://localhost:${port}/fake-anthropic` });
    const h: Record<string, string> = {}; r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h); res.end(await r.text()); return;
  }
  if (url.pathname.startsWith('/web/')) { // the static web build, like GitHub Pages
    const f = url.pathname.slice(5) || 'index.html';
    const safe = f.replace(/\.\./g, '');
    const type = safe.endsWith('.html') || safe === '' ? 'text/html' : safe.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    try { res.writeHead(200, { 'content-type': type }); res.end(readFileSync(`dist/web/${safe || 'index.html'}`)); } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (url.pathname === '/fake-box') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeBox(url.searchParams.get('k') ?? ''))); return; }
  if (url.pathname === '/box-kind') { boxKind = url.searchParams.get('k') ?? ''; res.writeHead(200); res.end(boxKind); return; }
  if (url.pathname === '/fake-interp') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeInterp(body))); return; }
  if (url.pathname === '/fake-brief') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeBrief(body))); return; }
  if (url.pathname === '/fake-teach') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeTeach(body))); return; }
  if (url.pathname === '/fake-diary') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeDiary(body))); return; }
  if (url.pathname === '/fake-voice') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeVoice(body))); return; }
  if (url.pathname === '/fake-clinical') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeClinical(body))); return; }
  if (url.pathname === '/fda-stub/drug/label.json') { fdaCalls.push(url.search); const r = fakeFda(decodeURIComponent(url.searchParams.get('search') ?? '')); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); return; }
  if (url.pathname === '/fda-calls') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fdaCalls)); return; }
  if (url.pathname === '/fake-converse') { let body = ''; for await (const c of req) body += c; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fakeConverse(body))); return; }
  if (url.pathname === '/ai-calls') { res.writeHead(200); res.end(String(aiProxyCalls)); return; }
  if (url.pathname === '/web-db') { webDb = url.searchParams.get('on') !== '0'; res.writeHead(200); res.end(String(webDb)); return; }
  if (url.pathname === '/reset') { cloud.store.clear(); aiMode = 'ok'; boxKind = ''; webDb = true; (await import('../../server/cloudflare-worker.mjs')).__resetMemoryDb(); res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/dump') { // test inspection: raw stored documents
    writeFileSync('/tmp/claude-0/cloud-dump.json', JSON.stringify([...cloud.store.entries()], null, 1));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([...cloud.store.entries()])); return;
  }
  res.writeHead(404); res.end();
}).listen(port, () => console.log(`cloud test server on http://localhost:${port}`));
