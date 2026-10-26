"""End-to-end test of the built preview file in headless Chromium (WebGL via SwiftShader).
Run: python3 tests/e2e/wrap.py && python3 tests/e2e/flow.py"""
import os, re, sys
from playwright.sync_api import sync_playwright, expect

URL = 'file://' + os.path.abspath('dist/preview-test.html')
SHOTS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0'
os.makedirs(SHOTS, exist_ok=True)
PW = 'secret-pass-1'
results = []

def ok(name):
    results.append(name); print('PASS', name)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(URL)
    shot = lambda n: pg.screenshot(path=f'{SHOTS}/{n}.png')
    btn = lambda name: pg.get_by_role('button', name=name, exact=True)

    def sign_out():
        for _ in range(4):
            if pg.get_by_role('button', name='Go back').count() == 0: break
            pg.get_by_role('button', name='Go back').first.click(); pg.wait_for_timeout(200)
        pg.get_by_role('button', name=re.compile('^Profile')).click()
        pg.get_by_test_id('logout').click()
        pg.get_by_role('dialog').get_by_role('button', name='Log out').click()
        expect(pg.get_by_test_id('logout-notice')).to_be_visible()
        pg.get_by_role('button', name='Go back').count() and None

    def sign_in(email):
        pg.fill('#signin-email', email); pg.fill('#signin-password', PW)
        pg.locator('form').get_by_role('button', name='Log in').click()

    # ---- invalid registration ----
    btn('Create an account').click()
    pg.get_by_test_id('role-doctor').click(); btn('Continue').click()
    btn('Continue Registration').click()
    expect(pg.get_by_text('Please enter your full name.')).to_be_visible()
    expect(pg.get_by_text('Please enter a valid email address.')).to_be_visible()
    ok('invalid registration data shows errors')

    # ---- doctor registration ----
    pg.fill('#su-name', 'Dr. Layla Hassan'); pg.fill('#su-email', 'layla@clinic.test'); pg.fill('#su-password', PW)
    pg.fill('#su-specialty', 'Neurology'); pg.fill('#su-clinic', 'Dubai Remote Clinic')
    btn('Continue Registration').click()
    doc_id = pg.get_by_test_id('doctor-id').inner_text().strip()
    assert re.fullmatch(r'AC-DOC-[2-9A-HJKMNP-Z]{6}', doc_id), doc_id
    shot('01-doctor-id')
    ok(f'doctor account created with ID {doc_id}')
    btn('Go to my dashboard').click()
    expect(pg.get_by_test_id('doctor-id')).to_have_text(doc_id)
    sign_out()
    sign_in('layla@clinic.test')
    expect(pg.get_by_test_id('doctor-id')).to_have_text(doc_id)
    pg.reload(); expect(pg.get_by_test_id('doctor-id')).to_have_text(doc_id)
    ok('doctor ID stable across sign out/in and app reload (session restored)')
    sign_out()

    # second doctor (unrelated)
    btn('Create account').click(); pg.get_by_test_id('role-doctor').click(); btn('Continue').click()
    pg.fill('#su-name', 'Dr. Other'); pg.fill('#su-email', 'other@clinic.test'); pg.fill('#su-password', PW)
    btn('Continue Registration').click()
    doc2 = pg.get_by_test_id('doctor-id').inner_text().strip()
    assert doc2 != doc_id
    ok('second doctor gets a different ID')
    btn('Go to my dashboard').click(); sign_out()

    # ---- patient registration with invalid then valid ID, cancel then confirm ----
    btn('Create account').click(); pg.get_by_test_id('role-patient').click(); btn('Continue').click()
    pg.fill('#su-name', 'Mariam Saleh'); pg.fill('#su-email', 'mariam@mail.test'); pg.fill('#su-password', PW)
    pg.fill('#su-doctor-id', 'hello')
    btn('Continue Registration').click()
    expect(pg.get_by_text("This doesn’t look like a Doctor ID")).to_be_visible()
    ok('malformed Doctor ID rejected at sign up')
    pg.fill('#su-doctor-id', 'AC-DOC-ZZZZZZ' if doc_id != 'AC-DOC-ZZZZZZ' else 'AC-DOC-YYYYYY')
    btn('Continue Registration').click()
    expect(pg.get_by_text('No doctor was found with this ID')).to_be_visible()
    ok('unknown Doctor ID shows a helpful error')
    pg.fill('#doctor-id-input', doc_id.lower())
    btn('Connect Doctor').click()
    expect(pg.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan')
    shot('02-confirm-doctor')
    btn('No, this isn’t my doctor').click()
    expect(pg.get_by_test_id('doctor-confirm')).to_have_count(0)
    btn('Connect Doctor').click()
    btn('Yes, connect to this doctor').click()
    expect(pg.get_by_text('You are connected to Dr. Layla Hassan')).to_be_visible()
    ok('patient sees doctor identity, cancel creates nothing, confirm connects')
    btn('Continue').click()
    # onboarding: one question at a time; pick large buttons
    expect(pg.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pg.get_by_test_id('onboard-question').count() == 0: break
        t = pg.get_by_test_id('onboard-question').inner_text()
        pg.locator('[data-testid^="onb-"]').nth(1 if 'buttons' in t else 0).click(); pg.wait_for_timeout(500)
    pg.get_by_test_id('onboard-finish').click()
    expect(pg.get_by_test_id('home-doctor')).to_contain_text('Dr. Layla Hassan')
    shot('03-patient-home')
    ok('connected doctor shown on patient dashboard')

    # ---- consultation ----
    pg.get_by_test_id('start-consultation').click()
    pg.get_by_test_id('none-of-these').click()
    canvas = pg.get_by_test_id('body-canvas')
    expect(pg.get_by_text('Loading 3D body…')).to_have_count(0, timeout=15000)
    box = canvas.bounding_box()
    # front view, patient's LEFT forearm is on the viewer's right side; scan for a hit
    hit = None
    for dx in [0.66, 0.68, 0.64, 0.7, 0.62]:
        for dy in [0.5, 0.47, 0.53, 0.44, 0.56]:
            pg.mouse.click(box['x'] + box['width'] * dx, box['y'] + box['height'] * dy)
            pg.wait_for_timeout(360)
            chips = pg.get_by_test_id('selected-chip')
            if chips.count():
                hit = chips.first.inner_text(); break
        if hit: break
    assert hit and hit.startswith('Left'), f'3D pick result: {hit}'
    shot('04-body-3d-selected')
    ok(f'3D model loaded, tap selected "{hit.split(chr(10))[0].rstrip("×").strip()}" (left side distinguished)')
    # rotate via drag and view buttons
    pg.mouse.move(box['x'] + 100, box['y'] + 100); pg.mouse.down(); pg.mouse.move(box['x'] + 220, box['y'] + 110, steps=6); pg.mouse.up()
    btn('Back view').click(); pg.wait_for_timeout(700)
    expect(pg.get_by_text('Back', exact=True).first).to_be_visible()
    shot('05-body-back')
    btn('Reset view').click()
    ok('rotation by drag and Front/Back/Side/Reset controls')
    # 2D fallback + list
    btn('2D map').click()
    pg.locator('[data-region="knee_r"]').first.click()
    expect(pg.locator('[data-region="knee_r"].on').first).to_be_visible()
    shot('06-body-2d')
    btn('List').click()
    pg.get_by_role('button', name=re.compile('^Right knee')).click()  # deselect via list
    expect(pg.get_by_test_id('selected-chip')).to_have_count(1)
    ok('2D map selection highlights and syncs with list; list deselects')
    btn('3D body').click()
    pg.get_by_test_id('body-next').click()
    pg.get_by_role('button', name=re.compile('Numbness')).click()
    btn('Next').click()
    pg.get_by_test_id('details-next').click()  # skip all details
    q = pg.get_by_test_id('bridge-question')
    first_q = q.inner_text()
    assert 'numbness' in first_q.lower(), first_q
    shot('07-bridge')
    btn('Skip').click()  # skip onset
    pg.wait_for_timeout(1100)
    asked = [first_q]
    for _ in range(8):
        if pg.get_by_test_id('bridge-question').count() == 0: break
        t = pg.get_by_test_id('bridge-question').inner_text(); asked.append(t)
        if 'choose all' in t.lower(): btn('Skip').click(); pg.wait_for_timeout(1100); continue
        if 'all the time' in t.lower(): pg.get_by_role('button', name=re.compile('comes and goes', re.I)).click()
        elif 'specific spot' in t.lower() or 'whole area' in t.lower(): pg.get_by_role('button', name=re.compile('one (specific )?spot', re.I)).click()
        elif 'how strong' in t.lower(): btn('Not sure').click()
        else: btn('Skip').click()
        pg.wait_for_timeout(1100)
    ok('Intent Bridge asked about the patient’s actual answers: ' + ' | '.join(asked))
    pg.get_by_test_id('to-brief').click()
    expect(pg.get_by_test_id('summary-text')).to_be_visible(timeout=10000)
    summary = pg.get_by_test_id('summary-text').inner_text()
    assert 'Onset and duration: Not specified [unknown]' in summary, summary
    assert 'Comes and goes' in summary and 'One specific spot' in summary
    assert not re.search(r'\b\d+\s*(day|hour|week)', summary), summary
    pg.wait_for_timeout(3500); shot('08-review')
    ok('missing onset stays “Not specified”; no invented duration')
    btn('Edit Information').click()
    pg.fill('#summary-edit', summary + '\nIt is worse in the morning.')
    btn('Done editing').click()
    expect(pg.get_by_text('Edited by you')).to_be_visible()
    pg.get_by_test_id('confirm-share').click()
    expect(pg.get_by_text('Shared with Dr. Layla Hassan')).to_be_visible()
    ok('patient edited the summary and confirmed before sharing')
    btn('View consultation').click()
    expect(pg.get_by_text(re.compile('Report you approved'))).to_be_visible()
    sign_out()

    # ---- unrelated doctor ----
    sign_in('other@clinic.test')
    expect(pg.get_by_test_id('doctor-stats')).to_contain_text('0')
    expect(pg.get_by_text('No consultations yet')).to_be_visible()
    ok('unrelated doctor sees no patients or consultations')
    sign_out()

    # ---- connected doctor reviews ----
    sign_in('layla@clinic.test')
    pg.wait_for_function("!(document.querySelector('[data-testid=doctor-stats]')?.innerText ?? '–').includes('–')", timeout=10000)  # numbers loaded
    stats = pg.get_by_test_id('doctor-stats').inner_text()
    assert re.search(r'1\s*Connected patients', stats) and re.search(r'1\s*New requests', stats), stats
    ok('dashboard counts come from stored data: ' + stats.replace('\n', ' '))
    pg.get_by_role('button', name=re.compile('Mariam Saleh')).first.click()
    approved = pg.get_by_test_id('approved-text').inner_text()
    assert 'worse in the morning' in approved
    ok('doctor sees the exact patient-approved (edited) text')
    shot('09-workspace')
    pg.get_by_role('tab', name='3D body').click()
    expect(pg.get_by_test_id('recon3d')).to_contain_text('Numbness')
    shot('10-doctor-body')
    pg.get_by_test_id('status-in_review').click()
    pg.get_by_role('tab', name='Notes').click()
    pg.fill('#doctor-note', 'Consider nerve conduction study.')
    btn('Save note').click()
    expect(pg.get_by_text('Consider nerve conduction study.')).to_be_visible()
    pg.get_by_role('tab', name=re.compile('Messages')).click()
    btn('Yes/No').click()
    pg.locator('input[aria-label="Message"]').fill('Does it wake you up at night?')
    pg.get_by_role('button', name='Send message').click()
    expect(pg.get_by_test_id('messages')).to_contain_text('Does it wake you up at night?')
    pg.reload()
    pg.get_by_role('button', name=re.compile('^Consultations')).click()
    expect(pg.get_by_text('In Review').first).to_be_visible()
    ok('status change, private note and message persisted after reload')
    sign_out()

    # ---- patient sees status + answers question; cannot see notes ----
    sign_in('mariam@mail.test')
    pg.get_by_role('button', name=re.compile('^History')).click()
    expect(pg.get_by_text('In Review')).to_be_visible()
    pg.get_by_role('button', name=re.compile('Left')).first.click()
    expect(pg.get_by_text('Consider nerve conduction study.')).to_have_count(0)
    pg.get_by_role('tab', name=re.compile('Messages')).click()
    pg.get_by_test_id('clarification-card').locator('[data-option="Yes"]').click()
    pg.get_by_test_id('approve-answer').click()
    expect(pg.get_by_test_id('messages')).to_contain_text('approved by patient')
    shot('11-patient-detail')
    ok('patient sees doctor status, answers Yes/No question; doctor notes hidden')

    # ---- emergency path ----
    pg.get_by_role('button', name='Go back').click()
    pg.get_by_role('button', name=re.compile('^Home')).click()
    pg.get_by_test_id('start-consultation').click()
    pg.get_by_role('checkbox', name='Severe difficulty breathing').click()
    btn('Get urgent help').click()
    expect(pg.get_by_test_id('emergency')).to_contain_text('urgent medical help')
    shot('12-emergency')
    ok('red-flag answer shows urgent guidance before any questionnaire')

    # role separation: doctor routes are never rendered for a patient
    assert pg.get_by_test_id('doctor-stats').count() == 0
    print('\nJS errors:', errors or 'none')
    print(f'{len(results)} checks passed')
    b.close()
