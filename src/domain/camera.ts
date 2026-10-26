// Silent Signal camera section — stored settings for answering with signs.
// Only choices and practice results are stored here (in the patient's
// preferences): never images or video. The examples of signs a patient teaches
// (hand-point numbers) stay on the device where they were taught.

export type Command = 'yes' | 'no' | 'next' | 'select' | 'unsure';
export const COMMANDS: Command[] = ['yes', 'no', 'next', 'select', 'unsure'];

export interface SignSetting {
  /** 'builtin' = an ASL sign the app recognizes; 'taught' = the patient's own sign */
  kind: 'builtin' | 'taught';
  label: string;
  /** practice attempts recognized / made */
  practiced: number;
  recognized: number;
  reliable: boolean;
  at: string;
}

export interface CameraSignalPrefs {
  method: 'signs';
  /** command → sign id ('asl_yes', 'asl_no', or a taught sign id) */
  mapping: Partial<Record<Command, string>>;
  signs: Record<string, SignSetting>;
  /** commands that worked in the sample-question test */
  tested: Partial<Record<Command, boolean>>;
  /** the patient confirmed the commands work as intended */
  confirmedByPatient: boolean;
  confirmedAt?: string;
}

const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : 0; };
const ID = /^(asl_yes|asl_no|t_[a-z0-9_-]{1,40})$/i;

/** Older camera settings (eye/head movements) are not carried over: the patient sets up signs once. */
export function cleanCameraPrefs(c: unknown): CameraSignalPrefs | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const src = c as Partial<CameraSignalPrefs>;
  if (src.method !== 'signs') return undefined;
  const out: CameraSignalPrefs = { method: 'signs', mapping: {}, signs: {}, tested: {}, confirmedByPatient: !!src.confirmedByPatient };
  if (src.confirmedAt) out.confirmedAt = String(src.confirmedAt).slice(0, 40);
  for (const [id, s] of Object.entries(src.signs ?? {})) {
    if (!ID.test(id) || !s || typeof s !== 'object') continue;
    out.signs[id] = { kind: s.kind === 'taught' ? 'taught' : 'builtin', label: String(s.label ?? id).slice(0, 60), practiced: num(s.practiced, 0, 50), recognized: num(s.recognized, 0, 50), reliable: !!s.reliable, at: String(s.at ?? '').slice(0, 40) };
  }
  const used = new Set<string>();
  for (const k of COMMANDS) {
    const m = src.mapping?.[k];
    if (m && out.signs[m] && !used.has(m)) { out.mapping[k] = m; used.add(m); }
    if (src.tested?.[k] !== undefined) out.tested[k] = !!src.tested[k];
  }
  return out;
}
