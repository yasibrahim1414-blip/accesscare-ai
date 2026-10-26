"""3D body check: every one of the 32 regions is picked correctly when tapping its surface from a front, back or side view.
Run from the project root: python3 tests/e2e/body_check/check.py"""
import os, subprocess, time, shutil
from playwright.sync_api import sync_playwright
D = os.path.dirname(os.path.abspath(__file__))
subprocess.run(['npx', 'esbuild', f'{D}/entry.ts', '--bundle', f'--outfile={D}/bundle.js', '--log-level=warning'], check=True)
shutil.copy('public/body.glb', f'{D}/new.glb')
srv = subprocess.Popen(['python3', '-m', 'http.server', '8902'], cwd=D, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader']); pg = b.new_page(viewport={'width': 420, 'height': 640})
        pg.goto('http://localhost:8902/index.html')
        r = pg.evaluate("pickTest('new.glb')")
        bad = {k: v for k, v in r.items() if k != v}
        assert len(r) == 32 and not bad, bad
        print(f'PASS all {len(r)} regions picked correctly')
finally:
    srv.terminate()
    for f in ('bundle.js', 'new.glb'):
        try: os.remove(f'{D}/{f}')
        except OSError: pass
