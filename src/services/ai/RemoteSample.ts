// Claude for the web version: AccessCare's fixed prompts go to a small proxy
// (server/cloudflare-worker.mjs) that holds the API key. The page never sees a key.
import type { SampleFn } from './AIAssist';

/** Result of the last call to the proxy, shown to the patient so a broken setup is visible. */
export const remoteStatus: { ok: boolean | null; error: string } = { ok: null, error: '' };

export function remoteSample(endpoint: string): SampleFn {
  const call = async (prompt: string, opts?: Record<string, unknown>) => {
    let r: Response;
    const maxTokens = typeof opts?.maxTokens === 'number' ? opts.maxTokens : undefined;
    const image = opts?.image instanceof Blob ? await blobToImage(opts.image) : undefined;
    try { r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(image ? { image } : {}) }) }); }
    catch (e) { remoteStatus.ok = false; remoteStatus.error = 'network'; throw Object.assign(new Error('AI service unreachable'), { code: 'unavailable', cause: e, detail: 'network' }); }
    if (!r.ok) {
      let detail = '';
      try { const b = (await r.json()) as { error?: string; status?: number; detail?: string }; detail = `${b.error ?? ''}${b.status ? ` ${b.status}` : ''}${b.detail ? ` — ${b.detail}` : ''}`.trim(); } catch { /* */ }
      remoteStatus.ok = false; remoteStatus.error = `${r.status}${detail ? ` ${detail}` : ''}`;
      // a refused proxy call is a setup problem, not the patient declining AI
      throw Object.assign(new Error(`AI service ${r.status}`), { code: 'unavailable', detail: remoteStatus.error });
    }
    const data = (await r.json()) as { json?: unknown };
    remoteStatus.ok = true; remoteStatus.error = '';
    return data.json ?? null;
  };
  const fn = (async (input: string, opts?: Record<string, unknown>) => ({ text: JSON.stringify(await call(input, opts)) })) as SampleFn;
  fn.json = (async (input: string, opts?: Record<string, unknown>) => call(input, opts)) as SampleFn['json'];
  (fn as unknown as { remote: boolean }).remote = true;
  return fn;
}

/** A photo as the proxy expects it: { media_type, data (base64) }. */
async function blobToImage(b: Blob): Promise<{ media_type: string; data: string }> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { media_type: b.type || 'image/jpeg', data: btoa(bin) };
}
