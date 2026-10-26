"""Web build (like GitHub Pages) with real AI through the Claude proxy: server/cloudflare-worker.mjs runs inside the
test server and forwards to a fake Claude API (the only simulated piece besides the speech engines).
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/blind_web.py"""
import urllib.request
from playwright.sync_api import sync_playwright, expect
SPEECH = open(__file__.replace('blind_web.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]
calls = lambda: int(urllib.request.urlopen('http://localhost:8787/ai-calls').read())
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(SPEECH)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html')
    def wait(pattern):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=30000)
        except Exception: print('SPOKE', pg.evaluate('window.__spoken')[-6:]); raise
    def say(t, pattern): pg.evaluate('window.__spoken.length = 0'); pg.evaluate('(t) => window.__heard.push(t)', t); wait(pattern)
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    wait('Blind Mode is active'); pg.get_by_test_id('mic-allow').click()
    say('new account', 'only on this device'); say('yes', 'full name'); say('Sara Ahmed', 'I heard: Sara Ahmed'); say('yes', 'type a password')
    pg.fill('#va-password', 'web-pass-123'); pg.fill('#va-confirm', 'web-pass-123'); pg.evaluate('window.__spoken.length = 0'); pg.get_by_test_id('va-form-submit').click()
    wait('Your Patient ID is'); say('continue', 'recovery code'); say('continue', 'Doctor ID')
    say('no', 'the AI service from Anthropic')
    before = calls()
    say('yes', 'What would you like to do')
    say('new consultation', 'What is bothering you')
    say('the bendy bit of my leg hurts since yesterday', 'I am sorry to hear that')
    wait(r'I understood that it is in the knee\. Is that right')
    say('yes', 'left side, your right side')
    say('I am worried', 'worried')  # the stand-in answers with false reassurance: the app must not say it
    assert "Don't worry" not in '\n'.join(pg.evaluate('window.__spoken')), 'false reassurance was refused'
    assert calls() > before, 'the Claude proxy was used'
    log = pg.get_by_test_id('va-log').inner_text()
    assert 'I am sorry to hear that' in log
    assert not errs, errs
    print(f'PASS web build: AI conversation through the Claude proxy ({calls() - before} calls): an unclear phrase interpreted and confirmed, false reassurance refused (rules used instead); no key in the page')
    html = open('dist/web/index.html').read()
    assert 'sk-ant' not in html and 'x-api-key' not in html
