// Blind Access & Voice Companion — saved accessibility preferences.
// Only settings are stored: never audio, transcripts of the microphone, or voice prints.

export type VoiceLang = 'en' | 'ar';
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
    lang: pick(s.lang, ['en', 'ar'], 'en'),
    rate: Math.min(1.6, Math.max(0.6, Number(s.rate) || 1)),
    ...(typeof s.voice === 'string' && s.voice ? { voice: s.voice.slice(0, 120) } : {}),
    ...(typeof s.voiceAr === 'string' && s.voiceAr ? { voiceAr: s.voiceAr.slice(0, 120) } : {}),
    ...(typeof s.voiceEn === 'string' && s.voiceEn ? { voiceEn: s.voiceEn.slice(0, 120) } : {}),
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
