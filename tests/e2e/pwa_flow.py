"""Installable app (PWA) — browser test of the website build, and of the downloaded copy run from a local server.
Real: the manifest, the service worker, the app opening with no connection, the files copy and its start script
(the Mac/Linux one; the Windows script needs Windows and is not run here).
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/pwa_flow.py"""
import json, os, subprocess, time, urllib.request, shutil, tempfile
from playwright.sync_api import sync_playwright, expect
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read(); urllib.request.urlopen('http://localhost:8787/web-db?on=1').read()
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    # ---------- 1. the website build is an installable app ----------
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html'); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    m = pg.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r => r.json())")
    assert m['display'] == 'standalone' and m['start_url'] == './' and {i['sizes'] for i in m['icons']} >= {'192x192', '512x512'}, m
    assert any(i.get('purpose') == 'maskable' for i in m['icons'])
    for i in m['icons']: assert pg.evaluate(f"fetch('{i['src']}').then(r => r.ok && r.headers.get('content-type'))") == 'image/png'
    pg.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null || (navigator.serviceWorker.ready.then(() => location.reload()), false)", timeout=20000)
    pg.wait_for_function("!!navigator.serviceWorker.controller", timeout=20000)
    cdp = ctx.new_cdp_session(pg)
    inst = cdp.send('Page.getInstallabilityErrors')
    assert inst.get('installabilityErrors', []) == [], inst
    ok(f'the website is an installable app: manifest (standalone, icons incl. maskable), service worker active, Chrome reports no installability errors')
    pg.wait_for_function("caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.match('body.glb'))))).then(r => r.some(Boolean))", timeout=60000)
    # ---------- 2. it opens with no connection ----------
    ctx.set_offline(True)
    pg.reload(); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    assert pg.evaluate("caches.keys().then(ks => ks.some(k => k.startsWith('accesscare-')))")
    stored = pg.evaluate("caches.keys().then(ks => caches.open(ks[0])).then(c => c.keys()).then(rs => rs.map(r => new URL(r.url).pathname))")
    assert not any('/ai' in s or '/db' in s for s in stored), f'no server data is stored: {stored}'
    ok('with the connection off, the installed app still opens (page, 3D body and hand-tracking files stored on the device; no account or AI data stored)')
    ctx.set_offline(False); ctx.close()

    # ---------- 3. the downloaded copy, started with the Mac/Linux start file ----------
    tmp = tempfile.mkdtemp(); shutil.copytree(os.path.join(ROOT, 'dist', 'web'), os.path.join(tmp, 'app'))
    for f in os.listdir(os.path.join(ROOT, 'local')): shutil.copy(os.path.join(ROOT, 'local', f), tmp)
    env = dict(os.environ, PATH='/usr/bin:/bin')  # no 'open'/'xdg-open' needed
    srv = subprocess.Popen(['sh', os.path.join(tmp, 'Start AccessCare (Mac or Linux).command')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    try:
        for _ in range(50):
            try: urllib.request.urlopen('http://localhost:8000/'); break
            except Exception: time.sleep(0.2)
        ctx = b.new_context(viewport={'width': 1280, 'height': 860}, permissions=['camera', 'microphone']); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://localhost:8000/'); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
        assert pg.evaluate('window.isSecureContext'), 'localhost is a secure context: camera and microphone are allowed'
        assert pg.evaluate("fetch('mp/vision_wasm_internal.wasm').then(r => r.ok)") and pg.evaluate("fetch('body.glb').then(r => r.ok)")
        pg.wait_for_function("!!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)", timeout=20000)
        ok('the downloaded copy runs from its start file at http://localhost:8000: secure context (camera allowed), 3D body and hand-tracking files load, installable there too')
        ctx.close()
    finally:
        srv.terminate()
    assert not errs, errs
    b.close()
print(f'{len(passed)} passed')
