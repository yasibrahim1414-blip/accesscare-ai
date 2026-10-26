"""Web build (like GitHub Pages) → the real worker code → fake Claude API: the diary check-in uses AI through the worker.
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/web_ai_flow.py"""
import re, urllib.request
from playwright.sync_api import sync_playwright, expect
calls = lambda: int(urllib.request.urlopen('http://localhost:8787/ai-calls').read())
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html')
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000); pg.wait_for_timeout(500)
    pg.get_by_role('button', name='Patient', exact=True).click()        # ready-made demo patient (offline demo)
    expect(pg.locator('.tab', has_text='Diary')).to_be_visible(timeout=20000)
    # the demo patient turns AI on (Profile → Communication preferences)
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
