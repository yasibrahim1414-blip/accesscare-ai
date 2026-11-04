"""Web build (like GitHub Pages) → the real worker code → fake Claude API: the diary check-in uses AI through the worker.
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/web_ai_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect
calls = lambda: int(urllib.request.urlopen('http://localhost:8787/ai-calls').read())
urllib.request.urlopen('http://localhost:8787/web-db?on=0').read()  # this test covers the website's on-this-device mode (no shared server)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html')
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000); pg.wait_for_timeout(500)
    btn = lambda n: pg.get_by_role('button', name=n, exact=True)
    # a new patient account, saved on this device (no shared server in this test)
    btn('Create an account').click(); pg.get_by_test_id('role-patient').click(); btn('Continue').click()
    pg.wait_for_selector('#su-name'); pg.wait_for_timeout(300)
    pg.fill('#su-name', 'Omar Adel'); pg.fill('#su-email', 'omar@example.com') if pg.locator('#su-email').count() else None
    pg.fill('#su-password', 'patient-pass-1'); pg.fill('#su-confirm', 'patient-pass-1') if pg.locator('#su-confirm').count() else None
    btn('Continue Registration').click()
    for _ in range(30):
        if pg.locator('.tab', has_text='Diary').count(): break
        if pg.get_by_test_id('onboard-question').count():
            q = pg.get_by_test_id('onboard-question').inner_text(); pg.locator('[data-testid^="onb-"]').nth(0).click(); pg.wait_for_timeout(400); continue
        if pg.get_by_test_id('onboard-finish').count(): pg.get_by_test_id('onboard-finish').click(); pg.wait_for_timeout(400); continue
        for n in ('Continue', 'Skip for now', 'Not now', 'Go to my home'):
            if btn(n).count() and btn(n).first.is_visible(): btn(n).first.click(); pg.wait_for_timeout(400); break
        else: pg.wait_for_timeout(500)
    expect(pg.locator('.tab', has_text='Diary')).to_be_visible(timeout=20000)
    # the patient turns AI on (Profile → Communication preferences)
    pg.locator('.tab', has_text='Profile').click(); pg.get_by_role('button', name=re.compile('Communication preferences')).click()
    sw = pg.get_by_role('switch', name=re.compile('Use AI to help')).first
    if sw.get_attribute('aria-checked') != 'true': sw.click(); pg.wait_for_timeout(500)
    pg.get_by_role('button', name='Go back').first.click()
    pg.locator('.tab', has_text='Diary').click()
    before = calls()
    pg.fill('[data-testid=diary-text]', 'so tired today, about 5'); pg.get_by_test_id('diary-next').click()
    expect(pg.get_by_test_id('diary-item').first).to_contain_text('Tiredness', timeout=15000)
    assert calls() > before, 'Claude was called through the worker'
    assert 'Fever' not in pg.get_by_test_id('diary-item').first.locator('xpath=..').inner_text()
    pg.get_by_test_id('diary-save').click(); expect(pg.get_by_test_id('diary-entry')).to_have_count(1, timeout=10000)
    assert not errs, errs
    print(f'PASS web build: diary check-in understood with AI through the worker ({calls() - before} call); the invented item was dropped; saved')
