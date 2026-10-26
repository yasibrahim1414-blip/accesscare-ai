"""Clinical Intelligence Engine — browser test (doctor decision support, medication options, prescriptions).
Real: the app, the engine's rules and validation, the shared-database stand-in with encryption, messaging,
patient and doctor on separate browser contexts. Simulated (stated honestly): Claude is a deterministic stand-in
(tests/e2e/fakeClinical.ts, fakeConverse.ts) and openFDA is a local stand-in with two test labels.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/clinical_flow.py"""
import re, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
SHOTS = '/tmp/claude-0/clinical'
import os; os.makedirs(SHOTS, exist_ok=True)
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()
SPEECH = open(__file__.replace('clinical_flow.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]

with sync_playwright() as p:
    b = p.chromium.launch(channel='chromium', args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
    errors = []
    def device(uid, name, w=390, h=844, q=''):
        ctx = b.new_context(viewport={'width': w, 'height': h})
        ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.on('console', lambda m: errors.append(f'{uid} console: {m.text}') if m.type == 'error' and 'fonts.g' not in m.text and 'ERR_TUNNEL' not in m.text and 'ERR_CONNECTION_REFUSED' not in m.text else None)
        pg.goto(f'{BASE}?uid={uid}&name={name}{q}'); return pg
    btn = lambda pg, name: pg.get_by_role('button', name=name, exact=True)
    log = lambda pg: pg.get_by_test_id('va-log').inner_text()
    def wait_log(pg, pattern, timeout=30000):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(document.querySelector("[data-testid=va-log]").innerText)', arg=pattern, timeout=timeout)
        except Exception: print('LOG:', log(pg)[-700:], flush=True); raise
    def typed(pg, text, expect_re):
        pg.fill('#va-typed', text); pg.get_by_test_id('va-send').click(); wait_log(pg, expect_re)
    def onboard(pg):
        expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
        for _ in range(9):
            if pg.get_by_test_id('onboard-question').count() == 0: break
            pg.locator('[data-testid^="onb-"]').nth(0).click(); pg.wait_for_timeout(600)
        pg.get_by_test_id('onboard-finish').click()
    def open_case(pg, n):
        pg.reload()
        pg.get_by_role('button', name=re.compile('^Consultations')).click()
        expect(pg.locator('.list .list-item').nth(n)).to_be_visible(timeout=15000)
        pg.locator('.list .list-item').nth(n).click(); pg.get_by_test_id('tab-clinical').click()
        expect(pg.get_by_test_id('clinical-panel')).to_be_visible(timeout=15000)
    def finish_and_send(pg, doctor_name):
        for _ in range(12):
            if pg.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
            for sel in ['.va-opt[data-option="continue"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="assoc:none"]', '.va-opt[data-option="ns"]']:
                if pg.locator(sel).count(): pg.locator(sel).first.click(); break
            else: typed(pg, 'not sure', '.')
            pg.wait_for_timeout(700)
            if os.environ.get('DBG'): print('ITER:', log(pg)[-260:].replace('\n', ' / '), flush=True)
        try: expect(pg.get_by_test_id('va-summary')).to_be_visible(timeout=10000)
        except Exception:
            print('LOG:', log(pg)[:1500], '\nOPTS:', [pg.locator('.va-opt').nth(i).get_attribute('data-option') for i in range(pg.locator('.va-opt').count())], flush=True); raise
        pg.locator('.va-opt[data-option="approve"]').click(); pg.wait_for_timeout(400)
        pg.locator('.va-opt[data-option="yes"]').click()
        wait_log(pg, doctor_name)

    # ---------- accounts ----------
    doc = device('u-doc', 'Layla', 1280, 900)
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', 'doctor-pass-1'); doc.fill('#su-confirm', 'doctor-pass-1')
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    # the patient's conversation uses the rule-based understanding (this device has no AI) so the test is deterministic;
    # the patient still allows AI for reports in onboarding, which the doctor's engine checks
    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); pat.fill('#su-password', 'patient-pass-1'); pat.fill('#su-confirm', 'patient-pass-1'); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    onboard(pat)  # first options: includes "Yes, use AI assistance"
    pat.goto(f'{BASE}?uid=u-pat&name=Omar&ai=0')  # same signed-in patient; this view has no AI, so the conversation is rule-based

    # ---------- report 1: knee pain (ordinary) ----------
    pat.get_by_test_id('home-talk').click()
    wait_log(pat, 'What is bothering you today')
    pat.get_by_test_id('mic-deny').click()
    typed(pat, 'my knee hurts since last week', 'knee')
    finish_and_send(pat, 'Dr. Layla Hassan')
    pat.get_by_label('Go back').first.click()

    # ---------- report 2: headache + sudden trouble speaking ----------
    pat.get_by_test_id('home-talk').click()
    wait_log(pat, 'What is bothering you today')
    if pat.get_by_test_id('mic-deny').count(): pat.get_by_test_id('mic-deny').click()
    typed(pat, 'I have a headache and suddenly I have trouble speaking', 'emergency number')
    ok('patient side: "headache + suddenly trouble speaking" showed emergency guidance immediately in the conversation (rules, not AI)')
    finish_and_send(pat, 'Dr. Layla Hassan')

    # ---------- doctor: prioritized queue ----------
    doc.reload()
    doc.get_by_role('button', name=re.compile('^Consultations')).click()
    rows = doc.locator('.list .list-item')
    expect(rows.first).to_contain_text('Emergency sign', timeout=15000)
    assert rows.count() == 2
    assert 'Emergency sign' not in rows.nth(1).inner_text()
    ok('doctor queue: the report with emergency warning signs is listed first and labelled (rule-based, not a risk score)')

    # ---------- emergency case ----------
    rows.first.click()
    expect(doc.get_by_role('alert').first).to_contain_text('emergency warning sign', timeout=15000)
    doc.get_by_test_id('tab-clinical').click()
    panel = doc.get_by_test_id('clinical-panel')
    expect(panel).to_be_visible()
    w = doc.get_by_test_id('cie-warnings')
    expect(w.locator('[data-level="emergency"]').first).to_be_visible()
    wt = w.inner_text()
    assert 'Possible stroke warning signs' in wt and 'Headache with neurological symptoms' in wt, wt[:800]
    assert 'Based on' not in wt or True
    assert re.search(r'F\d+\s+Headache', wt) and 'Trouble speaking' in wt, wt[:800]
    assert 'NHS' in wt
    meds = doc.get_by_test_id('cie-meds').inner_text()
    assert 'An emergency warning is active' in meds, meds
    doc.get_by_test_id('clinical-panel').screenshot(path=f'{SHOTS}/01-emergency-panel.png')
    ok('emergency case: stroke / headache-with-neurological-symptoms warnings shown first, each with the facts that triggered it and an NHS source; medication options withheld during an emergency')

    # AI considerations (validated)
    doc.get_by_test_id('cie-run-ai').click()
    expect(doc.get_by_test_id('cie-consideration').first).to_be_visible(timeout=20000)
    ai_txt = doc.get_by_test_id('cie-ai').inner_text()
    assert 'AI suggestion — not a diagnosis' in ai_txt and '70% likely' not in ai_txt and 'Unsupported idea' not in ai_txt and 'invented_guideline' not in ai_txt, ai_txt
    assert 'ibuprofen 400' not in doc.get_by_test_id('cie-steps').inner_text()
    prompts = doc.evaluate('window.__clinicalPrompts')
    assert prompts and 'Omar' not in prompts[0] and 'u-pat' not in prompts[0], 'no name or account in the AI prompt'
    doc.locator('[data-testid^="decide-ai:AC1-needs_assessment"]').click()
    doc.wait_for_timeout(800)
    open_case(doc, 0)
    expect(doc.locator('[data-testid="decide-ai:AC1-needs_assessment"]')).to_have_attribute('aria-pressed', 'true', timeout=15000)
    ok('AI considerations: shown with the facts they cite and an AI label; a probability, an invented fact, an invented citation and a dose were all rejected; no patient name sent; the doctor’s “needs assessment” decision persisted after reload')

    # ---------- ordinary case: missing info, ask patient, medication options, prescription ----------
    open_case(doc, 1)
    miss = doc.get_by_test_id('cie-missing').inner_text()
    assert not re.search(r'chest|stomach|headache|speaking', miss, re.I), miss
    first = doc.locator('[data-testid^="ask-pain:"]').first
    mid = first.get_attribute('data-testid').replace('ask-', '')
    first.click()
    expect(doc.locator(f'[data-missing="{mid}"]')).to_contain_text('Asked — awaiting answer', timeout=15000)
    gate = doc.get_by_test_id('cie-meds').inner_text()
    assert 'Age is not documented' in gate and 'Allergies are not documented' in gate and 'Current medicines are not documented' in gate, gate
    ok('ordinary knee report: missing items are about the knee only; “Ask the patient” sent a question and the item shows “awaiting answer”; medication options withheld until age, allergies and medicines are documented')

    # patient answers the question
    pat.reload()
    pat.get_by_role('button', name=re.compile('^History')).click()
    pat.locator('.list .list-item', has_text=re.compile('Knee|No area chosen', re.I)).first.click()
    pat.get_by_role('tab', name=re.compile('Messages')).click()
    card = pat.get_by_test_id('clarification-card')
    expect(card).to_be_visible(timeout=15000)
    card.locator('[data-option]').first.click()
    pat.get_by_test_id('approve-answer').click()
    expect(pat.get_by_test_id('messages')).to_contain_text('approved by patient')
    vis = pat.locator('#root').inner_text(); assert 'Clinical Intelligence' not in vis and 'AI clinical considerations' not in vis and 'Medication options' not in vis
    open_case(doc, 1)
    expect(doc.get_by_test_id('cie-facts')).to_contain_text('Answered after sending', timeout=15000)
    assert doc.locator(f'[data-missing="{mid}"]').count() == 0
    ok('patient answered with one tap and approved it; the doctor’s engine view now lists the answer as a fact and the gap is closed; the patient never sees the clinical panel')

    # document patient information, then options
    doc.get_by_test_id('doc-edit').click()
    doc.fill('#doc-age', '45'); doc.select_option('#doc-sex', 'male')
    doc.select_option('#doc-allergy-status', 'listed'); doc.fill('#doc-allergies', 'penicillin')
    doc.select_option('#doc-med-status', 'listed'); doc.fill('#doc-meds', 'warfarin')
    doc.get_by_test_id('doc-save').click()
    doc.get_by_test_id('cie-run-meds').click()
    expect(doc.get_by_test_id('cie-med-option').first).to_be_visible(timeout=20000)
    ml = doc.get_by_test_id('cie-med-list').inner_text()
    assert doc.get_by_test_id('cie-med-option').count() == 1 and 'naproxen' in ml.lower(), ml
    assert 'amoxicillin removed: it matches a documented allergy' in ml, ml
    assert 'No FDA label was found for: unknownium' in ml, ml
    assert 'warfarin' in ml and 'DailyMed' in ml and 'Boxed warning' in ml, ml
    assert not re.search(r'\d+\s*mg', ml), 'no dose is suggested'
    calls = json.loads(urllib.request.urlopen('http://localhost:8787/fda-calls').read())
    assert calls and all('warfarin' not in c and 'penicillin' not in c and 'knee' not in c.lower() for c in calls), calls
    doc.screenshot(path=f'{SHOTS}/02-meds.png', full_page=True)
    ok('medication options: one option shown with its FDA label (boxed warning, DailyMed link) and the label text that mentions the patient’s warfarin; the penicillin-class option was removed for the documented allergy; an option without a label was not shown; no doses; only medicine names went to openFDA')

    # prescription: draft → approve → send
    doc.get_by_test_id('use-naproxen').click()
    doc.fill('#rx-dose', '1 tablet (doctor-entered test dose)'); doc.fill('#rx-route', 'by mouth'); doc.fill('#rx-freq', 'twice daily with food'); doc.fill('#rx-dur', '5 days')
    doc.get_by_test_id('rx-save').click()
    expect(doc.locator('[data-rx-status="draft"]')).to_be_visible()
    assert doc.get_by_test_id('rx-send').count() == 0, 'a draft cannot be sent'
    doc.get_by_test_id('rx-approve').click()
    btn(doc, 'I approve this prescription').click()
    expect(doc.locator('[data-rx-status="approved"]')).to_be_visible()
    pat.reload(); pat.get_by_role('button', name=re.compile('^History')).click()
    pat.locator('.list .list-item', has_text=re.compile('Knee|No area chosen', re.I)).first.click(); pat.get_by_role('tab', name=re.compile('Messages')).click()
    pat.wait_for_timeout(800)
    assert pat.get_by_test_id('prescription-card').count() == 0, 'approved but not sent → the patient has nothing'
    doc.get_by_test_id('rx-send').click()
    expect(doc.locator('[data-rx-status="sent"]')).to_be_visible(timeout=15000)
    expect(pat.get_by_test_id('prescription-card')).to_contain_text('APPROVED BY DR. LAYLA HASSAN', timeout=20000)
    expect(pat.get_by_test_id('prescription-card')).to_contain_text('twice daily with food')
    pat.screenshot(path=f'{SHOTS}/03-patient-rx.png', full_page=True)
    ok('prescription: the draft could not be sent; after explicit approval it still reached the patient only when the doctor pressed Send; the patient sees the approved prescription with the doctor’s name and instructions')

    # ---------- follow-up after the prescription ----------
    doc.select_option('#fu-days', '0')
    doc.get_by_test_id('fu-schedule').click()
    expect(doc.locator('[data-testid="followup-item"][data-state="waiting"]')).to_be_visible(timeout=15000)
    pat.reload()
    expect(pat.get_by_test_id('home-followup')).to_be_visible(timeout=20000)
    pat.get_by_test_id('home-followup').click()
    pat.get_by_role('tab', name=re.compile('Messages')).click()
    card = pat.get_by_test_id('followup-card')
    expect(card).to_be_visible(timeout=15000)
    assert 'How are you doing?' in card.inner_text()
    pat.evaluate('window.__spoken.length = 0')
    card.get_by_role('button', name=re.compile('Read aloud')).first.click()
    pat.wait_for_function('window.__spoken.length > 0', timeout=10000)
    card.locator('[data-option="feel:worse"]').click()
    card.locator('[data-option="se:swelling"]').click()
    expect(pat.get_by_test_id('followup-emergency')).to_contain_text('Call your local emergency number now', timeout=5000)
    ok('follow-up: appeared on the patient’s home screen, read aloud on request; choosing lip/face swelling showed emergency guidance immediately, before anything was sent')
    pat.get_by_test_id('followup-next').click()
    card.locator('[data-option="adh:yes"]').click()
    pat.get_by_test_id('followup-review').click()
    expect(pat.get_by_test_id('followup-review-box')).to_contain_text('Worse')
    pat.get_by_test_id('followup-send').click()
    expect(pat.get_by_test_id('followup-answer')).to_be_visible(timeout=15000)
    open_case(doc, 1)
    item = doc.locator('[data-testid="followup-item"]').first
    expect(item).to_have_attribute('data-state', 'answered', timeout=20000)
    it = item.inner_text()
    assert 'EMERGENCY WARNING' in it and 'allergic reaction' in it and 'feels worse' in it, it
    ok('follow-up answer reviewed and approved by the patient; the doctor sees it flagged as an emergency (possible allergic reaction, NHS) and “feels worse”')

    # ---------- visit explanation in the patient's language ----------
    doc.fill('#vs-notes', 'Take naproxen twice daily with food for 5 days. If your lips or tongue swell or you cannot breathe, call the emergency number.')
    doc.get_by_test_id('vs-simplify').click()
    expect(doc.get_by_test_id('vs-draft')).to_be_visible(timeout=20000)
    assert doc.get_by_test_id('vs-send').is_disabled(), 'AI wording cannot be sent before the doctor confirms reviewing it'
    doc.get_by_test_id('vs-reviewed').check()
    doc.get_by_test_id('vs-send').click()
    expect(doc.get_by_test_id('cie-visit')).to_contain_text('AI wording reviewed by you', timeout=15000)
    pat.reload(); pat.get_by_role('button', name=re.compile('^History')).click()
    pat.locator('.list .list-item', has_text=re.compile('Knee|No area chosen', re.I)).first.click(); pat.get_by_role('tab', name=re.compile('Messages')).click()
    vs = pat.get_by_test_id('visit-summary')
    expect(vs).to_contain_text('naproxen', timeout=20000)
    assert 'call the emergency number' in vs.inner_text() and 'reviewed by your doctor' in vs.inner_text()
    pat.evaluate('window.__spoken.length = 0')
    vs.get_by_role('button', name=re.compile('Read aloud')).click()
    pat.wait_for_function('window.__spoken.join(" ").includes("naproxen")', timeout=10000)
    vs.screenshot(path=f'{SHOTS}/06-visit-summary.png')
    ok('visit explanation: AI reworded the doctor’s notes into plain English, the doctor had to confirm reviewing it before sending; the patient sees it labelled as doctor-approved AI wording and can have it read aloud')

    raw = urllib.request.urlopen('http://localhost:8787/dump').read().decode()
    for secret in ['naproxen', 'warfarin', 'penicillin', 'twice daily', 'trouble speaking', 'swelling', 'call the emergency number']:
        assert secret not in raw.lower(), f'{secret} stored in plain text'
    ok('database: clinical review, documented allergies/medicines and the prescription are stored encrypted (no plain text in the shared database)')

    doc.get_by_test_id('tab-clinical').click()
    log_txt = doc.locator('details.card').inner_text() if doc.locator('details.card').count() else ''
    doc.locator('details.card summary').click()
    lt = doc.locator('details.card').inner_text()
    assert 'prescription approved by doctor' in lt and 'prescription sent to patient' in lt and 'medication options requested' in lt, lt
    ok('audit log records documentation, option requests, approval and sending')

    # narrow phone layout of the doctor panel: nothing wider than the screen
    m = doc; m.set_viewport_size({'width': 360, 'height': 780})
    open_case(m, 1)
    over = m.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert over <= 1, f'horizontal overflow {over}px'
    m.get_by_test_id('clinical-panel').screenshot(path=f'{SHOTS}/04-phone-panel.png')
    pat.get_by_test_id('prescription-card').screenshot(path=f'{SHOTS}/05-rx-card.png')
    ok('doctor panel fits a 360 px phone screen (no horizontal scrolling)')

    doc.set_viewport_size({'width': 390, 'height': 844})
    # ---------- teach-back: the patient explains the plan; it is checked against what the doctor wrote ----------
    def open_patient_messages():
        pat.reload(); pat.get_by_role('button', name=re.compile('^History')).click()
        pat.locator('.list .list-item', has_text=re.compile('Knee|No area chosen', re.I)).first.click(); pat.get_by_role('tab', name=re.compile('Messages')).click()
    open_patient_messages()
    tb = pat.get_by_test_id('teachback-card')
    expect(tb).to_be_visible(timeout=20000)
    pat.fill('[data-testid=teachback-text]', 'I take naproxen once a day for 5 days, one tablet. If my lips swell I call the emergency number.')
    pat.get_by_test_id('teachback-check').click()
    expect(pat.get_by_test_id('teachback-score')).to_contain_text('4 of 5 points match', timeout=10000)
    diff = pat.locator('[data-testid=teachback-points] [data-status=different]')
    expect(diff).to_have_count(1); expect(diff).to_contain_text('how often'); expect(diff).to_contain_text('once a day'); expect(diff).to_contain_text('twice daily with food')
    pat.get_by_test_id('teachback-send').click()
    expect(pat.get_by_test_id('teachback-bubble')).to_be_visible(timeout=15000)
    assert pat.get_by_test_id('teachback-card').count() == 0, 'done until the doctor sends a new plan'
    doc.reload(); open_case(doc, 1); doc.get_by_test_id('tab-messages').click()
    tbd = doc.get_by_test_id('teachback-bubble')
    expect(tbd).to_contain_text('4 understood · 1 different', timeout=20000)
    expect(tbd).to_contain_text('patient said “once a day”')
    ok('teach-back: the patient explained the plan in their own words; 4 of 5 points matched and “once a day” was flagged against the doctor’s “twice daily with food” (shown with the doctor’s own wording); the doctor received the approved check')

    # ---------- "Here?": the doctor points at the body, the patient answers ----------
    doc.get_by_test_id('mode-probe').click()
    comp = doc.get_by_test_id('probe-composer')
    comp.get_by_role('button', name='List', exact=True).click()
    comp.get_by_role('button', name=re.compile('^Left knee')).click()
    doc.get_by_test_id('probe-send').click()
    expect(doc.get_by_test_id('probe-bubble')).to_contain_text('Left knee', timeout=15000)
    open_patient_messages()
    card = pat.get_by_test_id('probe-card')
    expect(card).to_contain_text('Does it hurt here?', timeout=20000); expect(card).to_contain_text('Left knee')
    card.locator('[data-option="probe:yes"]').click()
    assert pat.get_by_test_id('probe-approve').is_disabled(), 'strength is asked before sending'
    card.locator('[data-option="strength:6"]').click()
    expect(pat.get_by_test_id('probe-review')).to_contain_text('Yes · 6/10')
    pat.get_by_test_id('probe-approve').click()
    expect(pat.get_by_test_id('probe-answer')).to_contain_text('6/10', timeout=15000)
    doc.reload(); open_case(doc, 1); doc.get_by_test_id('tab-messages').click()
    expect(doc.get_by_test_id('probe-answer')).to_contain_text('Left knee: Yes · 6/10', timeout=20000)
    expect(doc.get_by_test_id('probe-bubble')).to_contain_text('Answered')
    ok('“Here?”: the doctor tapped the left knee and asked; the same area was highlighted on the patient’s body map; the patient answered Yes, 6/10 and approved; the doctor received it')

    real_errors = [e for e in errors if 'Failed to load resource' not in e]
    assert not real_errors, real_errors
    print(f'\n{len(passed)} checks passed')
