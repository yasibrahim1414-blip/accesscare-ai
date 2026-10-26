// Is the AI really working? Turns a failed AI call into a plain explanation and a fix,
// so the patient (or the person who set the app up) can see it — instead of the app
// quietly falling back to its built-in word list.

import type { SampleFn } from './AIAssist';
import { CONVERSE_PREFIX } from '../conversation/ai';

export const WORKER_VERSION = 3;

export interface AIProblem { problem: string; fix: string }

/** Explains an error string from the AI proxy (see RemoteSample.ts / server/cloudflare-worker.mjs). */
export function explainAIError(err: string): AIProblem {
  const e = err.toLowerCase();
  if (/network|failed to fetch|unreachable/.test(e)) return { problem: 'The app cannot reach your AI server (the Cloudflare worker).', fix: 'Check that the worker is deployed and that this page is opened from the address in ALLOWED_ORIGINS.' };
  if (/origin_not_allowed|403/.test(e) && !/upstream/.test(e)) return { problem: 'Your Cloudflare worker refused this website.', fix: 'In the worker settings, set ALLOWED_ORIGINS to https://yasibrahim1414-blip.github.io (no slash at the end), then Deploy.' };
  if (/prompt_not_allowed/.test(e)) return { problem: 'Your Cloudflare worker is an older version, so it refuses AccessCare’s conversation requests.', fix: 'Update the worker: copy the new code from cloudflare-worker.mjs (link below), paste it in Cloudflare → Edit code, then Deploy.' };
  if (/prompt_too_long/.test(e)) return { problem: 'The conversation became too long for the AI server.', fix: 'Start a new consultation.' };
  if (/not_configured|500/.test(e) && !/upstream/.test(e)) return { problem: 'Your Cloudflare worker has no Claude API key.', fix: 'In the worker: Settings → Variables and Secrets → add ANTHROPIC_API_KEY (type: Secret), then Deploy.' };
  if (/upstream/.test(e)) {
    if (/credit|balance|billing/.test(e)) return { problem: 'Claude refused because the API account has no credit left.', fix: 'Add credit in the Claude Console (Billing).' };
    if (/401|invalid.{0,3}api.key|authentication/.test(e)) return { problem: 'Claude refused the API key (it is wrong or was deleted).', fix: 'Create a new key in the Claude Console and replace ANTHROPIC_API_KEY in the worker, then Deploy.' };
    if (/404|model/.test(e)) return { problem: 'Claude does not know the model name set in the worker.', fix: 'Remove the MODEL variable in the worker (it then uses claude-haiku-5-5), or set a valid model name.' };
    if (/429|rate/.test(e)) return { problem: 'Too many AI requests at once (rate limit).', fix: 'Wait a minute and try again.' };
    if (/529|overloaded/.test(e)) return { problem: 'Claude is busy right now.', fix: 'Try again in a moment.' };
    return { problem: `Claude returned an error (${err}).`, fix: 'Try again; if it keeps happening, check the Claude Console.' };
  }
  if (/not_granted|declined|not allowed in this view/.test(e)) return { problem: 'AI was not allowed in this view.', fix: 'Allow AI when Claude asks, or reload the page.' };
  if (/answer failed the checks/.test(e)) return { problem: 'The AI answered, but its answer did not pass AccessCare’s safety checks, so it was not used.', fix: 'Say it again in other words; this can happen now and then.' };
  if (/no answer|timeout/.test(e)) return { problem: 'The AI did not answer in time.', fix: 'Try again. If it keeps happening, test the connection.' };
  return { problem: `The AI did not work (${err || 'unknown problem'}).`, fix: 'Test the connection to see why.' };
}

export type AIHealth = { ok: true; detail: string } | ({ ok: false } & AIProblem);

/** A real end-to-end check: the server's status, then one small conversation request. */
export async function checkAI(endpoint: string, sample: SampleFn | null): Promise<AIHealth> {
  if (endpoint) {
    let st: { version?: number; ai?: boolean; model?: string } | null = null;
    try {
      const r = await fetch(endpoint.replace(/\/+$/, '') + '/status');
      if (r.status === 403) return { ok: false, ...explainAIError('origin_not_allowed') };
      st = r.ok ? await r.json() : null;
    } catch { return { ok: false, ...explainAIError('network') }; }
    if (!st || !st.version || st.version < WORKER_VERSION) return { ok: false, ...explainAIError('prompt_not_allowed') };
    if (!st.ai) return { ok: false, ...explainAIError('not_configured') };
  }
  if (!sample) return { ok: false, problem: 'No AI service is available in this view.', fix: endpoint ? 'Reload the page.' : 'Open AccessCare inside Claude, or use the web version with a worker.' };
  try {
    const remote = (sample as { remote?: boolean }).remote;
    const j = await sample.json<{ reply?: string }>(`${CONVERSE_PREFIX}. Connection test. Reply with only JSON: {"reply":"ok"}`, remote ? { maxTokens: 100 } : {});
    if (j && typeof j === 'object' && typeof j.reply === 'string') return { ok: true, detail: endpoint ? 'Claude answered through your Cloudflare worker.' : 'Claude answered.' };
    return { ok: false, problem: 'The AI answered, but not in the expected format.', fix: 'Try again.' };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, ...explainAIError(code === 'not_granted' ? 'not_granted' : (e as { detail?: string }).detail || (e as Error).message || '') };
  }
}
