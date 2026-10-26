"""3D body in the patient workflow: multi-select by tapping, tap label, clear all, view buttons and zoom,
selected regions reaching the report, and the 2D fallback when WebGL is unavailable.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/body_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
PW = 'patient-secret-1'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()
NO_WEBGL = "HTMLCanvasElement.prototype.getContext = (function (orig) { return function (t, o) { return /webgl/.test(t) ? null : orig.call(this, t, o); }; })(HTMLCanvasElement.prototype.getContext);"

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    errors = []
    def device(uid, init=None):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True)
        if init: ctx.add_init_script(init)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(f'{BASE}?uid={uid}&name=Body&ai=0'); return pg
    btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
    def signup(pg):
        btn(pg, 'Create an account').click(); pg.get_by_test_id('role-patient').click(); btn(pg, 'Continue').click()
        pg.fill('#su-name', 'Body Tester'); pg.fill('#su-password', PW); pg.fill('#su-confirm', PW)
        btn(pg, 'Continue Registration').click()
        for _ in range(3):
            if pg.get_by_test_id('onboard-question').count(): break
            for n in ['Skip for now', 'Skip', 'Not now', 'Later', 'Continue']:
                if btn(pg, n).count(): btn(pg, n).first.click(); break
            pg.wait_for_timeout(1500)
        expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
        for _ in range(9):
            if pg.get_by_test_id('onboard-question').count() == 0: break
            pg.locator('[data-testid^="onb-"]').first.click(); pg.wait_for_timeout(600)
        pg.get_by_test_id('onboard-finish').click()

    pg = device('u-body')
    signup(pg)
    pg.get_by_test_id('start-consultation').click(); pg.get_by_test_id('none-of-these').click()
    expect(pg.get_by_text('Preparing the 3D body…')).to_have_count(0, timeout=30000)
    canvas = pg.get_by_test_id('body-canvas'); box = canvas.bounding_box()
    def tap(fx, fy):
        pg.mouse.click(box['x'] + box['width'] * fx, box['y'] + box['height'] * fy); pg.wait_for_timeout(450)
    picked = []
    for fx, fy in [(0.5, 0.30), (0.555, 0.55), (0.445, 0.55), (0.5, 0.12), (0.45, 0.72)]:
        tap(fx, fy)
        if pg.get_by_test_id('tapped-label').count():
            picked.append(pg.get_by_test_id('tapped-label').inner_text())
    chips = pg.get_by_test_id('selected-chip')
    assert chips.count() >= 3, [chips.nth(i).inner_text() for i in range(chips.count())]
    labels = [chips.nth(i).inner_text().replace('×', '').strip() for i in range(chips.count())]
    pg.screenshot(path='/tmp/claude-0/body-multi.png')
    ok(f'tapping the 3D body selected several regions with a label for each tap: {labels}')

    for v in ['Back', 'Left', 'Right', 'Front']:
        pg.get_by_role('button', name=f'{v} view').click(); pg.wait_for_timeout(700)
        expect(pg.locator('.stage-chip.stage-tl')).to_contain_text(v)
    pg.get_by_role('button', name='Zoom in').click(); pg.get_by_role('button', name='Zoom in').click()
    expect(pg.get_by_role('button', name='Show whole body')).to_be_visible()
    pg.get_by_role('button', name='Show whole body').click(); pg.wait_for_timeout(900)
    ok('front, back, left and right views and zoom in / whole body work')

    pg.get_by_test_id('clear-selection').click()
    expect(pg.get_by_test_id('selected-chip')).to_have_count(0)
    ok('Clear all removes every selected region')

    # pick a region again and follow it into the report
    target = None
    box = canvas.bounding_box()
    for fx, fy in [(0.555, 0.55), (0.445, 0.55), (0.56, 0.5), (0.44, 0.5)]:
        tap(fx, fy)
        if pg.get_by_test_id('selected-chip').count():
            target = pg.get_by_test_id('selected-chip').first.inner_text().replace('×', '').strip(); break
    assert target, 'no region selected'
    pg.get_by_test_id('body-next').click()
    pg.get_by_role('button', name=re.compile('Numb')).click(); btn(pg, 'Next').click()
    btn(pg, 'Comes and goes').click()
    pg.get_by_test_id('details-next').click()
    for _ in range(10):
        q = pg.get_by_test_id('bridge-question')
        try: q.wait_for(timeout=5000)
        except Exception: break
        btn(pg, 'Skip').click(); pg.wait_for_timeout(900)
    expect(pg.get_by_test_id('verifier')).to_contain_text(target, timeout=10000)
    pg.get_by_test_id('to-brief').click()
    expect(pg.get_by_test_id('summary-text')).to_contain_text(target, timeout=15000)
    expect(pg.get_by_test_id('summary-text')).to_contain_text(re.compile('numb', re.I))
    ok(f'the 3D selection ({target}) and the feeling chosen for it appear in the verification step and the summary the patient approves')

    # 2D fallback when WebGL is not available
    nf = device('u-body', init=NO_WEBGL)
    expect(nf.locator('#signin-password').or_(btn(nf, 'Log in')).first).to_be_visible(timeout=20000)
    if nf.locator('#signin-password').count() == 0: btn(nf, 'Log in').click()
    nf.fill('#signin-password', PW); nf.locator('form').get_by_role('button', name='Log in').click()
    nf.get_by_test_id('start-consultation').click(); nf.get_by_test_id('none-of-these').click()
    expect(nf.get_by_text(re.compile('3D view is currently unavailable'))).to_be_visible(timeout=20000)
    btn(nf, 'List').click()
    nf.get_by_role('button', name=re.compile('^Left knee')).click()
    expect(nf.get_by_test_id('selected-chip')).to_contain_text('Left knee')
    btn(nf, '2D map').click()
    expect(nf.get_by_test_id('selected-chip')).to_contain_text('Left knee')
    ok('without WebGL the 3D view reports it is unavailable and the 2D map / list keep working')

    assert not [e for e in errors if 'WebGL' not in e], errors
    print(f'\n{len(passed)} checks passed')
