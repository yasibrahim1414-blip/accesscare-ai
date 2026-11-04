// "Install AccessCare on this device": the website build can be installed as an app (home-screen icon,
// its own window, opens without a connection). Chrome/Edge/Android offer an install prompt; iPhone and
// iPad use Safari's Share → Add to Home Screen.
import React, { useEffect, useState } from 'react';
import { LuDownload, LuCircleCheck, LuShare } from 'react-icons/lu';
import { tr, useLang } from '../i18n/lang';

type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: Prompt | null = null;
const subs = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as Prompt; subs.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; subs.forEach((f) => f()); });
}

const standalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** inside the AccessCare Android app (android/): already an app */
const inAndroidApp = () => typeof navigator !== 'undefined' && /AccessCareAndroid\//.test(navigator.userAgent);
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const ANDROID_APK = 'https://github.com/yasibrahim1414-blip/accesscare-ai/releases/latest/download/AccessCare.apk';
/** only the website build has the app manifest (not the page inside Claude, not a local file) */
const installable = () => typeof document !== 'undefined' && !!document.querySelector('link[rel=manifest]') && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export function InstallApp({ compact }: { compact?: boolean }) {
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const [, setTick] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => { const f = () => setTick((t) => t + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  if (inAndroidApp()) return compact ? null : <p className="small" data-testid="install-done"><LuCircleCheck aria-hidden /> {L('You are using the AccessCare Android app.', 'إنت بتستخدم تطبيق أكسس كير للأندرويد.')}</p>;
  if (!installable()) return null;
  const apk = isAndroid() && !standalone() ? <p className={compact ? 'tiny' : 'small'}><a href={ANDROID_APK} data-testid="android-apk" rel="noopener"><LuDownload aria-hidden /> {L('Download the AccessCare Android app (opens without the browser)', 'نزّل تطبيق أكسس كير للأندرويد (بيفتح من غير المتصفح)')}</a></p> : null;
  if (standalone() || done) return compact ? null : <p className="small" data-testid="install-done"><LuCircleCheck aria-hidden /> {L('AccessCare is installed on this device. Open it from its icon on your home screen.', 'أكسس كير متثبّت على الجهاز ده. افتحه من الأيقونة على الشاشة الرئيسية.')}</p>;
  if (deferred) {
    return (<>{apk}
      <button className={compact ? 'linkbtn small' : 'btn secondary'} data-testid="install-app" onClick={async () => {
        const p = deferred; if (!p) return;
        await p.prompt(); const c = await p.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
        if (c.outcome === 'accepted') { deferred = null; setDone(true); }
      }}><LuDownload aria-hidden /> {L('Install AccessCare on this device', 'ثبّت أكسس كير على الجهاز ده')}</button></>
    );
  }
  if (isIos()) return <p className={compact ? 'tiny muted' : 'small'} data-testid="install-ios"><LuShare aria-hidden /> {L('To install on iPhone or iPad: open this page in Safari, tap Share, then “Add to Home Screen”.', 'علشان تثبّته على الآيفون أو الآيباد: افتح الصفحة في سفاري، دوس مشاركة، وبعدين "إضافة إلى الشاشة الرئيسية".')}</p>;
  if (apk) return apk;
  return compact ? null : <p className="small muted" data-testid="install-hint">{L('To install: open your browser’s menu and choose “Install app” or “Add to Home screen”.', 'علشان تثبّته: افتح قايمة المتصفح واختار "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية".')}</p>;
}
