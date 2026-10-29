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
export const sttSupported = () => typeof window !== 'undefined' && !!recCtor();
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
export const naturalVoice = { url: '', available: null as boolean | null, provider: '', lastError: '', used: 0, langs: ['en'] as string[] };
export async function probeNaturalVoice(base: string): Promise<void> {
  if (!base) { naturalVoice.available = false; return; }
  naturalVoice.url = base.replace(/\/$/, '') + '/tts';
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/status');
    const j = r.ok ? await r.json() as { tts?: boolean; ttsProvider?: string; ttsLangs?: string[] } : {};
    naturalVoice.available = !!j.tts; naturalVoice.provider = j.ttsProvider ?? ''; naturalVoice.langs = Array.isArray(j.ttsLangs) ? j.ttsLangs : ['en'];
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
    const natural = opts.engine !== 'device' && naturalVoice.available === true && !!naturalVoice.url && naturalVoice.langs.includes(opts.lang); // an older worker speaks fewer languages
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
  listening = false;
  constructor(private onState: (s: { listening: boolean; interim: string }) => void) {}

  /** Listens once; a transient speech-service error (network) is retried once automatically. */
  async listen(lang: VoiceLang, timeoutMs = 9000): Promise<ListenResult> {
    const r = await this.listenOnce(lang, timeoutMs);
    if ('error' in r && r.error === 'network') return this.listenOnce(lang, timeoutMs);
    return r;
  }

  private listenOnce(lang: VoiceLang, timeoutMs: number): Promise<ListenResult> {
    const C = recCtor();
    if (!C) return Promise.resolve({ error: 'unsupported' });
    this.stop();
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: ListenResult) => { if (done) return; done = true; this.listening = false; this.onState({ listening: false, interim: '' }); try { rec.abort(); } catch { /* */ } this.rec = null; resolve(r); };
      const rec = new C();
      this.rec = rec;
      rec.lang = LOCALE[lang]; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
      rec.onstart = () => { this.listening = true; this.onState({ listening: true, interim: '' }); };
      rec.onresult = (e) => {
        const res = e.results[e.results.length - 1];
        const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript.trim()).filter(Boolean);
        if (res.isFinal) finish({ text: alts[0] ?? '', alternatives: alts.slice(1), confidence: res[0]?.confidence ?? 0 });
        else this.onState({ listening: true, interim: alts[0] ?? '' });
      };
      rec.onerror = (e) => {
        const map: Record<string, SpeechErr> = { 'not-allowed': 'not-allowed', 'service-not-allowed': 'not-allowed', 'no-speech': 'no-speech', 'audio-capture': 'audio-capture', network: 'network', aborted: 'aborted', 'language-not-supported': 'language-not-supported' };
        finish({ error: map[e.error] ?? 'other' });
      };
      rec.onend = () => finish({ error: 'no-speech' });
      try { rec.start(); } catch { finish({ error: 'other' }); }
      setTimeout(() => finish({ error: 'no-speech' }), timeoutMs);
    });
  }
  stop() { try { this.rec?.abort(); } catch { /* */ } this.rec = null; if (this.listening) { this.listening = false; this.onState({ listening: false, interim: '' }); } }
}
