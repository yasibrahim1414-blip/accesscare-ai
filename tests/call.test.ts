import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCall, cleanMeta, messageKindFor, requireValidRx } from '../src/services/backend/sanitize';
import { callLine, callState, incomingCall } from '../src/services/call/call';
import type { Message } from '../src/domain/types';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const msg = (id: string, from: string, call: object, at: string): Message => ({ id, consultationId: 'c1', senderId: from, senderRole: from === 'doc' ? 'doctor' : 'patient', body: 'x', kind: 'call', createdAt: at, meta: { call: call as never } });

test('call set-up messages: only valid steps are kept; both roles may call', () => {
  assert.equal(messageKindFor('patient', 'call'), 'call'); assert.equal(messageKindFor('doctor', 'call'), 'call');
  assert.deepEqual(cleanCall({ id: 'call_abc123', step: 'offer', media: 'video', sdp: SDP, extra: 'dropped' }), { id: 'call_abc123', step: 'offer', media: 'video', sdp: SDP });
  assert.equal(cleanCall({ id: 'call_abc123', step: 'offer', media: 'video', sdp: '<script>' }), null, 'not a session description');
  assert.equal(cleanCall({ id: 'call_abc123', step: 'offer', media: 'video', sdp: 'v=0' + 'a'.repeat(30000) }), null, 'size limit');
  assert.equal(cleanCall({ id: '../x', step: 'offer', sdp: SDP }), null);
  assert.equal(cleanCall({ id: 'call_abc123', step: 'ring' }), null);
  assert.deepEqual(cleanCall({ id: 'call_abc123', step: 'end', media: 'audio', reason: 'weird', seconds: 125.4 }), { id: 'call_abc123', step: 'end', media: 'audio', reason: 'hangup', seconds: 125 });
  assert.deepEqual(cleanMeta({ call: { id: 'call_abc123', step: 'end', media: 'video', reason: 'missed' } } as never, 'call'), { call: { id: 'call_abc123', step: 'end', media: 'video', reason: 'missed' } });
  assert.throws(() => requireValidRx('call', undefined), /Call set-up/);
});

test('incoming calls ring for a minute, stop when answered or ended, and never for your own call', () => {
  const t0 = Date.parse('2026-11-03T10:00:00Z');
  const offer = msg('m1', 'doc', { id: 'call_aaaaaa', step: 'offer', media: 'video', sdp: SDP }, '2026-11-03T10:00:00Z');
  assert.equal(incomingCall([offer], 'pat', t0 + 5000)?.id, 'm1');
  assert.equal(incomingCall([offer], 'doc', t0 + 5000), null, 'the caller does not see its own call as incoming');
  assert.equal(incomingCall([offer], 'pat', t0 + 61000), null, 'after a minute it is no longer ringing');
  const ans = msg('m2', 'pat', { id: 'call_aaaaaa', step: 'answer', media: 'audio', sdp: SDP }, '2026-11-03T10:00:08Z');
  assert.equal(incomingCall([offer, ans], 'pat', t0 + 9000), null);
  const end = msg('m3', 'doc', { id: 'call_aaaaaa', step: 'end', media: 'video', reason: 'hangup', seconds: 190 }, '2026-11-03T10:03:20Z');
  const st = callState([offer, ans, end], 'call_aaaaaa');
  assert.equal(st.answer?.id, 'm2'); assert.equal(st.end?.id, 'm3');
  const L = (en: string) => en;
  assert.equal(callLine(end, L), 'Video call · 3 min');
  assert.equal(callLine(offer, L), null, 'set-up steps are not shown in the history');
  assert.equal(callLine(msg('m4', 'doc', { id: 'call_bbbbbb', step: 'end', media: 'audio', reason: 'missed' }, '2026-11-03T11:00:00Z'), L), 'Voice call · missed');
});
