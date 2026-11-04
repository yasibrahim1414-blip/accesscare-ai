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
import { createHash } from 'node:crypto';

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
// installable app (PWA): manifest, icons and a service worker that keeps the app's own files on the device
const pwaHead = `
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#0E7C7B">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="AccessCare">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">`;
const webPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}${pwaHead}</head>
<body><div id="root"></div><script>${jsWeb}</script></body></html>`;
writeFileSync('dist/web/index.html', webPage);
copyFileSync('public/body.glb', 'dist/web/body.glb');
mkdirSync('dist/web/icons', { recursive: true });
for (const f of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']) copyFileSync(`public/icons/${f}`, `dist/web/icons/${f}`);
writeFileSync('dist/web/manifest.webmanifest', JSON.stringify({
  name: 'AccessCare AI', short_name: 'AccessCare', description: 'Tell your doctor what you feel — by voice, touch or sign, in five languages.',
  start_url: './', scope: './', display: 'standalone', orientation: 'any', background_color: '#FFFFFF', theme_color: '#0E7C7B',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));
// a new build gets a new cache, so an installed app picks up updates
const buildId = createHash('sha256').update(webPage).digest('hex').slice(0, 12);
writeFileSync('dist/web/sw.js', readFileSync('public/sw.js', 'utf8').replace('__BUILD__', buildId));

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
