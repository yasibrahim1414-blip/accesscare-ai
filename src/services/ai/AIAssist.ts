// AI assistance for AccessCare AI.
//
// Real AI: when the app runs inside Claude, the page can ask Claude through the
// platform's `sample` capability (on the viewer's own Claude account; the
// first call asks the viewer to allow it). Used for three things only:
//   1. proposing structured values from the patient's own words (always shown
//      as suggestions the patient must confirm, and only if grounded in a quote)
//   2. wording the "main concern" sentence and Silent Signal messages from facts
//      the patient confirmed (checked so nothing new is added)
//   3. a supplementary safety hint that can only ADD urgent guidance, never
//      remove what the deterministic safety rules decided
// Every output passes guards; on any failure the rule-based path is used.
// Patient name, email and account ids are never sent.

import type { FieldSuggestion } from '../intent/ReconstructionEngine';
import { ASSOCIATED_OPTIONS, ONSET_OPTIONS, PATTERN_OPTIONS, SEVERITY_WORDS } from '../intent/ReconstructionEngine';
import { BODY_REGIONS } from '../../domain/bodyRegions';
import { checkAI, type AIHealth } from './health';
import { runtimeConfig } from '../config';

export interface SampleFn {
  (input: string, opts?: Record<string, unknown>): Promise<{ text: string }>;
  json<T = unknown>(input: string, opts?: Record<string, unknown>): Promise<T>;
}

export type AIState = 'available' | 'off' | 'unavailable' | 'declined';

/** Current consent, kept in sync with the signed-in patient's preference by the app. */
export const aiConsent = { on: false };

export interface AIAssist {
  /** whether the platform offers AI in this view at all */
  readonly supported: boolean;
  state(consent: boolean): AIState;
  readonly label: string;
  extract(text: string, context: { regions: string[]; sensations: string[] }): Promise<FieldSuggestion[]>;
  wordMainConcern(facts: string[]): Promise<string | null>;
  wordMessage(facts: string[]): Promise<string | null>;
  safetyHint(text: string, context: { regions: string[]; sensations: string[] }): Promise<{ concern: boolean; reason: string } | null>;
  /** Voice Companion: which offered option the patient's words mean (or null). The app always asks the patient to confirm it. */
  interpretChoice(question: string, options: { id: string; label: string }[], said: string, lang: 'en'): Promise<string | null>;
  /** Voice Companion: one short, warm acknowledgement of what the patient said, adding nothing. */
  acknowledge(said: string, lang: 'en'): Promise<string | null>;
  /** Voice Companion: a short spoken answer when the patient asks something or talks freely (about using the app — never medical advice). */
  chatReply(said: string, question: string, lang: 'en'): Promise<string | null>;
  /** Conversation manager: one validated conversation turn (raw JSON; validated by services/conversation/ai.ts). */
  converse(prompt: string): Promise<unknown | null>;
  /** Clinical Intelligence Engine (doctor-requested; the caller checks the patient's consent recorded in the report). */
  clinical(prompt: string, maxTokens: number): Promise<{ json: unknown } | { error: string }>;
  /** Blind Mode: interpret a spoken request against the controls on the screen (raw JSON; validated by the caller). */
  voiceCommand(prompt: string): Promise<unknown | null>;
  /** Reads a photo (medicine package): raw JSON validated by the caller; null when unavailable or it failed. */
  vision(prompt: string, image: Blob): Promise<unknown | null>;
  /** Whether this view can send photos to Claude at all. */
  visionSupported(): Promise<boolean>;
  /** Why the last AI call failed ('' after a success). */
  readonly lastError: string;
  /** A real end-to-end test of the AI connection (sends one tiny request). */
  testConnection(): Promise<AIHealth>;
}

// ---------- guards ----------
const DIAGNOSTIC = /\b(diagnos\w*|likely|probabl\w*|possibl\w*|suggest\w*|indicat\w*|consistent with|caused by|due to|syndrome|disease|disorder|infection|inflammation|neuropath\w*|arthritis|fracture|sprain|stroke|heart attack|appendicitis|cancer|tumou?r|condition|should|must|recommend\w*|treat\w*|medication|you have|don'?t worry|nothing serious|you('| wi)ll be (fine|ok))\b/i;
const REGION_WORDS = [...new Set(BODY_REGIONS.flatMap((r) => r.label.toLowerCase().replace(/^(left|right) /, '').split(' ')))]
  .filter((w) => w.length > 3 && !['upper', 'lower'].includes(w));

/**
 * Accepts AI wording only if it adds nothing: no diagnostic or advisory
 * language, no numbers or body parts that are not in the confirmed facts, and
 * a sensible length. Returns null when rejected.
 */
export function guardWording(output: unknown, facts: string[], maxLen = 260): string | null {
  if (typeof output !== 'string') return null;
  const text = output.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  if (text.length < 8 || text.length > maxLen) return null;
  if (DIAGNOSTIC.test(text)) return null;
  const factText = facts.join(' ').toLowerCase();
  for (const n of text.match(/\d+/g) ?? []) if (!factText.includes(n)) return null;
  for (const w of REGION_WORDS) if (new RegExp(`\\b${w}s?\\b`, 'i').test(text) && !factText.includes(w)) return null;
  for (const side of ['left', 'right']) if (new RegExp(`\\b${side}\\b`, 'i').test(text) && !factText.includes(side)) return null;
  return text;
}

const VALUES: Record<string, string[]> = {
  onset: ONSET_OPTIONS, pattern: PATTERN_OPTIONS, severity: SEVERITY_WORDS,
  associated: ASSOCIATED_OPTIONS.filter((o) => o !== 'Nothing else'),
};

/** Keeps only suggestions with an allowed value and a quote that really appears in the patient's text. */
export function guardSuggestions(raw: unknown, text: string): FieldSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const lower = text.toLowerCase();
  const out: FieldSuggestion[] = [];
  for (const r of raw.slice(0, 8)) {
    if (!r || typeof r !== 'object') continue;
    const { field, value, quote } = r as Record<string, unknown>;
    if (typeof field !== 'string' || typeof value !== 'string' || typeof quote !== 'string') continue;
    if (!(field in VALUES) || !VALUES[field].includes(value)) continue;
    if (quote.length < 2 || quote.length > 120 || !lower.includes(quote.toLowerCase())) continue;
    if (out.some((o) => o.field === field)) continue;
    out.push({ field: field as FieldSuggestion['field'], value, quote, by: 'ai' });
  }
  return out;
}

// ---------- implementations ----------
export class NoAI implements AIAssist {
  readonly supported = false;
  readonly label = 'AI not available here — wording by AccessCare rules';
  state(): AIState { return 'unavailable'; }
  async extract() { return []; }
  async wordMainConcern() { return null; }
  async wordMessage() { return null; }
  async safetyHint() { return null; }
  async interpretChoice() { return null; }
  async acknowledge() { return null; }
  async chatReply() { return null; }
  async converse() { return null; }
  async clinical() { return { error: 'No AI service in this view.' }; }
  async voiceCommand() { return null; }
  async vision() { return null; }
  async visionSupported() { return false; }
  readonly lastError = '';
  async testConnection(): Promise<AIHealth> { return checkAI(runtimeConfig.aiEndpoint, null); }
}

export class ClaudeAI implements AIAssist {
  readonly supported = true;
  readonly label = 'Claude (AI)';
  private declined = false;
  lastError = '';
  constructor(private sample: SampleFn, private consent: () => boolean) {}

  state(consent: boolean): AIState { return this.declined ? 'declined' : consent ? 'available' : 'off'; }

  private async ask<T>(prompt: string, opts: Record<string, unknown> = {}): Promise<T | null> {
    if (this.declined || !this.consent()) return null;
    try { const r = await this.sample.json<T>(prompt, { modelTier: 'quick', ...opts }); this.lastError = ''; return r; }
    catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'not_granted') this.declined = true;
      this.lastError = code === 'not_granted' ? 'not_granted' : (e as { detail?: string }).detail || (e as Error)?.message || 'unknown';
      return null;
    }
  }

  async extract(text: string, ctx: { regions: string[]; sensations: string[] }): Promise<FieldSuggestion[]> {
    if (!text.trim()) return [];
    const res = await this.ask<unknown>(`You help a patient who has trouble expressing symptoms. From the patient's own words below, find ONLY details they actually stated.
Allowed fields and values (use these exact values):
- onset: ${JSON.stringify(ONSET_OPTIONS)}
- pattern: ${JSON.stringify(PATTERN_OPTIONS)}
- severity: ${JSON.stringify(SEVERITY_WORDS)}
- associated: ${JSON.stringify(VALUES.associated)}
For each, give "quote": the exact words copied from the text that support it. Do not guess, infer causes, or diagnose. If nothing fits, return [].
Context (already selected by the patient): regions ${JSON.stringify(ctx.regions)}, sensations ${JSON.stringify(ctx.sensations)}.
Patient's words: ${JSON.stringify(text.slice(0, 1000))}
Reply with only a JSON array like [{"field":"onset","value":"1–3 days ago","quote":"since yesterday"}].`);
    return guardSuggestions(res, text);
  }

  async wordMainConcern(facts: string[]): Promise<string | null> {
    const res = await this.ask<{ sentence?: string }>(`Write ONE short, plain sentence (max 30 words) for a doctor stating the patient's main concern, using ONLY these patient-confirmed facts. Start with "Patient reports". Do not add any detail, cause, diagnosis, advice, number or body part that is not listed. Do not use words like likely, possibly, suggests.
Facts: ${JSON.stringify(facts)}
Reply with only JSON: {"sentence": "..."}`);
    return guardWording(res?.sentence, facts, 240);
  }

  async wordMessage(facts: string[]): Promise<string | null> {
    const res = await this.ask<{ message?: string }>(`A patient who cannot type built a message for their doctor by choosing options. Turn ONLY these confirmed selections into a short first-person message (max 45 words), in plain words. Do not add any detail, feeling, cause, diagnosis, request, number or body part that is not listed. If a selection says "not sure", keep that uncertainty.
Selections: ${JSON.stringify(facts)}
Reply with only JSON: {"message": "..."}`);
    return guardWording(res?.message, facts, 320);
  }

  async safetyHint(text: string, ctx: { regions: string[]; sensations: string[] }): Promise<{ concern: boolean; reason: string } | null> {
    if (!text.trim()) return null;
    const res = await this.ask<{ concern?: boolean; reason?: string }>(`Safety screen for a symptom-reporting app. Does the patient's text describe anything that could need URGENT medical attention right now (for example chest pressure, severe breathing trouble, sudden weakness on one side, fainting, heavy bleeding, thoughts of self-harm)? Do not diagnose. When unsure, answer true.
Regions: ${JSON.stringify(ctx.regions)}; sensations: ${JSON.stringify(ctx.sensations)}; text: ${JSON.stringify(text.slice(0, 1000))}
Reply with only JSON: {"concern": true|false, "reason": "short plain reason quoting the patient"}`);
    if (!res || typeof res.concern !== 'boolean') return null;
    return { concern: res.concern, reason: typeof res.reason === 'string' ? res.reason.slice(0, 160) : '' };
  }

  async interpretChoice(question: string, options: { id: string; label: string }[], said: string, lang: 'en'): Promise<string | null> {
    if (!said.trim() || !options.length) return null;
    const res = await this.ask<{ choice?: string | null }>(`A blind patient is answering a question by voice in English. Pick the ONE option their words clearly mean. If the words are unclear, unrelated, or could mean more than one option, answer null. Never guess.
Question: ${JSON.stringify(question.slice(0, 300))}
Options: ${JSON.stringify(options.map((o) => ({ id: o.id, label: o.label })))}
Patient said: ${JSON.stringify(said.slice(0, 300))}
Reply with only JSON: {"choice": "<option id>" | null}`);
    const c = res?.choice;
    return typeof c === 'string' && options.some((o) => o.id === c) ? c : null;
  }

  async acknowledge(said: string, lang: 'en'): Promise<string | null> {
    if (!said.trim()) return null;
    const res = await this.ask<{ reply?: string }>(`You are a calm voice assistant helping a blind patient prepare a message for their doctor. Reply with ONE short, warm sentence (max 20 words) in plain English acknowledging what they said. Do not ask a question. Do not add any detail, body part, number, cause, diagnosis, reassurance or advice that is not in their words.
Patient said: ${JSON.stringify(said.slice(0, 600))}
Reply with only JSON: {"reply": "..."}`);
    void lang; return guardWording(res?.reply, [said], 200);
  }

  async chatReply(said: string, question: string, lang: 'en'): Promise<string | null> {
    if (!said.trim()) return null;
    const res = await this.ask<{ reply?: string }>(`You are the voice of AccessCare AI, an app that helps a blind patient prepare a message for their doctor. The patient said something that is not an answer to the current question. Reply in plain English with at most 2 short sentences (max 40 words): answer briefly if it is about using the app, be kind if they share feelings, and then gently lead back to the question. Never diagnose, never give medical advice or reassurance, never invent facts about the patient, never mention numbers. If it sounds urgent, tell them to call emergency services.
Current question: ${JSON.stringify(question.slice(0, 300))}
Patient said: ${JSON.stringify(said.slice(0, 400))}
Reply with only JSON: {"reply": "..."}`);
    void lang; return guardWording(res?.reply, [said, question], 300);
  }

  async clinical(prompt: string, maxTokens: number): Promise<{ json: unknown } | { error: string }> {
    if (this.declined) return { error: 'AI was declined in this view.' };
    try {
      const remote = (this.sample as { remote?: boolean }).remote;
      const json = await this.sample.json<unknown>(prompt, remote ? { maxTokens } : { modelTier: 'default' });
      return { json };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'not_granted') this.declined = true;
      return { error: code === 'not_granted' ? 'AI was not allowed in this view.' : code === 'rate_limited' ? 'The AI is busy (rate limited). Try again in a minute.' : (e as Error)?.message || 'AI request failed' };
    }
  }
  async testConnection(): Promise<AIHealth> {
    if (this.declined) return { ok: false, problem: 'AI was not allowed in this view.', fix: 'Reload the page and allow AI when Claude asks.' };
    const h = await checkAI(runtimeConfig.aiEndpoint, this.sample);
    this.lastError = h.ok ? '' : this.lastError;
    return h;
  }

  async voiceCommand(prompt: string): Promise<unknown | null> {
    return this.ask<unknown>(prompt, (this.sample as { remote?: boolean }).remote ? { maxTokens: 300 } : {});
  }

  async vision(prompt: string, image: Blob): Promise<unknown | null> {
    const remote = (this.sample as { remote?: boolean }).remote;
    return this.ask<unknown>(prompt, remote ? { image, maxTokens: 500 } : { images: image, modelTier: 'default' });
  }

  async visionSupported(): Promise<boolean> {
    if ((this.sample as { remote?: boolean }).remote) return true;
    const lim = (this.sample as { limits?: () => Promise<{ images?: unknown }> }).limits;
    if (!lim) return false;
    try { return !!(await lim.call(this.sample))?.images; } catch { return false; }
  }

  async converse(prompt: string): Promise<unknown | null> {
    // the web proxy accepts a larger answer size; Claude's in-page `sample` takes only its documented options
    return this.ask<unknown>(prompt, (this.sample as { remote?: boolean }).remote ? { maxTokens: 900 } : {});
  }

}
