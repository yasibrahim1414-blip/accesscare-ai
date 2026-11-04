// AccessCare Android app: the phone's own speech services for the web app.
// Android's in-app browser (WebView) cannot turn speech into text and often cannot speak, so the app
// provides the standard browser speech objects (SpeechRecognition, speechSynthesis) backed by the phone:
// Android's speech recognizer and its text-to-speech voices. The microphone is used only while the
// web app is listening (between start and the result), after Android has asked the person's permission.
(function () {
  if (window.__ACCESSCARE_ANDROID__ || !window.AndroidSpeech) return;
  window.__ACCESSCARE_ANDROID__ = true;
  var N = window.AndroidSpeech;
  var nextId = 1;
  var recs = {};
  var utts = {};

  // ------------------------------------------------------------ speech to text
  function Recognition() {
    this.lang = ''; this.interimResults = false; this.maxAlternatives = 1; this.continuous = false;
    this.onresult = null; this.onerror = null; this.onend = null; this.onstart = null;
    this.onspeechstart = null; this.onspeechend = null; this.onaudiostart = null; this.onaudioend = null;
    this._id = 0; this._ended = true;
  }
  Recognition.prototype.start = function () {
    if (!this._ended) throw new Error('InvalidStateError: recognition has already started');
    this._id = nextId++; this._ended = false;
    recs[this._id] = this;
    N.listen(this._id, String(this.lang || navigator.language || 'en-US'), !!this.interimResults, Math.max(1, this.maxAlternatives | 0));
  };
  Recognition.prototype.stop = function () { if (!this._ended) N.stopListening(this._id); };
  Recognition.prototype.abort = function () {
    if (this._ended) return;
    N.cancelListening(this._id);
    fireRec(this._id, 'error', { error: 'aborted' }); fireRec(this._id, 'end');
  };
  Recognition.prototype.addEventListener = function (t, f) { this['on' + t] = f; };
  Recognition.prototype.removeEventListener = function (t) { this['on' + t] = null; };
  function fireRec(id, type, data) {
    var r = recs[id]; if (!r || r._ended) return;
    if (type === 'end') { r._ended = true; delete recs[id]; }
    var ev = data || {}; ev.type = type;
    var f = r['on' + type];
    if (typeof f === 'function') { try { f.call(r, ev); } catch (e) { setTimeout(function () { throw e; }); } }
  }
  // called by the app: kind = start | result | error | end
  window.__acRec = function (id, kind, payload) {
    if (kind === 'result') {
      var alts = payload.alts || [];
      var res = alts.map(function (t, k) { return { transcript: t, confidence: (payload.conf && payload.conf[k]) || (k ? 0 : 0.8) }; });
      res.isFinal = !!payload.final;
      res.item = function (k) { return res[k]; };
      var list = [res]; list.item = function (k) { return list[k]; };
      fireRec(id, 'result', { results: list, resultIndex: 0 });
    } else if (kind === 'error') fireRec(id, 'error', { error: payload.error, message: payload.message || '' });
    else fireRec(id, kind);
  };
  try { Object.defineProperty(window, 'SpeechRecognition', { value: Recognition, configurable: true, writable: true }); } catch (e) { window.SpeechRecognition = Recognition; }
  try { Object.defineProperty(window, 'webkitSpeechRecognition', { value: Recognition, configurable: true, writable: true }); } catch (e) { window.webkitSpeechRecognition = Recognition; }

  // ------------------------------------------------------------ text to speech
  var voices = [];
  function loadVoices() {
    try { voices = JSON.parse(N.voices() || '[]'); } catch (e) { voices = []; }
    return voices;
  }
  function Utterance(text) {
    this.text = text == null ? '' : String(text); this.lang = ''; this.voice = null;
    this.rate = 1; this.pitch = 1; this.volume = 1;
    this.onstart = null; this.onend = null; this.onerror = null; this.onpause = null; this.onresume = null; this.onboundary = null; this.onmark = null;
  }
  Utterance.prototype.addEventListener = function (t, f) { this['on' + t] = f; };
  Utterance.prototype.removeEventListener = function (t) { this['on' + t] = null; };

  var queue = []; var current = null; var paused = false;
  function fireUtt(u, type, extra) {
    var f = u && u['on' + type]; if (typeof f !== 'function') return;
    var ev = extra || {}; ev.type = type; ev.utterance = u; ev.charIndex = 0; ev.elapsedTime = 0;
    try { f.call(u, ev); } catch (e) { setTimeout(function () { throw e; }); }
  }
  function playCurrent() {
    var u = current; if (!u) return;
    var id = nextId++; u._id = id; utts[id] = u;
    var v = u.voice && u.voice.voiceURI ? u.voice.voiceURI : '';
    N.speak(id, u.text, String(u.lang || (u.voice && u.voice.lang) || navigator.language || 'en-US'), v, +u.rate || 1, +u.pitch || 1, u.volume == null ? 1 : +u.volume);
  }
  function next() {
    current = queue.shift() || null;
    if (current && !paused) playCurrent();
  }
  window.__acTts = function (id, kind, error) {
    var u = utts[id]; if (!u || u !== current || u._id !== id) return;
    if (kind === 'start') { fireUtt(u, 'start'); return; }
    delete utts[id];
    current = null;
    if (kind === 'error') fireUtt(u, 'error', { error: error || 'synthesis-failed' }); else fireUtt(u, 'end');
    if (!current) next(); // the end handler may already have started the next sentence
  };
  var synth = {
    get speaking() { return !!current; },
    get pending() { return queue.length > 0; },
    get paused() { return paused; },
    onvoiceschanged: null,
    speak: function (u) {
      if (!u) return;
      queue.push(u);
      if (!current) next();
    },
    cancel: function () {
      var u = current; var rest = queue.slice();
      queue = []; current = null; paused = false;
      N.stopSpeaking();
      if (u) { delete utts[u._id]; fireUtt(u, 'error', { error: 'interrupted' }); }
      rest.forEach(function (x) { fireUtt(x, 'error', { error: 'canceled' }); });
    },
    // Android voices can't pause mid-sentence: pausing stops the sentence and resuming says it again
    pause: function () {
      if (paused) return; paused = true;
      if (current) { delete utts[current._id]; N.stopSpeaking(); fireUtt(current, 'pause'); }
    },
    resume: function () {
      if (!paused) return; paused = false;
      if (current) { fireUtt(current, 'resume'); playCurrent(); } else next();
    },
    getVoices: function () { return voices.length ? voices : loadVoices(); },
    addEventListener: function (t, f) { if (t === 'voiceschanged') listeners.push(f); },
    removeEventListener: function (t, f) { listeners = listeners.filter(function (x) { return x !== f; }); },
  };
  var listeners = [];
  window.__acVoices = function () {
    loadVoices();
    var ev = { type: 'voiceschanged' };
    if (typeof synth.onvoiceschanged === 'function') try { synth.onvoiceschanged(ev); } catch (e) { /* */ }
    listeners.forEach(function (f) { try { f(ev); } catch (e) { /* */ } });
  };
  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true }); } catch (e) { window.speechSynthesis = synth; }
  try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true, writable: true }); } catch (e) { window.SpeechSynthesisUtterance = Utterance; }
  loadVoices();

  // ------------------------------------------------------------ saving a text file (e.g. the recovery code)
  // a WebView can't download blob: links, so the file's text goes to Android's share sheet instead
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    if (this.hasAttribute('download') && /^(blob:|data:)/.test(href) && window.AndroidApp) {
      var name = this.getAttribute('download') || 'accesscare.txt';
      fetch(href).then(function (r) { return r.text(); }).then(function (t) { window.AndroidApp.shareText(name, t); }).catch(function () { /* */ });
      return;
    }
    return click.apply(this, arguments);
  };
})();
