// QR code for the emergency card: the card's text is inside the code itself, so a
// paramedic's phone camera shows it without any server or account.
// Encoder: Kazuhiko Arase's QRCode (MIT), vendored in src/vendor/qrcode.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import QRCodeImpl from '../../vendor/qrcode/index.js';
import QRErrorCorrectLevel from '../../vendor/qrcode/QRErrorCorrectLevel.js';

interface QRLike { addData(d: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean }

/** UTF-8 bytes as a "binary string" (the encoder writes one byte per character). */
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');

/** The QR modules (true = dark) for a text; throws when the text is too long for a QR code. */
export function qrMatrix(text: string): boolean[][] {
  const Q = QRCodeImpl as unknown as new (t: number, l: number) => QRLike;
  const qr = new Q(-1, (QRErrorCorrectLevel as unknown as { M: number }).M);
  qr.addData(utf8(text));
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** An SVG path ("M x y h1 v1 h-1 z" per dark module) for a matrix, with a 4-module quiet zone. */
export function qrPath(m: boolean[][]): { d: string; size: number } {
  let d = '';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return { d, size: m.length + 8 };
}
