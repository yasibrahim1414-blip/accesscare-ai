"""Live check of the real AccessCare website and server (run by .github/workflows/live-check.yml on GitHub).
It uses the real site and the real Cloudflare worker + D1 database, from four separate browsers (= four devices):
  A  a doctor signs up                        → the account is created on the server
  B  a patient signs up with the Doctor ID    → finds the doctor through the server, confirms, connects
  C  the patient logs in on a new device      → the account comes from the server (wrong password refused)
  D  the doctor logs in on a new device       → sees the patient
Then both check accounts are deleted again (Settings → Delete account), so no test accounts stay on the server.
The accounts are clearly named "AccessCare live check" and contain no health information.
Locally: BASE=http://localhost:8787/web/index.html python3 tests/live/live_check.py"""
import os, re, sys, time, json, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'https://yasibrahim1414-blip.github.io/accesscare-ai/')
SERVER = os.environ.get('SERVER', 'https://accesscare-ai.yasibrahim1414.workers.dev')
RUN = os.environ.get('RUN', str(int(time.time())))
GH = bool(os.environ.get('GITHUB_ACTIONS'))
results = []
def say(kind, msg):
    msg = msg.replace('\n', ' ').strip()
    results.append((kind, msg))
    print(f'::{ {"PASS": "notice", "NOTE": "warning"}.get(kind, "error") }::{kind} {msg}' if GH else f'{kind} {msg}', flush=True)

# 0. the server says what it offers (no secrets in this answer)
try:
    req = urllib.request.Request(SERVER.rstrip('/') + '/status', headers={'Origin': 'https://yasibrahim1414-blip.github.io', 'User-Agent': 'AccessCare-live-check'})
    st = json.loads(urllib.request.urlopen(req, timeout=20).read())
    say('PASS' if st.get('db') else 'FAIL', f'server /status: version {st.get("version")}, database {"ON" if st.get("db") else "OFF (no D1 binding named DB)"}, AI {"ON" if st.get("ai") else "OFF"}, listening {"ON" if st.get("stt") else "OFF"}')
except Exception as e:
    say('FAIL', f'server /status could not be read: {e}')

btn = lambda pg, n: pg.get_by_role('button', name=n, exact=True)
doc_email, pat_email = f'live-check-{RUN}-doctor@example.com', f'live-check-{RUN}-patient@example.com'
doc_pw, pat_pw = f'Doc-{RUN}-pass', f'Pat-{RUN}-pass'

def signup(pg, role, name, email, pw):
    btn(pg, 'Create an account').click(); pg.get_by_test_id(f'role-{role}').click(); btn(pg, 'Continue').click()
    pg.wait_for_selector('#su-name'); pg.wait_for_timeout(400)
    pg.fill('#su-name', name); pg.fill('#su-email', email); pg.fill('#su-password', pw)
    if pg.locator('#su-confirm').count(): pg.fill('#su-confirm', pw)

def login(pg, email, pw):
    if btn(pg, 'Log in').count(): btn(pg, 'Log in').first.click()
    pg.wait_for_selector('#signin-email'); pg.fill('#signin-email', email); pg.fill('#signin-password', pw); pg.keyboard.press('Enter')

def delete_account(pg, pw):
    for name in ('Settings',):
        target = pg.get_by_role('button', name=re.compile(name)).or_(pg.get_by_role('link', name=re.compile(name)))
        if not target.count():
            pg.locator('.tab', has_text='Profile').first.click(); pg.wait_for_timeout(600)
            target = pg.get_by_role('button', name=re.compile(name))
        target.first.click(); pg.wait_for_timeout(600)
    pg.get_by_role('button', name=re.compile('Delete account')).first.click()
    pg.fill('#delete-pw', pw); btn(pg, 'Delete my account').click()
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=30000)

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    def device(w=390, h=844):
        ctx = b.new_context(viewport={'width': w, 'height': h})
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE, timeout=60000); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=60000)
        return pg
    step = 'start'
    try:
        step = 'A: the website opens and uses the server'
        A = device(1280, 900)
        expect(A.get_by_test_id('mode-strip')).to_contain_text('Synced through the AccessCare server', timeout=20000)
        say('PASS', 'the website shows "Synced through the AccessCare server" (accounts are on the server, not on one device)')
        step = 'A: doctor sign-up'
        signup(A, 'doctor', 'Dr. AccessCare live check', doc_email, doc_pw); btn(A, 'Continue Registration').click()
        doc_id = A.get_by_test_id('doctor-id').inner_text(timeout=30000).strip()
        say('PASS', f'device A: doctor account created on the server ({doc_id})')

        step = 'B: patient sign-up with the Doctor ID'
        B = device()
        signup(B, 'patient', 'AccessCare live check patient', pat_email, pat_pw); B.fill('#su-doctor-id', doc_id)
        btn(B, 'Continue Registration').click()
        expect(B.get_by_test_id('doctor-confirm')).to_contain_text('Dr. AccessCare live check', timeout=30000)
        btn(B, 'Yes, connect to this doctor').click()
        expect(B.get_by_text(re.compile('You are connected to Dr. AccessCare live check'))).to_be_visible(timeout=30000)
        say('PASS', 'device B: patient account created; found the doctor by the Doctor ID through the server and connected after confirming')

        step = 'C: patient on a new device'
        C = device()
        login(C, pat_email, 'wrong-password-123')
        expect(C.get_by_role('alert').first).to_contain_text(re.compile('incorrect|wrong', re.I), timeout=30000)
        C.fill('#signin-password', pat_pw); C.keyboard.press('Enter')
        C.wait_for_function("['p.home','p.onboard','p.connect'].includes(document.querySelector('[data-route]')?.dataset.route)", timeout=60000)
        say('PASS', 'device C (new, empty browser): the patient logged in with email and password (a wrong password was refused)')

        step = 'D: doctor on a new device sees the patient'
        D = device(1280, 900)
        login(D, doc_email, doc_pw)
        D.wait_for_function("(document.querySelector('[data-route]')?.dataset.route || '').startsWith('d.')", timeout=60000)
        seen = False
        for _ in range(6):
            nav = D.get_by_role('button', name='Patients').or_(D.get_by_role('link', name='Patients'))
            if nav.count(): nav.first.click(); D.wait_for_timeout(1500)
            if D.get_by_text('AccessCare live check patient').count(): seen = True; break
            D.reload(); D.wait_for_timeout(2500)
        if not seen: raise AssertionError('the doctor did not see the patient')
        say('PASS', 'device D (new, empty browser): the doctor logged in and sees the connected patient')
    except Exception as e:
        body = ''
        try: body = re.sub(r'\s+', ' ', (locals().get('D') or locals().get('C') or locals().get('B') or locals().get('A')).inner_text('body'))[:600]
        except Exception: pass
        say('FAIL', f'{step}: {str(e).splitlines()[0][:300]} | screen: {body}')
    # clean up: the check accounts are deleted (patient first, then doctor)
    for who, email, pw in (('patient', pat_email, pat_pw), ('doctor', doc_email, doc_pw)):
        try:
            pg = device(1280, 900); login(pg, email, pw)
            pg.wait_for_function("(document.querySelector('[data-route]')?.dataset.route || 'welcome') !== 'signin'", timeout=30000)
            pg.wait_for_timeout(1500); delete_account(pg, pw)
            say('PASS', f'clean-up: the check {who} account was deleted from the server')
        except Exception as e:
            say('FAIL' if not any(k == 'FAIL' for k, _ in results[:2]) else 'NOTE', f'clean-up of the {who} account: {str(e).splitlines()[0][:200]}')
    try:
        pg = device(); login(pg, pat_email, pat_pw)
        expect(pg.get_by_role('alert').first).to_be_visible(timeout=30000)
        say('PASS', 'after clean-up the check account can no longer log in (it is gone from the server)')
    except Exception as e:
        say('NOTE', f'could not confirm the clean-up: {str(e).splitlines()[0][:200]}')
    if errors: say('NOTE', 'page errors: ' + ' | '.join(errors[:3]))
    b.close()
fails = [m for k, m in results if k == 'FAIL']
print(f'\n{sum(k == "PASS" for k, _ in results)} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
