"""Five languages — browser test of the web build (offline-demo mode, like GitHub Pages without a shared server).
Real: the app, the language menu, the screen translation, Blind Mode's dialog and its understanding of what is said.
Simulated (stated honestly): the speech engines record what would be spoken and play back what we "say".
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/lang_flow.py"""
import re, os, urllib.request
from playwright.sync_api import sync_playwright, expect
SPEECH = open(__file__.replace('lang_flow.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]
# also remember the language each sentence is spoken in, and the language the microphone listens for
SPEECH = SPEECH.replace('window.__spoken.push(u.text);', 'window.__spoken.push(u.text); (window.__langs = window.__langs || []).push(u.lang);')
SPEECH = SPEECH.replace('window.__recStarts++;', 'window.__recStarts++; window.__recLang = this.lang;')
urllib.request.urlopen('http://localhost:8787/reset').read()
urllib.request.urlopen('http://localhost:8787/web-db?on=0').read()
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/lang-shots'); os.makedirs(SHOTS, exist_ok=True)
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)

LANGS = {
  'fr': dict(locale='fr-FR', dir='ltr', script=r'[àâçéèêëîïôùûœ]', active='Le mode vocal est actif', new='nouveau compte', device='uniquement sur cet appareil',
             yes='oui', no='non', name_q='nom complet', heard='J’ai entendu', pw='mot de passe', pid='identifiant patient est', cont='continuer', rec='code de récupération',
             doc='identifiant médecin', ai='Anthropic', menu='Que voulez-vous faire', consult='nouvelle consultation', bother="Qu’est-ce qui ne va pas",
             symptom="j'ai mal à la tête depuis ce matin", understood='mal de tête', home='Accueil'),
  'ur': dict(locale='ur-PK', dir='rtl', script=r'[؀-ۿ]', active='صوتی موڈ چالو ہے', new='نیا اکاؤنٹ', device='صرف اسی آلے',
             yes='ہاں', no='نہیں', name_q='پورا نام', heard='میں نے سنا', pw='پاس ورڈ', pid='مریض آئی ڈی ہے', cont='جاری رکھو', rec='ریکوری کوڈ',
             doc='ڈاکٹر آئی ڈی', ai='Anthropic', menu='آپ کیا کرنا چاہتے ہیں', consult='نئی مشاورت', bother='کیا تکلیف ہے',
             symptom='صبح سے سر میں درد ہے', understood='سر درد', home=None),
  'hi': dict(locale='hi-IN', dir='ltr', script=r'[ऀ-ॿ]', active='वॉइस मोड चालू है', new='नया खाता', device='सिर्फ़ इसी डिवाइस',
             yes='हां', no='नहीं', name_q='पूरा नाम', heard='मैंने सुना', pw='पासवर्ड', pid='मरीज़ आईडी है', cont='जारी रखो', rec='रिकवरी कोड',
             doc='डॉक्टर आईडी', ai='Anthropic', menu='आप क्या करना चाहते हैं', consult='नया परामर्श', bother='क्या तकलीफ़ है',
             symptom='सुबह से सिर में दर्द है', understood='सिरदर्द', home=None),
}

with sync_playwright() as p:
    b = p.chromium.launch()
    errs = []
    # ---------- the language menu, screen text, direction and layout ----------
    ctx = b.new_context(viewport={'width': 360, 'height': 780}); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html'); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    sw = pg.locator('[data-testid=lang-switch]:visible').first
    sw.click()
    expect(pg.get_by_role('menu')).to_be_visible()
    assert pg.get_by_role('menuitemradio').count() == 5
    assert pg.locator('[data-testid=lang-opt-en]').get_attribute('aria-checked') == 'true'
    pg.keyboard.press('ArrowDown'); assert pg.evaluate('document.activeElement.dataset.testid') == 'lang-opt-ar'
    pg.keyboard.press('Escape'); expect(pg.get_by_role('menu')).to_have_count(0)
    assert pg.evaluate('document.activeElement.dataset.testid') == 'lang-switch'
    ok('language menu: 5 languages, the current one marked, arrow keys move, Escape closes and returns focus')
    english_text = pg.locator('#root').inner_text()
    for l, d in LANGS.items():
        sw.click(); pg.locator(f'[data-testid=lang-opt-{l}]').click(); pg.wait_for_timeout(400)
        assert pg.evaluate('document.documentElement.lang') == l and pg.evaluate('document.documentElement.dir') == d['dir']
        text = pg.locator('#root').inner_text()
        assert re.search(d['script'], text), f'{l}: no {l} text on the welcome screen'
        # every line that was English now reads differently (brand names and the language list aside)
        same = [x for x in english_text.split('\n') if x.strip() and x in text.split('\n') and re.search('[a-z]{4}', x) and not re.search(r'AccessCare|English|Claude|Français|Anthropic|^Patient$', x)]
        assert not same, f'{l}: still in English: {same[:5]}'
        assert pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'{l}: page scrolls sideways'
        pg.screenshot(path=f'{SHOTS}/welcome-{l}.png', full_page=True)
        ok(f'{l}: welcome screen translated, lang="{l}" dir="{d["dir"]}", no sideways scrolling on a 360px phone')
    sw.click(); pg.locator('[data-testid=lang-opt-ur]').click(); pg.reload(); pg.wait_for_timeout(800)
    assert pg.evaluate('document.documentElement.lang') == 'ur', 'the chosen language is remembered after reloading'
    font = pg.evaluate("getComputedStyle(document.body).fontFamily")
    assert 'Nastaliq' in font, font
    ok('the chosen language is remembered after reloading; Urdu uses a Nastaliq font')
    ctx.close()

    # ---------- Blind Mode speaks and understands each language ----------
    for l, d in [(k, LANGS[k]) for k in os.environ.get('ONLY', 'fr,ur,hi').split(',')]:
        ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(SPEECH)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://localhost:8787/web/index.html'); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
        pg.locator('[data-testid=lang-switch]:visible').first.click(); pg.locator(f'[data-testid=lang-opt-{l}]').click(); pg.wait_for_timeout(300)
        def wait(pattern):
            try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=30000)
            except Exception: print('SPOKE', l, pg.evaluate('window.__spoken')[-6:]); raise
        def say(t, pattern): pg.evaluate('window.__spoken.length = 0'); pg.evaluate('(t) => window.__heard.push(t)', t); wait(pattern)
        for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
        wait(d['active']); pg.get_by_test_id('mic-allow').click()
        say(d['new'], d['device']); say(d['yes'], d['name_q']); say('Sara Ahmed', d['heard']); say(d['yes'], d['pw'])
        pg.fill('#va-password', 'lang-pass-123'); pg.fill('#va-confirm', 'lang-pass-123'); pg.evaluate('window.__spoken.length = 0'); pg.get_by_test_id('va-form-submit').click()
        wait(d['pid']); say(d['cont'], d['rec']); say(d['cont'], d['doc'])
        say(d['no'], d['ai']); say(d['no'], d['menu'])
        say(d['consult'], d['bother'])
        say(d['symptom'], d['understood'])
        spoken = pg.evaluate('window.__spoken'); langs = set(pg.evaluate('window.__langs'))
        assert langs <= {d['locale']}, f'{l}: spoken in {langs}'
        assert pg.evaluate('window.__recLang') == d['locale'], pg.evaluate('window.__recLang')
        english = [s for s in spoken if re.search(r'\b(the|you|your|what|is|and)\b', s, re.I)]
        assert not english, f'{l}: English spoken: {english}'
        assert pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        pg.screenshot(path=f'{SHOTS}/blind-{l}.png')
        ok(f'{l}: Blind Mode set up an account and started a report by voice — every sentence spoken in {d["locale"]}, the microphone listening in {d["locale"]}, the symptom understood')
        ctx.close()
    assert not errs, errs
    b.close()
print(f'{len(passed)} passed')
