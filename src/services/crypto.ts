// Crypto helpers built on WebCrypto (available in browsers and Node 20+).

const subtle = () => globalThis.crypto.subtle;

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + toHex(bytes);
}

export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export const PBKDF2_ITERATIONS = 120_000;

/** PBKDF2-SHA256 password hash. Passwords are never stored in plain text. */
export async function hashPassword(password: string, salt: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const enc = new TextEncoder();
  const key = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return toHex(bits);
}

/** Constant-time-ish comparison of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Unambiguous alphabet: no 0/O, 1/I/L.
export const DOCTOR_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const DOCTOR_ID_PATTERN = /^AC-DOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/**
 * Doctor ID: AC-DOC- + 6 characters from a 31-symbol alphabet (~887M combinations),
 * drawn with crypto.getRandomValues and rejection sampling (no modulo bias).
 * Uniqueness is enforced by the caller (retry on collision) and, in production,
 * by a UNIQUE constraint in the database.
 */
export function generateDoctorId(): string {
  const n = DOCTOR_ID_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  const buf = new Uint8Array(1);
  while (out.length < 6) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) out += DOCTOR_ID_ALPHABET[buf[0] % n];
  }
  return `AC-DOC-${out}`;
}

export function normalizeDoctorId(input: string): string {
  let s = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!s.startsWith('AC-DOC-')) {
    s = s.replace(/^AC-?DOC-?/, '');
    s = `AC-DOC-${s}`;
  }
  return s;
}

function randomChars(count: number): string {
  const n = DOCTOR_ID_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  const buf = new Uint8Array(1);
  while (out.length < count) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) out += DOCTOR_ID_ALPHABET[buf[0] % n];
  }
  return out;
}

export const PATIENT_ID_PATTERN = /^AC-PAT-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
/**
 * Patient ID: AC-PAT- + 6 random characters. An identifier to read aloud and share,
 * never a credential: signing in always needs the password (or a recovery code).
 */
export function generatePatientId(): string { return `AC-PAT-${randomChars(6)}`; }

export function normalizePatientId(input: string): string {
  const s = input.trim().toUpperCase().replace(/[\s.]+/g, '').replace(/^AC-?PAT-?/, '');
  return `AC-PAT-${s}`;
}

/** Recovery code: 16 random characters (~79 bits) in 4 groups, e.g. 7K4P-9XQ2-MBTA-3HZR. Shown once; only a hash / wrapped key is stored. */
export function generateRecoveryCode(): string {
  const c = randomChars(16);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}
export function normalizeRecoveryCode(input: string): string {
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return s.length === 16 ? `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}` : s;
}
