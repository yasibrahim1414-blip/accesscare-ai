"""AI connection problems are shown loudly with the cause and fix (web build, real worker code in the test server,
fake Claude API behind it). Modes simulate: an old worker, a missing key, no API credit.
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/ai_health_flow.py"""
import urllib.request
from playwright.sync_api import sync_playwright, expect
SPEECH = open(__file__.replace('ai_health_flow.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]
mode = lambda m: urllib.request.urlopen('http://localhost:8787/ai-mode?m=' + m).read()
urllib.request.urlopen('http://localhost:8787/reset').read()
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
    mode('old')
    say('yes', 'What would you like to do')
    expect(pg.get_by_test_id('va-ai-problem')).to_contain_text('older version', timeout=15000)
    expect(pg.get_by_test_id('va-ai-problem')).to_contain_text('cloudflare-worker.mjs')
    print('PASS old worker: a red banner says AI is not working, why (old worker version) and how to fix it')
    mode('nokey'); pg.get_by_test_id('va-ai-test').click()
    expect(pg.get_by_test_id('va-ai-problem')).to_contain_text('ANTHROPIC_API_KEY', timeout=15000)
    print('PASS missing key: the banner names the ANTHROPIC_API_KEY secret')
    mode('ok'); pg.get_by_test_id('va-ai-test').click()
    expect(pg.get_by_test_id('va-ai-ok')).to_be_visible(timeout=15000)
    assert pg.get_by_test_id('va-ai-problem').count() == 0
    print('PASS fixed: "Test AI connection again" sends a real request and the banner goes away (AI connected)')
    mode('credit')
    say('new consultation', 'What is bothering you')
    pg.evaluate('(t) => window.__heard.push(t)', 'my tummy feels funny since lunch')
    expect(pg.get_by_test_id('va-ai-problem')).to_contain_text('credit', timeout=30000)
    print('PASS no credit: a failed conversation turn shows the banner with the real cause from Claude (no credit)')
    assert not errs, errs
