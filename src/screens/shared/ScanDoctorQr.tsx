// "Scan the doctor's QR code": the camera starts only after the patient presses the button, looks for a
// QR code in the picture (nothing is recorded, stored or sent), and stops as soon as a Doctor ID is found.
// The ID only fills in the form: the patient still sees the doctor's name and confirms.
import React, { useEffect, useRef, useState } from 'react';
import { LuQrCode, LuCameraOff, LuImagePlus } from 'react-icons/lu';
import { Button } from '../../ui/components';
import { useLang, tr } from '../../i18n/lang';
import { CAMERA_ERROR_TEXT, cameraSupport, classifyCameraError, type CameraError } from '../../services/camera/camera';
import { doctorIdFromQr } from '../../services/care/doctorQr';
import { AR_CAMERA_ERR } from '../care/CameraCapture';
import jsQRImpl from '../../vendor/jsqr/jsQR.js';

type JsQR = (data: Uint8ClampedArray, w: number, h: number, o?: { inversionAttempts?: string }) => { data: string } | null;
const jsQR = jsQRImpl as unknown as JsQR;
type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

function nativeDetector(): Detector | null {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  try { return BD ? new BD({ formats: ['qr_code'] }) : null; } catch { return null; }
}

/** All QR texts found in a picture (the browser's own reader when it has one, otherwise jsQR). */
async function readQr(src: HTMLVideoElement | ImageBitmap, canvas: HTMLCanvasElement, det: Detector | null): Promise<string[]> {
  const w0 = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
  const h0 = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
  if (!w0 || !h0) return [];
  if (det) { try { const r = await det.detect(src); if (r.length) return r.map((x) => x.rawValue); } catch { /* fall back */ } }
  const k = Math.min(1, 800 / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(src, 0, 0, w, h);
  const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  return r?.data ? [r.data] : [];
}

export function ScanDoctorQr({ onId, compact }: { onId: (doctorId: string) => void; compact?: boolean }) {
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef(0);
  const [state, setState] = useState<'off' | 'starting' | 'on'>('off');
  const [err, setErr] = useState<CameraError | null>(null);
  const [note, setNote] = useState('');

  const stop = () => {
    window.clearTimeout(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    if (video.current) video.current.srcObject = null;
    setState('off');
  };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const found = (texts: string[]): boolean => {
    if (!texts.length) return false;
    for (const t of texts) { const id = doctorIdFromQr(t); if (id) { stop(); setNote(''); onId(id); return true; } }
    setNote(L('This QR code is not an AccessCare Doctor ID. Ask your doctor to show the QR code from their AccessCare app.', 'كود QR ده مش كود دكتور من أكسس كير. اطلب من الدكتور يوريك الكود من تطبيق أكسس كير بتاعه.'));
    return false;
  };

  const start = async () => {
    setErr(null); setNote('');
    const sup = cameraSupport();
    if (!sup.ok) { setErr(sup.error); return; }
    setState('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      const v = video.current!;
      v.srcObject = s; await v.play().catch(() => undefined);
      setState('on');
      const det = nativeDetector();
      const tick = async () => {
        if (!stream.current) return;
        try { if (found(await readQr(v, canvas.current!, det))) return; } catch { /* keep looking */ }
        if (stream.current) timer.current = window.setTimeout(tick, 220);
      };
      timer.current = window.setTimeout(tick, 300);
    } catch (e) { setErr(classifyCameraError(e)); setState('off'); }
  };

  const fromPhoto = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setNote('');
    try {
      const bmp = await createImageBitmap(f);
      const texts = await readQr(bmp, canvas.current!, nativeDetector());
      bmp.close?.();
      if (!texts.length) setNote(L('No QR code was found in that photo. Try again with the whole code in the picture.', 'ملقيتش كود QR في الصورة دي. جرّب تاني والكود كله باين في الصورة.'));
      else found(texts);
    } catch { setNote(L('That photo could not be opened.', 'مقدرتش أفتح الصورة دي.')); }
  };

  return (
    <div className="stack" style={{ gap: 8 }} data-testid="scan-doctor">
      <video ref={video} playsInline muted aria-label={L('Camera picture: hold the doctor’s QR code inside the frame', 'صورة الكاميرا: خلّي كود الدكتور جوه الإطار')}
        style={{ display: state === 'off' ? 'none' : 'block', width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 14, background: '#000' }} data-testid="scan-video" />
      <canvas ref={canvas} hidden />
      {state === 'off' ? (
        <div className={compact ? 'row wrap' : 'grid2'}>
          <Button type="button" variant={compact ? 'secondary' : undefined} big={!compact} onClick={() => void start()} data-testid="scan-start"><LuQrCode aria-hidden /> {L('Scan the doctor’s QR code', 'امسح كود الدكتور')}</Button>
          <Button type="button" variant="secondary" onClick={() => file.current?.click()} data-testid="scan-photo"><LuImagePlus aria-hidden /> {L('From a photo', 'من صورة')}</Button>
        </div>
      ) : (
        <>
          <p className="small" role="status">{state === 'starting' ? L('Starting the camera…', 'بشغّل الكاميرا…') : L('Point the camera at the QR code on your doctor’s screen.', 'وجّه الكاميرا على الكود اللي على شاشة الدكتور.')}</p>
          <Button type="button" variant="secondary" onClick={stop} data-testid="scan-stop"><LuCameraOff aria-hidden /> {L('Stop the camera', 'اقفل الكاميرا')}</Button>
        </>
      )}
      <input ref={file} type="file" accept="image/*" hidden data-testid="scan-file" onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ''; }} />
      {err && <p className="small danger-text" role="alert" data-testid="scan-error">{tr(CAMERA_ERROR_TEXT[err], AR_CAMERA_ERR[err], lang)}</p>}
      {note && <p className="small warn-text" role="alert" data-testid="scan-note">{note}</p>}
    </div>
  );
}
