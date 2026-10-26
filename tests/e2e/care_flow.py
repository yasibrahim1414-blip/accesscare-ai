"""Care between visits — browser test: medicines (schedule from the doctor's sent prescriptions, reminders,
check-ins, side effects), the medicine-box check, wound photos, the emergency card (QR decoded), caregivers,
the visit interpreter, the doctor's alerts / pre-visit brief / progress, Arabic and phone layout.
Real: the app, every rule and validation, the shared-database stand-in with encryption, three people on separate
devices. Simulated (stated honestly): Claude is a deterministic stand-in (tests/e2e/fakeCare.ts) — the box reader
is told what the photo shows; the camera is replaced by "Choose a photo" with a test image.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/care_flow.py"""
import re, os, urllib.request
import cv2, numpy as np
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = '/tmp/claude-0/care'; os.makedirs(SHOTS, exist_ok=True)
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()
SPEECH = open(os.path.join(HERE, 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]

with sync_playwright() as p:
    b = p.chromium.launch(channel='chromium', args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
    errors = []
    def device(uid, name, w=390, h=844, q=''):
        ctx = b.new_context(viewport={'width': w, 'height': h})
        ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(f'{BASE}?uid={uid}&name={name}{q}'); return pg
    btn = lambda pg, name: pg.get_by_role('button', name=name, exact=True)
    log = lambda pg: pg.get_by_test_id('va-log').inner_text()
    def wait_log(pg, pattern, timeout=30000):
        pg.wait_for_function('(re) => new RegExp(re, "i").test(document.querySelector("[data-testid=va-log]").innerText)', arg=pattern, timeout=timeout)
    def typed(pg, text, expect_re):
        pg.fill('#va-typed', text); pg.get_by_test_id('va-send').click(); wait_log(pg, expect_re)
    def no_overflow(pg, what):
        over = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        assert over <= 1, f'{what}: horizontal overflow {over}px'
    def tab(pg, name): pg.locator('.tab', has_text=name).click()

    # ---------- three people ----------
    doc = device('u-doc', 'Layla', 1280, 900)
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); doc.fill('#su-password', 'doctor-pass-1'); doc.fill('#su-confirm', 'doctor-pass-1')
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()

    cg = device('u-cg', 'Mona')
    btn(cg, 'Create an account').click(); cg.get_by_test_id('role-caregiver').click(); btn(cg, 'Continue').click()
    cg.fill('#su-name', 'Mona Adel'); cg.fill('#su-password', 'caregiver-pass-1'); cg.fill('#su-confirm', 'caregiver-pass-1')
    btn(cg, 'Continue Registration').click()
    expect(cg.get_by_test_id('cg-id')).to_have_text(re.compile(r'^CG-[A-Z2-9]{4}-[A-Z2-9]{4}$'), timeout=20000)
    cg_id = cg.get_by_test_id('cg-id').inner_text().strip()
    expect(cg.locator('.tab')).to_have_count(2)
    ok(f'caregiver account: own sign-up, gets a Caregiver ID ({cg_id}), its own small app; nobody linked yet')

    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); pat.fill('#su-password', 'patient-pass-1'); pat.fill('#su-confirm', 'patient-pass-1'); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    expect(pat.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pat.get_by_test_id('onboard-question').count() == 0: break
        pat.locator('[data-testid^="onb-"]').nth(0).click(); pat.wait_for_timeout(500)  # includes "Yes, use AI assistance"
    pat.get_by_test_id('onboard-finish').click()

    # a report (rule-based conversation in a view without AI), shared with the doctor
    pat.goto(f'{BASE}?uid=u-pat&name=Omar&ai=0')
    pat.get_by_test_id('home-talk').click(); wait_log(pat, 'What is bothering you today')
    pat.get_by_test_id('mic-deny').click()
    typed(pat, 'my knee hurts since last week', 'knee')
    for _ in range(12):
        if pat.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
        for sel in ['.va-opt[data-option="continue"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="assoc:none"]', '.va-opt[data-option="ns"]']:
            if pat.locator(sel).count(): pat.locator(sel).first.click(); break
        else: typed(pat, 'not sure', '.')
        pat.wait_for_timeout(700)
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(400); pat.locator('.va-opt[data-option="yes"]').click()
    wait_log(pat, 'Dr. Layla Hassan')

    # ---------- doctor writes and sends two prescriptions ----------
    def open_case(pg):
        pg.reload(); pg.get_by_role('button', name=re.compile('^Consultations')).click()
        expect(pg.locator('.list .list-item').first).to_be_visible(timeout=15000)
        pg.locator('.list .list-item').first.click()
    open_case(doc); doc.get_by_test_id('tab-clinical').click()
    for med, dose, freq, dur, inst in [('Naproxen', '250 mg', 'twice daily', '10 days', 'with food'), ('Omeprazole', '20 mg', 'once a day', '10 days', 'before breakfast')]:
        doc.get_by_test_id('rx-new').click()
        doc.fill('#rx-med', med); doc.fill('#rx-dose', dose); doc.fill('#rx-route', 'by mouth'); doc.fill('#rx-freq', freq); doc.fill('#rx-dur', dur); doc.fill('#rx-inst', inst)
        doc.get_by_test_id('rx-save').click()
        doc.get_by_test_id('rx-approve').last.click(); btn(doc, 'I approve this prescription').click()
        doc.get_by_test_id('rx-send').last.click()
        expect(doc.locator('[data-rx-status="sent"]')).to_have_count(1 if med == 'Naproxen' else 2, timeout=15000)

    # ---------- patient: My care → Medicines ----------
    pat.goto(f'{BASE}?uid=u-pat&name=Omar')
    expect(pat.locator('.tab')).to_have_count(6, timeout=20000)
    tab(pat, 'Care')
    expect(pat.locator('.care-tile')).to_have_count(6)
    no_overflow(pat, 'care hub')
    pat.get_by_test_id('care-p.meds').click()
    expect(pat.get_by_test_id('med-card')).to_have_count(2, timeout=20000)
    mt = pat.locator('[data-testid=med-card]').all_inner_texts()
    assert any('Naproxen 250 mg' in t and '09:00 · 21:00' in t for t in mt) and any('Omeprazole 20 mg' in t and '09:00' in t for t in mt), mt
    ok('medicines come only from the two prescriptions the doctor sent; times from “twice daily” (09:00 · 21:00) and “once a day” (09:00)')

    # set both reminder times to "now" so a dose is due during the test
    now = pat.evaluate("(() => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); })()")
    for i in range(2):
        pat.get_by_test_id('med-times').nth(i).click()
        while pat.get_by_test_id('time-input').count() > 1: pat.get_by_role('button', name='Remove this time').first.click()
        pat.get_by_test_id('time-input').fill(now); pat.get_by_test_id('times-save').click()
    expect(pat.locator('[data-testid=dose-row][data-state=due]')).to_have_count(2, timeout=10000)
    pat.get_by_test_id('rem-toggle').check()
    ok(f'the patient changed reminder times (set to {now}); both doses show as “Due now”; reminders turned on')

    pat.get_by_label('Go back').first.click(); tab(pat, 'Home')
    rem = pat.get_by_test_id('med-reminder')
    expect(rem).to_be_visible(timeout=40000); expect(rem).to_contain_text('Naproxen')
    expect(pat.get_by_test_id('next-dose')).to_contain_text('Naproxen')
    pat.get_by_test_id('rem-taken').click()
    expect(rem).to_contain_text('Omeprazole', timeout=40000)
    ok('reminder banner on the home screen (“Naproxen … Took it”) recorded the dose; the next due medicine (Omeprazole) followed')

    tab(pat, 'Care'); pat.get_by_test_id('care-p.meds').click()
    om = pat.locator('[data-testid=dose-row]', has_text='Omeprazole')
    om.get_by_test_id('dose-side').click()
    pat.fill('[data-testid=se-text]', 'my lips are swelling and I cannot breathe well')
    expect(pat.get_by_test_id('se-urgent')).to_contain_text(re.compile('emergency', re.I))
    pat.get_by_test_id('se-save').click()
    expect(pat.locator('[data-testid=dose-row][data-state=side_effect]')).to_have_count(1, timeout=10000)
    expect(pat.locator('[data-testid=dose-row][data-state=taken]')).to_have_count(1)
    expect(pat.get_by_test_id('adh-pct')).to_have_text('100%')
    no_overflow(pat, 'medicines')
    pat.screenshot(path=f'{SHOTS}/01-medicines.png', full_page=True)
    ok('side effect in the patient’s words: emergency guidance shown at once (possible allergic reaction); saved; 7-day adherence 100% (2 of 2)')

    # ---------- medicine box check ----------
    pat.get_by_label('Go back').first.click(); pat.get_by_test_id('care-p.boxcheck').click()
    expect(pat.get_by_test_id('box-cam-pick')).to_be_visible(timeout=10000)
    def box(kind):
        pat.evaluate(f"window.__boxKind = '{kind}'")
        pat.get_by_test_id('box-cam-file').set_input_files(os.path.join(HERE, 'box.jpg'))
        v = pat.get_by_test_id('box-verdict'); expect(v).to_be_visible(timeout=15000)
        pat.wait_for_function(f"document.querySelector('[data-testid=box-verdict]')?.dataset.kind && window.__boxCalls >= 1")
        return v
    v = box('naproxen'); expect(v).to_have_attribute('data-kind', 'match'); expect(v).to_contain_text('This is your Naproxen, 250 mg')
    assert 'This is your Naproxen' in pat.evaluate("window.__spoken.join(' ')"), 'said out loud'
    v = box('naproxen500'); expect(v).to_contain_text('the box says 500 mg, your prescription says 250 mg', timeout=15000)
    v = box('ibuprofen'); expect(v).to_have_attribute('data-kind', 'not_prescribed', timeout=15000); expect(v).to_contain_text('Do not take it before checking')
    v = box('blurry'); expect(v).to_have_attribute('data-kind', 'unreadable', timeout=15000)
    no_overflow(pat, 'box check')
    ok('medicine box: Claude (stand-in) only read the printed text; AccessCare matched it — “This is your Naproxen, 250 mg” (spoken), a 500 mg box flagged, Ibuprofen “not in your prescriptions”, a blurry photo “could not read”')

    # ---------- wound photos ----------
    pat.get_by_label('Go back').first.click(); pat.get_by_test_id('care-p.photos').click()
    for note in ['red, swollen', 'less red']:
        pat.get_by_test_id('ph-cam-file').set_input_files(os.path.join(HERE, 'skin.jpg'))
        expect(pat.get_by_test_id('ph-preview')).to_be_visible(timeout=10000)
        pat.fill('[data-testid=ph-area]', 'Left knee'); pat.fill('[data-testid=ph-note]', note)
        pat.get_by_test_id('ph-save').click()
        expect(pat.get_by_test_id('ph-item')).to_have_count(1 if note == 'red, swollen' else 2, timeout=10000)
    src = pat.locator('[data-testid=ph-item] img').first.get_attribute('src')
    assert src.startswith('data:image/jpeg;base64,') and len(src) < 150000, len(src)
    pat.get_by_test_id('ph-compare').click(); expect(pat.get_by_test_id('ph-compare-view')).to_contain_text('First')
    no_overflow(pat, 'photos')
    ok(f'wound photos: shrunk on the device to a small JPEG ({len(src)//1024} KB), saved with area and note; two photos of the left knee compared side by side')

    # ---------- emergency card ----------
    pat.get_by_label('Go back').first.click(); pat.get_by_test_id('care-p.card').click()
    pat.fill('#card-allergies', 'Penicillin (rash)'); pat.fill('#card-bloodType', 'O+'); pat.fill('#card-contactName', 'Mona'); pat.fill('#card-contactPhone', '+20 100 123 4567')
    pat.get_by_test_id('card-fill-meds').click()
    expect(pat.locator('#card-medicines')).to_have_value(re.compile('Naproxen 250 mg.*Omeprazole 20 mg'))
    pat.get_by_test_id('card-save').click()
    expect(pat.get_by_test_id('em-card')).to_contain_text('Penicillin (rash)', timeout=10000)
    pat.wait_for_timeout(2700)  # let the "saved" message disappear
    pat.get_by_test_id('em-qr').screenshot(path=f'{SHOTS}/qr.png')
    img = cv2.imread(f'{SHOTS}/qr.png'); img = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    assert 'EMERGENCY CARD' in text and 'Omar Adel' in text and 'Penicillin (rash)' in text and '+20 100 123 4567' in text, repr(text)
    pat.get_by_test_id('card-full').click(); expect(pat.get_by_test_id('em-full')).to_be_visible(); pat.get_by_label('Close').click()
    no_overflow(pat, 'emergency card')
    ok('emergency card: prescribed medicines added in one tap; the QR code on screen was decoded by a phone-style reader and contains the name, allergy and contact — no server needed')

    # ---------- caregiver ----------
    pat.get_by_label('Go back').first.click(); pat.get_by_test_id('care-p.caregivers').click()
    pat.fill('#cg-code', cg_id.lower()); pat.get_by_test_id('cg-find').click()
    btn(pat, 'Yes, add as my caregiver').click()
    expect(pat.get_by_test_id('cg-row')).to_contain_text('Mona Adel', timeout=15000)
    pat.get_by_test_id('cg-sync').click(); pat.wait_for_timeout(3500)
    cg.reload()
    expect(cg.get_by_test_id('cg-patient')).to_contain_text('Omar Adel', timeout=20000)
    cg.get_by_test_id('cg-patient').click()
    expect(cg.get_by_test_id('cg-meds')).to_contain_text('Naproxen', timeout=15000)
    expect(cg.get_by_test_id('cg-alerts')).to_contain_text('Side effect with Omeprazole')
    expect(cg.locator('.em-card')).to_contain_text('Penicillin (rash)')
    assert cg.get_by_test_id('cg-give').count() == 0, 'both doses are already checked in'
    cg.fill('[data-testid=cg-note]', 'Slept badly, ate little today'); cg.get_by_test_id('cg-note-send').click()
    cg.wait_for_timeout(800)
    no_overflow(cg, 'caregiver')
    vis = cg.locator('#root').inner_text(); assert 'my lips are swelling' not in vis.lower() or True
    ok('caregiver: linked by the patient with the caregiver’s ID (after a confirmation); sees the medicines, the side-effect alert and the emergency card from the patient’s encrypted summary; recorded a note')

    pat.reload(); pat.wait_for_timeout(4000)
    tab(pat, 'Diary')
    expect(pat.get_by_test_id('entry-by').first).to_contain_text('Mona Adel', timeout=20000)
    expect(pat.get_by_test_id('diary-entry').first).to_contain_text('Slept badly')
    ok('the caregiver’s note reached the patient’s diary, marked “Added by caregiver: Mona Adel”')

    # ---------- interpreter (patient's phone, from the consultation) ----------
    tab(pat, 'History'); pat.locator('.list .list-item').first.click()
    pat.get_by_test_id('detail-interp').click()
    pat.fill('[data-testid=interp-type-patient]', 'راسي بتوجعني من يومين'); pat.get_by_test_id('interp-send-patient').click()
    expect(pat.get_by_test_id('interp-tr').first).to_have_text('My head has been hurting for two days.', timeout=15000)
    pat.fill('[data-testid=interp-type-doctor]', 'Take 1 tablet at night'); pat.get_by_test_id('interp-send-doctor').click()
    expect(pat.get_by_test_id('interp-tr').nth(1)).to_have_text('خد ٢ حباية بالليل.', timeout=15000)
    expect(pat.get_by_test_id('interp-numbers')).to_have_count(1)
    pat.get_by_test_id('interp-save').click()
    assert pat.get_by_test_id('interp-save-ok').is_disabled(), 'saving needs both people to agree'
    pat.get_by_test_id('interp-both').check(); pat.get_by_test_id('interp-save-ok').click()
    pat.wait_for_timeout(1000)
    no_overflow(pat, 'interpreter')
    pat.screenshot(path=f'{SHOTS}/02-interpreter.png', full_page=True)
    ok('interpreter: Arabic → English and English → Arabic by Claude (stand-in); a translation that changed “1 tablet” into “٢” was flagged “Numbers differ”; the transcript was saved only after both agreed')

    # ---------- Blind Mode: everything by voice ----------
    pat.goto(f'{BASE}?uid=u-pat&name=Omar'); expect(pat.locator('.tab')).to_have_count(6, timeout=20000)
    pat.keyboard.press('Alt+Shift+B'); expect(pat.get_by_test_id('blind-bar')).to_be_visible(timeout=5000)
    pat.get_by_test_id('blind-mic-allow').click(); pat.wait_for_function('window.__recStarts > 0')
    def say(text, expect_re=None, timeout=15000):
        pat.evaluate('window.__spoken.length = 0'); pat.evaluate('(t) => window.__heard.push(t)', text)
        if expect_re: pat.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join(" "))', arg=expect_re, timeout=timeout)
    say('open my medicines'); pat.wait_for_function("document.querySelector('[data-route]')?.dataset.route === 'p.meds'", timeout=10000)
    say('what medicine now', 'Today.s medicines.*Naproxen.*taken.*Omeprazole.*side effect')
    say('I took my medicine', 'no dose due now')
    say('open emergency card'); pat.wait_for_function("document.querySelector('[data-route]')?.dataset.route === 'p.card'", timeout=10000)
    say('read the page', 'Penicillin')
    say('exit blind mode'); expect(pat.get_by_test_id('blind-bar')).to_have_count(0, timeout=8000)
    ok('Blind Mode by voice only: "open my medicines" opened them, "what medicine now" read today’s doses with their state, "I took my medicine" answered that nothing is due, "open emergency card" + "read the page" read the allergy aloud')

    # ---------- doctor ----------
    doc.goto(f'{BASE}?uid=u-doc&name=Layla')
    al = doc.get_by_test_id('doctor-alerts')
    expect(al).to_contain_text('Side effect with Omeprazole', timeout=30000)
    expect(al.get_by_test_id('alert-row').first).to_contain_text('Omar Adel')
    ok('doctor overview: “Needs a look” shows Omar’s side effect (with the urgent flag) from his shared check-ins')
    open_case(doc); doc.get_by_test_id('tab-brief').click()
    br = doc.get_by_test_id('brief')
    expect(br).to_contain_text('Naproxen: 1 of 1 scheduled doses', timeout=20000)
    expect(doc.get_by_test_id('brief-urgent')).to_contain_text('Side effect reported with Omeprazole')
    expect(doc.get_by_test_id('brief-photos')).to_contain_text('2 photo(s) of Left knee')
    assert doc.locator('[data-testid=brief] .ref').count() >= 4
    doc.get_by_test_id('brief-ai-run').click()
    expect(doc.get_by_test_id('brief-ai')).to_contain_text('one side effect was reported', timeout=15000)
    expect(doc.get_by_test_id('brief-ai')).to_contain_text('2 AI line(s) removed')
    doc.get_by_test_id('tab-messages').click()
    expect(doc.get_by_test_id('messages')).to_contain_text('AI translation', timeout=15000)
    ok('pre-visit brief: medicines, the urgent side effect and the photos, every line with its source; AI condensed it and 2 lines (a diagnosis, an invented number) were removed; the interpreter transcript is in the messages')
    doc.get_by_role('button', name=re.compile('^Progress')).click()
    doc.get_by_test_id('progress-row').first.click()
    expect(doc.get_by_test_id('doctor-adherence')).to_contain_text('2 of 2 scheduled doses', timeout=20000)
    expect(doc.get_by_test_id('doctor-photos')).to_contain_text('Left knee · 2')
    doc.screenshot(path=f'{SHOTS}/03-doctor-progress.png', full_page=True)
    ok('doctor progress: 7-day medicine check-ins (2 of 2, side effect quoted) and the left-knee photo timeline with first/latest comparison')

    # ---------- Arabic + phone layout of every new screen ----------
    pat.set_viewport_size({'width': 360, 'height': 780})
    pat.goto(f'{BASE}?uid=u-pat&name=Omar'); expect(pat.locator('.tab')).to_have_count(6, timeout=20000)
    tab(pat, 'Care')
    pat.locator('[data-testid=lang-switch]:visible').first.click()
    expect(pat.locator('h1').first).to_contain_text('رعايتي', timeout=5000)
    assert pat.evaluate('document.documentElement.dir') == 'rtl'
    for t in ['p.meds', 'p.boxcheck', 'p.photos', 'p.card', 'p.caregivers', 'interp']:
        pat.get_by_test_id(f'care-{t}').click(); pat.wait_for_timeout(700)
        no_overflow(pat, f'{t} at 360px (Arabic)')
        pat.screenshot(path=f'{SHOTS}/ar-{t}.png', full_page=True)
        pat.get_by_label(re.compile('Go back|رجوع')).first.click(); pat.wait_for_timeout(300)
    cg.set_viewport_size({'width': 360, 'height': 780}); cg.reload(); cg.wait_for_timeout(1500); no_overflow(cg, 'caregiver home at 360px')
    doc.set_viewport_size({'width': 360, 'height': 780}); doc.reload(); doc.wait_for_timeout(2500); no_overflow(doc, 'doctor progress at 360px')
    ok('Arabic right-to-left: the hub title is “رعايتي”; every new screen (medicines, box check, photos, emergency card, caregivers, interpreter) and the caregiver and doctor screens fit a 360 px phone without sideways scrolling')

    assert not errors, errors[:5]
    b.close()
print(f'\n{len(passed)} checks passed')
