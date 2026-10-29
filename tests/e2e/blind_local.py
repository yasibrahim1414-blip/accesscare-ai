"""Blind Mode in the offline (single-device) build: account without email, login with Patient ID + password.
Speech engines are simulated as in blind_flow.py. Run: python3 tests/e2e/blind_local.py"""
import re
from playwright.sync_api import sync_playwright, expect
SPEECH = open(__file__.replace('blind_local.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(SPEECH)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('file:///home/claude/accesscare-ai/dist/accesscare-ai-standalone.html')
    def wait(pattern):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=15000)
        except Exception: print("SPOKE", pg.evaluate("window.__spoken")[-5:], pg.evaluate("window.__recStarts")); raise
    def say(t, pattern): pg.evaluate('window.__spoken.length = 0'); pg.evaluate('(t) => window.__heard.push(t)', t); wait(pattern)
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    pg.get_by_test_id('mic-allow').click()
    say('new account', 'saved only on this device'); say('yes', 'full name'); say('Omar Ali', 'I heard: Omar Ali'); say('yes', 'type a password')
    pg.fill('#va-password', 'local-pass-1'); pg.fill('#va-confirm', 'local-pass-1'); pg.evaluate('window.__spoken.length = 0'); pg.get_by_test_id('va-form-submit').click()
    wait(r'Your Patient ID is: A C\. P A T\.')
    pid = 'AC-PAT-' + ''.join(re.search(r'P A T\. ([2-9A-Z ]+)\. ([2-9A-Z ]+)\.', '\n'.join(pg.evaluate('window.__spoken'))).groups()).replace(' ', '')
    say('continue', 'recovery code'); say('continue', 'Doctor ID'); say('no', 'AI help is not available')
    say('log out', 'Log out'); say('yes', 'logged out'); wait('create a new account, or log in')
    say('log in', 'Patient ID or email')
    expect(pg.locator('#va-login')).to_be_visible(); pg.wait_for_timeout(300)  # the login form is on screen and settled
    pg.fill('#va-login', pid.lower()); pg.fill('#va-password', 'local-pass-1'); pg.evaluate('window.__spoken.length = 0'); pg.get_by_test_id('va-form-submit').click()
    wait('Welcome back')
    assert not errs, errs
    print('PASS offline build: account without email, Patient ID', pid, 'read aloud, logged out and back in with Patient ID + password')
