// End-to-end encryption for the shared cloud database.
//
// Every account has:
//  * a random AES-256-GCM "vault" key, stored only wrapped by a key derived
//    from the user's AccessCare passcode (PBKDF2-SHA256), used for the
//    user's own private records (drafts, doctor notes, preferences);
//  * an ECDH P-256 key pair; the private key is stored encrypted with the vault.
// A patient and their doctor derive the same AES-GCM "pair key" with ECDH +
// HKDF, so shared consultations and messages are readable only by those two.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const rand = (n: number): Uint8Array<ArrayBuffer> => { const a = new Uint8Array(new ArrayBuffer(n)); globalThis.crypto.getRandomValues(a); return a; };

export interface Sealed { iv: string; ct: string }

export async function seal(key: CryptoKey, value: unknown, aad = ''): Promise<Sealed> {
  const iv = rand(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open<T>(key: CryptoKey, s: Sealed, aad = ''): Promise<T> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: enc.encode(aad) }, key, unb64(s.ct));
  return JSON.parse(dec.decode(pt)) as T;
}

export const PASSCODE_ITERATIONS = 210_000;

async function passKey(passcode: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function newVault(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export async function exportVault(k: CryptoKey): Promise<string> { return b64(await subtle().exportKey('raw', k)); }
export async function importVault(raw: string): Promise<CryptoKey> {
  return subtle().importKey('raw', unb64(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export interface WrappedVault { salt: string; iter: number; wrapped: Sealed }

export async function wrapVault(vault: CryptoKey, passcode: string, iterations = PASSCODE_ITERATIONS): Promise<WrappedVault> {
  const salt = rand(16);
  const k = await passKey(passcode, salt, iterations);
  return { salt: b64(salt), iter: iterations, wrapped: await seal(k, await exportVault(vault), 'vault') };
}

/** Throws when the passcode is wrong (AES-GCM authentication fails). */
export async function unwrapVault(w: WrappedVault, passcode: string): Promise<CryptoKey> {
  const k = await passKey(passcode, unb64(w.salt), w.iter);
  return importVault(await open<string>(k, w.wrapped, 'vault'));
}

export interface KeyPairRecord { pub: JsonWebKey; encPriv: Sealed }

export async function newKeyPair(vault: CryptoKey): Promise<{ rec: KeyPairRecord; priv: CryptoKey; pub: JsonWebKey }> {
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = await subtle().exportKey('jwk', kp.publicKey);
  const privJwk = await subtle().exportKey('jwk', kp.privateKey);
  return { rec: { pub, encPriv: await seal(vault, privJwk, 'ecdh') }, priv: kp.privateKey, pub };
}

export async function openPrivateKey(vault: CryptoKey, rec: KeyPairRecord): Promise<CryptoKey> {
  const jwk = await open<JsonWebKey>(vault, rec.encPriv, 'ecdh');
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** Same key on both sides: ECDH(mine, theirs) → HKDF-SHA256 → AES-GCM. */
export async function pairKey(myPriv: CryptoKey, theirPub: JsonWebKey, patientUid: string, doctorUid: string): Promise<CryptoKey> {
  const pub = await subtle().importKey('jwk', theirPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, myPriv, 256);
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('accesscare-pair-v1'), info: enc.encode(`pat:${patientUid}|doc:${doctorUid}`) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
