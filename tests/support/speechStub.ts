// a device voice list like iOS / Chrome report it (names only; nothing is spoken in this test)
export const V = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra }) as SpeechSynthesisVoice;
export const state = { voices: [] as SpeechSynthesisVoice[] };
export const spoken: { text: string; voice?: string; lang: string; rate: number }[] = [];
(globalThis as any).window = globalThis;
(globalThis as any).SpeechSynthesisUtterance = function (this: any, t: string) { this.text = t; };
(globalThis as any).speechSynthesis = {
  getVoices: () => state.voices, speaking: false, pending: false,
  speak(u: any) { spoken.push({ text: u.text, voice: u.voice?.name, lang: u.lang, rate: u.rate }); setTimeout(() => u.onend?.(), 5); },
  cancel() {}, pause() {}, resume() {},
};
