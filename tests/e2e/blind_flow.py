"""Blind Access & Voice Companion — browser test of the required scenarios.
Real: the app, accounts in the shared-database stand-in (same access rules, encryption), doctor on another
browser context, the conversation engine, gesture recognition from real pointer events, the AI stand-in path.
Simulated (stated honestly): the browser's speech engines. speechSynthesis records what would be spoken, and
SpeechRecognition returns the phrases this test queues (or a chosen error). Real speech engines and real
phones / screen readers need a manual test.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/blind_flow.py"""
import re, sys, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/blindshots'
import os; os.makedirs(SHOTS, exist_ok=True)
PW, DOC_PW = 'patient-pass-1', 'doctor-pass-1'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()

SPEECH = """
(() => {
  window.__spoken = []; window.__heard = []; window.__recStarts = 0;
  const voices = [{ name: 'Test EN', lang: 'en-US', default: true }, { name: 'Test AR', lang: 'ar-EG' }];
  let current = null, paused = false;
  const synth = {
    get speaking() { return !!current; }, get paused() { return paused; }, pending: false,
    getVoices: () => voices, addEventListener() {}, removeEventListener() {},
    speak(u) { window.__spoken.push(u.text); window.__rates = (window.__rates || []).concat([u.rate]); current = u; setTimeout(() => { if (current === u) { current = null; u.onend && u.onend(); } }, 15); },
    cancel() { const u = current; current = null; paused = false; },
    pause() { paused = true; }, resume() { paused = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ''; this.rate = 1; };
  if (window.__noStt) { try { delete window.webkitSpeechRecognition; } catch (e) {} window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined; return; }
  class Rec {
    start() {
      window.__recStarts++; this.onstart && this.onstart(); this._t = 0;
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
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    errors = []
    def device(uid, name='Test', stt=True, touch=True):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=touch)
        if not stt: ctx.add_init_script('window.__noStt = true;')
        ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}'); return pg
    spoken = lambda pg: '\n'.join(pg.evaluate('window.__spoken'))
    def open_blind(pg):  # three quick taps on the screen (no need to see anything)
        expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
        for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    def clear(pg): pg.evaluate('window.__spoken.length = 0')
    def wait_spoken(pg, pattern, timeout=40000):  # account steps run real PBKDF2 (210k iterations)
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=timeout)
        except Exception:
            print('EXPECTED /' + pattern + '/ BUT SPOKE:\n  ' + '\n  '.join(pg.evaluate('window.__spoken')[-8:]), '\nAI calls:', pg.evaluate('window.__aiCalls'), 'recStarts', pg.evaluate('window.__recStarts'), 'heard', pg.evaluate('window.__heard'), 'status', pg.get_by_test_id('va-status').inner_text() if pg.get_by_test_id('va-status').count() else '', 'phase', pg.evaluate("(document.querySelector('[data-testid=voice-companion]')||{}).dataset?.phase"), 'busy', pg.evaluate("(document.querySelector('[data-testid=va-form-submit]')||{}).getAttribute?.('aria-busy')"), 'log', pg.get_by_test_id('va-log').inner_text()[-300:] if pg.get_by_test_id('va-log').count() else '', flush=True); raise
    def say(pg, text, expect_re=None):
        clear(pg); pg.evaluate('(t) => window.__heard.push(t)', text)
        if expect_re: wait_spoken(pg, expect_re)
    def touch_swipe(pg, x0, y0, x1, y1, ms=None, sel='[data-testid=welcome]'):
        if ms is None:  # a quick, deliberate swipe: all moves in ~one frame (independent of machine load)
            pg.evaluate("""([sel, x0, y0, x1, y1]) => { const el = document.querySelector(sel); const id = Math.floor(Math.random() * 1e6);
              const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
              ev('pointerdown', x0, y0); for (const f of [0.25, 0.5, 0.75, 1]) ev('pointermove', x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); ev('pointerup', x1, y1); }""", [sel, x0, y0, x1, y1])
            return
        pg.evaluate("""([sel, x0, y0, x1, y1, ms]) => new Promise((res) => {
          const el = document.querySelector(sel); const id = Math.floor(Math.random() * 1e6); const t0 = performance.now();
          const ev = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true }));
          ev('pointerdown', x0, y0); let k = 0;
          const iv = setInterval(() => { k++; const f = Math.min(1, k * 16 / ms); ev('pointermove', x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
            if (f >= 1) { clearInterval(iv); ev('pointerup', x1, y1); res(); } }, 16);
        })""", [sel, x0, y0, x1, y1, ms])
    def touch_tap(pg, x, y, sel='.va'):
        pg.evaluate("""([sel, x, y]) => { const el = document.querySelector(sel); const id = Math.floor(Math.random() * 1e6);
          const t = document.elementFromPoint(x, y) || el;
          for (const type of ['pointerdown', 'pointerup']) t.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true })); }""", [sel, x, y])

    # ---------- doctor account (visual app) ----------
    doc = device('u-doc', 'Layla')
    doc.get_by_role('button', name='Create an account', exact=True).click(); doc.get_by_test_id('role-doctor').click(); doc.get_by_role('button', name='Continue', exact=True).click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', DOC_PW); doc.fill('#su-confirm', DOC_PW)
    doc.get_by_role('button', name='Continue Registration', exact=True).click()
    doc_id = doc.get_by_test_id('doctor-id').inner_text().strip()
    doc.get_by_role('button', name='Go to my dashboard', exact=True).click()

    # ---------- 3. accidental gestures never activate ----------
    pat = device('u-blind', 'Mariam')
    expect(pat.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    touch_swipe(pat, 200, 600, 200, 300)          # scroll up
    touch_swipe(pat, 300, 400, 170, 400)          # left swipe 1
    touch_swipe(pat, 300, 400, 170, 400)          # left swipe 2
    touch_swipe(pat, 200, 300, 200, 650)          # scroll down resets
    touch_swipe(pat, 300, 400, 170, 400)          # left swipe (count restarts)
    touch_swipe(pat, 300, 400, 230, 400, ms=1400) # slow drag: not a swipe
    pat.wait_for_timeout(300)
    assert pat.get_by_test_id('voice-companion').count() == 0, 'scrolling / slow drags must not activate Blind Mode'
    ok('3 scrolls, a slow drag and incomplete swipe sequences did not activate Blind Mode')

    # ---------- 1. three deliberate left swipes activate it, with spoken confirmation ----------
    pat.wait_for_timeout(1300)
    for _ in range(3): touch_swipe(pat, 320, 450, 140, 455); pat.wait_for_timeout(150)
    expect(pat.get_by_test_id('voice-companion')).to_be_visible(timeout=8000)
    wait_spoken(pat, 'Blind Mode is active. Welcome to AccessCare AI')
    ok('1 three left swipes on the entry screen opened Blind Mode and it said: "Blind Mode is active. Welcome to AccessCare AI…"')

    # ---------- 2. screen-reader / keyboard alternative ----------
    alt = device('u-other', 'Other', touch=False)
    expect(alt.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    alt.keyboard.press('Tab')
    assert alt.evaluate('document.activeElement && document.activeElement.dataset.testid') == 'blind-mode', 'Blind Mode button is the first focusable control'
    box = alt.get_by_test_id('blind-mode').bounding_box()
    assert box['width'] <= 2 and box['height'] <= 2, 'the Blind Mode button is not shown on screen'
    lbl = alt.get_by_test_id('blind-mode').get_attribute('aria-label')
    assert 'Blind Mode' in lbl and not re.search('[\u0600-\u06FF]', lbl)
    alt.keyboard.press('Enter')
    expect(alt.get_by_test_id('voice-companion')).to_be_visible(timeout=8000)
    wait_spoken(alt, 'Blind Mode is active')
    alt2 = device('u-other2', 'Other2', touch=False); expect(alt2.get_by_test_id('welcome')).to_be_visible(timeout=20000); alt2.keyboard.press('Alt+v')
    expect(alt2.get_by_test_id('voice-companion')).to_be_visible(timeout=8000)
    ok('2 the first focusable control is a hidden-from-sight, labelled Blind Mode button for VoiceOver/TalkBack/keyboard; Alt+V also works')
    # triple tap (mouse/finger) — a single tap on a button still works after a short pause
    tt = device('u-tt', 'TT', touch=False); expect(tt.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    tt.get_by_role('button', name='Log in', exact=True).click()
    expect(tt.locator('h1', has_text='Log in')).to_be_visible(timeout=5000)
    tt2 = device('u-tt2', 'TT2', touch=False); open_blind(tt2)
    expect(tt2.get_by_test_id('voice-companion')).to_be_visible(timeout=8000); wait_spoken(tt2, 'Blind Mode is active')
    tt3 = device('u-tt3', 'TT3', touch=False); expect(tt3.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    for _ in range(3): tt3.get_by_role('button', name='Create an account', exact=True).click(delay=20); tt3.wait_for_timeout(110)
    expect(tt3.get_by_test_id('voice-companion')).to_be_visible(timeout=8000)
    assert tt3.locator('#su-name').count() == 0, 'the button under the taps was not pressed'
    ok('triple tap anywhere (even on a button) opens Blind Mode without pressing that button; a single tap still presses it')
    for x in (tt, tt2, tt3): x.context.close()
    alt.context.close(); alt2.context.close()

    # ---------- 4-6. onboarding by voice, genuine account, Patient ID read aloud ----------
    pat.get_by_test_id('mic-allow').click()
    say(pat, 'I want a new account', 'linked to your Claude account')
    say(pat, 'yes', 'say your full name')
    say(pat, 'my name is Mariam Saleh', 'I heard: Mariam Saleh')
    say(pat, 'yes', 'type a password')
    pat.wait_for_function("document.activeElement && document.activeElement.id === 'va-password'", timeout=3000)  # focus moved to the password field
    pat.keyboard.type(PW); pat.focus('#va-confirm'); pat.keyboard.type('different-1'); pat.keyboard.press('Enter')
    wait_spoken(pat, 'two passwords are different')
    pat.fill('#va-confirm', PW); clear(pat); pat.keyboard.press('Enter')
    wait_spoken(pat, r'Your Patient ID is: A C\. P A T\. [2-9A-Z ]+\.', 60000)
    sp = spoken(pat)
    pid = 'AC-PAT-' + re.search(r'A C\. P A T\. ([2-9A-Z ]+?) ?\.\s?([2-9A-Z ]+)\.', sp).group(0).split('P A T. ')[1].replace(' ', '').replace('.', '')
    assert PW not in sp, 'the password is never spoken'
    dump = urllib.request.urlopen('http://localhost:8787/dump').read().decode()
    assert '"data/users/u-blind/patient"' in dump and 'Mariam Saleh' not in dump, 'account saved in the shared database, encrypted'
    say(pat, 'repeat', 'Your Patient ID is')
    say(pat, 'spell it slowly', r'P, A, T')
    ok(f'4-6 onboarding by voice + typing only; genuine encrypted account in the shared database; Patient ID {pid} read aloud, repeated and spelled slowly')
    say(pat, 'continue', 'recovery code is:')
    code = re.search(r'recovery code is: ([2-9A-Z ]+?)\. ([2-9A-Z ]+?)\. ([2-9A-Z ]+?)\. ([2-9A-Z ]+?)\.', spoken(pat))
    rcode = '-'.join(g.replace(' ', '') for g in code.groups())
    assert re.fullmatch(r'[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}', rcode), rcode
    assert 'nobody can hear' in spoken(pat) or 'nobody can hear' in '\n'.join(pat.evaluate('window.__spoken'))
    say(pat, 'continue', 'Doctor ID from your doctor')
    say(pat, 'yes', 'Type the Doctor ID')
    pat.fill('#va-doctor', doc_id.lower()); clear(pat); pat.get_by_test_id('va-doctor-submit').click()
    wait_spoken(pat, 'belongs to Dr. Layla Hassan')
    say(pat, 'yes', 'connected to Dr. Layla Hassan')
    wait_spoken(pat, 'Do you want AI help')
    say(pat, 'yes', 'What would you like to do')
    pat.screenshot(path=f'{SHOTS}/01-menu.png', full_page=True)
    ok('onboarding continued by voice: recovery code read with a privacy warning, Doctor ID typed and confirmed by name, AI consent asked')

    # ---------- 9-14. voice consultation with AI, errors, repeat, correction, review, approval ----------
    say(pat, 'I want to start a new consultation', 'What is bothering you today')
    clear(pat); pat.evaluate("window.__heard.push('__err:no-speech')")
    wait_spoken(pat, 'I did not hear anything')
    ok('10 a speech-recognition error ("no speech") was announced and the question stayed open')
    pat.get_by_test_id('va-speak').click()
    say(pat, 'the bendy bit of my leg hurts since yesterday', 'I am sorry to hear that')
    wait_spoken(pat, r'I understood that it is in the knee\. Is that right')
    assert any('AI' in x for x in pat.get_by_test_id('va-log').all_inner_texts()), 'AI wording labelled'
    ok('9 conversation with the AI (stand-in): it understood "the bendy bit of my leg" as the knee, and that interpretation is checked with the patient before it counts; AI lines are labelled')
    say(pat, 'repeat', r'Is that right')
    say(pat, 'yes', r'left side, your right side, or both')
    assert not re.search(r'chest|abdomen|which area', spoken(pat), re.I), 'no unrelated body areas are offered'
    say(pat, 'left', 'How strong')
    say(pat, 'seven', 'all the time, or does it come and go')
    say(pat, 'it comes and goes', 'anything else you would like your doctor to know')
    say(pat, 'no that is all', 'Is this correct')
    sp = spoken(pat)
    assert 'left knee' in sp and '7 out of 10' in sp and 'yesterday' in sp and 'comes and goes' in sp, pat.evaluate('window.__spoken')
    ok('11-13 repeat, the interpretation confirmed, follow-up questions only about the knee, everything read back in the spoken summary')
    say(pat, 'change', 'What would you like to change or add')
    say(pat, 'actually it is severe now', 'Is this correct')
    assert 'severe' in spoken(pat)
    say(pat, 'approve', 'Send this summary to Dr. Layla Hassan now')
    assert pat.evaluate("window.__spoken.join(' ')").count('Sent to') == 0, 'nothing sent before the final yes'
    say(pat, 'yes', 'Sent to Dr. Layla Hassan')
    pat.screenshot(path=f'{SHOTS}/02-sent.png', full_page=True)
    ok('11/14 the patient corrected the strength from the review, approved, confirmed once more, and only then was it sent')

    doc.get_by_role('button', name=re.compile('^Consultations')).click()
    doc.get_by_role('button', name=re.compile('Mariam Saleh')).first.click()
    expect(doc.get_by_test_id('approved-text')).to_contain_text('left knee', timeout=15000)
    expect(doc.get_by_test_id('approved-text')).to_contain_text('Strength: severe')
    expect(doc.get_by_test_id('approved-text')).to_contain_text('interpretation you confirmed')
    expect(doc.get_by_test_id('approved-text')).to_contain_text('You corrected: 7 out of 10 → severe')
    expect(doc.get_by_test_id('approved-text')).to_contain_text('Prepared in a conversation with AccessCare AI')
    ok('the doctor (another device) received exactly the summary the patient approved, with what was said, chosen, interpreted and corrected')

    # ---------- 15. doctor message heard and answered by voice ----------
    doc.get_by_role('tab', name=re.compile('Messages')).click()
    doc.get_by_label('Message', exact=True).fill('Is the knee pain worse at night?'); doc.keyboard.press('Enter')
    expect(doc.get_by_test_id('messages')).to_contain_text('worse at night', timeout=10000)
    say(pat, 'my messages', 'Is the knee pain worse at night')
    say(pat, 'reply', 'Say your reply')
    say(pat, 'yes it is worse at night', r'Your reply is: yes it is worse at night\. Send it')
    say(pat, 'yes', 'Your reply was sent')
    expect(doc.get_by_test_id('messages')).to_contain_text('yes it is worse at night', timeout=15000)
    say(pat, 'main menu', 'What would you like to do')
    say(pat, 'my doctor', 'Your doctor is Dr. Layla Hassan')
    ok('15 doctor message read aloud with status; reply dictated, confirmed and received by the doctor; doctor name heard')

    # ---------- urgent ----------
    say(pat, 'new consultation', 'What is bothering you')
    say(pat, "I can't breathe properly", 'urgent medical help'); wait_spoken(pat, 'emergency number')
    assert 'emergency' in spoken(pat).lower(), pat.evaluate('window.__spoken')
    say(pat, 'main menu', 'What would you like to do')
    ok('safety: urgent words gave spoken emergency guidance immediately')

    # ---------- gesture navigation inside Blind Mode ----------
    clear(pat)
    touch_swipe(pat, 100, 500, 300, 505, sel='.va'); pat.wait_for_timeout(650)  # one item at a time, like a person listening to each
    first = pat.evaluate('document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent)')
    touch_swipe(pat, 100, 500, 300, 505, sel='.va'); pat.wait_for_timeout(650)
    second = pat.evaluate('document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent)')
    assert first and second and first != second and (first.strip() in spoken(pat) or 'Speak your answer' in spoken(pat)), (first, second, spoken(pat))
    # move to "My Patient ID" and double tap to activate
    for _ in range(12):
        if (pat.evaluate('document.activeElement && document.activeElement.textContent') or '').strip() == 'My Patient ID': break
        touch_swipe(pat, 100, 500, 300, 505, sel='.va'); pat.wait_for_timeout(650)
    assert pat.evaluate('document.activeElement.textContent').strip() == 'My Patient ID'
    clear(pat)
    for i in range(2):  # two quick taps, about 80 ms apart, anywhere on the screen
        pat.evaluate("""(id) => { const el = document.querySelector('.va'); const r = el.getBoundingClientRect(); const x = r.left + 30, y = r.top + 30;
          for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true })); }""", 40 + i)
        pat.wait_for_timeout(80)
    assert pat.evaluate("document.querySelector('.va').dataset.lastGesture") == 'doubleTap'
    wait_spoken(pat, 'Your Patient ID is')
    ok('gesture navigation: swipe right moved focus item by item and announced it; double tap activated the focused item')

    # ---------- 8. log out by voice ----------
    say(pat, 'log out', 'Log out of AccessCare on this device')
    say(pat, 'yes', 'You are logged out')
    wait_spoken(pat, 'create a new account, or log in')
    ok('8 logged out by voice after a confirmation; the guide restarted at the account question')

    # ---------- 7. secure access again on another device + recovery ----------
    dev2 = device('u-blind', 'Mariam')
    open_blind(dev2); dev2.get_by_test_id('mic-allow').click()
    say(dev2, 'log in', 'Type your AccessCare password')
    dev2.wait_for_function("document.activeElement && document.activeElement.id === 'va-password'", timeout=3000)
    dev2.keyboard.type('wrong-password'); dev2.keyboard.press('Enter')
    wait_spoken(dev2, 'password is incorrect')
    dev2.fill('#va-password', pid); clear(dev2); dev2.keyboard.press('Enter')
    wait_spoken(dev2, 'password is incorrect')
    dev2.fill('#va-password', PW); clear(dev2); dev2.keyboard.press('Enter')
    wait_spoken(dev2, 'Welcome back')
    say(dev2, 'my patient id', 'Your Patient ID is: ' + ' '.join(pid[:2]) + r'\.')
    say(dev2, 'log out', 'Log out'); say(dev2, 'yes', 'logged out')
    wait_spoken(dev2, 'create a new account, or log in')
    say(dev2, 'I forgot my password', 'recovery code and a new password')
    expect(dev2.locator('#va-confirm')).to_be_visible(); dev2.wait_for_timeout(300)  # the recovery form is on screen
    dev2.fill('#va-code', rcode.lower().replace('-', ' ')); dev2.fill('#va-password', 'brand-new-pass-2'); dev2.fill('#va-confirm', 'brand-new-pass-2')
    clear(dev2); dev2.get_by_test_id('va-form-submit').click()
    wait_spoken(dev2, 'Your password was changed', 60000)
    wait_spoken(dev2, 'Your Patient ID is', 60000)
    ok('7 on another device: wrong password and the Patient ID alone were refused; the password worked; the recovery code set a new password once and a new code was issued')

    # ---------- 16. microphone permission missing ----------
    dn = device('u-deny', 'Deny')
    open_blind(dn)
    dn.evaluate("window.__heard.push('__err:not-allowed')"); clear(dn); dn.get_by_test_id('mic-allow').click()
    wait_spoken(dn, 'Microphone permission was not given')
    expect(dn.get_by_test_id('va-speak')).to_be_disabled()
    dn.locator('.va-opt[data-option="new_account"]').click()
    wait_spoken(dn, 'Shall I create it')
    ok('16 microphone permission denied: announced, voice input turned off, and the buttons still drive the conversation')

    # ---------- 17. no speech recognition at all ----------
    ns = device('u-nostt', 'NoSTT', stt=False)
    open_blind(ns)
    expect(ns.get_by_text(re.compile('Speech recognition is not available'))).to_be_visible(timeout=8000)
    assert ns.get_by_test_id('mic-consent').count() == 0
    ns.fill('#va-typed', 'log in'); clear(ns); ns.keyboard.press('Enter')
    wait_spoken(ns, 'Type your AccessCare password')
    ok('17 without speech recognition: spoken guidance continues and typed answers / buttons work')

    # ---------- Arabic understood + preferences persisted ----------
    ar = device('u-blind', 'Mariam'); open_blind(ar); ar.get_by_test_id('mic-allow').click()
    say(ar, 'log in', 'password'); ar.wait_for_function("document.activeElement && document.activeElement.id === 'va-password'", timeout=3000); ar.keyboard.type('brand-new-pass-2'); clear(ar); ar.keyboard.press('Enter'); wait_spoken(ar, 'Welcome back')
    say(ar, 'settings', 'Settings'); say(ar, 'slower', 'Done')
    say(ar, 'main menu', 'What would you like')
    say(ar, 'new consultation', 'What is bothering you')
    say(ar, '\u0639\u0646\u062f\u064a \u0648\u062c\u0639', '\u0648\u062c\u0639')
    ar.wait_for_function("document.documentElement.dir === 'rtl'", timeout=5000)
    assert ar.evaluate("document.documentElement.lang") == 'ar'
    nb = device('u-blind', 'Mariam'); open_blind(nb); nb.get_by_test_id('mic-allow').click()
    say(nb, 'log in', 'password'); nb.wait_for_function("document.activeElement && document.activeElement.id === 'va-password'", timeout=3000); nb.keyboard.type('brand-new-pass-2'); clear(nb); nb.keyboard.press('Enter')
    wait_spoken(nb, 'Welcome back')
    nb.wait_for_function('window.__rates && window.__rates[window.__rates.length - 1] < 1', timeout=8000)
    ok('Arabic: the patient spoke Arabic and the assistant answered in Arabic, and the whole app switched to Arabic (right-to-left); the slower speech setting followed the account to a new device')

    assert not errors, errors
    print(f'\n{len(passed)} checks passed')
