import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctorIdFromQr, doctorLink, APP_URL } from '../src/services/care/doctorQr';
import { qrMatrix } from '../src/services/care/qr';

test('doctor QR: the link holds the Doctor ID and is read back', () => {
  const link = doctorLink('AC-DOC-7K4P9X');
  assert.equal(link, `${APP_URL}?doctor=AC-DOC-7K4P9X`);
  assert.equal(doctorIdFromQr(link), 'AC-DOC-7K4P9X');
  assert.ok(qrMatrix(link).length >= 21, 'fits in a QR code');
});

test('doctor QR: the ID alone, lower case or with spaces, is accepted', () => {
  assert.equal(doctorIdFromQr('AC-DOC-7K4P9X'), 'AC-DOC-7K4P9X');
  assert.equal(doctorIdFromQr('  ac-doc-7k4p9x '), 'AC-DOC-7K4P9X');
});

test('doctor QR: anything else is refused (no guessing)', () => {
  for (const t of ['', 'hello', 'https://example.com/', `${APP_URL}?doctor=`, `${APP_URL}?doctor=AC-DOC-11111`, 'AC-DOC-0O0O0O', 'AccessCare emergency card\nName: Sara', 'PAT-123456']) {
    assert.equal(doctorIdFromQr(t), null, t);
  }
});
