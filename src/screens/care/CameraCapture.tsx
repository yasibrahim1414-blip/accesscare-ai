// Camera for a single still photo (medicine box, wound photo). The camera starts
// only after the person presses "Turn on camera"; nothing is recorded — only the
// one photo they take is used. "Choose a photo" always works as an alternative
// (it also opens the phone camera where the browser allows).
import React, { useEffect, useRef, useState } from 'react';
import { LuCamera, LuCameraOff, LuImagePlus, LuAperture } from 'react-icons/lu';
import { Button } from '../../ui/components';
import { useLang, tr } from '../../i18n/lang';
import { CAMERA_ERROR_TEXT, cameraSupport, classifyCameraError, type CameraError } from '../../services/camera/camera';
import { frameBrightness } from '../../services/care/photos';

const AR_ERR: Record<CameraError, string> = {
  unsupported: 'المتصفح ده مش بيقدر يستخدم الكاميرا.',
  insecure: 'الكاميرا بتشتغل بس في صفحة آمنة (https).',
  blocked: 'الكاميرا مش مسموحة في العرض ده. استخدم "اختار صورة" أو افتح نسخة الموقع في المتصفح.',
  denied: 'إذن الكاميرا اترفض. تقدر تسمح بيه من إعدادات الموقع في المتصفح، أو تختار صورة.',
  no_camera: 'ملقيتش كاميرا على الجهاز ده.',
  in_use: 'الكاميرا مستخدمة في تطبيق تاني، أو مقدرتش تشتغل.',
  load_failed: 'مقدرتش أحمّل جزء الكاميرا.',
  tracking_failed: 'الكاميرا وقفت.',
  unknown: 'الكاميرا مقدرتش تشتغل.',
};

export function CameraCapture({ onPhoto, facing = 'environment', purpose, busy, testid = 'cam' }: {
  onPhoto: (src: Blob | HTMLVideoElement) => void | Promise<void>;
  facing?: 'environment' | 'user';
  /** one line: what the photo is for (shown before the camera starts) */
  purpose: string;
  busy?: boolean;
  testid?: string;
}) {
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'off' | 'starting' | 'on'>('off');
  const [err, setErr] = useState<CameraError | null>(null);
  const [hint, setHint] = useState('');

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setState('off'); };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setErr(null);
    const sup = cameraSupport();
    if (!sup.ok) { setErr(sup.error); return; }
    setState('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => undefined); }
      setState('on');
    } catch (e) { setErr(classifyCameraError(e)); setState('off'); }
  };

  // light guidance while the camera is on
  useEffect(() => {
    if (state !== 'on') return;
    const id = window.setInterval(() => {
      const b = video.current ? frameBrightness(video.current) : null;
      setHint(b === null ? '' : b < 45 ? L('Too dark — move to more light.', 'الصورة ضلمة — قرّب من نور أكتر.') : b > 235 ? L('Too bright — avoid direct light on it.', 'فيه نور زيادة — بعّد عن النور المباشر.') : '');
    }, 900);
    return () => window.clearInterval(id);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const snap = async () => { if (video.current && state === 'on') { await onPhoto(video.current); } };

  return (
    <div className="cam-capture" data-testid={testid}>
      <div className={`cam-frame ${state === 'on' ? 'live' : ''}`}>
        <video ref={video} playsInline muted aria-label={L('Camera preview', 'معاينة الكاميرا')} hidden={state !== 'on'} />
        {state !== 'on' && <div className="cam-placeholder"><LuCamera aria-hidden /><p className="small">{purpose}</p></div>}
        {state === 'on' && hint && <p className="capture-hint" role="status">{hint}</p>}
      </div>
      {err && <p className="small danger-text" role="alert">{lang === 'ar' ? AR_ERR[err] : CAMERA_ERROR_TEXT[err]}</p>}
      <div className="cam-btns">
        {state === 'on' ? (
          <>
            <Button big block className="span2" onClick={snap} busy={busy} data-testid={`${testid}-snap`}><LuAperture aria-hidden /> {L('Take photo', 'صوّر')}</Button>
            <Button variant="secondary" onClick={stop} data-testid={`${testid}-off`}><LuCameraOff aria-hidden /> {L('Camera off', 'اقفل الكاميرا')}</Button>
          </>
        ) : (
          <Button onClick={start} busy={state === 'starting'} data-testid={`${testid}-on`}><LuCamera aria-hidden /> {L('Turn on camera', 'شغّل الكاميرا')}</Button>
        )}
        <Button variant="secondary" onClick={() => file.current?.click()} busy={busy && state !== 'on'} data-testid={`${testid}-pick`}><LuImagePlus aria-hidden /> {L('Choose a photo', 'اختار صورة')}</Button>
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" capture={facing} hidden data-testid={`${testid}-file`}
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await onPhoto(f); }} />
      </div>
      <p className="tiny muted">{L('The camera starts only when you press the button. Nothing is recorded — only the photo you take is used.', 'الكاميرا مش بتشتغل غير لما تدوس الزرار. مفيش تسجيل — بس الصورة اللي بتاخدها هي اللي بتستخدم.')}</p>
    </div>
  );
}
