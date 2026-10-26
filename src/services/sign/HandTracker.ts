// Camera + MediaPipe Hand Landmarker (two hands), running entirely in this
// browser tab. Frames are analysed in memory and discarded: no video or image
// is recorded, stored or uploaded. Only hand-point numbers leave this module.

import { HandLandmarker } from '../../../vendor/mediapipe/vision_bundle.mjs';
import ModuleFactory from '../../../vendor/mediapipe/vision_wasm_internal.mjs';
import { cameraSupport, classifyCameraError, type CameraError, type TrackerState } from '../camera/camera';
import type { SignFrame } from './SignRecognizer';

const b64 = (s: string) => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

async function bytes(kind: 'wasm' | 'hand'): Promise<Uint8Array> {
  const emb = window.__ACCESSCARE_MP__?.[kind];
  if (emb) return b64(emb);
  const file = kind === 'wasm' ? 'vision_wasm_internal.wasm' : 'hand_landmarker.task';
  const r = await fetch(new URL(`mp/${file}`, document.baseURI).href);
  if (!r.ok) throw new Error(`asset ${file}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

let hl: Promise<HandLandmarker> | null = null;
/** Loads the hand landmarker once per page (WASM + ~7.8 MB model). */
export function loadHandLandmarker(): Promise<HandLandmarker> {
  if (hl) return hl;
  hl = (async () => {
    const [wasm, model] = await Promise.all([bytes('wasm'), bytes('hand')]);
    const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }));
    const make = async (delegate: 'GPU' | 'CPU') => {
      (self as unknown as { ModuleFactory: unknown }).ModuleFactory = ModuleFactory;
      return HandLandmarker.createFromOptions({ wasmLoaderPath: '', wasmBinaryPath: wasmUrl }, {
        baseOptions: { modelAssetBuffer: model, delegate }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    };
    try { return await make('GPU'); } catch { return await make('CPU'); }
  })();
  hl.catch(() => { hl = null; });
  return hl;
}

export class HandTracker {
  state: TrackerState = 'idle';
  error: CameraError | null = null;
  fps = 0;
  private stream: MediaStream | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private times: number[] = [];
  private lm: HandLandmarker | null = null;
  private failures = 0;

  constructor(private video: HTMLVideoElement, private cb: { onState(s: TrackerState, e?: CameraError): void; onFrame(f: SignFrame): void }) {}
  private set(s: TrackerState, e?: CameraError) { this.state = s; this.error = e ?? null; this.cb.onState(s, e); }

  /** Call from a user action: this is when the browser asks for camera permission. */
  async start() {
    const sup = cameraSupport();
    if (!sup.ok) { this.set('error', sup.error); return; }
    this.set('requesting');
    const loading = loadHandLandmarker(); loading.catch(() => undefined);
    try { this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
    catch (e) { this.set('error', classifyCameraError(e)); return; }
    if ((this.state as TrackerState) !== 'requesting') { this.release(); return; }
    this.video.srcObject = this.stream; this.video.muted = true; this.video.playsInline = true;
    try { await this.video.play(); } catch { /* muted autoplay */ }
    this.set('loading');
    try { this.lm = await loading; } catch { this.release(); this.set('error', 'load_failed'); return; }
    if ((this.state as TrackerState) !== 'loading') return;
    this.set('running'); this.loop();
  }
  pause() { if (this.state === 'running') { cancelAnimationFrame(this.raf); this.set('paused'); } }
  resume() { if (this.state === 'paused') { this.set('running'); this.loop(); } }
  stop() { cancelAnimationFrame(this.raf); this.release(); if (this.state !== 'idle' && this.state !== 'error') this.set('stopped'); }
  get cameraOn() { return !!this.stream?.getVideoTracks().some((t) => t.readyState === 'live'); }
  private release() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; try { this.video.srcObject = null; } catch { /* */ } }

  private loop = () => {
    if (this.state !== 'running' || !this.lm) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      try {
        // automated tests can replay recorded hand points instead of tracking (no effect unless a test defines this)
        const replay = (window as unknown as { __ACCESSCARE_TEST_HANDS__?: (t: number) => SignFrame['hands'] | null }).__ACCESSCARE_TEST_HANDS__;
        let hands = typeof replay === 'function' ? replay(t) : null;
        if (!hands) {
          const r = this.lm.detectForVideo(v, t);
          hands = (r.landmarks ?? []).map((pts, i) => {
            // MediaPipe labels handedness as seen in the (unmirrored) picture; we keep its label consistently
            const h = r.handedness?.[i]?.[0] ?? r.handednesses?.[i]?.[0];
            return { handedness: (h?.categoryName === 'Left' ? 'Left' : 'Right') as 'Left' | 'Right', score: h?.score ?? 0, lm: pts.map((p) => [p.x, p.y, p.z] as [number, number, number]) };
          });
        }
        this.failures = 0;
        this.cb.onFrame({ t, hands });
        this.times.push(t); while (this.times.length && t - this.times[0] > 1000) this.times.shift(); this.fps = this.times.length;
      } catch { if (++this.failures > 5) { this.stop(); this.set('error', 'tracking_failed'); return; } }
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}
