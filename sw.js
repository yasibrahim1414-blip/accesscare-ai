// AccessCare AI — service worker for the installed app (website build only).
// It keeps the app's own files on the device so the installed app opens without the website and
// without a connection. It never stores health data: accounts, messages, AI and voices are network
// requests to the AccessCare server and are never cached here.
const VERSION = 'e9825002d866';
const CACHE = `accesscare-${VERSION}`;
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const LARGE = ['./body.glb', './mp/vision_wasm_internal.wasm', './mp/hand_landmarker.task'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    // the 3D body and hand tracking are large: fetched in the background, used once ready
    for (const u of LARGE) c.add(u).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('accesscare-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // AI, accounts, messages: always the network
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const scope = new URL(self.registration.scope).pathname;
  // only the app's own files inside its folder; anything else (the AccessCare server, AI, accounts) is never stored
  const appFile = same && url.pathname.startsWith(scope) && !url.search && (url.pathname === scope || /\.(html|webmanifest|png|glb|wasm|task|js)$/.test(url.pathname));
  if (!appFile && !FONTS.test(req.url)) return;
  if (same && (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/'))) {
    // the page: newest from the network when online, the stored copy when offline
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) { const c = await caches.open(CACHE); await c.put('./index.html', r.clone()); }
        return r;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  // files that never change within a version (3D body, hand tracking, icons, fonts): stored copy first
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') { const c = await caches.open(CACHE); c.put(req, r.clone()).catch(() => {}); }
    return r;
  })());
});
