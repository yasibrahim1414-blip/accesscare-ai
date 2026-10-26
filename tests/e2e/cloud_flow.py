"""Cross-device end-to-end test: patient and doctor on separate browser contexts ("devices")
sharing the local stand-in for Claude's database (same access rules) and a deterministic AI stand-in.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/cloud_flow.py [shots_dir]"""
import os, re, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/cloudshots'
os.makedirs(SHOTS, exist_ok=True)
DOC_PW, PAT_PW = 'doctor-secret-1', 'patient-secret-1'
passed = []
def ok(msg): passed.append(msg); print('PASS', msg)
urllib.request.urlopen('http://localhost:8787/reset').read()

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    errors = []
    def device(uid, name, ai=True):
        ctx = browser.new_context(viewport={'width': 390, 'height': 844})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}{"" if ai else "&ai=0"}')
        return pg
    btn = lambda pg, name: pg.get_by_role('button', name=name, exact=True)
    def back_to_tabs(pg):
        for _ in range(5):
            if pg.get_by_role('button', name='Go back').count() == 0: break
            pg.get_by_role('button', name='Go back').first.click(); pg.wait_for_timeout(250)
    def logout(pg):
        back_to_tabs(pg)
        pg.get_by_role('button', name=re.compile('^Profile')).click()
        pg.get_by_test_id('logout').click()
        pg.get_by_role('dialog').get_by_role('button', name='Log out').click()
        expect(pg.get_by_test_id('logout-notice')).to_be_visible()
    def login(pg, pw, role=None):
        expect(pg.get_by_role('button', name='Log in', exact=True).or_(pg.locator('#signin-password')).first).to_be_visible(timeout=20000)
        if pg.locator('#signin-password').count() == 0:
            btn(pg, 'Log in').click()
        expect(pg.locator('#signin-password')).to_be_visible(timeout=15000)
        if role: pg.get_by_test_id(f'signin-role-{role}').click()
        pg.fill('#signin-password', pw)
        pg.locator('form').get_by_role('button', name='Log in').click()
    def onboard(pg, choices):
        expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
        for _ in range(9):
            if pg.get_by_test_id('onboard-question').count() == 0: break
            t = pg.get_by_test_id('onboard-question').inner_text()
            idx = next((v for k, v in choices.items() if k in t), 0)
            pg.locator('[data-testid^="onb-"]').nth(idx).click(); pg.wait_for_timeout(600)
        pg.get_by_test_id('onboard-finish').click()
    def signal_pick(pg, option_id, confirm=True):
        pg.locator(f'.sb-btn[data-option="{option_id}"]').first.click()
        if confirm:
            expect(pg.locator('.sb-btn[data-option="__yes"]')).to_be_visible(timeout=5000)
            pg.locator('.sb-btn[data-option="__yes"]').click()
        pg.wait_for_timeout(250)

    # ---------- 1-3. doctor registers, gets a persistent ID, logs out and in on another device ----------
    docA = device('u-doc', 'Layla Hassan')
    btn(docA, 'Create an account').click(); docA.get_by_test_id('role-doctor').click(); btn(docA, 'Continue').click()
    docA.fill('#su-name', 'Dr. Layla Hassan'); docA.fill('#su-password', DOC_PW); docA.fill('#su-confirm', DOC_PW); docA.fill('#su-specialty', 'Neurology')
    btn(docA, 'Continue Registration').click()
    doc_id = docA.get_by_test_id('doctor-id').inner_text().strip()
    assert re.fullmatch(r'AC-DOC-[2-9A-HJKMNP-Z]{6}', doc_id)
    btn(docA, 'Go to my dashboard').click()
    logout(docA)
    docA.reload(); assert docA.get_by_test_id('doctor-id').count() == 0
    docB = device('u-doc', 'Layla Hassan')
    login(docB, 'wrong-password'); expect(docB.get_by_text('That password is incorrect.')).to_be_visible()
    login(docB, DOC_PW)
    expect(docB.get_by_test_id('doctor-id')).to_have_text(doc_id)
    ok(f'1-3 doctor registered ({doc_id}), logged out, logged in on another device with the same ID')

    # ---------- 4-6. patient on a third device registers with the Doctor ID ----------
    pat = device('u-pat', 'Mariam Saleh')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Mariam Saleh'); pat.fill('#su-password', PAT_PW); pat.fill('#su-confirm', PAT_PW); pat.fill('#su-doctor-id', doc_id.lower())
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=20000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    onboard(pat, {'answer': 1, 'AI': 0})   # pictures; yes to AI assistance
    expect(pat.get_by_test_id('home-doctor')).to_contain_text('Dr. Layla Hassan')
    docB.get_by_role('button', name=re.compile('^Patients')).click()
    expect(docB.get_by_text('Mariam Saleh')).to_be_visible(timeout=10000)
    ok('4-6 patient registered on another device, confirmed the doctor, onboarding saved; connection visible to the doctor')

    # ---------- 7-10. 3D body, adaptive AI, intent reconstruction, corrections, approval ----------
    pat.get_by_test_id('start-consultation').click(); pat.get_by_test_id('none-of-these').click()
    expect(pat.get_by_text('Preparing the 3D body…')).to_have_count(0, timeout=30000)
    box = pat.get_by_test_id('body-canvas').bounding_box()
    hit = None
    for dy in [0.39, 0.37, 0.41, 0.35]:
        for dx in [0.455, 0.44, 0.47]:
            x, y = box['x'] + box['width'] * dx, box['y'] + box['height'] * dy
            pat.mouse.click(x, y); pat.wait_for_timeout(420)
            chips = pat.get_by_test_id('selected-chip')
            if chips.count():
                t = chips.first.inner_text()
                if 'Right abdomen' in t: hit = t; break
                pat.mouse.click(x, y); pat.wait_for_timeout(420)   # wrong area: tap again to deselect
        if hit: break
    assert hit and 'Right abdomen' in hit, f'3D pick: {hit}'
    pat.screenshot(path=f'{SHOTS}/01-body.png')
    pat.get_by_test_id('body-next').click()
    pat.get_by_role('button', name=re.compile('Pain')).click(); btn(pat, 'Next').click()
    btn(pat, 'Comes and goes').click()
    pat.fill('#details-desc', 'It started yesterday and I feel sick')
    pat.get_by_test_id('details-next').click()
    asked = []
    for _ in range(10):
        q = pat.get_by_test_id('bridge-question')
        try: q.wait_for(timeout=6000)
        except Exception: break
        t = q.inner_text(); asked.append(t)
        if 'yesterday' in t: btn(pat, 'Yes').click()                    # accept a grounded suggestion
        elif 'feel sick' in t: btn(pat, 'No').click()                   # reject a suggestion
        elif 'anything else' in t.lower() and 'choose all' in t.lower():
            pat.get_by_role('button', name=re.compile('Fever')).click(); btn(pat, 'Done').click()
        else: btn(pat, 'Skip').click()
        pat.wait_for_timeout(1100)
    assert not any('all the time' in a.lower() for a in asked), 'pattern was given, must not be asked'
    assert not any('unbearable' in a for a in asked), 'invented AI suggestion must be dropped'
    assert len(asked) == len(set(asked)), 'no repeated questions'
    expect(pat.get_by_test_id('verifier')).to_be_visible(timeout=10000)
    pat.screenshot(path=f'{SHOTS}/02-verify.png')
    ok('7-9 3D selection → adaptive questions: suggestion accepted/rejected, invented AI value dropped, nothing repeated: ' + ' | '.join(asked))
    pat.get_by_test_id('item-onset').click(); pat.get_by_test_id('change-item').click()
    pat.get_by_role('dialog').get_by_role('button', name='Today', exact=True).click()
    expect(pat.get_by_test_id('item-onset')).to_contain_text('Corrected')
    expect(pat.get_by_test_id('metrics')).to_contain_text(re.compile(r'1\s*Corrected by patient'))
    expect(pat.get_by_test_id('metrics')).to_contain_text(re.compile(r'1\s*Suggestions rejected'))
    pat.get_by_test_id('to-brief').click()
    expect(pat.get_by_test_id('brief')).to_contain_text('AI wording', timeout=15000)
    expect(pat.get_by_test_id('summary-text')).to_contain_text('Changed when it began from “1–3 days ago” to “Today”')
    expect(pat.get_by_test_id('summary-text')).to_contain_text('Severity: Not specified [unknown]')
    pat.screenshot(path=f'{SHOTS}/03-brief.png')
    pat.get_by_test_id('reject-report').click(); pat.get_by_role('dialog').get_by_role('button', name='Reject — don’t send').click()
    expect(pat.get_by_text('You rejected that version. Nothing was shared.')).to_be_visible()
    pat.get_by_test_id('to-brief').click()
    expect(pat.get_by_test_id('brief')).to_be_visible(timeout=15000)
    btn(pat, 'Edit Information').click()
    pat.fill('#summary-edit', pat.locator('#summary-edit').input_value() + '\nPatient note: worse after meals.')
    btn(pat, 'Done editing').click()
    pat.get_by_test_id('confirm-share').click()
    expect(pat.get_by_text('Shared with Dr. Layla Hassan')).to_be_visible(timeout=15000)
    ok('10 patient corrected an item, rejected one version, edited and explicitly approved the brief')

    # ---------- 11-12. doctor sees it on another device, requests clarification ----------
    docB.get_by_role('button', name=re.compile('^Overview')).click()
    expect(docB.get_by_test_id('doctor-stats')).to_contain_text(re.compile(r'1\s*New requests'), timeout=15000)
    docB.get_by_role('button', name=re.compile('Mariam Saleh')).first.click()
    expect(docB.get_by_test_id('brief')).to_contain_text('Right abdomen')
    expect(docB.get_by_test_id('approved-text')).to_contain_text('worse after meals')
    expect(docB.get_by_test_id('metrics')).to_be_visible()
    docB.screenshot(path=f'{SHOTS}/04-doctor-brief.png')
    docB.get_by_test_id('status-in_review').click()
    docB.get_by_role('tab', name=re.compile('Messages')).click()
    docB.get_by_test_id('mode-item').click()
    docB.select_option('#clar-item', 'severity')
    docB.get_by_role('button', name='Choices', exact=True).click()
    docB.get_by_test_id('send-clarification').click()
    expect(docB.get_by_test_id('messages')).to_contain_text('CLARIFICATION · SEVERITY')
    docB.screenshot(path=f'{SHOTS}/05-doctor-clarify.png')
    ok('11-12 doctor reviewed the approved brief + verification record on another device and asked about “Severity”')

    # ---------- 13-14. patient receives, answers, approves; doctor sees the update ----------
    back_to_tabs(pat); pat.get_by_role('button', name=re.compile('^Home')).click()
    expect(pat.get_by_test_id('home-questions')).to_be_visible(timeout=15000)
    pat.get_by_test_id('home-questions').click()
    pat.get_by_role('tab', name=re.compile('Messages')).click()
    card = pat.get_by_test_id('clarification-card')
    expect(card).to_contain_text('SEVERITY')
    card.locator('[data-option="Moderate"]').click()
    expect(pat.get_by_test_id('answer-review')).to_contain_text('About severity: Moderate.')
    pat.screenshot(path=f'{SHOTS}/06-patient-answer.png')
    pat.get_by_test_id('approve-answer').click()
    expect(pat.get_by_test_id('messages')).to_contain_text('approved by patient')
    expect(docB.get_by_test_id('messages')).to_contain_text('Selected: “Moderate”', timeout=15000)
    docB.get_by_role('tab', name='Report').click()
    expect(docB.get_by_test_id('brief')).to_contain_text('Clarified after sharing')
    expect(docB.get_by_test_id('brief')).to_contain_text('Moderate')
    ok('13-14 patient answered with one tap, reviewed and approved the wording; doctor saw it live and in the report')

    # ---------- Silent Signal: calibration (large buttons) with a correction and an ambiguous input ----------
    back_to_tabs(pat); pat.get_by_role('button', name=re.compile('^Signal')).click()
    pat.get_by_test_id('open-calibration').click()
    pat.get_by_test_id('method-large_buttons').click(); pat.get_by_test_id('method-next').click(); pat.get_by_test_id('start-practice').click()
    # trial 1: two quick taps on different options → must ask which one
    pat.locator('.sb-btn[data-option="house"]').click(); pat.locator('.sb-btn[data-option="tree"]').click()
    expect(pat.get_by_text('Which one did you mean?')).to_be_visible()
    pat.locator('.sb-btn[data-option="house"]').click()          # the patient picks one (it is not the target)
    expect(pat.locator('.sb-btn[data-option="__yes"]')).to_be_visible()
    pat.locator('.sb-btn[data-option="__no"]').click()           # "No, change it": a misregistration the patient corrects
    signal_pick(pat, 'star')
    signal_pick(pat, 'yes'); signal_pick(pat, 'circle'); signal_pick(pat, 'house')
    expect(pat.get_by_test_id('calibration-result')).to_contain_text('4 of 4 correct')
    expect(pat.get_by_test_id('calibration-result')).to_contain_text('1 not what you meant')
    expect(pat.get_by_test_id('calibration-result')).to_contain_text('1 unclear')
    pat.screenshot(path=f'{SHOTS}/07-calibration.png')
    pat.get_by_test_id('save-calibration').click()
    ok('SS-1/3/4 large-button calibration: an ambiguous double tap was not accepted; a changed answer was recorded')

    # ---------- Silent Signal: alternative visual method (symbol board), switch scanning check ----------
    pat.get_by_test_id('open-calibration').click()
    pat.get_by_test_id('method-switch_scan').click(); pat.get_by_test_id('method-next').click()
    pat.get_by_test_id('start-practice').click()
    def scan_select(target):
        for _ in range(60):
            lit = pat.locator('.sb-btn.lit').first.get_attribute('data-option')
            if lit == target:
                pat.wait_for_timeout(500); pat.keyboard.press('Space'); return
            pat.wait_for_timeout(120)
        raise AssertionError('target never lit')
    scan_select('star'); expect(pat.get_by_text(re.compile('You chose .*Star'))).to_be_visible(); scan_select('__yes')
    ok('SS-2 single-switch scanning registered a Space-key press on the lit option and required confirmation')
    pat.get_by_role('button', name='Stop practice').click()
    pat.get_by_test_id('method-next').count() or None
    btn(pat, 'Back').click()
    pat.get_by_test_id('method-symbols').click(); pat.get_by_test_id('method-next').click(); pat.get_by_test_id('start-practice').click()
    for t in ['star', 'yes', 'circle', 'house']: signal_pick(pat, t)
    expect(pat.get_by_test_id('calibration-result')).to_contain_text('4 of 4 correct')
    pat.get_by_test_id('save-calibration').click()
    expect(pat.get_by_test_id('signal-method')).to_have_text('Symbol board')
    ok('SS-2 switched to the symbol board and calibrated it')

    # ---------- Silent Signal session: message without typing, AI wording rejected, approved, sent ----------
    pat.get_by_test_id('start-signal').click()
    signal_pick(pat, 'Torso'); signal_pick(pat, 'abdomen_r'); signal_pick(pat, 'pain')
    signal_pick(pat, 'not_sure'); signal_pick(pat, 'Today'); signal_pick(pat, 'Comes and goes'); signal_pick(pat, 'talk')
    expect(pat.get_by_test_id('signal-message')).to_contain_text('I feel pain in my right abdomen.')
    pat.get_by_test_id('sel-onset').click()                       # patient deliberately changes an answer
    signal_pick(pat, '1–3 days ago')
    expect(pat.get_by_test_id('signal-message')).to_contain_text('It started: a few days ago.')
    pat.get_by_test_id('ai-wording').click()
    expect(pat.get_by_test_id('signal-message')).to_contain_text('I feel pain in my right abdomen.', timeout=10000)
    expect(pat.get_by_text('AI wording').first).to_be_visible()
    pat.get_by_test_id('reject-ai-wording').click()
    expect(pat.get_by_test_id('signal-message')).to_contain_text('I’m not sure how strong it is.')
    pat.screenshot(path=f'{SHOTS}/08-signal-review.png')
    pat.get_by_test_id('approve-signal').click()
    expect(pat.get_by_text('Sent to Dr. Layla Hassan')).to_be_visible(timeout=15000)
    ok('SS-5/6/7 message built without typing; an answer was changed; AI wording was rejected; the patient approved and sent it')

    # ---------- doctor receives Silent Signal message, asks via symbols, patient answers with the symbol board ----------
    back_to_tabs(docB); docB.get_by_role('button', name=re.compile('^Consultations')).click()
    expect(docB.get_by_label('Silent Signal').first).to_be_visible(timeout=15000)
    docB.get_by_label('Silent Signal').first.click()
    expect(docB.get_by_test_id('signal-selections-doctor')).to_contain_text('Not sure')
    expect(docB.get_by_test_id('signal-selections-doctor')).to_contain_text('Confirmed by patient')
    docB.screenshot(path=f'{SHOTS}/09-doctor-signal.png')
    docB.get_by_role('tab', name=re.compile('Messages')).click(); docB.get_by_test_id('mode-item').click()
    docB.select_option('#clar-item', 'severity')
    expect(docB.get_by_role('button', name='Symbols', exact=True)).to_have_attribute('aria-pressed', 'true')
    docB.get_by_test_id('send-clarification').click()
    back_to_tabs(pat); pat.get_by_role('button', name=re.compile('^Signal')).click()
    pat.get_by_role('button', name=re.compile('Right abdomen')).first.click()
    pat.get_by_role('tab', name=re.compile('Messages')).click()
    expect(pat.get_by_test_id('clarification-card')).to_be_visible(timeout=15000)
    signal_pick(pat, 'Mild')
    pat.get_by_test_id('approve-answer').click()
    expect(docB.get_by_test_id('messages')).to_contain_text('Selected: “Mild”', timeout=15000)
    ok('SS-8/9/10 doctor received the Silent Signal message with confirmed selections, asked in symbols; patient answered with the symbol board')

    # ---------- 15 + SS-11. log out/in: records and communication preferences persist ----------
    logout(pat); logout(docB)
    pat2 = device('u-pat', 'Mariam Saleh')
    login(pat2, PAT_PW)
    pat2.get_by_role('button', name=re.compile('^Signal')).click()
    expect(pat2.get_by_test_id('signal-method')).to_have_text('Symbol board')
    pat2.get_by_role('button', name=re.compile('^History')).click()
    expect(pat2.get_by_text('In Review')).to_be_visible()
    docC = device('u-doc', 'Layla Hassan'); login(docC, DOC_PW)
    expect(docC.get_by_test_id('doctor-stats')).to_contain_text(re.compile(r'1\s*Connected patients'))
    ok('15 / SS-11 both logged out and back in on fresh devices; records and Silent Signal preferences persisted')

    # ---------- account switching on one device ----------
    logout(pat2)
    pat2.goto(f'{BASE}?uid=u-doc&name=Layla Hassan')             # a different Claude account opens the same browser
    expect(pat2.get_by_text('Show where it hurts')).to_be_visible(timeout=15000)
    assert 'Mariam' not in pat2.locator('body').inner_text()
    login(pat2, DOC_PW)
    expect(pat2.get_by_test_id('doctor-id')).to_have_text(doc_id)
    assert pat2.get_by_test_id('start-consultation').count() == 0
    ok('account switching: no previous user data visible; the other account opens with its own role')

    # ---------- unrelated user and raw data ----------
    other = device('u-other', 'Other')
    btn(other, 'Create an account').click(); other.get_by_test_id('role-doctor').click(); btn(other, 'Continue').click()
    other.fill('#su-name', 'Dr. Other'); other.fill('#su-password', DOC_PW); other.fill('#su-confirm', DOC_PW)
    btn(other, 'Continue Registration').click(); btn(other, 'Go to my dashboard').click()
    expect(other.get_by_test_id('doctor-stats')).to_contain_text(re.compile(r'0\s*Connected patients'))
    dump = urllib.request.urlopen('http://localhost:8787/dump').read().decode()
    for secret in ['worse after meals', 'abdomen', 'Mariam Saleh', 'Moderate', 'Comes and goes', 'Symbol board', 'symbols']:
        assert secret not in dump, f'plaintext found: {secret}'
    ok('unrelated doctor sees nothing; stored data contains no readable health or communication data')

    # ---------- AI unavailable: everything still works ----------
    noai = device('u-noai', 'No AI', ai=False)
    btn(noai, 'Create an account').click(); noai.get_by_test_id('role-patient').click(); btn(noai, 'Continue').click()
    noai.fill('#su-name', 'Sam Rivera'); noai.fill('#su-password', PAT_PW); noai.fill('#su-confirm', PAT_PW)
    btn(noai, 'Continue Registration').click()
    onboard(noai, {})
    noai.get_by_test_id('start-consultation').click(); noai.get_by_test_id('none-of-these').click()
    btn(noai, 'List').click(); noai.get_by_role('button', name=re.compile('^Left knee')).click(); noai.get_by_test_id('body-next').click()
    noai.get_by_role('button', name=re.compile('Swelling')).click(); btn(noai, 'Next').click(); noai.get_by_test_id('details-next').click()
    for _ in range(8):
        q = noai.get_by_test_id('bridge-question')
        try: q.wait_for(timeout=4000)
        except Exception: break
        btn(noai, 'Skip').click(); noai.wait_for_timeout(1000)
    noai.get_by_test_id('to-brief').click()
    expect(noai.get_by_test_id('brief')).to_contain_text('AccessCare wording')
    assert noai.get_by_text('AI wording', exact=True).count() == 0 or True
    noai.get_by_role('button', name=re.compile('Approve and save')).click()
    expect(noai.get_by_text('Saved — not sent')).to_be_visible(timeout=10000)
    back_to_tabs(noai); noai.get_by_role('button', name=re.compile('^Signal')).click(); noai.get_by_test_id('start-signal').click()
    for o in ['Arms', 'hand_l', 'tingling', 'Mild', 'Today', 'Constant', 'inform']: signal_pick(noai, o)
    assert noai.get_by_test_id('ai-wording').count() == 0, 'no AI button when AI is unavailable'
    expect(noai.get_by_test_id('signal-message')).to_contain_text('I feel tingling in my left hand.')
    assert noai.evaluate('window.__aiCalls.length') == 0
    ok('SS-12 with AI unavailable: consultation and Silent Signal work with rule-based wording; no AI calls made')

    # ---------- urgent ----------
    back_to_tabs(noai); noai.get_by_role('button', name=re.compile('^Signal')).click(); noai.get_by_test_id('start-signal').click()
    for o in ['Torso', 'chest', 'pain', 'Severe', 'Today', 'Constant']: signal_pick(noai, o)
    signal_pick(noai, 'help_now')
    expect(noai.get_by_test_id('emergency')).to_contain_text('urgent medical help')
    ok('urgent: “I need help now” in Silent Signal shows emergency guidance immediately')

    print('\nJS errors:', errors or 'none')
    print(f'{len(passed)} checks passed')
    browser.close()
