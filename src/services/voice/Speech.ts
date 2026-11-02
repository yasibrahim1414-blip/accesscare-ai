// Speech for the Voice Companion: text-to-speech (speechSynthesis) and
// speech-to-text (SpeechRecognition), both provided by the browser.
// Nothing is recorded or stored by AccessCare: audio is turned into text by the
// browser's speech service (Chrome sends it to Google, Safari to Apple or
// on-device), and only the resulting text is used.

import type { VoiceLang } from '../../domain/voice';
import { tr } from '../../i18n/lang';

export type SpeechErr = 'unsupported' | 'not-allowed' | 'no-speech' | 'audio-capture' | 'network' | 'aborted' | 'language-not-supported' | 'other';

export const ERROR_TEXT: Record<SpeechErr, { en: string; ar: string }> = {
  unsupported: { en: 'Speech recognition is not available in this browser. Please use the buttons or type your answer.', ar: 'التعرف على الكلام مش متاح في المتصفح ده. استخدم الزراير أو اكتب إجابتك.' },
  'not-allowed': { en: 'Microphone permission was not given, so I cannot hear you. Please use the buttons or type your answer. You can allow the microphone in your browser settings.', ar: 'إذن المايك مش متاح، فمش هقدر أسمعك. استخدم الزراير أو اكتب إجابتك. تقدر تسمح بالمايك من إعدادات المتصفح.' },
  'no-speech': { en: 'I did not hear anything. Please try again.', ar: 'مسمعتش حاجة. جرّب تاني.' },
  'audio-capture': { en: 'No microphone was found. Please use the buttons or type your answer.', ar: 'ملقيتش مايك. استخدم الزراير أو اكتب إجابتك.' },
  network: { en: 'The speech service could not be reached. Please use the buttons or type your answer.', ar: 'خدمة الكلام مش متاحة دلوقتي. استخدم الزراير أو اكتب إجابتك.' },
  aborted: { en: 'Listening stopped.', ar: 'وقفت الاستماع.' },
  'language-not-supported': { en: 'Speech recognition does not support this language here.', ar: 'التعرف على الكلام مش بيدعم اللغة دي هنا.' },
  other: { en: 'Speech recognition failed. Please try again or use the buttons.', ar: 'التعرف على الكلام فشل. جرّب تاني أو استخدم الزراير.' },
};

/** a speech error message in the language */
export const errText = (e: SpeechErr, lang: VoiceLang) => tr(ERROR_TEXT[e].en, ERROR_TEXT[e].ar, lang);

// Apple's speech service knows Saudi Arabic, Google's also Egyptian Arabic
const apple = typeof navigator !== 'undefined' && /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|CriOS/.test(navigator.userAgent);
export const LOCALE: Record<VoiceLang, string> = { en: 'en-US', ar: apple ? 'ar-SA' : 'ar-EG', fr: 'fr-FR', ur: 'ur-PK', hi: 'hi-IN' };

type Rec = {
  lang: string; interimResults: boolean; maxAlternatives: number; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; onstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
const recCtor = (): (new () => Rec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
/** server speech-to-text (Whisper on Cloudflare Workers AI through the AccessCare worker), for browsers that can't listen themselves */
export const serverListen = { url: '', available: false, used: 0 };
export const sttSupported = () => typeof window !== 'undefined' && (!!recCtor() || (serverListen.available && typeof MediaRecorder !== 'undefined'));
/** said next to the microphone permission when a recording may go to the AccessCare server to be turned into text */
export const SERVER_LISTEN_NOTE = { en: 'If your browser cannot turn speech into text itself, your short answer is sent to the AccessCare server and turned into text by Cloudflare Workers AI (Whisper). AccessCare does not keep the recording.', ar: 'لو المتصفح مش بيقدر يحوّل الكلام لنص بنفسه، إجابتك القصيرة بتتبعت لسيرفر أكسس كير وبتتحول لنص عن طريق Cloudflare Workers AI (Whisper). أكسس كير مش بيحتفظ بالتسجيل.' };
export const ttsAvailable = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

export function voicesFor(lang: VoiceLang): SpeechSynthesisVoice[] {
  if (!ttsAvailable()) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
}

// Novelty and "Eloquence" voices that iOS/macOS list next to the normal ones. They are hard to
// understand (or are joke voices), so they are never chosen automatically.
const POOR = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|espeak|robot|novelty)\b/i;
// Clear, commonly installed voices (Apple, Google, Microsoft), in order of preference.
const GOOD: Record<VoiceLang, RegExp[]> = {
  ar: [/\b(salma|shakir)\b.*online|online.*\b(salma|shakir)\b/i, /online \(natural\)/i, /google/i, /\bmajed\b|\bmaged\b/i, /\b(laila|mariam|tarik|hoda|naayf|zariyah|hamed)\b/i],
  en: [/\b(ava|jenny|aria|guy)\b.*online|online \(natural\)/i, /google us english/i, /\b(samantha|ava|allison|susan|nicky|tom|alex)\b/i, /google uk english/i, /\b(daniel|karen|moira|tessa|serena|kate)\b/i],
  fr: [/\b(denise|henri|vivienne|remy|eloise)\b.*online|online \(natural\)/i, /google fran[cç]ais/i, /\b(am[eé]lie|thomas|audrey|aur[eé]lie|marie|julie|paul)\b/i],
  ur: [/\b(uzma|asad|gul|salman)\b.*online|online \(natural\)/i, /google/i, /\b(uzma|asad)\b/i],
  hi: [/\b(swara|madhur)\b.*online|online \(natural\)/i, /google (हिन्दी|hindi)/i, /\b(lekha|kalpana|hemant|rishi|neel|swara)\b/i],
};
const quality = (v: SpeechSynthesisVoice) => (/premium/i.test(v.name) ? 2 : /enhanced|neural|natural/i.test(v.name) ? 1 : 0);

/**
 * The device voice used for a language: the patient's choice if they picked one; otherwise a
 * downloaded high-quality voice, then a known clear voice, then the system's own default for the
 * language — never a novelty voice. (Measured on what devices report; how it sounds depends on the device.)
 */
export function bestVoice(lang: VoiceLang, preferred?: string): SpeechSynthesisVoice | undefined {
  const all = voicesFor(lang);
  const chosen = preferred ? all.find((v) => v.name === preferred) : undefined;
  if (chosen) return chosen;
  const list = all.filter((v) => !POOR.test(v.name));
  if (!list.length) return all[0];
  const top = Math.max(...list.map(quality));
  if (top > 0) return list.find((v) => quality(v) === top);
  for (const re of GOOD[lang]) { const v = list.find((x) => re.test(x.name)); if (v) return v; }
  return list.find((v) => v.default) ?? list.find((v) => v.lang.replace('_', '-') === LOCALE[lang]) ?? list[0];
}
/** true when no clear voice for the language is installed (worth suggesting a voice download) */
export function onlyBasicVoices(lang: VoiceLang): boolean {
  const v = bestVoice(lang);
  return !v || POOR.test(v.name);
}

/** Text as it should be spoken: no emoji, arrows or symbols read out loud; dashes become pauses. */
export function speakable(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[✓✔✗✘•·→←↑↓]/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/["“”«»]/g, '')
    .replace(/\s*[()[\]]\s*/g, /[\u0600-\u06FF]/.test(text) ? '، ' : ', ')
    .replace(/(\p{L})\s*\/\s*(\p{L})/gu, '$1, $2')
    .replace(/([,،]\s*){2,}/g, '$1')
    .replace(/[,،]\s*([.!?؟۔।:])/g, '$1')
    .replace(/\s*[—–]\s*/g, /[\u0600-\u06FF]/.test(text) ? '، ' : ', ')
    .replace(/\s+([,.!?،؟])/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

/** One spoken item per message the app says; only very long ones are split at sentence ends. */
export function speechChunks(sentences: string[]): string[] {
  const out: string[] = [];
  for (const raw of sentences) {
    const t = speakable(raw);
    if (!t) continue;
    if (t.length <= 300) { out.push(t); continue; }
    let cur = '';
    for (const part of t.match(/[^.!?؟…]+[.!?؟…]*\s*/g) ?? [t]) {
      if ((cur + part).length > 300 && cur) { out.push(cur.trim()); cur = ''; }
      cur += part;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}
/** which voice should read a sentence: by its script, staying in the conversation's language when the script fits it */
export const langOfText = (t: string, fallback: VoiceLang): VoiceLang => {
  const ar = (t.match(/[؀-ۿ]/g) ?? []).length; const de = (t.match(/[ऀ-ॿ]/g) ?? []).length; const la = (t.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  if (!ar && !de && !la) return fallback;
  if (de >= ar && de >= la) return 'hi';
  if (ar >= la) return fallback === 'ur' || /[ٹڈڑںھہۂیےۓکگپچژ]/.test(t) ? 'ur' : 'ar';
  return fallback === 'fr' ? 'fr' : 'en';
};

// ---------------------------------------------------------------- natural (server) voice
/** The optional natural voice: Azure AI Speech through the AccessCare worker (the key stays on the server). */
export const naturalVoice = { url: '', available: null as boolean | null, provider: '', lastError: '', used: 0, langs: ['en'] as string[], failures: {} as Record<string, number> };
export async function probeNaturalVoice(base: string): Promise<void> {
  if (!base) { naturalVoice.available = false; return; }
  naturalVoice.url = base.replace(/\/$/, '') + '/tts';
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/status');
    const j = r.ok ? await r.json() as { tts?: boolean; ttsProvider?: string; ttsLangs?: string[]; stt?: boolean } : {};
    naturalVoice.available = !!j.tts; naturalVoice.provider = j.ttsProvider ?? ''; naturalVoice.langs = Array.isArray(j.ttsLangs) ? j.ttsLangs : ['en'];
    serverListen.available = !!j.stt; serverListen.url = base.replace(/\/$/, '') + '/stt';
  } catch { naturalVoice.available = false; }
}
let audioEl: HTMLAudioElement | null = null;
/** 50 ms of silence as a WAV data URI (used to unlock audio on mobile) */
function silentWav(): string {
  const n = 400, buf = new Uint8Array(44 + n), v = new DataView(buf.buffer);
  const w = (o: number, t: string) => [...t].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); buf.fill(128, 44);
  let bin = ''; buf.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}
/** Must run inside a tap once, so mobile browsers allow audio playback afterwards. */
export function unlockAudio() {
  if (naturalVoice.available !== true) return; // only the server voice plays audio files; never disturb the device voice
  try { if (!audioEl) audioEl = new Audio(); audioEl.src = silentWav(); void audioEl.play().catch(() => {}); } catch { /* */ }
}
const audioCache = new Map<string, Promise<string>>();
function fetchAudio(text: string, lang: VoiceLang, rate: number): Promise<string> {
  const key = `${lang}|${rate}|${text}`;
  let p = audioCache.get(key);
  if (!p) {
    p = fetch(naturalVoice.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang, rate }) })
      .then(async (r) => { if (!r.ok) throw new Error(`tts ${r.status}`); return URL.createObjectURL(await r.blob()); });
    p.catch(() => audioCache.delete(key));
    audioCache.set(key, p);
    if (audioCache.size > 40) audioCache.delete(audioCache.keys().next().value as string);
  }
  return p;
}

export interface SpeakOpts { lang: VoiceLang; rate: number; voice?: string; voiceAr?: string; voiceEn?: string; voices?: Partial<Record<VoiceLang, string>>; engine?: 'natural' | 'device' }

/** Speaks queued sentences; can pause, resume, stop and repeat. One voice at a time, never overlapping. */
export class Speaker {
  speaking = false;
  paused = false;
  /** which voice spoke last: 'natural' (server neural voice) or 'device' */
  engine: 'natural' | 'device' = 'device';
  private token = 0;
  private release: (() => void) | null = null;
  private live: SpeechSynthesisUtterance | null = null;
  constructor(private onState: (s: { speaking: boolean; paused: boolean }) => void) {}

  /** Resolves when everything was spoken (or speaking was stopped). */
  speak(sentences: string[], opts: SpeakOpts): Promise<void> {
    const chunks = speechChunks(sentences);
    if (!chunks.length) return Promise.resolve();
    const natural = opts.engine !== 'device' && naturalVoice.available === true && !!naturalVoice.url && naturalVoice.langs.includes(opts.lang) && (naturalVoice.failures[opts.lang] ?? 0) < 2; // an older worker speaks fewer languages; a voice that keeps failing is skipped
    if (!natural && !ttsAvailable()) return Promise.resolve();
    const wasBusy = ttsAvailable() && (speechSynthesis.speaking || speechSynthesis.pending);
    this.stop();
    const my = ++this.token;
    this.set(true, false);
    return new Promise((resolveOuter) => {
      const resolve = () => { if (this.release === resolve) this.release = null; resolveOuter(); };
      this.release = resolve;
      let i = 0;
      const finish = () => { if (my === this.token) this.set(false, false); resolve(); };
      const deviceNext = () => {
        if (my !== this.token) return resolve();
        if (i >= chunks.length) return finish();
        const text = chunks[i++];
        const lang = langOfText(text, opts.lang);
        const voice = bestVoice(lang, lang === 'ar' ? (opts.voiceAr ?? (opts.lang === 'ar' ? opts.voice : undefined)) : lang === 'en' ? (opts.voiceEn ?? (opts.lang === 'en' ? opts.voice : undefined)) : opts.voices?.[lang]);
        const u = new SpeechSynthesisUtterance(text);
        u.lang = voice?.lang ?? LOCALE[lang]; if (voice) u.voice = voice;
        u.rate = opts.rate; u.pitch = 1; u.volume = 1;
        let done = false; let guard = 0;
        const next = () => { if (done) return; done = true; window.clearTimeout(guard); deviceNext(); };
        u.onend = next; u.onerror = next;
        this.live = u; // keep a reference: some browsers drop unreferenced utterances and never report the end
        this.engine = 'device';
        speechSynthesis.speak(u);
        // if the browser never reports the end (hidden page, engine bug), move on once — never speak anything twice
        guard = window.setTimeout(() => { if (my === this.token && !this.paused) next(); }, 6000 + text.length * 120 / Math.max(0.6, opts.rate));
      };
      const naturalNext = async () => {
        if (my !== this.token) return resolve();
        if (i >= chunks.length) return finish();
        const text = chunks[i];
        const lang = langOfText(text, opts.lang);
        if (!naturalVoice.langs.includes(lang) || (naturalVoice.failures[lang] ?? 0) >= 2) { deviceNext(); return; } // e.g. an English word in an Urdu sentence list
        try {
          const url = await fetchAudio(text, lang, opts.rate);
          if (i + 1 < chunks.length) void fetchAudio(chunks[i + 1], langOfText(chunks[i + 1], opts.lang), opts.rate).catch(() => {}); // prefetch: no gap between sentences
          if (my !== this.token) return resolve();
          if (!audioEl) audioEl = new Audio();
          const a = audioEl;
          a.onended = () => { i++; void naturalNext(); };
          a.onerror = () => { naturalVoice.lastError = 'playback'; deviceNext(); };
          a.src = url;
          this.engine = 'natural'; naturalVoice.used++;
          await a.play();
        } catch (e) {
          // server voice failed: say the rest with the device voice (and report it)
          naturalVoice.lastError = (e as Error).message || 'failed';
          naturalVoice.failures[lang] = (naturalVoice.failures[lang] ?? 0) + 1;
          if (my !== this.token) return resolve();
          if (ttsAvailable()) deviceNext(); else finish();
        }
      };
      const begin = () => { if (my !== this.token) return resolve(); if (natural) void naturalNext(); else deviceNext(); };
      if (wasBusy) window.setTimeout(begin, 120); else begin();
    });
  }
  pause() {
    if (!this.speaking) return;
    if (this.engine === 'natural' && audioEl) audioEl.pause(); else if (ttsAvailable()) speechSynthesis.pause();
    this.set(true, true);
  }
  resume() {
    if (!this.paused) return;
    if (this.engine === 'natural' && audioEl) void audioEl.play().catch(() => {}); else if (ttsAvailable()) speechSynthesis.resume();
    this.set(true, false);
  }
  /** Stops speaking now; whoever was waiting for the speech to end continues (some engines never report a cancelled sentence). */
  stop() {
    this.token++; const r = this.release; this.release = null;
    if (ttsAvailable()) speechSynthesis.cancel();
    if (audioEl) { try { audioEl.pause(); audioEl.onended = null; audioEl.onerror = null; } catch { /* */ } }
    this.set(false, false); r?.();
  }
  private set(speaking: boolean, paused: boolean) { this.speaking = speaking; this.paused = paused; this.onState({ speaking, paused }); }
}

/** Speak immediately inside a user gesture (iOS only allows speech that starts from a tap). */
export function primeSpeech(text: string, lang: VoiceLang) {
  unlockAudio();
  if (!ttsAvailable()) return;
  text = speakable(text);
  try { const u = new SpeechSynthesisUtterance(text); const v = bestVoice(lang); u.lang = v?.lang ?? LOCALE[lang]; if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ }
}

export type ListenResult = { text: string; alternatives: string[]; confidence: number } | { error: SpeechErr };

/** One listening turn. The microphone is on only between start and the result. */
export class Listener {
  private rec: Rec | null = null;
  private cancel: (() => void) | null = null;
  listening = false;
  constructor(private onState: (s: { listening: boolean; interim: string }) => void) {}

  /**
   * Listens once, waiting up to timeoutMs for the person to start speaking (at least 12 s).
   * The browser's recognizer is used first; it is restarted quietly when it stops too early.
   * If the browser can't listen (no recognizer, service unreachable, language missing) and the
   * AccessCare server offers speech-to-text, a short clip is recorded and transcribed there instead.
   */
  async listen(lang: VoiceLang, timeoutMs = 12000): Promise<ListenResult> {
    const wait = Math.max(12000, timeoutMs);
    if (!recCtor()) return serverListen.available ? this.listenServer(lang, wait) : { error: 'unsupported' };
    const r = await this.listenBrowser(lang, wait);
    if ('error' in r && ['network', 'language-not-supported', 'other', 'unsupported'].includes(r.error) && serverListen.available) return this.listenServer(lang, wait);
    return r;
  }

  private async listenBrowser(lang: VoiceLang, wait: number): Promise<ListenResult> {
    const until = Date.now() + wait;
    let last: ListenResult = { error: 'no-speech' };
    let networkTries = 0;
    // the recognizer often ends after a few seconds of silence: start it again until the person speaks or the time is up
    while (Date.now() < until - 400) {
      const r = await this.listenOnce(lang, until - Date.now());
      if (!('error' in r)) return r;
      last = r;
      if (r.error === 'network' && ++networkTries < 2) continue;
      if (r.error !== 'no-speech' && r.error !== 'aborted') return r;
      if (r.error === 'aborted' && !this.wanted) return r; // stopped on purpose
      await new Promise((ok) => setTimeout(ok, 150));
    }
    return last;
  }
  private wanted = false;

  private listenOnce(lang: VoiceLang, timeoutMs: number): Promise<ListenResult> {
    const C = recCtor();
    if (!C) return Promise.resolve({ error: 'unsupported' });
    this.stopEngine();
    this.wanted = true;
    return new Promise((resolve) => {
      let done = false; let heard = '';
      const finish = (r: ListenResult) => {
        if (done) return; done = true; window.clearTimeout(timer); this.cancel = null;
        this.listening = false; this.onState({ listening: false, interim: '' }); try { rec.abort(); } catch { /* */ } this.rec = null; resolve(r);
      };
      const rec = new C();
      this.rec = rec;
      this.cancel = () => finish({ error: 'aborted' });
      rec.lang = LOCALE[lang]; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
      rec.onstart = () => { this.listening = true; this.onState({ listening: true, interim: '' }); };
      rec.onresult = (e) => {
        const res = e.results[e.results.length - 1];
        const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript.trim()).filter(Boolean);
        if (res.isFinal) finish({ text: alts[0] ?? '', alternatives: alts.slice(1), confidence: res[0]?.confidence ?? 0 });
        else { heard = alts[0] ?? heard; this.onState({ listening: true, interim: heard }); }
      };
      rec.onerror = (e) => {
        const map: Record<string, SpeechErr> = { 'not-allowed': 'not-allowed', 'service-not-allowed': 'not-allowed', 'no-speech': 'no-speech', 'audio-capture': 'audio-capture', network: 'network', aborted: 'aborted', 'language-not-supported': 'language-not-supported' };
        // words were heard but the engine never sent a final result: use them
        if (heard && (e.error === 'no-speech' || e.error === 'aborted')) return finish({ text: heard, alternatives: [], confidence: 0.5 });
        finish({ error: map[e.error] ?? 'other' });
      };
      rec.onend = () => finish(heard ? { text: heard, alternatives: [], confidence: 0.5 } : { error: 'no-speech' });
      const timer = window.setTimeout(() => finish(heard ? { text: heard, alternatives: [], confidence: 0.5 } : { error: 'no-speech' }), Math.max(1000, timeoutMs));
      try { rec.start(); } catch { finish({ error: 'other' }); }
    });
  }

  /** Records one short answer (stops after a pause, or after 15 s of talking) and has the AccessCare server transcribe it. Nothing is kept. */
  private async listenServer(lang: VoiceLang, wait: number): Promise<ListenResult> {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { error: 'unsupported' };
    this.stopEngine();
    this.wanted = true;
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return { error: (e as DOMException)?.name === 'NotFoundError' ? 'audio-capture' : 'not-allowed' }; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = AC ? new AC() : null;
    const an = ctx ? ctx.createAnalyser() : null;
    if (ctx && an) { an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an); }
    const buf = new Uint8Array(1024);
    const level = () => { if (!an) return 0; an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; } return Math.sqrt(sum / buf.length); };
    const result = await new Promise<'speech' | 'silence' | 'aborted'>((resolve) => {
      let spoke = false; let lastLoud = 0; const t0 = Date.now(); let floor = 0.01; let n = 0;
      const tick = window.setInterval(() => {
        const l = level(); const now = Date.now();
        if (now - t0 < 400) { floor = Math.max(floor, l); n++; return; } // the room's own noise
        const loud = l > Math.max(0.03, floor * 2.5);
        if (loud) { if (!spoke) { spoke = true; this.onState({ listening: true, interim: '…' }); } lastLoud = now; }
        if (spoke && now - lastLoud > 1300) end('speech');
        else if (!spoke && now - t0 > wait) end('silence');
        else if (spoke && now - t0 > wait + 15000) end('speech');
        else if (!an && now - t0 > 7000) end('speech'); // no level meter: a fixed 7-second answer
      }, 100);
      const end = (r: 'speech' | 'silence' | 'aborted') => { window.clearInterval(tick); this.cancel = null; resolve(r); };
      this.cancel = () => end('aborted');
      rec.start(250); this.listening = true; this.onState({ listening: true, interim: '' });
      void n;
    });
    const stopped = new Promise<void>((ok) => { rec.onstop = () => ok(); });
    try { rec.stop(); } catch { /* */ }
    await Promise.race([stopped, new Promise((ok) => setTimeout(ok, 800))]);
    stream.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => {});
    this.listening = false; this.onState({ listening: false, interim: '' });
    if (result === 'aborted') return { error: 'aborted' };
    if (result === 'silence' || !parts.length) return { error: 'no-speech' };
    const blob = new Blob(parts, { type: type ?? 'audio/webm' });
    const b64 = await new Promise<string>((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, '')); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
    try {
      this.onState({ listening: false, interim: '…' });
      const r = await fetch(serverListen.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: b64, lang }) });
      if (!r.ok) return { error: 'network' };
      const j = await r.json() as { text?: string };
      serverListen.used++;
      const text = String(j.text ?? '').trim();
      return text ? { text, alternatives: [], confidence: 0.8 } : { error: 'no-speech' };
    } catch { return { error: 'network' }; }
    finally { this.onState({ listening: false, interim: '' }); }
  }

  private stopEngine() { try { this.rec?.abort(); } catch { /* */ } this.rec = null; }
  stop() { this.wanted = false; const c = this.cancel; this.cancel = null; c?.(); this.stopEngine(); if (this.listening) { this.listening = false; this.onState({ listening: false, interim: '' }); } }
}
