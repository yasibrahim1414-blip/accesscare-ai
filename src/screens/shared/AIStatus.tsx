// One line under an AI-assisted feature saying whether Claude is helping, with a
// one-tap "Turn on AI" when the patient has not turned it on yet (turning it on
// is the patient's own explicit choice; it can be turned off in Profile).
import React, { useState } from 'react';
import { LuSparkles } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Button } from '../../ui/components';
import { useLang, tr } from '../../i18n/lang';

export function AIStatus({ on }: { on: string }) {
  const { ai, prefs, me, setMe, backend, toast } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const [busy, setBusy] = useState(false);
  const state = ai.state(prefs.aiAssist);
  if (state === 'available') return <p className="tiny muted" data-testid="ai-status" data-state="on">{on}</p>;
  if (state === 'off' && me?.profile.role === 'patient') {
    const enable = async () => {
      setBusy(true);
      try { const saved = await backend.savePreferences({ ...me.preferences, aiAssist: true }); setMe({ ...me, preferences: saved }); toast(L('AI assistance is on. You can turn it off in Profile.', 'مساعدة الذكاء الاصطناعي اشتغلت. تقدر تقفلها من الملف الشخصي.')); }
      catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    };
    return (
      <div className="row wrap" data-testid="ai-status" data-state="off" style={{ alignItems: 'center', gap: 8 }}>
        <p className="tiny muted" style={{ margin: 0 }}>{L('AI is off — understood with AccessCare’s word list.', 'الذكاء الاصطناعي مقفول — بيتفهم بقائمة كلمات أكسس كير.')}</p>
        <Button variant="secondary" busy={busy} onClick={enable} data-testid="ai-turn-on"><LuSparkles aria-hidden /> {L('Turn on AI', 'شغّل الذكاء الاصطناعي')}</Button>
      </div>
    );
  }
  return <p className="tiny muted" data-testid="ai-status" data-state="unavailable">{L('AI is not available right now — understood with AccessCare’s word list.', 'الذكاء الاصطناعي مش متاح دلوقتي — بيتفهم بقائمة كلمات أكسس كير.')}</p>;
}
