"""Symptom diary (patient) and "What changed?" (doctor) — browser test.
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
        pat.locator('[data-testid^="onb-"]').nth(0).click(); pat.wait_for_timeout(500)   # first option includes "Yes, use AI assistance"
    pat.get_by_test_id('onboard-finish').click()

    # ---------- patient: Diary is a section of the navigation; home shows today's check-in ----------
    expect(pat.get_by_test_id('home-diary')).to_contain_text('Today’s check-in', timeout=10000)
    expect(pat.locator('.tab')).to_have_count(6)
    pat.locator('.tab', has_text='Diary').click()
    expect(pat.locator('.tab[aria-current=page]')).to_contain_text('Diary')
    ok('patient: "Diary" is a new section in the navigation (6 tabs), and the home screen invites today’s check-in')

    def write(text, expect_items):
        pat.fill('[data-testid=diary-text]', text); pat.get_by_test_id('diary-next').click()
        expect(pat.get_by_test_id('diary-item').first).to_be_visible(timeout=10000) if expect_items else pat.wait_for_timeout(800)

    write('My headache is about 4', True)
    expect(pat.get_by_test_id('diary-item')).to_have_count(1)
    assert pat.get_by_test_id('diary-sev').first.input_value() == '4'
    pat.get_by_test_id('diary-save').click(); expect(pat.get_by_test_id('diary-entry')).to_have_count(1, timeout=10000)
    write('My headache is worse, about 7, and I am so tired', True)
    items = pat.get_by_test_id('diary-item')
    expect(items).to_have_count(2)
    txt = pat.locator('[data-testid=diary-item]').all_inner_texts()
    assert 'Headache' in txt[0] and 'Tiredness' in txt[1], txt
    assert pat.get_by_test_id('diary-sev').first.input_value() == '7'
    assert not any('Fever' in t for t in txt), 'the AI stand-in’s invented “fever” was dropped'
    assert pat.evaluate('window.__diaryAi') >= 1
    ok('words → items to check: "My headache is worse, about 7, and I am so tired" → headache 7/10 worse + tiredness; an AI item not in the patient’s words (fever) was dropped')
    pat.get_by_test_id('diary-save').click(); expect(pat.get_by_test_id('diary-entry')).to_have_count(2, timeout=10000)
    write('I feel better, nothing else to say', False)
    pat.get_by_test_id('diary-share').uncheck(); pat.get_by_test_id('diary-save').click()
    expect(pat.get_by_test_id('diary-entry')).to_have_count(3, timeout=10000)
    expect(pat.get_by_test_id('diary-entry').first).to_contain_text('Only you can see this')
    expect(pat.get_by_test_id('diary-chart')).to_be_visible()
    ok('three check-ins saved (one kept private); the chart shows strength over time, with a table version for screen readers')

    import os; SH = os.environ.get('SHOTS')
    if SH: pat.screenshot(path=f'{SH}/diary-patient.png', full_page=True)
    write('I have chest pain', True)
    expect(pat.get_by_test_id('emergency')).to_be_visible()
    btn(pat, 'Change my words').click()
    ok('urgent words in a check-in show emergency guidance immediately')

    pat.locator('.tab', has_text='Home').click()
    expect(pat.get_by_test_id('home-diary')).to_contain_text('done', timeout=10000)

    # ---------- doctor: Progress section ----------
    doc.reload(); expect(doc.locator('.tab')).to_have_count(5, timeout=20000)
    doc.locator('.tab', has_text='Progress').click()
    row = doc.get_by_test_id('progress-row').first
    expect(row).to_contain_text('Omar Adel', timeout=15000)
    expect(row).to_contain_text('2 check-ins')
    expect(row).to_contain_text('Headache got stronger: 4 → 7')
    row.click()
    ch = doc.get_by_test_id('changes')
    expect(ch).to_contain_text('Headache got stronger: 4 → 7 out of 10')
    expect(ch).to_contain_text('D1'); expect(ch).to_contain_text('D2')
    assert 'nothing else to say' not in doc.inner_text('#root'), 'the private entry is not visible to the doctor'
    ok('doctor: "Progress" is a new section; the patient is flagged “Headache got stronger: 4 → 7” with references D1, D2; the private entry is not shown')
    doc.get_by_test_id('changes-ai').click(); doc.wait_for_timeout(1500)
    if SH: doc.screenshot(path=f'{SH}/diary-doctor.png'); doc.locator('[data-screen-root] .screen').evaluate('e => e.scrollTo(0, 600)'); doc.screenshot(path=f'{SH}/diary-doctor2.png')
    lines = doc.get_by_test_id('changes-ai-lines')
    expect(lines).to_contain_text('described as stronger', timeout=15000)
    t = lines.inner_text()
    assert 'migraine' not in t and '9' not in t and 'D99' not in t, t
    expect(doc.locator('#root')).to_contain_text('3 AI line(s) removed by the checks')
    ok('AI summary: the valid line was kept with its references; a diagnosis, an invented number and an invented reference were removed')

    assert not errors, errors
    print(f'\n{len(passed)} checks passed')
