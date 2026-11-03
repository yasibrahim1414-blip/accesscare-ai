"""Live call between a patient and their doctor — browser test with two separate browser profiles (two devices).
Real: the app, the encrypted message sync used to set up the call, WebRTC audio/video between the two browsers,
the in-call text chat, ending and declining, the call history line.
Simulated (stated honestly): the cameras and microphones are Chromium's built-in fake devices (a test pattern and a
tone), and both devices run on one machine, so no STUN/TURN relay is needed here as it may be on real networks.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/call_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect
import os
WEB = os.environ.get('WEB') == '1'   # WEB=1: the website build, synced through the worker's /db
BASE = 'http://localhost:8787/web/index.html' if WEB else 'http://localhost:8787/app'
url = lambda uid, name: BASE if WEB else f'{BASE}?uid={uid}&name={name}'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read(); urllib.request.urlopen('http://localhost:8787/web-db?on=1').read()
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'])
    errors = []
    def device(uid, name, w=390, h=844):
        ctx = b.new_context(viewport={'width': w, 'height': h}, permissions=['camera', 'microphone'])
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        pg.goto(url(uid, name)); return pg
    btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
    doc = device('u-doc', 'Layla', 1280, 860)
    btn(doc, 'Create an account').click(); doc.get_by_test_id('role-doctor').click(); btn(doc, 'Continue').click()
    doc.fill('#su-name', 'Dr. Layla Hassan'); (doc.fill('#su-email', 'layla@clinic.example') if WEB else None); doc.fill('#su-password', 'doctor-pass-1'); (doc.fill('#su-confirm', 'doctor-pass-1') if doc.locator('#su-confirm').count() else None)
    btn(doc, 'Continue Registration').click(); doc_id = doc.get_by_test_id('doctor-id').inner_text().strip(); btn(doc, 'Go to my dashboard').click()
    pat = device('u-pat', 'Omar')
    btn(pat, 'Create an account').click(); pat.get_by_test_id('role-patient').click(); btn(pat, 'Continue').click()
    pat.fill('#su-name', 'Omar Adel'); (pat.fill('#su-email', 'omar@mail.example') if WEB else None); pat.fill('#su-password', 'patient-pass-1'); (pat.fill('#su-confirm', 'patient-pass-1') if pat.locator('#su-confirm').count() else None); pat.fill('#su-doctor-id', doc_id)
    btn(pat, 'Continue Registration').click()
    expect(pat.get_by_test_id('doctor-confirm')).to_contain_text('Dr. Layla Hassan', timeout=30000)
    btn(pat, 'Yes, connect to this doctor').click(); btn(pat, 'Continue').click()
    expect(pat.get_by_test_id('onboard-question')).to_be_visible(timeout=20000)
    for _ in range(9):
        if pat.get_by_test_id('onboard-question').count() == 0: break
        pat.locator('[data-testid^="onb-"]').nth(1 if pat.locator('[data-testid^="onb-"]').count() > 1 else 0).click(); pat.wait_for_timeout(400)
    pat.get_by_test_id('onboard-finish').click()
    # a report, so the patient and doctor share a consultation
    pat.get_by_test_id('home-talk').click(); pat.get_by_test_id('mic-deny').click()
    pat.fill('#va-typed', 'my knee hurts since last week'); pat.get_by_test_id('va-send').click(); pat.wait_for_timeout(1000)
    for _ in range(16):
        if pat.get_by_test_id('voice-companion').get_attribute('data-phase') == 'review': break
        for sel in ['.va-opt[data-option="yes"]', '.va-opt[data-option="else:no"]', '.va-opt[data-option="ns"]', '.va-opt[data-option="assoc:none"]']:
            if pat.locator(sel).count(): pat.locator(sel).first.click(); break
        pat.wait_for_timeout(700)
    pat.locator('.va-opt[data-option="approve"]').click(); pat.wait_for_timeout(400); pat.locator('.va-opt[data-option="yes"]').click(); pat.wait_for_timeout(1500)
    pat.goto(url('u-pat', 'Omar')); expect(pat.locator('.tab').first).to_be_visible(timeout=20000)

    # ---------- doctor starts a video call ----------
    doc.reload(); doc.get_by_role('button', name=re.compile('^Consultations')).click()
    doc.locator('.list .list-item').first.click(); doc.get_by_test_id('tab-messages').click()
    expect(doc.get_by_test_id('call-buttons')).to_contain_text('encrypted', timeout=10000)
    doc.get_by_test_id('call-video').click()
    expect(doc.get_by_test_id('call-window')).to_have_attribute('data-phase', 'ringing', timeout=15000)
    expect(doc.get_by_test_id('call-status')).to_contain_text('Calling Omar Adel')
    inc = pat.get_by_test_id('call-incoming'); expect(inc).to_be_visible(timeout=20000)
    expect(inc).to_contain_text('Dr. Layla Hassan is calling you'); expect(inc).to_contain_text('Nothing is recorded')
    assert pat.evaluate("document.activeElement?.dataset.testid") == 'call-answer-video', 'focus moves to Answer (keyboard and screen readers)'
    ok('the doctor starts a video call from the consultation; on the patient’s home screen an incoming-call alert says who is calling, that nothing is recorded, and takes the focus')
    pat.get_by_test_id('call-answer-video').click()
    for pg in (doc, pat): expect(pg.get_by_test_id('call-window')).to_have_attribute('data-phase', 'connected', timeout=30000)
    for pg, who in ((doc, 'Omar Adel'), (pat, 'Dr. Layla Hassan')):
        expect(pg.get_by_test_id('call-status')).to_contain_text(f'Connected with {who}')
        pg.wait_for_function("() => { const v = document.querySelector('[data-testid=call-remote]'); return v && v.videoWidth > 0 && v.currentTime > 0; }", timeout=20000)
    ok('the patient answers: both devices connect directly and each one receives the other’s live video (frames playing)')

    # ---------- typing during the call (for deaf or non-verbal patients) ----------
    pat.get_by_test_id('call-chat-toggle').click(); pat.fill('[data-testid=call-chat-input]', 'I cannot hear well, can you type?'); pat.get_by_test_id('call-chat-send').click()
    doc.get_by_test_id('call-chat-toggle').click(); expect(doc.get_by_test_id('call-chat')).to_contain_text('I cannot hear well, can you type?', timeout=10000)
    doc.fill('[data-testid=call-chat-input]', 'Yes. Does the knee hurt when you walk?'); doc.get_by_test_id('call-chat-send').click()
    expect(pat.get_by_test_id('call-chat')).to_contain_text('Does the knee hurt when you walk?', timeout=10000)
    ok('typed messages go both ways inside the call (for patients who are deaf, hard of hearing or cannot speak)')
    pat.get_by_test_id('call-mute').click(); expect(pat.get_by_test_id('call-mute')).to_have_attribute('aria-pressed', 'true')
    assert pat.evaluate("() => { const v = document.querySelector('video.call-local'); return v && v.srcObject.getAudioTracks().every(t => !t.enabled); }"), 'muted'
    pat.get_by_test_id('call-camera').click()
    assert pat.evaluate("() => document.querySelector('video.call-local').srcObject.getVideoTracks().every(t => !t.enabled)"), 'camera off'
    ok('mute and camera-off really turn the patient’s microphone and camera off')

    # ---------- end ----------
    doc.wait_for_timeout(2500)
    doc.get_by_test_id('call-end').click()
    expect(pat.get_by_test_id('call-window')).to_have_count(0, timeout=20000)
    expect(doc.get_by_test_id('call-window')).to_have_count(0, timeout=10000)
    doc.reload(); doc.get_by_role('button', name=re.compile('^Consultations')).click(); doc.locator('.list .list-item').first.click(); doc.get_by_test_id('tab-messages').click()
    expect(doc.get_by_test_id('call-line').first).to_contain_text(re.compile(r'Video call · \d+ s'), timeout=10000)
    assert doc.locator('[data-kind=call]').count() == 0, 'set-up steps are not shown as chat bubbles'
    ok('the doctor hangs up: the call closes on both devices; the history shows “Video call · N s”, no technical set-up messages')

    # ---------- the patient calls, the doctor declines ----------
    pat.goto(url('u-pat', 'Omar')); expect(pat.locator('.tab').first).to_be_visible(timeout=20000)
    pat.locator('.tab', has_text='History').click(); pat.locator('.list .list-item').first.click()
    pat.get_by_role('tab', name=re.compile('^Messages')).click()
    expect(pat.get_by_test_id('call-line').first).to_contain_text(re.compile(r'Video call · \d+ s'), timeout=10000)
    pat.get_by_test_id('call-audio').click()
    expect(doc.get_by_test_id('call-incoming')).to_contain_text('Omar Adel is calling you', timeout=20000)
    assert doc.get_by_test_id('call-answer-video').count() == 0, 'a voice call offers voice only'
    doc.get_by_test_id('call-decline').click()
    expect(pat.get_by_test_id('call-status')).to_contain_text('declined', timeout=20000)
    expect(pat.get_by_test_id('call-window')).to_have_count(0, timeout=15000)
    ok('the patient can call too (voice); the doctor declines and the patient is told')
    assert not errors, errors
    b.close()
print(f'{len(passed)} passed')
