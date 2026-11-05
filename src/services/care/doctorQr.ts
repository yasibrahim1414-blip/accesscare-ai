// Doctor ID QR codes. The code holds a link to AccessCare with the Doctor ID, so it works two ways:
// scanned inside AccessCare (the ID is filled in), or with any phone camera (the link opens AccessCare
// with the ID filled in). Either way the patient still sees the doctor's name and confirms before
// anything is connected — a QR code never connects anyone by itself.
import { DOCTOR_ID_PATTERN, normalizeDoctorId } from '../crypto';

export const APP_URL = 'https://yasibrahim1414-blip.github.io/accesscare-ai/';

/** the link inside a doctor's QR code */
export const doctorLink = (doctorId: string) => `${APP_URL}?doctor=${encodeURIComponent(doctorId)}`;

/** The Doctor ID in a scanned QR code: an AccessCare link with ?doctor=…, or the ID itself. Anything else → null. */
export function doctorIdFromQr(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let raw = t;
  try {
    const u = new URL(t);
    raw = u.searchParams.get('doctor') ?? '';
  } catch { /* not a link: maybe the ID itself */ }
  if (!raw) return null;
  const id = normalizeDoctorId(raw);
  return DOCTOR_ID_PATTERN.test(id) ? id : null;
}

// ---------------------------------------------------------------- a Doctor ID that came in with the link
const KEY = 'accesscare.pendingDoctor';
let pending: string | null = null;
/** Read ?doctor=… from the address once (when the app opens) and take it out of the address. */
export function takeDoctorFromAddress(): void {
  try {
    const u = new URL(location.href);
    const id = doctorIdFromQr(u.searchParams.has('doctor') ? u.href : '');
    if (u.searchParams.has('doctor')) { u.searchParams.delete('doctor'); history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash); }
    if (id) { pending = id; try { sessionStorage.setItem(KEY, id); } catch { /* */ } }
  } catch { /* */ }
}
export function pendingDoctor(): string | null {
  if (pending) return pending;
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
export function clearPendingDoctor(): void {
  pending = null;
  try { sessionStorage.removeItem(KEY); } catch { /* */ }
}
