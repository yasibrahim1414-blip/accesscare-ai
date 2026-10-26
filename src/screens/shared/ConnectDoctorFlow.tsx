import React, { useEffect, useState } from 'react';
import { LuBadgeCheck, LuStethoscope } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, Button, Field, initials } from '../../ui/components';
import type { DoctorPublicInfo } from '../../domain/types';

/**
 * Doctor ID connection: enter → validate against doctor records → show the
 * doctor's identity → patient confirms → connection created. Cancel creates nothing.
 */
export function ConnectDoctorFlow({ initialId = '', autoLookup, onDone, skipLabel = 'Skip for now' }: {
  initialId?: string; autoLookup?: boolean; onDone: (connected: boolean) => void; skipLabel?: string;
}) {
  const { backend, toast, refresh } = useApp();
  const [id, setId] = useState(initialId);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<DoctorPublicInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DoctorPublicInfo | null>(null);

  const lookup = async (value = id) => {
    setErr(null); setFound(null);
    if (!value.trim()) { setErr('Enter the Doctor ID your doctor gave you, or skip this step.'); return; }
    setBusy(true);
    try { setFound(await backend.lookupDoctor(value)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (autoLookup && initialId) lookup(initialId); /* eslint-disable-next-line */ }, []);

  const confirm = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await backend.connectToDoctor(found.doctorId);
      setDone(found); refresh(); toast(`Connected to ${found.fullName}`);
    } catch (e) { setErr((e as Error).message); setFound(null); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="stack">
        <Banner kind="ok"><b>You are connected to {done.fullName}.</b> Consultations you approve can now be shared with them.</Banner>
        <Button big block onClick={() => onDone(true)}>Continue</Button>
      </div>
    );
  }

  if (found) {
    return (
      <div className="stack">
        <p style={{ fontWeight: 700 }}>Is this your doctor?</p>
        <div className="card raised" data-testid="doctor-confirm" style={{ borderLeft: 0 }}>
          <div className="row">
            <div className="avatar navy">{initials(found.fullName)}</div>
            <div className="grow">
              <div style={{ fontWeight: 800, fontSize: '1.1em' }}>{found.fullName}</div>
              <div className="small muted">{[found.specialty, found.clinic].filter(Boolean).join(' · ') || 'Doctor on AccessCare AI'}</div>
            </div>
            <LuBadgeCheck style={{ color: 'var(--teal)', fontSize: '1.5em' }} aria-hidden />
          </div>
          <div className="small"><span className="muted">Doctor ID </span><span className="mono strong">{found.doctorId}</span></div>
        </div>
        <p className="small muted">Connecting lets this doctor see the consultation summaries you approve and share. You can disconnect at any time.</p>
        <Button big block onClick={confirm} busy={busy}>Yes, connect to this doctor</Button>
        <Button variant="secondary" block onClick={() => { setFound(null); toast('Not connected'); }}>No, this isn’t my doctor</Button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="feature"><div className="fi"><LuStethoscope /></div></div>
        <p className="muted small grow">Already have a doctor on AccessCare AI? Enter their Doctor ID to connect with them now. You can also skip this step and connect later.</p>
      </div>
      <Field id="doctor-id-input" label="Doctor ID — Optional" value={id} onChange={(v) => { setId(v.toUpperCase()); setErr(null); }}
        placeholder="AC-DOC-7K4P9X" error={err} hint="Ask your doctor for this code. It looks like AC-DOC-7K4P9X." maxLength={20} mono />
      <Button big block onClick={() => lookup()} busy={busy}>Connect Doctor</Button>
      <Button variant="ghost" block onClick={() => onDone(false)}>{skipLabel}</Button>
    </div>
  );
}
