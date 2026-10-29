// Blind Access & Voice Companion — saved accessibility preferences.
// Only settings are stored: never audio, transcripts of the microphone, or voice prints.

import type { Lang } from '../i18n/lang';

export type VoiceLang = Lang;
const VOICE_LANGS: VoiceLang[] = ['en', 'ar', 'fr', 'ur', 'hi'];
export type GestureAction = 'next' | 'previous' | 'activate' | 'describe' | 'none';

export interface GestureMap {
  swipeRight: GestureAction;
  swipeLeft: GestureAction;
  doubleTap: GestureAction;
  longPress: GestureAction;
}

export interface BlindPrefs {
  enabled: boolean;
  lang: VoiceLang;
  /** speech rate, 0.6 – 1.6 (1 = normal) */
  rate: number;
  /** a SpeechSynthesis voice name, when the device offers several (older setting; per-language below wins) */
  voice?: string;
  /** chosen device voices per language */
  voiceAr?: string;
  voiceEn?: string;
  /** chosen device voices for French, Urdu and Hindi */
  voices?: Partial<Record<VoiceLang, string>>;
  /** natural = the server voice (Azure neural) when the app has one, else the best device voice; device = always the device voice */
  engine: 'natural' | 'device';
  /** full = explain each step; brief = short prompts */
  guidance: 'full' | 'brief';
  /** gestures = this app's swipe gestures; screenreader = VoiceOver/TalkBack only; buttons = large buttons only */
  navigation: 'gestures' | 'screenreader' | 'buttons';
  gestures: GestureMap;
  /** announce every item while moving, or only important changes */
  announce: 'all' | 'changes';
  /** answer by speaking or by touch / typing */
  input: 'voice' | 'touch';
  /** start listening automatically after each spoken question */
  autoListen: boolean;
}

export const DEFAULT_GESTURES: GestureMap = { swipeRight: 'next', swipeLeft: 'previous', doubleTap: 'activate', longPress: 'describe' };

export const DEFAULT_BLIND: BlindPrefs = {
  enabled: true, lang: 'en', rate: 1, guidance: 'full', navigation: 'gestures', gestures: { ...DEFAULT_GESTURES },
  announce: 'all', input: 'voice', autoListen: true, engine: 'natural',
};

const ACTIONS: GestureAction[] = ['next', 'previous', 'activate', 'describe', 'none'];

export function cleanBlindPrefs(b: unknown): BlindPrefs | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const s = b as Partial<BlindPrefs>;
  const g = (s.gestures ?? {}) as Partial<GestureMap>;
  const pick = <T extends string>(v: unknown, allowed: T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  return {
    enabled: s.enabled !== false,
    lang: pick(s.lang, VOICE_LANGS, 'en'),
    rate: Math.min(1.6, Math.max(0.6, Number(s.rate) || 1)),
    ...(typeof s.voice === 'string' && s.voice ? { voice: s.voice.slice(0, 120) } : {}),
    ...(typeof s.voiceAr === 'string' && s.voiceAr ? { voiceAr: s.voiceAr.slice(0, 120) } : {}),
    ...(typeof s.voiceEn === 'string' && s.voiceEn ? { voiceEn: s.voiceEn.slice(0, 120) } : {}),
    ...(s.voices && typeof s.voices === 'object' ? { voices: Object.fromEntries(Object.entries(s.voices).filter(([k, v]) => (VOICE_LANGS as string[]).includes(k) && typeof v === 'string' && v).map(([k, v]) => [k, (v as string).slice(0, 120)])) } : {}),
    engine: pick(s.engine, ['natural', 'device'], 'natural'),
    guidance: pick(s.guidance, ['full', 'brief'], 'full'),
    navigation: pick(s.navigation, ['gestures', 'screenreader', 'buttons'], 'gestures'),
    gestures: {
      swipeRight: pick(g.swipeRight, ACTIONS, 'next'), swipeLeft: pick(g.swipeLeft, ACTIONS, 'previous'),
      doubleTap: pick(g.doubleTap, ACTIONS, 'activate'), longPress: pick(g.longPress, ACTIONS, 'describe'),
    },
    announce: pick(s.announce, ['all', 'changes'], 'all'),
    input: pick(s.input, ['voice', 'touch'], 'voice'),
    autoListen: s.autoListen !== false,
  };
}

/** The device voice the person chose for a language (if any). */
export function chosenVoice(b: Pick<BlindPrefs, 'voice' | 'voiceAr' | 'voiceEn' | 'voices' | 'lang'>, lang: VoiceLang): string | undefined {
  if (lang === 'ar') return b.voiceAr ?? (b.lang === 'ar' ? b.voice : undefined);
  if (lang === 'en') return b.voiceEn ?? (b.lang === 'en' ? b.voice : undefined);
  return b.voices?.[lang];
}
/** The same preferences with a chosen voice for a language. */
export function withVoice<T extends Pick<BlindPrefs, 'voiceAr' | 'voiceEn' | 'voices'>>(b: T, lang: VoiceLang, name: string | undefined): T {
  if (lang === 'ar') return { ...b, voiceAr: name };
  if (lang === 'en') return { ...b, voiceEn: name };
  const voices = { ...(b.voices ?? {}) }; if (name) voices[lang] = name; else delete voices[lang];
  return { ...b, voices };
}
