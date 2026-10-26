"""AI on/off line: one-tap "Turn on AI" in the diary. (Based on diary_flow setup.)
"""
""" (patient) and "What changed?" (doctor) — browser test.
Real: the app, the diary rules, the shared-database stand-in (encrypted), both roles on separate devices.
Simulated (stated honestly): Claude is a deterministic stand-in that also returns items/lines the app must reject.
Run:  tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/diary_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8787/app'
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
urllib.request.urlopen('http://localhost:8787/reset').read()

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def device(uid, name):
        ctx = b.new_context(viewport={'width': 390, 'height': 844})
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
        q = pat.get_by_test_id('onboard-question').inner_text()
        pat.locator('[data-testid^="onb-"]').nth(1 if 'AI' in q else 0).click(); pat.wait_for_timeout(500)
    pat.get_by_test_id('onboard-finish').click()

    pat.locator('.tab', has_text='Diary').click()
    st = pat.get_by_test_id('ai-status')
    expect(st).to_have_attribute('data-state', 'off', timeout=10000)
    expect(pat.get_by_test_id('ai-turn-on')).to_be_visible()
    ok('AI off: the diary says so and offers a one-tap "Turn on AI"')
    pat.get_by_test_id('ai-turn-on').click()
    expect(st).to_have_attribute('data-state', 'on', timeout=10000)
    pat.fill('[data-testid=diary-text]', 'My headache is worse, about 7, and I am so tired'); pat.get_by_test_id('diary-next').click()
    expect(pat.get_by_test_id('diary-item').first).to_be_visible(timeout=10000)
    assert pat.evaluate('window.__diaryAi') >= 1, 'the AI was really called'
    ok('after one tap the AI is on and is really used to read the diary entry')
    pat.reload(); pat.locator('.tab', has_text='Diary').click()
    expect(pat.get_by_test_id('ai-status')).to_have_attribute('data-state', 'on', timeout=15000)
    ok('the choice is saved (still on after reload)')
    assert not errors, errors
    b.close()
print(f'\n{len(passed)} checks passed')
