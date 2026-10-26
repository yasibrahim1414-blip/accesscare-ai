"""Teach-back and "Here?" with AI on, in Arabic, answered by voice — browser test.
Real: the app, the rules, the shared-database stand-in, two devices. Simulated (stated honestly): Claude is a
deterministic stand-in (tests/e2e/cloudServer.ts fakeTeach / fakeConverse) and speech engines are simulated.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/interact_ai_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect
BASE = 'http://localhost:8787/app'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()
SPEECH = open(__file__.replace('interact_ai_flow.py', 'blind_global.py')).read().split('SPEECH = """')[1].split('"""')[0]

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def device(uid, name):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}'); return pg
    btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
    doc = device('u-doc', 'Layla')
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', 'doctor-pass-1'); doc.fill('#su-confirm', 'doctor-pass-1')
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); pat.fill('#su-password', 'patient-pass-1'); pat.fill('#su-confirm', 'patient-pass-1'); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    expect(pat.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pat.get_by_test_id('onboard-question').count() == 0: break
        pat.locator('[data-testid^="onb-"]').nth(0).click(); pat.wait_for_timeout(500)   # includes "Yes, use AI assistance"
    pat.get_by_test_id('onboard-finish').click()
    # a report, typed in Talk to AccessCare, sent to the doctor
    pat.get_by_test_id('home-talk').click(); pat.get_by_test_id('mic-deny').click()
    pat.fill('#va-typed', 'my knee hurts since last week'); pat.get_by_test_id('va-send').click(); pat.wait_for_timeout(1000)
    for _ in range(14):
        if pat.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
        for sel in ['.va-opt[data-option="yes"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="ns"]', '.va-opt[data-option="assoc:none"]']:
            if pat.locator(sel).count(): pat.locator(sel).first.click(); break
        pat.wait_for_timeout(700)
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(400); pat.locator('.va-opt[data-option="yes"]').click(); pat.wait_for_timeout(1500)

    # doctor: explanation of the visit (no prescription) + "Here?"
    doc.reload(); doc.get_by_role('button', name=re.compile('^Consultations')).click()
    doc.locator('.list .list-item').first.click(); doc.get_by_test_id('tab-clinical').click()
    doc.fill('#vs-notes', 'Take naproxen twice a day with food for 5 days. If your lips swell, call the emergency number.')
    doc.get_by_test_id('vs-send').click(); doc.wait_for_timeout(1500)
    doc.get_by_test_id('tab-messages').click(); doc.get_by_test_id('mode-probe').click()
    comp = doc.get_by_test_id('probe-composer')
    comp.get_by_role('button', name='List', exact=True).click(); comp.get_by_role('button', name=re.compile('^Left knee')).click()
    doc.get_by_test_id('probe-send').click(); expect(doc.get_by_test_id('probe-bubble')).to_be_visible(timeout=15000)

    # patient switches the app to Arabic
    pat.goto(f'{BASE}?uid=u-pat&name=Omar'); pat.locator('[data-testid=lang-switch]:visible').first.click()
    pat.wait_for_function("document.documentElement.dir === 'rtl'")
    expect(pat.get_by_test_id('home-teachback')).to_be_visible(timeout=20000)
    expect(pat.get_by_test_id('home-questions')).to_be_visible()
    pat.get_by_test_id('home-teachback').click()
    pat.get_by_role('tab', name=re.compile('الرسائل')).click()

    # "Here?" answered by voice, in Arabic
    card = pat.get_by_test_id('probe-card')
    expect(card).to_contain_text('بيوجعك هنا؟', timeout=20000); expect(card).to_contain_text('الركبة')
    pat.evaluate("window.__heard.push('أيوه حوالي ٧')")
    card.get_by_role('button', name=re.compile('رد بصوتك')).click()
    expect(pat.get_by_test_id('probe-review')).to_contain_text('أيوه · 7/10', timeout=10000)
    import os; SH = os.environ.get('SHOTS')
    if SH: card.screenshot(path=f'{SH}/ia-probe.png')
    pat.get_by_test_id('probe-approve').click()
    expect(pat.get_by_test_id('probe-answer')).to_be_visible(timeout=15000)
    ok('“Here?” in Arabic by voice: the patient’s screen said “بيوجعك هنا؟” on the highlighted knee; “أيوه حوالي ٧” became Yes 7/10, shown for approval, then sent')

    # teach-back in Arabic with AI
    tb = pat.get_by_test_id('teachback-card'); expect(tb).to_be_visible()
    pat.fill('[data-testid=teachback-text]', 'باخدها مرة واحدة في اليوم لمدة خمس ايام، ولو حصل حاجة باروح للدكتور الصبح')
    pat.get_by_test_id('teachback-check').click()
    expect(pat.get_by_test_id('teachback-score')).to_contain_text('1 من 3', timeout=15000)
    pts = pat.get_by_test_id('teachback-points')
    expect(pts.locator('[data-status=different]')).to_have_count(2)
    expect(pts).to_contain_text('اتقيّمت بالذكاء الاصطناعي من كلامك')
    expect(pts).to_contain_text('call the emergency number')
    assert pat.evaluate('window.__teachAi') >= 1
    t = pts.inner_text(); assert 'twice a day' in t and 'I take it twice a day' not in t, t
    if SH: tb.screenshot(path=f'{SH}/ia-teach.png')
    pat.get_by_test_id('teachback-send').click(); expect(pat.get_by_test_id('teachback-bubble')).to_be_visible(timeout=15000)
    ok('teach-back in Arabic with AI: “مرة واحدة” flagged against “twice a day” by the rules; Claude (stand-in) judged the urgent-help point from the patient’s own words (“باروح للدكتور الصبح”) and its made-up quote was ignored; corrections shown in the doctor’s own words')

    doc.reload(); doc.get_by_role('button', name=re.compile('^Consultations')).click(); doc.locator('.list .list-item').first.click(); doc.get_by_test_id('tab-messages').click()
    expect(doc.get_by_test_id('probe-answer')).to_contain_text('Left knee: Yes · 7/10', timeout=20000)
    expect(doc.get_by_test_id('teachback-bubble')).to_contain_text('1 understood · 2 different', timeout=20000)
    expect(doc.get_by_test_id('teachback-bubble')).to_contain_text('(AI)')
    if SH: doc.get_by_test_id('teachback-bubble').screenshot(path=f'{SH}/ia-doc.png')
    ok('the doctor received both: “Left knee: Yes · 7/10” and the understanding check (1 understood · 2 different, the AI-judged point marked)')
    real = [e for e in errors if 'Failed to load resource' not in e]
    assert not real, real
    print(f'\n{len(passed)} checks passed')
