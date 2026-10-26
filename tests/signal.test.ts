import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretTaps, interpretScanPress, matchSpeech, scoreCalibration, mustConfirm, templateMessage, methodCatalog, SENSATION_SYMBOLS,
} from '../src/services/signal/SignalEngine';
import { DEFAULT_SIGNAL } from '../src/domain/types';

test('taps on two options in quick succession are ambiguous, never silently accepted', () => {
  assert.deepEqual(interpretTaps([{ optionId: 'pain', at: 1000 }]), { kind: 'clear', optionId: 'pain' });
  assert.deepEqual(interpretTaps([{ optionId: 'pain', at: 1000 }, { optionId: 'burning', at: 1300 }]), { kind: 'ambiguous', candidates: ['pain', 'burning'] });
  assert.deepEqual(interpretTaps([{ optionId: 'pain', at: 1000 }, { optionId: 'burning', at: 2500 }]), { kind: 'clear', optionId: 'burning' });
  assert.deepEqual(interpretTaps([{ optionId: 'pain', at: 1000 }, { optionId: 'pain', at: 1200 }]), { kind: 'clear', optionId: 'pain' });
});

test('switch scanning: a press right after the highlight moved asks which was meant', () => {
  assert.deepEqual(interpretScanPress(5000, 4000, 2, 4), { kind: 'clear', index: 2 });
  assert.deepEqual(interpretScanPress(4100, 4000, 2, 4), { kind: 'ambiguous', indices: [1, 2] });
  assert.deepEqual(interpretScanPress(4100, 4000, 0, 4), { kind: 'ambiguous', indices: [3, 0] });
});

test('speech matching is exact or ambiguous, never a guess', () => {
  const opts = SENSATION_SYMBOLS;
  assert.deepEqual(matchSpeech('it is burning', opts), { kind: 'clear', optionId: 'burning' });
  assert.equal(matchSpeech('hmm I dunno', opts).kind, 'none');
  const two = matchSpeech('pain and burning', opts);
  assert.equal(two.kind, 'ambiguous');
});

test('calibration scoring and when confirmation is required', () => {
  const ok = scoreCalibration('large_buttons', [
    { target: 'star', registered: 'star', patientConfirmed: true, ambiguous: false },
    { target: 'yes', registered: 'yes', patientConfirmed: true, ambiguous: false },
    { target: 'circle', registered: 'circle', patientConfirmed: true, ambiguous: false },
    { target: 'house', registered: 'house', patientConfirmed: true, ambiguous: false },
  ]);
  assert.equal(ok.passed, true); assert.equal(ok.correct, 4);
  const shaky = scoreCalibration('large_buttons', [
    { target: 'star', registered: 'house', patientConfirmed: false, ambiguous: false },
    { target: 'yes', registered: 'no', patientConfirmed: false, ambiguous: true },
    { target: 'circle', registered: 'circle', patientConfirmed: true, ambiguous: false },
    { target: 'house', registered: 'house', patientConfirmed: true, ambiguous: false },
  ]);
  assert.equal(shaky.passed, false); assert.equal(shaky.misregistered, 2); assert.equal(shaky.correct, 2);
  assert.equal(mustConfirm({ ...DEFAULT_SIGNAL, confirmEachSelection: false }), true, 'no calibration: still confirm');
  assert.equal(mustConfirm({ ...DEFAULT_SIGNAL, confirmEachSelection: false, calibration: ok }), false);
  assert.equal(mustConfirm({ ...DEFAULT_SIGNAL, confirmEachSelection: false, calibration: shaky }), true);
  assert.equal(mustConfirm({ ...DEFAULT_SIGNAL, method: 'symbols', confirmEachSelection: false, calibration: ok }), true, 'calibrated a different method');
});

test('template message only states selections and keeps uncertainty', () => {
  const m = templateMessage({ regions: ['Right abdomen'], sensation: 'Pain', severity: 'Not sure', onset: 'Today', pattern: 'Comes and goes', need: 'Talk with my doctor' });
  assert.equal(m, 'I feel pain in my right abdomen. I’m not sure how strong it is. It started: today. It comes and goes. Talk with my doctor.');
});

test('unavailable methods are honest', () => {
  const cat = methodCatalog({ speech: false, tts: true });
  assert.equal(cat.find((m) => m.id === 'speech')!.available, false);
  assert.equal(cat.find((m) => m.id === 'eye_gaze')!.available, false);
  assert.equal(cat.find((m) => m.id === 'switch_scan')!.available, true);
});
