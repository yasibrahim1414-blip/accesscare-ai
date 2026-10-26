// Background work for a signed-in patient while the app is open:
//  • check-ins a caregiver recorded are added to the patient's records (marked with their name)
//  • the encrypted summary each linked caregiver reads is refreshed
//  • dose reminders (in the app; as a notification when the patient allowed notifications)
import React, { useEffect, useRef, useState } from 'react';
import { LuBellRing, LuCircleCheck, LuX } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { localDay, type CardData } from '../../domain/care';
import { remindersOn, todaySlots, type Slot } from '../../services/care/meds';
import { deviceBlind } from '../voice/blindMode';
import { speak } from '../../ui/components';
import { tr, useLang } from '../../i18n/lang';
import { buildDigest, loadMedData, shareCareDefault, type MedData } from './careData';
import { useDoseActions } from './MedScreens';

export function CareSync() {
  const { backend, me, version, refresh } = useApp();
  const last = useRef(0);
  const running = useRef(false);
  const patient = me?.profile.role === 'patient';

  useEffect(() => {
    if (!patient) return;
    const run = async (force: boolean) => {
      if (running.current || (!force && Date.now() - last.current < 60_000)) return;
      running.current = true; last.current = Date.now();
      try {
        const caregivers = await backend.listMyCaregivers().catch(() => []);
        if (!caregivers.length) return;
        let imported = 0;
        for (const { item, caregiver } of await backend.pendingCaregiverItems().catch(() => [])) {
          try {
            if (item.kind === 'dose' && item.dose) await backend.addRecord('dose', item.dose, { share: shareCareDefault(), by: caregiver.name, id: item.id });
            else if (item.kind === 'note' && item.note) await backend.addDiaryEntry({ text: item.note, via: 'text', feeling: null, items: [], medicine: null, urgent: [], ai: false, aiAllowed: false, share: shareCareDefault(), by: caregiver.name, importId: item.id });
            imported++;
          } catch { /* skip a bad item; it stays pending */ }
        }
        const [md, diary, card] = await Promise.all([loadMedData(backend), backend.listDiary().catch(() => []), backend.listRecords('card').catch(() => [])]);
        await backend.publishCareDigest(buildDigest(me!.profile.fullName, md, diary, (card[0]?.data as CardData | undefined) ?? null));
        if (imported) refresh();
      } catch { /* offline: try again later */ } finally { running.current = false; }
    };
    const t = window.setTimeout(() => void run(false), 1500);
    const onEvt = () => void run(true);
    window.addEventListener('accesscare:care-changed', onEvt);
    return () => { window.clearTimeout(t); window.removeEventListener('accesscare:care-changed', onEvt); };
  }, [patient, version, me?.profile.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const NOTIFIED = 'accesscare.reminded.v1';
const notified = (): string[] => { try { return JSON.parse(localStorage.getItem(NOTIFIED) || '[]'); } catch { return []; } };
const markNotified = (k: string) => { try { localStorage.setItem(NOTIFIED, JSON.stringify([...notified().filter((x) => x.startsWith(localDay())), k].slice(-50))); } catch { /* */ } };

/** A banner at the top when a dose is due (only when reminders are on). */
export function MedReminder() {
  const { backend, me, version, nav } = useApp();
  const lang = useLang();
  const L = (en: string, ar: string) => tr(en, ar, lang);
  const [due, setDue] = useState<Slot | null>(null);
  const [dismissed, setDismissed] = useState('');
  const data = useRef<{ at: number; md: MedData } | null>(null);
  const act = useDoseActions(() => { data.current = null; });
  const patient = me?.profile.role === 'patient';

  useEffect(() => { data.current = null; }, [version]);
  useEffect(() => {
    if (!patient) return;
    let alive = true;
    const tick = async () => {
      if (!remindersOn()) { setDue(null); return; }
      try {
        if (!data.current || Date.now() - data.current.at > 10 * 60_000) data.current = { at: Date.now(), md: await loadMedData(backend) };
        const slot = todaySlots(data.current.md.plans, data.current.md.doses).find((s) => s.state === 'due' && !s.record);
        if (!alive) return;
        setDue(slot ?? null);
        if (slot) {
          const k = `${localDay()}|${slot.plan.rxId}|${slot.slot}`;
          if (!notified().includes(k)) {
            markNotified(k);
            const text = L(`Time for ${slot.plan.name} ${slot.plan.dose} (${slot.slot}).`, `ميعاد ${slot.plan.name} ${slot.plan.dose} (${slot.slot}).`);
            try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification('AccessCare', { body: text, tag: k }); } catch { /* */ }
            if (deviceBlind()?.enabled) speak(`${text} ${L('Say: I took my medicine.', 'قول: خدت الدوا.')}`);
          }
        }
      } catch { /* try again next minute */ }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 30_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [patient, version, me?.profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = due ? `${due.plan.rxId}|${due.slot}` : '';
  if (!patient || !due || nav.route.name === 'p.meds' || dismissed === key) return null;
  return (
    <div className="med-reminder" role="alert" data-testid="med-reminder">
      <LuBellRing aria-hidden />
      <button className="grow linkbtn" style={{ textAlign: 'start' }} onClick={() => nav.push({ name: 'p.meds' })}><b data-no-tr>{due.slot}</b> · <span data-no-tr>{due.plan.name} {due.plan.dose}</span></button>
      <button className="chip" onClick={async () => { await act(due.plan, due.slot, 'taken'); setDue(null); }} data-testid="rem-taken"><LuCircleCheck aria-hidden /> {L('Took it', 'خدتها')}</button>
      <button className="iconbtn sm" onClick={() => setDismissed(key)} aria-label={L('Hide this reminder', 'اخفي التذكير ده')} data-testid="rem-hide"><LuX /></button>
    </div>
  );
}
