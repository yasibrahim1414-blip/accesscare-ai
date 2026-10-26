// Camera access shared by the camera sections: permission checks, error
// classification and plain-language error text. No frame is stored or sent.

export type CameraError = 'unsupported' | 'insecure' | 'blocked' | 'denied' | 'no_camera' | 'in_use' | 'load_failed' | 'tracking_failed' | 'unknown';

export const CAMERA_ERROR_TEXT: Record<CameraError, string> = {
  unsupported: 'This browser can’t use a camera.',
  insecure: 'The camera only works on a secure (https) page.',
  blocked: 'Camera access is not allowed in this view. Inside the Claude app, pages can’t use the camera; open the standalone version of AccessCare AI in a browser to use the camera.',
  denied: 'Camera permission was denied. You can allow it in your browser’s site settings, or use another way to answer.',
  no_camera: 'No camera was found on this device.',
  in_use: 'The camera is being used by another app, or couldn’t be started.',
  load_failed: 'The hand-tracking component couldn’t be loaded on this device.',
  tracking_failed: 'Hand tracking stopped working on this device.',
  unknown: 'The camera couldn’t be started.',
};

export type TrackerState = 'idle' | 'requesting' | 'loading' | 'running' | 'paused' | 'stopped' | 'error';

declare global {
  interface Window { __ACCESSCARE_MP__?: { wasm?: string; model?: string; hand?: string } }
}

function cameraPolicyAllows(): boolean {
  const d = document as unknown as { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
  const p = d.permissionsPolicy ?? d.featurePolicy;
  try { return p ? p.allowsFeature('camera') : true; } catch { return true; }
}

/** Environment check before asking for permission. */
export function cameraSupport(): { ok: true } | { ok: false; error: CameraError } {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { ok: false, error: window.isSecureContext === false ? 'insecure' : 'unsupported' };
  if (!cameraPolicyAllows()) return { ok: false, error: 'blocked' };
  return { ok: true };
}

export function classifyCameraError(e: unknown): CameraError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return cameraPolicyAllows() ? 'denied' : 'blocked';
  if (name === 'SecurityError') return 'blocked';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'in_use';
  return 'unknown';
}

