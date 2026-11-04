"""Android app speech bridge (android/app/src/main/assets/bridge.js) — browser test with the website build.
Real: bridge.js and the whole web app (Blind Mode talking and listening through it).
Simulated (stated honestly): the Android side (AndroidSpeech) is a stand-in written here that "speaks" by
recording the text and "hears" queued words; the real Android SpeechRecognizer/TextToSpeech are not run here.
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/android_bridge.py"""
import os, urllib.request
from playwright.sync_api import sync_playwright, expect
get = lambda p: urllib.request.urlopen('http://localhost:8787' + p).read().decode()
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIDGE = open(os.path.join(ROOT, 'android/app/src/main/assets/bridge.js')).read()
# the stand-in for the Java side: same method names and the same callbacks the Java code sends
FAKE_ANDROID = """
(() => {
  window.__spoken = []; window.__heard = []; window.__listens = []; window.__calls = [];
  const later = (f, ms) => setTimeout(f, ms);
  window.AndroidSpeech = {
    voices: () => JSON.stringify([
      { voiceURI: 'default:en-US', name: 'Phone voice (English (United States))', lang: 'en-US', localService: true, default: true },
      { voiceURI: 'default:ar-EG', name: 'Phone voice (Arabic (Egypt))', lang: 'ar-EG', localService: true, default: true },
      { voiceURI: 'en-us-x-iol-local', name: 'en-us-x-iol-local', lang: 'en-US', localService: true, default: false }]),
    speak: (id, text, lang, voice, rate) => {
      window.__calls.push(['speak', id, lang, voice, rate]);
      later(() => window.__acTts(id, 'start', ''), 5);
      later(() => { window.__spoken.push(text); window.__acTts(id, 'end', ''); }, 20 + Math.min(200, text.length));
    },
    stopSpeaking: () => window.__calls.push(['stop']),
    listen: (id, lang, interim, max) => {
      window.__listens.push(lang);
      later(() => window.__acRec(id, 'start', {}), 30);
      later(() => {
        const said = window.__heard.shift();
        if (!said) { window.__acRec(id, 'error', { error: 'no-speech' }); window.__acRec(id, 'end', {}); return; }
        if (interim) window.__acRec(id, 'result', { alts: [said.split(' ')[0]], conf: [], final: false });
        later(() => { window.__acRec(id, 'result', { alts: [said], conf: [0.9], final: true }); window.__acRec(id, 'end', {}); }, 140);
      }, 300);
    },
    stopListening: () => {}, cancelListening: () => {},
  };
})();
"""
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    get('/reset'); get('/web-db?on=0')
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(FAKE_ANDROID + BRIDGE)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html')
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)

    # ---------- 1. the standard objects behave like the browser's ----------
    r = pg.evaluate("""() => new Promise((done) => {
      const out = { android: window.__ACCESSCARE_ANDROID__ === true, same: window.SpeechRecognition === window.webkitSpeechRecognition };
      window.__heard.push('hello doctor');
      const rec = new webkitSpeechRecognition(); rec.lang = 'en-US'; rec.interimResults = true; const ev = [];
      rec.onstart = () => ev.push('start');
      rec.onresult = (e) => { const x = e.results[e.results.length - 1]; ev.push((x.isFinal ? 'final:' : 'interim:') + x[0].transcript); };
      rec.onerror = (e) => ev.push('error:' + e.error);
      rec.onend = () => {
        ev.push('end'); out.rec = ev;
        rec.onend = null; rec.onerror = null; let threw = false; try { rec.start(); rec.abort(); } catch (e) { threw = true; } out.restart = !threw;
        // speaking: a queue, one end per sentence, in order; cancel interrupts the rest
        const order = []; const a = new SpeechSynthesisUtterance('one'); const b2 = new SpeechSynthesisUtterance('two'); const c = new SpeechSynthesisUtterance('three');
        a.onend = () => order.push('end one'); b2.onend = () => { order.push('end two'); speechSynthesis.speak(c); setTimeout(() => speechSynthesis.cancel(), 2); };
        c.onerror = (e) => { order.push('three: ' + e.error); out.tts = order; out.voices = speechSynthesis.getVoices().length; out.idle = !speechSynthesis.speaking; done(out); };
        speechSynthesis.speak(a); speechSynthesis.speak(b2); out.pending = speechSynthesis.pending;
      };
      rec.start();
    })""")
    assert r['android'] and r['same'], r
    assert r['rec'] == ['start', 'interim:hello', 'final:hello doctor', 'end'], r['rec']
    assert r['restart'] and r['pending'], r
    assert r['tts'] == ['end one', 'end two', 'three: interrupted'] and r['voices'] == 3 and r['idle'], r
    ok('the Android bridge gives the page standard speech objects: listening (start, words while speaking, final words, end, start again) and speaking (queue in order, cancel interrupts)')

    # ---------- 2. the real app talks and listens through it (Blind Mode) ----------
    pg.evaluate('window.__spoken.length = 0')
    def wait(pattern, timeout=30000):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=timeout)
        except Exception: print('SPOKE', pg.evaluate('window.__spoken')[-6:]); raise
    for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    wait('Blind Mode is active')
    assert any(c[0] == 'speak' and c[2].startswith('en') for c in pg.evaluate('window.__calls')), 'spoken with an English phone voice'
    ok('Blind Mode starts and its spoken guide is said by the phone voice (through the bridge)')
    wait('create a new account, or log in')
    expect(pg.get_by_test_id('mic-allow')).to_be_visible(timeout=10000)
    pg.evaluate("window.__heard.push('new account')")
    pg.get_by_test_id('mic-allow').click()
    pg.wait_for_function('window.__listens.length > 0', timeout=30000)
    wait('saved only on this device|full name', timeout=30000)
    assert pg.evaluate('window.__listens')[0].startswith('en'), pg.evaluate('window.__listens')
    ok(f'the spoken answer is heard through the phone recognizer ({pg.evaluate("window.__listens")[0]}) and Blind Mode moves on ("new account" understood)')
    assert not errs, errs
    ctx.close(); b.close()
print(f'\n{len(passed)} checks passed')
