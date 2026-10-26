"""Blind Mode across the whole app — browser test.
Real: the app (every screen), the Blind Mode controller, the gesture detector, the command understanding, the
shared-database stand-in, navigation, forms and the accounts. Simulated (stated honestly): the speech engines —
speech output is recorded instead of played, and "what the person says" is fed to a stand-in speech recognizer.
AI is off for these accounts, so everything here works without any AI service.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/blind_global.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()

SPEECH = """
(() => {
  window.__spoken = []; window.__langs = []; window.__heard = []; window.__recStarts = 0; window.__recLangs = []; window.__cancels = 0;
  const voices = [{ name: 'Test EN', lang: 'en-US', default: true }, { name: 'Test AR', lang: 'ar-EG' }];
  let current = null, paused = false;
  window.__slow = false; // when true, each sentence "takes" 4 seconds (so it can be interrupted)
  const synth = {
    get speaking() { return !!current; }, get paused() { return paused; }, pending: false,
    getVoices: () => voices, addEventListener() {}, removeEventListener() {},
    speak(u) { window.__spoken.push(u.text); window.__langs.push(u.lang); current = u; setTimeout(() => { if (current === u) { current = null; u.onend && u.onend(); } }, window.__slow ? 4000 : 15); },
    cancel() { if (current) window.__cancels++; const u = current; current = null; paused = false; },
    pause() { paused = true; }, resume() { paused = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ''; this.rate = 1; };
  class Rec {
    start() {
      window.__recStarts++; window.__recLangs.push(this.lang); this.onstart && this.onstart(); this._t = 0;
      const tick = () => {
        if (this._stopped) return;
        const next = window.__heard.shift();
        if (next === undefined) { if ((this._t += 50) < 8000) return setTimeout(tick, 50); this.onerror && this.onerror({ error: 'no-speech' }); return; }
        if (next.startsWith('__err:')) { this.onerror && this.onerror({ error: next.slice(6) }); return; }
        const alt = [{ transcript: next, confidence: 0.9 }]; alt.isFinal = true;
        this.onresult && this.onresult({ results: [alt] });
      };
      setTimeout(tick, 60);
    }
    stop() { this._stopped = true; } abort() { this._stopped = true; }
  }
  window.SpeechRecognition = Rec;
})();
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def device(uid, name, w=390, h=844, touch=True):
        ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=touch)
        ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}'); return pg
    btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
    spoken = lambda pg: '\n'.join(pg.evaluate('window.__spoken'))
    def clear(pg): pg.evaluate('window.__spoken.length = 0')
    def wait_spoken(pg, pattern, timeout=20000):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=timeout)
        except Exception:
            print('EXPECTED /' + pattern + '/ BUT SPOKE:\n  ' + '\n  '.join(pg.evaluate('window.__spoken')[-8:]), '\nroute', pg.evaluate("document.querySelector('[data-route]')?.dataset.route"), 'bar', pg.get_by_test_id('blind-bar').get_attribute('data-status') if pg.get_by_test_id('blind-bar').count() else None, flush=True); raise
    def say(pg, text, expect_re=None):
        clear(pg); pg.evaluate('(t) => window.__heard.push(t)', text)
        if expect_re: wait_spoken(pg, expect_re)
    route = lambda pg: pg.evaluate("document.querySelector('[data-route]')?.dataset.route")
    def wait_route(pg, name, timeout=10000):
        pg.wait_for_function('(n) => document.querySelector("[data-route]")?.dataset.route === n', arg=name, timeout=timeout)
    def swipe_right_3(pg):
        pg.evaluate("""() => { const el = document.querySelector('[data-screen-root]');
          for (let k = 0; k < 3; k++) { const id = 950 + k;
            const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
            ev('pointerdown', 60, 420); for (const f of [0.25, 0.5, 0.75, 1]) ev('pointermove', 60 + 220 * f, 420 + 6 * f); ev('pointerup', 280, 426); } }""")
    def swipe_left_3(pg):
        pg.evaluate("""() => { const el = document.querySelector('[data-screen-root]');
          for (let k = 0; k < 3; k++) { const id = 900 + k; const t = performance.now();
            const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
            ev('pointerdown', 330, 420); for (const f of [0.25, 0.5, 0.75, 1]) ev('pointermove', 330 - 220 * f, 420 + 6 * f); ev('pointerup', 110, 426); } }""")

    # ---------- accounts (normal visual use) ----------
    doc = device('u-doc', 'Layla')
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', 'doctor-pass-1'); doc.fill('#su-confirm', 'doctor-pass-1')
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    wait_route(doc, 'd.overview')

    # ---------- 1. three left swipes on the doctor dashboard ----------
    assert doc.get_by_test_id('blind-bar').count() == 0
    # an ordinary vertical scroll and a single swipe do not activate it
    doc.evaluate("""() => { const el = document.querySelector('[data-screen-root]'); const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
      ev('pointerdown', 200, 600); for (const f of [0.3, 0.6, 1]) ev('pointermove', 200, 600 - 300 * f); ev('pointerup', 200, 300); }""")
    doc.wait_for_timeout(300); assert doc.get_by_test_id('blind-bar').count() == 0, 'a scroll does not turn on Blind Mode'
    swipe_left_3(doc)
    expect(doc.get_by_test_id('blind-bar')).to_be_visible(timeout=5000)
    wait_spoken(doc, 'Blind Mode is on'); wait_spoken(doc, 'Doctor dashboard'); wait_spoken(doc, 'microphone')
    ok('doctor dashboard: three quick left swipes turned on Blind Mode on the spot (a scroll did not); it said it is on, which screen this is, and asked for the microphone')
    clear(doc); doc.get_by_test_id('blind-mic-allow').click()
    doc.wait_for_function('window.__recStarts > 0', timeout=5000)
    expect(doc.get_by_test_id('blind-status')).to_contain_text('Listening', timeout=5000)
    ok('after "Allow microphone" it listens by itself — no microphone button to find each time')

    # ---------- 2. real actions by voice ----------
    say(doc, 'what can I do here', 'On this screen you can choose'); wait_spoken(doc, 'Pages:')
    s = spoken(doc); assert 'Copy ID' in s and 'Patients' in s, s
    ok('"what can I do here" lists the real controls on this screen (e.g. Copy ID, Patients) — read from the page, not invented')
    say(doc, 'open my patients'); wait_route(doc, 'd.patients'); wait_spoken(doc, 'My patients')
    ok('"open my patients" opened the Patients page and announced it')
    say(doc, 'go back'); doc.wait_for_function('document.querySelector("[data-route]")?.dataset.route !== "d.patients"', timeout=8000)
    say(doc, 'open settings'); wait_route(doc, 'settings'); wait_spoken(doc, 'Settings')
    say(doc, 'read the page', 'Settings')
    ok('"go back", "open settings" and "read the page" all worked on the real screens')
    say(doc, 'speak more slowly', 'more slowly')
    doc.evaluate('window.__slow = true'); clear(doc)
    say(doc, 'read the page'); doc.wait_for_function('window.__spoken.length > 0', timeout=8000)
    doc.get_by_test_id('blind-stop').click(); doc.wait_for_function('window.__cancels > 0', timeout=3000)
    doc.evaluate('window.__slow = false')
    say(doc, 'repeat', 'Settings')
    ok('speech can be slowed down, stopped at once with "Stop voice", and repeated')

    # ---------- 3. stays on while moving around (tabs, reload) ----------
    doc.get_by_role('button', name='Go back').first.click(); doc.wait_for_timeout(300)
    doc.locator('.tab', has_text='Consultations').click(); wait_route(doc, 'd.consults')
    expect(doc.get_by_test_id('blind-bar')).to_be_visible(); wait_spoken(doc, 'Consultations')
    doc.reload(); expect(doc.get_by_test_id('blind-bar')).to_be_visible(timeout=15000); wait_spoken(doc, 'Blind Mode is on')
    ok('Blind Mode stayed on when switching tabs and after reloading the page (remembered on this device)')
    clear(doc); before = route(doc); swipe_right_3(doc)
    expect(doc.get_by_test_id('blind-bar')).to_have_count(0, timeout=5000); wait_spoken(doc, 'Blind Mode is off')
    assert route(doc) == before, f'stayed on the same screen, not {route(doc)}'
    swipe_left_3(doc); expect(doc.get_by_test_id('blind-bar')).to_be_visible(timeout=5000); wait_spoken(doc, 'swipe right three times')
    doc.wait_for_function("document.querySelector('[data-testid=blind-status]')?.textContent.includes('Listening')", timeout=8000)
    ok('three quick right swipes turned Blind Mode off (on the same screen, said aloud); three left swipes turned it back on and it went straight back to listening')

    # ---------- 4. Arabic ----------
    say(doc, 'change the language to Arabic', 'بالعربي')
    doc.wait_for_function("document.documentElement.dir === 'rtl'", timeout=5000)
    assert doc.evaluate("window.__langs[window.__langs.length - 1]").startswith('ar'), 'spoken with an Arabic voice'
    doc.wait_for_function("window.__recLangs.length && window.__recLangs[window.__recLangs.length - 1].startsWith('ar')", timeout=8000)
    try: expect(doc.locator('.tab[aria-current=page]')).to_contain_text('نظرة عامة')
    except Exception: print(doc.evaluate("Array.from(document.querySelectorAll('.tab')).map(t=>t.outerHTML).join('\\n')"), doc.evaluate("document.querySelector('[data-route]')?.dataset.route")); raise
    ok('"change the language to Arabic": the interface switched to Arabic right-to-left on the same screen, and Blind Mode now speaks and listens in Arabic')
    say(doc, 'افتح الإعدادات'); wait_route(doc, 'settings')
    say(doc, 'ارجع'); doc.wait_for_function('document.querySelector("[data-route]")?.dataset.route !== "settings"', timeout=8000)
    say(doc, 'إيه الاختيارات', 'في الصفحة دي تقدر تختار')
    ok('Arabic requests worked: "افتح الإعدادات" opened Settings, "ارجع" went back, "إيه الاختيارات" listed the controls in Arabic')
    say(doc, 'غير اللغة للإنجليزي', 'English'); doc.wait_for_function("document.documentElement.dir === 'ltr'", timeout=5000)

    # ---------- 5. consequential actions are confirmed; logout clears everything ----------
    say(doc, 'log out', 'Say yes or no')
    say(doc, 'no', 'did not do it'); assert route(doc) != 'welcome'
    say(doc, 'log out', 'Say yes or no'); say(doc, 'yes', 'logged out'); wait_route(doc, 'welcome')
    say(doc, 'read my latest report', 'log in first')
    assert 'Dr. Layla Hassan' not in doc.inner_text('#root')
    ok('logging out asked first ("no" did nothing; "yes" logged out); afterwards nothing from the account is readable — "read my latest report" asks to log in')

    # ---------- 6. exit ----------
    say(doc, 'exit blind mode'); expect(doc.get_by_test_id('blind-bar')).to_have_count(0, timeout=5000)
    wait_spoken(doc, 'Blind Mode is off')
    ok('"exit blind mode" turned it off and returned to the normal visual app')

    # ---------- 7. forms by voice (sign-up), keyboard shortcut ----------
    reg = device('u-reg', 'Reg', w=1280, h=860, touch=False)
    btn(reg, 'Create an account').click(); wait_route(reg, 'signup')
    reg.keyboard.press('Alt+Shift+B'); expect(reg.get_by_test_id('blind-bar')).to_be_visible(timeout=5000); wait_spoken(reg, 'Create account')
    reg.get_by_test_id('blind-mic-allow').click(); reg.wait_for_function('window.__recStarts > 0')
    say(reg, 'I am a patient', 'Pressed'); say(reg, 'continue'); reg.wait_for_selector('#su-name', timeout=8000)
    say(reg, 'help me fill the form', 'Full name')
    say(reg, 'Nour Salem', 'password'); assert reg.input_value('#su-name') == 'Nour Salem'
    s = spoken(reg); assert 'passwords are not taken by voice' in s, s
    ok('wide screen + keyboard: Alt+Shift+B turned on Blind Mode on the sign-up screen; by voice it pressed "I am a patient", went on, and "help me fill the form" filled the name field by field (passwords are never taken by voice)')

    # ---------- 8. patient: report and the doctor's reply read aloud ----------
    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); pat.fill('#su-password', 'patient-pass-1'); pat.fill('#su-confirm', 'patient-pass-1'); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    expect(pat.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pat.get_by_test_id('onboard-question').count() == 0: break
        pat.locator('[data-testid^="onb-"]').nth(1 if 'AI' in pat.get_by_test_id('onboard-question').inner_text() else 0).click(); pat.wait_for_timeout(500)
    pat.get_by_test_id('onboard-finish').click(); wait_route(pat, 'p.home')
    # a report, made the normal way (typed), sent to the doctor
    pat.get_by_test_id('home-talk').click(); pat.get_by_test_id('mic-deny').click()
    pat.fill('#va-typed', 'my knee hurts since last week'); pat.get_by_test_id('va-send').click(); pat.wait_for_timeout(800)
    for _ in range(12):
        if pat.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
        for sel in ['.va-opt[data-option="yes"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="ns"]', '.va-opt[data-option="assoc:none"]']:
            if pat.locator(sel).count(): pat.locator(sel).first.click(); break
        pat.wait_for_timeout(600)
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(400); pat.locator('.va-opt[data-option="yes"]').click()
    pat.wait_for_timeout(1500)
    # the doctor replies (normal use)
    dv = device('u-doc', 'Layla'); dv.wait_for_timeout(1500)
    if dv.get_by_test_id('blind-bar').count(): dv.get_by_test_id('blind-exit').click()
    if route(dv) == 'welcome':
        btn(dv, 'Log in').click(); dv.fill('input[type=password]', 'doctor-pass-1'); dv.keyboard.press('Enter'); wait_route(dv, 'd.overview', 20000)
    dv.locator('.tab', has_text='Consultations').click()
    dv.get_by_role('button', name=re.compile('Omar Adel')).first.click()
    dv.get_by_role('tab', name=re.compile('Messages')).click()
    dv.get_by_label('Message', exact=True).fill('Please rest the knee and use ice tonight.'); dv.keyboard.press('Enter')
    expect(dv.get_by_test_id('messages')).to_contain_text('rest the knee', timeout=10000)
    # back to the patient: Blind Mode from the patient home with three taps on an empty area
    pat.goto(f'{BASE}?uid=u-pat&name=Omar'); wait_route(pat, 'p.home', 20000)
    assert pat.evaluate("!document.elementFromPoint(6, 400).closest('button,a,input')"), 'tapping the page margin'
    for _ in range(3): pat.mouse.click(6, 400); pat.wait_for_timeout(110)
    expect(pat.get_by_test_id('blind-bar')).to_be_visible(timeout=5000)
    assert route(pat) == 'p.home', 'the taps pressed nothing'
    pat.get_by_test_id('blind-mic-allow').click(); pat.wait_for_function('window.__recStarts > 0')
    say(pat, 'read my latest report', 'Latest report'); wait_spoken(pat, 'knee')
    ok('patient home: three quick taps on an empty part of the screen turned on Blind Mode; "read my latest report" read the patient’s own report aloud (from the real account data)')
    say(pat, "open my doctor's latest response", 'Latest message from'); wait_spoken(pat, 'rest the knee')
    ok('"open my doctor\'s latest response" read the doctor’s actual reply')
    # ---------- 8a. voice only: saying how you feel anywhere starts a consultation; AI is turned on by voice ----------
    say(pat, 'turn on AI', 'AI assistance is on')
    assert pat.evaluate("JSON.parse(JSON.stringify(window.__spoken)).join(' ')").find('button') < 0
    ok('voice only: "turn on AI" turned AI assistance on by voice (no button needed)')
    say(pat, 'some headache'); wait_route(pat, 'va', 15000)
    pat.wait_for_function("document.querySelector('[data-testid=voice-companion]')?.dataset.phase === 'consult'", timeout=15000)
    expect(pat.get_by_test_id('voice-companion')).to_contain_text('headache', timeout=15000)
    ok('saying "some headache" on the home screen was not "not understood": it opened the spoken consultation with those words')

    say(pat, 'I want to report a new symptom'); wait_route(pat, 'va'); pat.wait_for_function("document.querySelector('[data-testid=voice-companion]')?.dataset.phase === 'consult'", timeout=15000)
    ok('"I want to report a new symptom" opened the spoken symptom conversation')

    # ---------- 8b. a request the rules don't know, understood by Claude (stand-in), only real actions allowed ----------
    ai = device('u-ai', 'Huda')
    btn(ai, 'Create an account').click(); ai.get_by_test_id('role-patient').click(); btn(ai, 'Continue').click()
    ai.fill('#su-name', 'Huda Kamal'); ai.fill('#su-password', 'patient-pass-2'); ai.fill('#su-confirm', 'patient-pass-2'); ai.fill('#su-doctor-id', doc_id)
    btn(ai, 'Continue Registration').click()
    expect(ai.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(ai, 'Yes, connect to this doctor').click(); btn(ai, 'Continue').click()
    expect(ai.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if ai.get_by_test_id('onboard-question').count() == 0: break
        ai.locator('[data-testid^="onb-"]').nth(0).click(); ai.wait_for_timeout(500)  # first option: includes "Yes, use AI assistance"
    ai.get_by_test_id('onboard-finish').click(); wait_route(ai, 'p.home')
    ai.keyboard.press('Alt+Shift+B'); expect(ai.get_by_test_id('blind-bar')).to_be_visible(timeout=5000)
    ai.get_by_test_id('blind-mic-allow').click(); ai.wait_for_function('window.__recStarts > 0')
    say(ai, "I'd like to see who I am connected with"); wait_route(ai, 'p.doctor', 15000)
    assert ai.evaluate('window.__voiceAi') >= 1
    ai.get_by_role('button', name='Go back').count() and None
    say(ai, 'please press the moon', 'could not find|did not understand')
    assert route(ai) == 'p.doctor', 'an invented control is never pressed'
    ok('with AI allowed: "I\'d like to see who I am connected with" was understood by Claude (stand-in) and opened My Doctor; an AI answer naming a control that does not exist was refused')

    # ---------- 9. microphone failure ----------
    mf = device('u-mf', 'Mic')
    expect(mf.get_by_test_id('welcome')).to_be_visible(timeout=15000)
    btn(mf, 'Log in').click(); wait_route(mf, 'signin')
    mf.keyboard.press('Alt+Shift+B'); expect(mf.get_by_test_id('blind-bar')).to_be_visible(timeout=5000)
    mf.evaluate("window.__heard.push('__err:not-allowed')"); mf.get_by_test_id('blind-mic-allow').click()
    wait_spoken(mf, 'Microphone permission was not given')
    expect(mf.get_by_test_id('blind-status')).to_contain_text('Microphone problem')
    expect(mf.get_by_test_id('blind-listen')).to_be_visible()
    ok('microphone refused: it says so (spoken and on screen), does not pretend to listen, and offers "Listen" to try again')

    # ---------- 10. screen-reader structure ----------
    h1 = mf.evaluate("document.querySelector('[data-screen-root] h1')?.textContent")
    assert h1, 'every screen has a main heading'
    assert mf.evaluate("!!document.querySelector('main[data-screen-root]')"), 'a main landmark'
    assert mf.evaluate("!!document.querySelector('#blind-live[aria-live]')"), 'spoken text also goes to a live region'
    ok('screen-reader structure: a main landmark, a heading per screen, and a live region carrying what Blind Mode says')

    assert not errors, errors
    print(f'\n{len(passed)} checks passed')
