// Live call between a patient and their doctor (audio or video).
// The call is set up through the consultation's encrypted messages (offer → answer → end), so it
// works wherever messages already sync, and only between a patient and their connected doctor.
// The audio and video themselves go directly between the two browsers (WebRTC, encrypted with
// DTLS-SRTP) and are never recorded or stored. A public STUN server only helps the two devices find
// a route; no audio or video passes through it. Networks that block direct connections need a
// TURN relay, which this prototype does not have — the call then fails and says so.

import type { CallSignal, Message } from '../../domain/types';

export const RING_SECONDS = 60;
export const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export const newCallId = () => 'call_' + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');

const calls = (msgs: Message[]) => msgs.filter((m): m is Message & { meta: { call: CallSignal } } => m.kind === 'call' && !!m.meta?.call);

/** The state of one call from its messages. */
export function callState(msgs: Message[], id: string) {
  const own = calls(msgs).filter((m) => m.meta.call.id === id);
  const offer = own.find((m) => m.meta.call.step === 'offer');
  const answer = own.find((m) => m.meta.call.step === 'answer');
  const end = own.find((m) => m.meta.call.step === 'end');
  return { offer, answer, end };
}

/** A call someone else started that is still ringing (no answer, not ended, under a minute old). */
export function incomingCall(msgs: Message[], myId: string, now = Date.now()): (Message & { meta: { call: CallSignal } }) | null {
  const offers = calls(msgs).filter((m) => m.meta.call.step === 'offer' && m.senderId !== myId && now - Date.parse(m.createdAt) < RING_SECONDS * 1000);
  for (const o of offers.reverse()) {
    const st = callState(msgs, o.meta.call.id);
    if (!st.answer && !st.end) return o;
  }
  return null;
}

/** One line for the message history ("Video call · 3 min", "Missed call"); set-up steps show nothing. */
export function callLine(m: Message, lang: (en: string, ar: string) => string): string | null {
  const c = m.meta?.call;
  if (!c || c.step !== 'end') return null;
  const kind = c.media === 'audio' ? lang('Voice call', 'مكالمة صوتية') : lang('Video call', 'مكالمة فيديو');
  if (c.reason === 'missed') return `${kind} · ${lang('missed', 'فايتة')}`;
  if (c.reason === 'declined') return `${kind} · ${lang('declined', 'اترفضت')}`;
  if (c.reason === 'failed') return `${kind} · ${lang('could not connect', 'مقدرتش تتوصل')}`;
  const s = c.seconds ?? 0;
  return `${kind} · ${s < 60 ? lang(`${s} s`, `${s} ث`) : lang(`${Math.round(s / 60)} min`, `${Math.round(s / 60)} د`)}`;
}

/** Waits until the browser has gathered its network routes (or 3 s), so one message carries everything. */
export function gathered(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((ok) => {
    const t = window.setTimeout(done, ms);
    function done() { window.clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); ok(); }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export const callsSupported = () => typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export type CallPhase = 'idle' | 'starting' | 'ringing' | 'incoming' | 'connecting' | 'connected' | 'ended';

/** One live call on this device. */
export class CallSession {
  pc: RTCPeerConnection | null = null;
  local: MediaStream | null = null;
  remote: MediaStream | null = null;
  chat: RTCDataChannel | null = null;
  connectedAt = 0;
  constructor(public id: string, public media: 'video' | 'audio', private on: {
    state: (s: RTCPeerConnectionState) => void; remote: (s: MediaStream) => void; text: (t: string) => void;
  }) {}

  private async open(media: 'video' | 'audio') {
    this.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: media === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local!));
    this.remote = new MediaStream();
    pc.ontrack = (e) => { e.streams[0]?.getTracks().forEach((t) => { if (!this.remote!.getTracks().includes(t)) this.remote!.addTrack(t); }); this.on.remote(this.remote!); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected' && !this.connectedAt) this.connectedAt = Date.now(); this.on.state(pc.connectionState); };
    pc.ondatachannel = (e) => this.useChat(e.channel);
    return pc;
  }
  private useChat(ch: RTCDataChannel) { this.chat = ch; ch.onmessage = (e) => { if (typeof e.data === 'string') this.on.text(e.data.slice(0, 500)); }; }

  /** caller: camera/microphone on, returns the offer to send */
  async offer(): Promise<string> {
    const pc = await this.open(this.media);
    this.useChat(pc.createDataChannel('chat'));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return pc.localDescription!.sdp;
  }
  /** callee: camera/microphone on, returns the answer to send */
  async answer(offerSdp: string, media: 'video' | 'audio'): Promise<string> {
    const pc = await this.open(media);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return pc.localDescription!.sdp;
  }
  async accept(answerSdp: string) { if (this.pc && !this.pc.currentRemoteDescription) await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }); }
  send(text: string) { if (this.chat?.readyState === 'open') { this.chat.send(text.slice(0, 500)); return true; } return false; }
  mute(on: boolean) { this.local?.getAudioTracks().forEach((t) => { t.enabled = !on; }); }
  camera(on: boolean) { this.local?.getVideoTracks().forEach((t) => { t.enabled = on; }); }
  seconds() { return this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0; }
  /** camera and microphone off, connection closed */
  close() {
    this.local?.getTracks().forEach((t) => t.stop());
    try { this.chat?.close(); } catch { /* */ }
    try { this.pc?.close(); } catch { /* */ }
    this.pc = null; this.local = null;
  }
}
