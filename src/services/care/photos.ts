// Wound / skin photos for a timeline: shrunk on the device to a small JPEG
// (long side ≤ 640 px, ≤ ~110 KB) before anything is saved. Nothing is sent to
// an AI and nothing is judged from the picture; the doctor sees the photos side
// by side with the dates and the patient's own notes.
import { MAX_PHOTO_CHARS } from '../../domain/care';

export async function photoDataUrl(src: Blob | HTMLVideoElement, maxSide = 640): Promise<{ image: string; w: number; h: number }> {
  let w: number, h: number, draw: CanvasImageSource;
  if (src instanceof Blob) { const bmp = await createImageBitmap(src); w = bmp.width; h = bmp.height; draw = bmp; }
  else { w = src.videoWidth; h = src.videoHeight; draw = src; }
  if (!w || !h) throw new Error('The camera has no picture yet. Try again.');
  for (const side of [maxSide, 520, 420]) {
    const k = Math.min(1, side / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d')!.drawImage(draw, 0, 0, c.width, c.height);
    for (const q of [0.72, 0.6, 0.5, 0.4]) {
      const image = c.toDataURL('image/jpeg', q);
      if (image.startsWith('data:image/jpeg') && image.length <= MAX_PHOTO_CHARS - 10_000) return { image, w: c.width, h: c.height };
    }
  }
  throw new Error('The photo is too detailed to store. Try again closer, with plain background.');
}

/** Average brightness 0–255 of a video frame (for "too dark" guidance), or null. */
export function frameBrightness(v: HTMLVideoElement): number | null {
  if (!v.videoWidth) return null;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true }); if (!g) return null;
  g.drawImage(v, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4);
}
