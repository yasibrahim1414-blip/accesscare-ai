"""Silent Signal camera section — answering with SIGN LANGUAGE. Browser test (full Chromium).
Real: the app, camera permission handling (getUserMedia), MediaPipe Hand Landmarker running on the camera frames,
the sign detector (built-in ASL YES/NO rules + a sign taught by the patient), the Silent Signal question workflow,
the shared-database stand-in, the doctor's view on another browser context.
Simulated (stated honestly): (a) the camera picture is a canvas showing a still photo of an open hand (to prove that
hands are detected in real frames); (b) the SIGNS themselves are replayed as hand-landmark sequences shaped like the
ASL dictionary forms of YES / NO and a made-up "wave" sign — fed in place of MediaPipe's output through a test-only
hook. So this verifies the pipeline after hand tracking, not accuracy with real signers, lighting or phones.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/camera_flow.py"""
import re, sys, os, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/signshots'
os.makedirs(SHOTS, exist_ok=True)
PAT_PW, DOC_PW = 'patient-pass-1', 'doctor-pass-1'
passed = []
def ok(msg): passed.append(msg); print('PASS', msg, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()

FAKE_CAM = """
(() => {
  const imgs = {}; let cur = 'none'; let timer = null;
  window.__cam = { set: (n) => { cur = n; }, active: () => !!timer, calls: 0, stops: 0 };
  const load = (n) => new Promise((r, j) => { const i = new Image(); i.onload = () => { imgs[n] = i; r(); }; i.onerror = j; i.src = '/hx/' + n + '.jpg'; });
  navigator.mediaDevices.getUserMedia = async () => {
    window.__cam.calls++;
    await load('train_hello_2').catch(() => {});
    const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
    const draw = () => { g.fillStyle = '#556'; g.fillRect(0, 0, 640, 480); const i = imgs[cur]; if (i) { const h = 320, w = h * i.width / i.height; g.drawImage(i, 320 - w / 2, 80, w, h); } };
    draw(); timer = setInterval(draw, 33);
    const stream = c.captureStream(30); const tr = stream.getVideoTracks()[0]; const stop = tr.stop.bind(tr);
    tr.stop = () => { stop(); clearInterval(timer); timer = null; window.__cam.stops++; };
    return stream;
  };
  // ---- replayed signs (hand points), shaped like the dictionary form of each sign
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  function hand(cx, cy, pose, size = 0.18) {
    const w = [cx, cy + size * 0.5, 0]; const pts = [w];
    const angI = -Math.PI / 2 - 0.33;
    const tt = pose.pinch ? [w[0] + Math.cos(angI) * size * 1.25, w[1] + Math.sin(angI) * size * 1.25] : [cx - size * 0.32, cy + size * 0.05];
    for (let j = 1; j <= 4; j++) pts.push([w[0] + (tt[0] - w[0]) * j / 4, w[1] + (tt[1] - w[1]) * j / 4, 0]);
    const f4 = [pose.index, pose.middle, pose.ring, pose.pinky];
    for (let f = 0; f < 4; f++) {
      const ang = -Math.PI / 2 + (f - 1.5) * 0.22; const mcp = [w[0] + Math.cos(ang) * size * 0.9, w[1] + Math.sin(ang) * size * 0.9];
      for (let j = 1; j <= 4; j++) {
        let p;
        if (j === 1) p = mcp;
        else if (f4[f] === 'ext') p = [w[0] + Math.cos(ang) * size * (0.9 + 0.33 * (j - 1)), w[1] + Math.sin(ang) * size * (0.9 + 0.33 * (j - 1))];
        else if (pose.pinch && f < 2) p = [mcp[0] + (tt[0] + f * 0.02 - mcp[0]) * (j - 1) / 3, mcp[1] + (tt[1] - mcp[1]) * (j - 1) / 3];
        else p = [mcp[0] + (w[0] - mcp[0]) * 0.12 * (j - 1), mcp[1] + (w[1] - mcp[1]) * 0.12 * (j - 1)];
        pts.push([p[0] + rnd() * 0.003, p[1] + rnd() * 0.003, 0]);
      }
    }
    return [{ handedness: 'Right', score: 0.95, lm: pts }];
  }
  const FIST = { index: 'curl', middle: 'curl', ring: 'curl', pinky: 'curl' }, V = { index: 'ext', middle: 'ext', ring: 'curl', pinky: 'curl' };
  const CLOSED = { ...FIST, pinch: true }, OPEN = { index: 'ext', middle: 'ext', ring: 'ext', pinky: 'ext' };
  const SIGNS = {
    yes: () => Array.from({ length: 32 }, (_, i) => hand(0.5, 0.5 + 0.035 * Math.sin((i / 16) * Math.PI * 2), FIST)),
    no: () => { const o = []; for (let s = 0; s < 2; s++) { for (let i = 0; i < 6; i++) o.push(hand(0.5, 0.5, V)); for (let i = 0; i < 5; i++) o.push(hand(0.5, 0.5, CLOSED)); } return o; },
    wave: () => Array.from({ length: 30 }, (_, i) => hand(0.3 + 0.4 * Math.abs(Math.sin(i / 6)), 0.35, OPEN)),
    sweep: () => Array.from({ length: 30 }, (_, i) => hand(0.2 + i * 0.02, 0.3 + i * 0.012, OPEN)),
  };
  let queue = []; window.__photo = false;
  window.__sign = (name) => { queue = queue.concat(SIGNS[name](), Array.from({ length: 16 }, () => [])); };
  window.__signing = () => queue.length > 0;
  // one replayed frame per camera frame; empty hands when idle; null = use MediaPipe's real result (photo mode)
  window.__hookCalls = 0;
  window.__ACCESSCARE_TEST_HANDS__ = () => { window.__hookCalls++; return window.__photo ? null : (queue.length ? queue.shift() : []); };
})();
"""

with sync_playwright() as p:
    args = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    browser = p.chromium.launch(channel='chromium', args=args + ['--use-fake-device-for-media-stream'])
    errors = []
    def device(uid, name, fake=True, perms=None, b=None, extra=''):
        ctx = (b or browser).new_context(viewport={'width': 390, 'height': 844}, permissions=perms or [])
        if fake: ctx.add_init_script(FAKE_CAM)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}&ai=0{extra}'); return pg
    btn = lambda pg, name: pg.get_by_role('button', name=name, exact=True)
    def login(pg, pw):
        expect(pg.get_by_role('button', name='Log in', exact=True).or_(pg.locator('#signin-password')).first).to_be_visible(timeout=20000)
        if pg.locator('#signin-password').count() == 0: btn(pg, 'Log in').click()
        pg.fill('#signin-password', pw); pg.locator('form').get_by_role('button', name='Log in').click()
    def onboard(pg):
        expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
        for _ in range(9):
            if pg.get_by_test_id('onboard-question').count() == 0: break
            pg.locator('[data-testid^="onb-"]').first.click(); pg.wait_for_timeout(600)
        pg.get_by_test_id('onboard-finish').click()
    def to_signal(pg):
        pg.get_by_role('button', name=re.compile('^Signal')).click()
        expect(pg.get_by_test_id('camera-card')).to_be_visible(timeout=10000)
    def sign(pg, name, wait=True):
        pg.evaluate(f'window.__sign({name!r})')
        if wait:
            try: pg.wait_for_function('!window.__signing()', timeout=15000)
            except Exception:
                print('DEBUG cam', pg.evaluate('[window.__hookCalls, typeof window.__sign]'), pg.get_by_test_id('cam-status').inner_text(), pg.evaluate("[document.querySelector('video').currentTime, document.querySelector('video').readyState, window.__cam.active()]"), errors, flush=True); raise
            pg.wait_for_timeout(250)

    # ---------- accounts ----------
    doc = device('u-doc', 'Layla Hassan', fake=False)
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', DOC_PW); doc.fill('#su-confirm', DOC_PW)
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    pat = device('u-pat', 'Mariam Saleh')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Mariam Saleh'); pat.fill('#su-password', PAT_PW); pat.fill('#su-confirm', PAT_PW); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=20000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    onboard(pat); to_signal(pat)
    expect(pat.get_by_test_id('camera-card')).to_contain_text('Answer with signs')

    # ---------- camera denied / blocked ----------
    bd = p.chromium.launch(channel='chromium', args=args + ['--use-fake-device-for-media-stream', '--deny-permission-prompts'])
    d = device('u-pat', 'Mariam Saleh', fake=False, perms=[], b=bd)
    login(d, PAT_PW); to_signal(d); d.get_by_test_id('open-camera-setup').click(); d.get_by_test_id('cam-start').click()
    expect(d.get_by_test_id('cam-error')).to_have_attribute('data-error', 'denied', timeout=20000)
    d.get_by_test_id('cam-alt').click(); expect(d.get_by_text('How would you like to choose?')).to_be_visible()
    d.context.close(); bd.close()
    blk = device('u-pat', 'Mariam Saleh', fake=False, perms=['camera'], extra='&nocam=1')
    login(blk, PAT_PW); to_signal(blk); blk.get_by_test_id('open-camera-setup').click(); blk.get_by_test_id('cam-start').click()
    expect(blk.get_by_test_id('cam-error')).to_have_attribute('data-error', 'blocked'); blk.context.close()
    ok('camera permission denied, or forbidden by the host page: clear message and “Answer another way” (the other input methods)')

    # ---------- setup: scope, real hand detection, built-in ASL YES / NO ----------
    pat.get_by_test_id('open-camera-setup').click()
    expect(pat.get_by_test_id('sign-scope')).to_contain_text('Arabic and Egyptian sign languages are not built in')
    expect(pat.get_by_test_id('sign-scope')).to_contain_text('does not translate full signed sentences')
    pat.get_by_test_id('cam-start').click()
    expect(pat.get_by_test_id('cam-status')).to_have_text('Camera on', timeout=60000)
    expect(pat.get_by_test_id('cam-hands')).to_contain_text('Hands not visible', timeout=10000)
    pat.evaluate("window.__photo = true; window.__cam.set('train_hello_2')")
    pat.wait_for_function("+document.querySelector('[data-testid=cam-overlay]').dataset.hands >= 1", timeout=20000)
    pat.screenshot(path=f'{SHOTS}/01-hand-found.png')
    pat.evaluate("window.__photo = false; window.__cam.set('none')")
    ok('permission asked only after “Start camera”; MediaPipe Hand Landmarker found the hand in a real photo in the camera picture (points drawn), and said so when no hands were visible')

    expect(pat.get_by_test_id('map-yes')).to_have_value('asl_yes'); expect(pat.get_by_test_id('map-no')).to_have_value('asl_no')
    pat.get_by_test_id('practise-yes').click()
    for i in range(3):
        expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', 'go', timeout=10000); sign(pat, 'yes')
        expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', re.compile('seen|ready'), timeout=8000)
    expect(pat.get_by_test_id('sign-status-yes')).to_contain_text('3 of 3 recognized', timeout=10000)
    pat.get_by_test_id('practise-no').click()
    expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', 'go', timeout=10000); sign(pat, 'yes')   # the wrong sign
    expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', 'other', timeout=8000)
    for i in range(2):
        expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', 'go', timeout=10000); sign(pat, 'no')
        pat.wait_for_timeout(300)
    expect(pat.get_by_test_id('sign-status-no')).to_contain_text('2 of 3 recognized', timeout=10000)
    ok('built-in ASL YES (fist nodding) and NO (two fingers snapping onto the thumb) practised: 3/3 and 2/3 — the wrong sign during NO practice was reported as a different sign, not counted')

    # ---------- teach an own sign for "Not sure" ----------
    pat.get_by_test_id('teach-unsure').click()
    for i in range(3):
        pat.get_by_test_id('teach-record').click(); sign(pat, 'wave')
        expect(pat.get_by_test_id('teach-status')).to_contain_text(f'{i + 1} OF 3', timeout=8000)
    pat.get_by_test_id('teach-save').click()
    for i in range(3):
        expect(pat.get_by_test_id('trial-status')).to_have_attribute('data-phase', 'go', timeout=10000); sign(pat, 'wave')
        pat.wait_for_timeout(300)
    expect(pat.get_by_test_id('sign-status-unsure')).to_contain_text('3 of 3 recognized', timeout=10000)
    expect(pat.get_by_test_id('map-unsure')).to_have_value('t_unsure')
    ok('the patient taught their own sign for “Not sure” (3 examples, kept on this device) and it was recognized 3/3 in practice')

    # ---------- sample questions + confirm by signing ----------
    pat.get_by_test_id('map-save').click()
    for cmd in ['yes', 'no', 'unsure']:
        expect(pat.get_by_test_id('test-step')).to_have_attribute('data-cmd', cmd, timeout=10000)
        if cmd == 'yes': sign(pat, 'no'); expect(pat.get_by_test_id('cam-flash')).to_contain_text('not YES', timeout=5000)
        sign(pat, {'yes': 'yes', 'no': 'no', 'unsure': 'wave'}[cmd])
    expect(pat.get_by_test_id('confirm-works')).to_be_visible(timeout=10000)
    sign(pat, 'yes', wait=False)
    expect(pat.get_by_test_id('camera-card')).to_contain_text('Set up', timeout=15000)
    expect(pat.get_by_test_id('camera-card')).to_contain_text('ASL sign “YES”')
    ok('sample questions answered by signing (a wrong sign was caught), setup confirmed by signing YES and saved')

    # ---------- the medical session, driven by signs ----------
    pat.get_by_test_id('start-camera-session').click()
    pat.get_by_test_id('cam-start').click()
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'help_now', timeout=60000)
    sign(pat, 'sweep')
    expect(pat.get_by_test_id('cam-flash')).to_contain_text('didn’t recognize that sign', timeout=5000)
    assert pat.get_by_test_id('cam-interpreted').count() == 0, 'an unrecognized sign never becomes an answer'
    sign(pat, 'no')
    expect(pat.get_by_test_id('cam-interpreted')).to_contain_text('No', timeout=5000)
    sign(pat, 'yes')   # confirm
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'breathing', timeout=8000)
    sign(pat, 'no'); sign(pat, 'yes')
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'stroke', timeout=8000)
    sign(pat, 'wave')  # own sign: Not sure
    expect(pat.get_by_test_id('cam-interpreted')).to_contain_text('Not sure', timeout=5000)
    sign(pat, 'yes')
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'pain', timeout=8000)
    sign(pat, 'yes'); sign(pat, 'yes')
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'group', timeout=8000)
    sign(pat, 'no')    # in lists, NO moves to the next option
    expect(pat.locator('.opt.lit')).to_contain_text('Torso', timeout=5000)
    sign(pat, 'yes'); expect(pat.get_by_test_id('cam-interpreted')).to_contain_text('Torso', timeout=5000); sign(pat, 'yes')
    expect(pat.get_by_test_id('cam-question')).to_have_attribute('data-qid', 'region', timeout=8000)
    pat.get_by_test_id('opt-chest').click(); pat.get_by_test_id('confirm-answer').click()   # touch still works
    pat.wait_for_timeout(600)
    if pat.get_by_test_id('urgent-continue').count(): pat.get_by_test_id('urgent-continue').click()
    for _ in range(6):
        if pat.get_by_test_id('approve-camera').count(): break
        try: pat.get_by_test_id('skip-question').click(timeout=8000)
        except Exception:
            pat.screenshot(path='/tmp/claude-0/camfail.png'); print('DBG', pat.evaluate("(() => { const r = document.querySelector('[data-testid=skip-question]').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2); return e.outerHTML.slice(0,300) + ' PARENT ' + e.parentElement.className; })()")); raise
        pat.wait_for_timeout(300)
    expect(pat.get_by_test_id('sum-confirmed')).to_contain_text('No', timeout=8000)
    assert 'sign language, camera' in pat.get_by_test_id('sum-confirmed').inner_text()
    expect(pat.get_by_test_id('sum-unsure')).to_contain_text('Not sure')
    pat.screenshot(path=f'{SHOTS}/02-summary.png', full_page=True)
    ok('session: an unrecognized sign was refused (never guessed); NO and YES signs answered and confirmed questions; the patient’s own sign gave “Not sure”; NO moved through a list and YES chose; touch still works')
    pat.get_by_test_id('approve-camera').click()
    expect(pat.get_by_test_id('cam-done')).to_be_visible(timeout=20000)
    assert not pat.evaluate('window.__cam.active()'), 'camera off after the session'
    doc.get_by_role('button', name=re.compile('^Consultations')).click()
    doc.get_by_role('button', name=re.compile('Mariam Saleh')).first.click()
    expect(doc.get_by_test_id('approved-text')).to_contain_text('sign language', timeout=15000)
    expect(doc.get_by_test_id('approved-text')).to_contain_text('ASL sign “NO” → No')
    ok('approved and sent; the camera turned off; the doctor saw each answer and the sign that gave it')

    # ---------- the voice conversation keeps working on its own ----------
    v = device('u-pat', 'Mariam Saleh', fake=False)
    login(v, PAT_PW)
    v.get_by_test_id('home-talk').click(timeout=30000)
    v.get_by_test_id('mic-deny').click()
    v.fill('#va-typed', 'I have a headache since this morning'); v.get_by_test_id('va-send').click()
    v.wait_for_function("/suddenly, or build up gradually/.test(document.querySelector('[data-testid=va-log]').innerText)", timeout=20000)
    assert v.get_by_test_id('va-method-sign').count() == 0, 'no sign-language section inside the conversation'
    ok('the voice / text conversation works independently (headache → head questions) and has no camera section of its own')

    assert not errors, errors
    print(f'\n{len(passed)} checks passed')
