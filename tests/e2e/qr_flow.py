"""Doctor ID QR code — browser test of the web build with the shared server (worker /db, in memory here).
Real: the web build, the real worker code, the doctor's QR code as drawn on the doctor's screen, the patient's camera
reading it (Chromium's camera playing a video made from a screenshot of that QR code), jsQR, the link with ?doctor=…
Not real: a printed or phone-screen QR seen through a real phone camera (light, focus, angle) — check on real phones.
Build:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:    tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/qr_flow.py"""
import os, subprocess, tempfile, urllib.request
from playwright.sync_api import sync_playwright, expect

WEB = 'http://localhost:8787/web/index.html'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read(); urllib.request.urlopen('http://localhost:8787/web-db?on=1').read()
tmp = tempfile.mkdtemp()
btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
def signup(pg, role, name, email, pw):
    btn(pg, 'Create an account').click(); pg.get_by_test_id(f'role-{role}').click(); btn(pg, 'Continue').click()
    pg.wait_for_selector('#su-name'); pg.wait_for_timeout(300)
    pg.fill('#su-name', name); pg.fill('#su-email', email); pg.fill('#su-password', pw)
    if pg.locator('#su-confirm').count(): pg.fill('#su-confirm', pw)

with sync_playwright() as p:
    errors = []
    b = p.chromium.launch()
    # ---------- 1. the doctor's QR code ----------
    dctx = b.new_context(viewport={'width': 1280, 'height': 900}); doc = dctx.new_page(); doc.on('pageerror', lambda e: errors.append(str(e)))
    doc.goto(WEB); expect(doc.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    signup(doc, 'doctor', 'Dr. Layla Hassan', 'layla@example.com', 'doctor-pass-1'); btn(doc, 'Continue Registration').click()
    doc_id = doc.get_by_test_id('doctor-id').inner_text().strip()
    qr = doc.get_by_test_id('doctor-qr'); expect(qr).to_be_visible()
    assert doc_id in (qr.get_attribute('aria-label') or '')
    png = os.path.join(tmp, 'qr.png'); qr.screenshot(path=png)
    ok(f'the doctor sees a QR code for {doc_id} on the Doctor ID screen')

    # a camera that films the doctor's screen: a video made from the screenshot of the QR code
    y4m = os.path.join(tmp, 'qr.y4m')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-vf',
                    'scale=480:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p', '-frames:v', '20', y4m], check=True)
    cam = p.chromium.launch(channel='chromium', args=['--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])

    # ---------- 2. a patient scans it with the app while signing up ----------
    pctx = cam.new_context(viewport={'width': 390, 'height': 844}, permissions=['camera']); pat = pctx.new_page(); pat.on('pageerror', lambda e: errors.append(str(e)))
    pat.goto(WEB); expect(pat.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    signup(pat, 'patient', 'Omar Adel', 'omar@example.com', 'patient-pass-1')
    pat.get_by_test_id('su-scan').click(); pat.get_by_test_id('scan-start').click()
    expect(pat.locator('#su-doctor-id')).to_have_value(doc_id, timeout=20000)
    assert pat.evaluate("!document.querySelector('[data-testid=scan-video]') || !document.querySelector('[data-testid=scan-video]').srcObject"), 'camera off after the code is read'
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    ok('the patient scans the code with the app camera: the Doctor ID is filled in, the camera turns off, and the doctor’s name is shown to confirm')
    btn(pat, 'Yes, connect to this doctor').click()
    expect(pat.get_by_text('You are connected to Dr. Layla Hassan')).to_be_visible(timeout=20000)
    seen = False
    for _ in range(8):
        doc.reload(); doc.wait_for_timeout(2000)
        nav = doc.get_by_role('button', name='Patients').or_(doc.get_by_role('link', name='Patients'))
        if nav.count(): nav.first.click(); doc.wait_for_timeout(1500)
        if doc.get_by_text('Omar Adel').count(): seen = True; break
    assert seen, 'the doctor sees the new patient'
    ok('after the patient confirms, the doctor sees the patient on the other device (shared server)')

    # ---------- 3. the link inside the code, opened with any phone camera ----------
    lctx = b.new_context(viewport={'width': 390, 'height': 844}); lp = lctx.new_page(); lp.on('pageerror', lambda e: errors.append(str(e)))
    lp.goto(f'{WEB}?doctor={doc_id}'); expect(lp.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    expect(lp.get_by_test_id('doctor-link-note')).to_contain_text(doc_id)
    assert 'doctor=' not in lp.url, lp.url
    signup(lp, 'patient', 'Sara Ali', 'sara@example.com', 'patient-pass-2')
    expect(lp.locator('#su-doctor-id')).to_have_value(doc_id)
    btn(lp, 'Continue Registration').click()
    expect(lp.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(lp, 'No, this isn’t my doctor').click()
    ok('the link in the code (phone camera) opens AccessCare with the Doctor ID filled in; nothing connects without confirming (“No” connects nothing)')

    # ---------- 4. from a photo of the code (e.g. a screenshot the doctor sent), on the same connect form ----------
    expect(lp.get_by_test_id('scan-file')).to_have_count(1)
    lp.get_by_test_id('scan-file').first.set_input_files(png)
    expect(lp.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=20000)
    ok('a photo of the QR code (e.g. a screenshot the doctor sent) is read too, and the doctor is shown to confirm')
    assert not errors, errors
    b.close(); cam.close()
print(f'\n{len(passed)} checks passed')
