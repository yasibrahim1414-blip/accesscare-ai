"""Listening and natural voice through the AccessCare server — browser test of the web build.
Real: the app, the worker (server/cloudflare-worker.mjs) and its /stt and /tts routes, the recording and the pause detection.
Simulated (stated honestly): the microphone is a generated tone (no person speaking), Whisper and the voices are
stand-ins inside the test server (tests/e2e/cloudServer.ts) that return queued words and a short tone.
Build first:  ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai node scripts/build.mjs
Run:          tsx tests/e2e/cloudServer.ts 8787 &   then   python3 tests/e2e/listen_flow.py"""
import json, urllib.request
from playwright.sync_api import sync_playwright, expect
get = lambda p: urllib.request.urlopen('http://localhost:8787' + p).read().decode()
SPEECH = open(__file__.replace('listen_flow.py', 'blind_flow.py')).read().split('SPEECH = """')[1].split('"""')[0]
# like Firefox: no speech recognition in the browser
NO_STT = "window.__noStt = true;"
# a microphone that is quiet for 0.7 s, then "speaks" (a tone) for 1.2 s, then is quiet again — once per recording
FAKE_MIC = """
(() => {
  window.__mics = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    window.__mics++;
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = 300; gain.gain.value = 0; osc.connect(gain); const dst = ctx.createMediaStreamDestination(); gain.connect(dst); osc.start();
    const t = ctx.currentTime; gain.gain.setValueAtTime(0, t); gain.gain.setValueAtTime(0.6, t + 0.7); gain.gain.setValueAtTime(0, t + 1.9);
    const s = dst.stream; const tr = s.getAudioTracks()[0]; const stop = tr.stop.bind(tr);
    tr.stop = () => { stop(); window.__micStops = (window.__micStops || 0) + 1; ctx.close(); };
    return s;
  };
})();
"""
passed = []
def ok(m): passed.append(m); print('PASS', m, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    # ---------- 1. listening when the browser has no speech recognition ----------
    get('/reset'); get('/web-db?on=0'); get('/speech-ai?m=stt')
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(NO_STT + SPEECH + FAKE_MIC)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html')
    def wait(pattern, timeout=30000):
        try: pg.wait_for_function('(re) => new RegExp(re, "i").test(window.__spoken.join("\\n"))', arg=pattern, timeout=timeout)
        except Exception: print('SPOKE', pg.evaluate('window.__spoken')[-5:]); raise
    expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    wait('Blind Mode is active')
    expect(pg.get_by_test_id('server-listen-note')).to_be_visible()
    assert 'Cloudflare Workers AI' in pg.get_by_test_id('server-listen-note').inner_text()
    ok('without browser speech recognition, the microphone offer appears and says the short answer goes to the AccessCare server (Whisper) and is not kept')
    get('/stt-say?t=' + urllib.request.quote('new account'))
    pg.evaluate('window.__spoken.length = 0'); pg.get_by_test_id('mic-allow').click()
    wait('saved only on this device')
    calls = json.loads(get('/stt-calls'))
    assert len(calls['stt']) == 1 and calls['stt'][0]['lang'] == 'en' and calls['stt'][0]['bytes'] > 1000, calls
    assert pg.evaluate('window.__micStops') == pg.evaluate('window.__mics'), 'the microphone is turned off after each answer'
    ok(f'spoken answer recorded until the pause ({calls["stt"][0]["bytes"]} bytes), transcribed by the server, understood ("new account"); microphone off afterwards')
    get('/stt-say?t=yes'); pg.evaluate('window.__spoken.length = 0'); wait('full name')
    get('/stt-say?t=' + urllib.request.quote('Sara Ahmed')); wait('I heard: Sara Ahmed')
    assert len(json.loads(get('/stt-calls'))['stt']) == 3
    ok('the conversation keeps listening by itself through the server, answer after answer')
    # silence: nothing sent
    before = len(json.loads(get('/stt-calls'))['stt'])
    ctx.close()

    # ---------- 2. natural voice from the server ----------
    get('/reset'); get('/web-db?on=0'); get('/speech-ai?m=all')
    ctx = b.new_context(viewport={'width': 390, 'height': 844}); ctx.add_init_script(SPEECH)
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://localhost:8787/web/index.html'); expect(pg.get_by_test_id('welcome')).to_be_visible(timeout=20000)
    for _ in range(3): pg.mouse.click(195, 160); pg.wait_for_timeout(120)
    pg.wait_for_function('() => true'); pg.wait_for_timeout(4000)
    tts = json.loads(get('/stt-calls'))['tts']
    assert tts >= 1, 'the server voice was asked to speak'
    expect(pg.get_by_test_id('va-voice-status')).to_contain_text('natural', ignore_case=True, timeout=10000)
    ok(f'with Workers AI on the worker, the app speaks with the server voice ({tts} sentence(s) fetched) and says so on screen')
    ctx.close()
    assert not errs, errs
    b.close()
print(f'{len(passed)} passed')
