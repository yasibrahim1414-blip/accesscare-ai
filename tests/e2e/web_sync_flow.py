"""Website with the shared server (worker /db): doctor and patient on DIFFERENT devices (separate browsers).
Real: the web build, the real worker code (its storage runs in memory here instead of Cloudflare D1), end-to-end
encryption, live updates. Checks that a prescription sent by the doctor reaches the patient's other device, that the
patient can log in on a new device, and that doctor accounts have no Blind Mode.
Build:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:    tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/web_sync_flow.py"""
import re, json, urllib.request
from playwright.sync_api import sync_playwright, expect

WEB = 'http://localhost:8787/web/index.html'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def device(w=390, h=844):
        ctx = b.new_context(viewport={'width': w, 'height': h})   # its own storage = another phone
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(WEB); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
        return pg
    btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
    def signup(pg, role, name, email, pw, doctor_id=None):
        btn(pg, 'Create an account').click(); pg.get_by_test_id(f'role-{role}').click(); btn(pg, 'Continue').click()
        pg.fill('#su-name', name); pg.fill('#su-email', email); pg.fill('#su-password', pw)
        if doctor_id: pg.fill('#su-doctor-id', doctor_id)
        btn(pg, 'Continue Registration').click()

    doc = device(1280, 900)
    expect(doc.get_by_test_id('mode-strip')).to_contain_text('Synced through the AccessCare server', timeout=10000)
    ok('the website uses the AccessCare server (worker /db) when it is set up, and says so')
    signup(doc, 'doctor', 'Dr. Layla Hassan', 'layla@clinic.example', 'doctor-pass-1')
    doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    expect(doc.get_by_test_id('global-blind')).to_have_count(0)
    for _ in range(3): doc.mouse.click(700, 860); doc.wait_for_timeout(110)
    doc.keyboard.press('Alt+Shift+B'); doc.wait_for_timeout(600)
    expect(doc.get_by_test_id('blind-bar')).to_have_count(0)
    ok('doctor account: no Blind Mode button, and taps / Alt+Shift+B do not turn it on')

    pat = device()
    signup(pat, 'patient', 'Omar Adel', 'omar@example.test', 'patient-pass-1', doc_id)
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    ok('the patient on another device found the doctor by the Doctor ID through the server')
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    expect(pat.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pat.get_by_test_id('onboard-question').count() == 0: break
        q = pat.get_by_test_id('onboard-question').inner_text()
        pat.locator('[data-testid^="onb-"]').nth(1 if 'AI' in q else 0).click(); pat.wait_for_timeout(500)
    pat.get_by_test_id('onboard-finish').click()

    # a report by the conversation (rules, no AI)
    pat.get_by_test_id('home-talk').click()
    pat.wait_for_function('() => /What is bothering you today/i.test(document.querySelector("[data-testid=va-log]")?.innerText || "")', timeout=30000)
    if pat.get_by_test_id('mic-deny').count(): pat.get_by_test_id('mic-deny').click()
    pat.fill('#va-typed', 'my knee hurts since last week'); pat.get_by_test_id('va-send').click(); pat.wait_for_timeout(1500)
    for _ in range(14):
        if pat.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
        for sel in ['.va-opt[data-option="continue"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="assoc:none"]', '.va-opt[data-option="ns"]']:
            if pat.locator(sel).count(): pat.locator(sel).first.click(); break
        else:
            pat.fill('#va-typed', 'not sure'); pat.get_by_test_id('va-send').click()
        pat.wait_for_timeout(900)
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(500); pat.locator('.va-opt[data-option="yes"]').click()
    pat.wait_for_function('() => /Dr\\. Layla Hassan/.test(document.querySelector("[data-testid=va-log]")?.innerText || "")', timeout=30000)
    pat.get_by_label('Go back').first.click()

    # the doctor (other device) receives it live and sends a prescription
    doc.get_by_role('button', name=re.compile('^Consultations')).click()
    expect(doc.locator('.list .list-item').first).to_contain_text('Omar Adel', timeout=30000)
    doc.locator('.list .list-item').first.click(); doc.get_by_test_id('tab-clinical').click()
    doc.get_by_test_id('rx-new').click()
    doc.fill('#rx-med', 'Naproxen'); doc.fill('#rx-dose', '250 mg'); doc.fill('#rx-route', 'by mouth'); doc.fill('#rx-freq', 'twice daily'); doc.fill('#rx-dur', '5 days'); doc.fill('#rx-inst', 'with food')
    doc.get_by_test_id('rx-save').click(); doc.get_by_test_id('rx-approve').click(); btn(doc, 'I approve this prescription').click()
    doc.get_by_test_id('rx-send').click()
    expect(doc.locator('[data-rx-status="sent"]')).to_be_visible(timeout=20000)
    ok('the doctor saw the report arrive from the other device and sent an approved prescription')

    # the patient's phone shows it without reloading (live updates), on Home and in Care → Medicines
    expect(pat.get_by_test_id('next-dose')).to_contain_text('Naproxen', timeout=30000)
    pat.locator('.tab', has_text='History').click(); pat.locator('.list .list-item').first.click()
    pat.get_by_role('tab', name=re.compile('Messages')).click()
    expect(pat.get_by_test_id('prescription-card')).to_contain_text('APPROVED BY DR. LAYLA HASSAN', timeout=20000)
    ok('the prescription reached the patient’s phone (live, no reload): the home card shows Naproxen and the prescription card is in the messages')

    # the patient on a NEW device: log in with email + password, everything is there
    lap = device(1280, 900)
    btn(lap, 'Log in').first.click() if lap.get_by_role('button', name='Log in', exact=True).count() else None
    lap.fill('#signin-email', 'OMAR@example.test'); lap.fill('#signin-password', 'wrong-password-1'); lap.keyboard.press('Enter')
    expect(lap.get_by_role('alert').first).to_contain_text(re.compile('incorrect', re.I), timeout=15000)
    lap.fill('#signin-password', 'patient-pass-1'); lap.keyboard.press('Enter')
    lap.wait_for_function("document.querySelector('[data-route]')?.dataset.route === 'p.home'", timeout=30000)
    lap.get_by_role('button', name=re.compile('^Care')).first.click(); lap.get_by_test_id('care-p.meds').click()
    expect(lap.get_by_test_id('med-card')).to_contain_text('Naproxen 250 mg', timeout=20000)
    ok('the patient logged in on a new computer (a wrong password refused): the prescription and medicine schedule are there')

    dump = json.loads(urllib.request.urlopen('http://localhost:8787/dump').read())  # (Claude-version store; the web store is in the worker)
    assert not errors, errors[:5]
    b.close()
print(f'\n{len(passed)} checks passed')
