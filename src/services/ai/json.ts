// Reading JSON out of a model's answer. Models sometimes wrap it in ```json fences or a sentence, and a
// long answer can be cut off at the length limit. A cut-off answer is repaired by keeping every complete
// item and dropping only the unfinished last one — nothing is invented, and the app's checks still run.
// (server/cloudflare-worker.mjs has the same function.)

export function extractJson(text: unknown): unknown {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch { /* look inside */ }
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  const s = t.slice(start);
  const stack: string[] = []; const cuts: { at: number; closers: string }[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) { try { return JSON.parse(s.slice(0, i + 1)); } catch { return null; } }
      cuts.push({ at: i + 1, closers: [...stack].reverse().join('') }); // after a finished value
    } else if (ch === ',') cuts.push({ at: i, closers: [...stack].reverse().join('') });
  }
  // cut off: close at the last point where everything before was complete
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 60; k--) {
    try { return JSON.parse(s.slice(0, cuts[k].at) + cuts[k].closers); } catch { /* try an earlier point */ }
  }
  return null;
}
