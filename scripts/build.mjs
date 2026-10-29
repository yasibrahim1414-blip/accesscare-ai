// Builds:
//   dist/accesscare-ai.html  one self-contained file (app + 3D model) that runs inside Claude
//   dist/mp/                 face-tracking WASM published next to the in-Claude page (camera mode; the model is embedded)
//   dist/web/                standalone static build (index.html + body.glb + mp/)
//   dist/accesscare-ai-standalone.html  one file with everything embedded, for opening in a normal browser
//                            (camera mode needs a real browser: Claude's preview doesn't allow the camera)
// Environment (optional, for the standalone build only):
//   ACCESSCARE_SUPABASE_URL, ACCESSCARE_SUPABASE_ANON_KEY  → use the Supabase backend
// Never put a service-role key here: everything in the bundle is public.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const supaUrl = process.env.ACCESSCARE_SUPABASE_URL ?? '';
const supaKey = process.env.ACCESSCARE_SUPABASE_ANON_KEY ?? '';
// public URL of the Claude proxy (server/cloudflare-worker.mjs) for the web build; not a secret
const aiEndpoint = process.env.ACCESSCARE_AI_ENDPOINT ?? '';
if (/sk-ant-/.test(aiEndpoint)) throw new Error('ACCESSCARE_AI_ENDPOINT must be a URL, never an API key.');
if (/service_role/.test(supaKey)) throw new Error('Refusing to embed a service-role key in the client bundle.');

async function bundle(define) {
  const res = await build({
    entryPoints: ['src/main.tsx'], bundle: true, minify: true, format: 'iife', target: 'es2020',
    jsx: 'automatic', write: false, legalComments: 'none', external: ['fs', 'path'], logOverride: { 'direct-eval': 'silent' },
    define: { 'process.env.NODE_ENV': '"production"', ...define },
  });
  return res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

const head = `<title>AccessCare AI</title>
<meta name="description" content="AccessCare AI — The Adaptive Digital Clinic (prototype)">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=IBM+Plex+Sans+Arabic:wght@400;500;700&family=Noto+Nastaliq+Urdu:wght@400;700&family=Noto+Sans+Devanagari:wght@400;700&display=swap">`;

// In-Claude build: no Supabase (external servers are unreachable from Claude's preview).
const jsClaude = await bundle({ __SUPABASE_URL__: '""', __SUPABASE_ANON_KEY__: '""', __AI_ENDPOINT__: '""' });
const glb = readFileSync('public/body.glb').toString('base64');
mkdirSync('dist/web', { recursive: true });
writeFileSync('dist/accesscare-ai.html', `${head}
<div id="root"></div>
<script>window.__ACCESSCARE_BODY_GLB__=${JSON.stringify(glb)};</script>
<script>${jsClaude}</script>
`);

const jsWeb = await bundle({ __SUPABASE_URL__: JSON.stringify(supaUrl), __SUPABASE_ANON_KEY__: JSON.stringify(supaKey), __AI_ENDPOINT__: JSON.stringify(aiEndpoint) });
writeFileSync('dist/web/index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head>
<body><div id="root"></div><script>${jsWeb}</script></body></html>`);
copyFileSync('public/body.glb', 'dist/web/body.glb');

// hand tracking (MediaPipe Hand Landmarker, Apache-2.0) — see vendor/mediapipe/NOTICE.md
// hand tracking for sign recognition (MediaPipe Hand Landmarker) — web builds only: pages inside Claude can't use the camera
const MP = { wasm: 'vendor/mediapipe/vision_wasm_internal.wasm', hand: 'vendor/mediapipe/hand_landmarker.task' };
for (const dir of ['dist/mp', 'dist/web/mp']) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(MP.wasm, `${dir}/vision_wasm_internal.wasm`);
  copyFileSync(MP.hand, `${dir}/hand_landmarker.task`); // dist/mp copy is for local browser tests; the in-Claude page can't use the camera
}
const mpEmbed = JSON.stringify({ wasm: readFileSync(MP.wasm).toString('base64'), hand: readFileSync(MP.hand).toString('base64') });
writeFileSync('dist/accesscare-ai-standalone.html', `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head>
<body><div id="root"></div>
<script>window.__ACCESSCARE_BODY_GLB__=${JSON.stringify(glb)};window.__ACCESSCARE_MP__=${mpEmbed};</script>
<script>${jsWeb}</script></body></html>`);
console.log(`built: js ${(jsClaude.length / 1024).toFixed(0)} KB, in-Claude file ${((jsClaude.length + glb.length) / 1024).toFixed(0)} KB, web build ${supaUrl ? 'with Supabase' : 'offline demo (no Supabase env set)'}`);
