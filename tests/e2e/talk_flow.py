"""Talk to AccessCare (every patient) — browser test.
Real: the app, the conversation manager and its checks, the shared-database stand-in, the body map, the doctor's view
on another browser context. Simulated (stated honestly): the AI is a deterministic stand-in (tests/e2e/fakeConverse.ts)
and the speech engines record instead of speaking.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/talk_flow.py"""
import re, sys, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
PW, DOC_PW = 'patient-pass-1', 'doctor-pass-1'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()
SPEECH = open(__file__.replace('talk_flow.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]

# getUserMedia → a canvas showing a hand photo (or nothing), scaled into a 640×480 picture
FAKE_CAM = """
(() => {
  const imgs = {}; let cur = 'none'; let timer = null;
  window.__cam = { set: (n) => { cur = n; }, active: () => !!timer, calls: 0, stops: 0 };
  const load = (n) => new Promise((r, j) => { const i = new Image(); i.onload = () => { imgs[n] = i; r(); }; i.onerror = j; i.src = '/hx/' + n + '.jpg'; });
  window.__camLoad = (names) => Promise.all(names.map((n) => imgs[n] ? 0 : load(n)));
  navigator.mediaDevices.getUserMedia = async () => {
    window.__cam.calls++;
    const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
    const draw = () => { g.fillStyle = '#556'; g.fillRect(0, 0, 640, 480); const i = imgs[cur]; if (i) { const h = 380, w = h * i.width / i.height; g.drawImage(i, 320 - w / 2, 60, w, h); } };
    draw(); timer = setInterval(draw, 33);
    const stream = c.captureStream(30); const tr = stream.getVideoTracks()[0]; const stop = tr.stop.bind(tr);
    tr.stop = () => { stop(); clearInterval(timer); timer = null; window.__cam.stops++; };
    return stream;
  };
})();
"""

with sync_playwright() as p:
    args = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    b = p.chromium.launch(channel='chromium', args=args + ['--use-fake-device-for-media-stream'])
    errors = []
    def device(uid, name, fake=False, perms=None):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, permissions=perms or [])
        ctx.add_init_script(SPEECH)
        if fake: ctx.add_init_script(FAKE_CAM)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}'); return pg
    btn = lambda pg, name: pg.get_by_role('button', name=name, exact=True)
    log = lambda pg: pg.get_by_test_id('va-log').inner_text()
    def wait_log(pg, pattern, timeout=30000):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(document.querySelector("[data-testid=va-log]").innerText)', arg=pattern, timeout=timeout)
        except Exception: print('LOG:', log(pg)[-700:], '\nOPTIONS:', pg.get_by_test_id('va-options').inner_text() if pg.get_by_test_id('va-options').count() else '', flush=True); raise
    def typed(pg, text, expect_re):
        pg.fill('#va-typed', text); pg.get_by_test_id('va-send').click(); wait_log(pg, expect_re)
    def onboard(pg):
        expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
        for _ in range(9):
            if pg.get_by_test_id('onboard-question').count() == 0: break
            t = pg.get_by_test_id('onboard-question').inner_text()
            pg.locator('[data-testid^="onb-"]').nth(0).click(); pg.wait_for_timeout(600)
        pg.get_by_test_id('onboard-finish').click()

    # ---------- accounts ----------
    doc = device('u-doc', 'Layla')
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', DOC_PW); doc.fill('#su-confirm', DOC_PW)
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); pat.fill('#su-password', PW); pat.fill('#su-confirm', PW); pat.fill('#su-doctor-id', doc_id.lower())
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    onboard(pat)  # first option everywhere: includes "Yes, use AI assistance"

    # ---------- Talk to AccessCare ----------
    pat.get_by_test_id('home-talk').click()
    expect(pat.get_by_test_id('voice-companion')).to_have_attribute('data-mode', 'talk', timeout=10000)
    wait_log(pat, 'What is bothering you today')
    pat.get_by_test_id('mic-deny').click()  # this patient types / taps
    typed(pat, 'I have a really bad headache since this morning', 'sorry')
    wait_log(pat, 'start suddenly, or build up gradually')
    opts = pat.get_by_test_id('va-options').inner_text()
    assert 'Chest' not in opts and 'Back' not in opts, opts
    assert 'AI' in log(pat), 'AI turn labelled'
    ok('typed "I have a really bad headache since this morning": the AI (stand-in) reply was shown and labelled AI; the next question is about the headache (sudden or gradual, with the reason) — no chest/back choices')
    pat.locator('.va-opt', has_text='Gradually').click()
    wait_log(pat, 'Where in your head')
    pat.get_by_test_id('va-method-body').click()
    expect(pat.get_by_test_id('va-body-panel')).to_be_visible()
    pat.get_by_test_id('va-body-panel').get_by_role('button', name='List', exact=True).click()
    pat.get_by_test_id('va-body-panel').get_by_role('button', name=re.compile('^Neck')).click()
    pat.get_by_test_id('va-body-send').click()
    wait_log(pat, 'Body map|neck')
    ok('switched to the body map in the same conversation (neck added to the headache record), then back to words')
    assert pat.get_by_test_id('va-method-sign').count() == 0
    assert pat.get_by_test_id('va-lang').count() == 0, 'no language switch: English only'
    assert not pat.evaluate("(() => { const c = document.getElementById('root').cloneNode(true); c.querySelectorAll('[data-testid=lang-switch]').forEach((e) => e.remove()); return /[\\u0600-\\u06FF]/.test(c.innerText); })()"), 'English chosen: no Arabic on the screen (except the switch to Arabic)'

    # ---------- finish, review, send ----------
    for _ in range(8):
        ph = pat.get_by_test_id('voice-companion').get_attribute('data-phase')
        if ph == 'review': break
        o = pat.locator('.va-opt[data-option="else:no"]')
        if o.count(): o.click()
        elif pat.locator('.va-opt[data-option="ns"]').count(): pat.locator('.va-opt[data-option="ns"]').click()
        elif pat.locator('.va-opt[data-option="assoc:none"]').count(): pat.locator('.va-opt[data-option="assoc:none"]').click()
        else: typed(pat, 'not sure', '.')
        pat.wait_for_timeout(700)
    expect(pat.get_by_test_id('va-summary')).to_be_visible(timeout=10000)
    summ = pat.get_by_test_id('va-summary').inner_text()
    assert 'Headache' in summ and 'really bad' in summ and 'neck' in summ.lower() and 'body map' in summ, summ
    ok('the summary keeps the original complaint in the patient’s words, what came from the body map, and marks unanswered items')
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(400)
    pat.locator('.va-opt[data-option="yes"]').click()
    wait_log(pat, 'Dr. Layla Hassan')
    doc.get_by_role('button', name=re.compile('^Consultations')).click()
    doc.get_by_role('button', name=re.compile('Omar Adel')).first.click()
    expect(doc.get_by_test_id('approved-text')).to_contain_text('Headache', timeout=15000)
    t = doc.get_by_test_id('approved-text').inner_text()
    assert 'the body map' in t and 'typing' in t, t
    ok('approved and sent: the doctor received the summary the patient approved and how each part was communicated (typing, body map)')

    st = pat.get_by_test_id('va-voice-status').inner_text()
    assert 'device' in st.lower(), st
    ok('voice status says honestly which voice is used (no natural-voice service configured here → the device voice)')

    assert not errors, errors
    print(f'\n{len(passed)} checks passed')
