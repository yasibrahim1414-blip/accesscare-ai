import React, { useState } from 'react';
import { LuKeyRound, LuAudioLines } from 'react-icons/lu';
import { LuLogOut, LuTrash2, LuRepeat, LuAccessibility, LuUnlink, LuChevronRight, LuRefreshCw, LuMap, LuDatabase, LuShieldCheck, LuCloud } from 'react-icons/lu';
import { useApp } from '../../app/AppContext';
import { Banner, ConfirmSheet, Field, Toggle, TopBar } from '../../ui/components';
import { forgetAccount, useLogout } from '../auth/AuthScreens';

export function SettingsScreen() {
  const { me, backend, nav, setMe, toast, force2D, setForce2D, refresh } = useApp();
  const [sheet, setSheet] = useState<null | 'logout' | 'delete' | 'reset' | 'switch' | 'disconnect'>(null);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);
  const isPatient = me?.profile.role === 'patient';
  const logout = useLogout();
  const close = () => { setSheet(null); setBusy(false); };

  return (
    <>
      <TopBar title="Settings" />
      <div className="screen screen-in"><div className="pad">
        <h3 className="section">Account</h3>
        <div className="list">
          <button className="list-item" onClick={() => setSheet('logout')} data-testid="sign-out"><span className="li-ico"><LuLogOut /></span><div className="grow"><b>Log out</b><div className="small muted">End your session on this device</div></div></button>
          <button className="list-item" onClick={() => setSheet('switch')} data-testid="switch-account"><span className="li-ico"><LuRepeat /></span><div className="grow"><b>Switch account</b><div className="small muted">Log out, then open your other AccessCare account</div></div></button>
          {isPatient && backend.createRecoveryCode && <button className="list-item" onClick={async () => { try { const c = await backend.createRecoveryCode!(); setRecovery(c); } catch (e) { toast((e as Error).message); } }} data-testid="new-recovery"><span className="li-ico"><LuKeyRound /></span><div className="grow"><b>Create a recovery code</b><div className="small muted">Lets you set a new password once if you forget it. Replaces any older code.</div></div></button>}
          {recovery && <div className="banner ok" role="alert" data-testid="recovery-code"><div><b>Your recovery code: <span className="mono">{recovery}</span></b><div className="small">Write it down and keep it private. It is shown only now.</div></div></div>}
          {isPatient && <button className="list-item" onClick={() => setSheet('disconnect')}><span className="li-ico"><LuUnlink /></span><div className="grow"><b>Disconnect Doctor</b></div></button>}
          <button className="list-item danger" onClick={() => { setPw(''); setErr(null); setSheet('delete'); }}><span className="li-ico"><LuTrash2 /></span><div className="grow"><b>Delete account</b></div></button>
        </div>

        <h3 className="section">Accessibility</h3>
        <div className="list">
          {isPatient && <button className="list-item" onClick={() => nav.push({ name: 'p.prefs' })}><span className="li-ico"><LuAccessibility /></span><div className="grow"><b>Communication preferences</b><div className="small muted">Text size, buttons, question style, speech</div></div><LuChevronRight className="chev" /></button>}
          {isPatient && <button className="list-item" onClick={() => nav.push({ name: 'va' })} data-testid="settings-voice"><span className="li-ico"><LuAudioLines /></span><div className="grow"><b>Blind Mode</b><div className="small muted">Spoken guidance, voice answers, swipe navigation</div></div><LuChevronRight className="chev" /></button>}
          <Toggle id="force2d" label="Use the 2D body map" desc="Show the flat body map instead of the 3D model." checked={force2D} onChange={setForce2D} />
        </div>

        <h3 className="section">Data</h3>
        <div className="card tinted" style={{ gap: 8 }}>
          <div className="row"><span className="li-ico" style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--surface)' }}>{backend.shared ? <LuCloud /> : <LuDatabase />}</span>
            <div className="grow"><b>{backend.mode === 'claude-cloud' ? 'Shared cloud database' : backend.mode === 'supabase' ? 'AccessCare server (Supabase)' : 'Offline demo storage'}</b>
              <div className="small muted">{backend.mode === 'claude-cloud' ? 'Synced across your devices. Health records are end-to-end encrypted.'
                : backend.mode === 'supabase' ? 'Synced across devices, protected by row-level security.'
                : backend.persistent ? 'Stored in this browser only. Not synced.' : 'Browser storage is blocked: data is lost when you close the app.'}</div></div></div>
        </div>
        {backend.mode === 'local-demo' && (
          <div className="list">
            <button className="list-item" onClick={() => setSheet('reset')}><span className="li-ico"><LuRefreshCw /></span><div className="grow"><b>Reset local demo data</b><div className="small muted">Erase every account and consultation stored in this browser</div></div></button>
          </div>
        )}
      </div></div>

      {sheet === 'logout' && <ConfirmSheet title="Log out of AccessCare AI?" icon={<LuLogOut />} confirmLabel="Log out" danger busy={busy}
        body="Your data stays saved. You’ll need your password to open your account again on this device."
        onConfirm={async () => { setBusy(true); await logout(); }} onCancel={close} />}
      {sheet === 'switch' && <ConfirmSheet title="Switch account" icon={<LuRepeat />} confirmLabel="Log out and switch" busy={busy}
        body={backend.mode === 'claude-cloud' ? 'One Claude account can have a patient account and a doctor account. You’ll be logged out, then you can open the other one with its own password.' : 'You’ll be logged out, then you can log in with another account.'}
        onConfirm={async () => { setBusy(true); await logout(); }} onCancel={close} />}
      {sheet === 'disconnect' && <ConfirmSheet title="Disconnect your doctor?" danger confirmLabel="Disconnect" icon={<LuUnlink />} busy={busy}
        body="Your doctor will lose access to your consultations. You keep your own copy and can reconnect with their Doctor ID."
        onConfirm={async () => { setBusy(true); try { await backend.disconnectDoctor(); refresh(); toast('Doctor disconnected'); } catch (e) { toast((e as Error).message); } close(); }}
        onCancel={close} />}
      {sheet === 'reset' && <ConfirmSheet title="Reset all demo data?" danger confirmLabel="Erase everything in this browser" icon={<LuRefreshCw />}
        body="This deletes all offline demo accounts, consultations, messages and notes stored in this browser. It cannot be undone."
        onConfirm={async () => { await backend.resetDemoData?.(); try { localStorage.removeItem('accesscare.recent.v1'); } catch { /* */ } setMe(null); nav.reset({ name: 'welcome' }); toast('Demo data erased'); }}
        onCancel={close} />}
      {sheet === 'delete' && (
        <ConfirmSheet title="Delete your account?" danger confirmLabel="Delete my account" icon={<LuTrash2 />} busy={busy}
          body={isPatient
            ? `This permanently deletes your patient account, consultations and messages${backend.shared ? ' from the shared database' : ' from this browser'}. Your doctor loses access.`
            : `This permanently deletes your doctor account and private notes${backend.shared ? ' from the shared database' : ' from this browser'}. Your Doctor ID stops working and patients are disconnected. Copies a patient already received stay with the patient.`}
          onCancel={close}
          onConfirm={async () => {
            setErr(null); setBusy(true);
            try { const email = me!.profile.email; await backend.deleteAccount(pw); forgetAccount(email); setMe(null); nav.reset({ name: 'welcome' }); toast('Account deleted'); }
            catch (e) { setErr((e as Error).message); setBusy(false); }
          }}>
          <Field id="delete-pw" label="Enter your password to confirm" type="password" value={pw} onChange={setPw} error={err} />
        </ConfirmSheet>
      )}
    </>
  );
}

export function AboutScreen() {
  const { backend, ai } = useApp();
  const mode = backend.mode;
  return (
    <>
      <TopBar title="About this prototype" />
      <div className="screen screen-in"><div className="pad">
        <Banner kind="warn"><b>Prototype.</b> Not for real medical use, not clinically validated and not a certified medical device. It does not diagnose.</Banner>
        <div className="card">
          <div className="row"><LuShieldCheck style={{ color: 'var(--teal-ink)', fontSize: '1.3em' }} aria-hidden /><b>What is real here</b></div>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 5 }}>
            {mode === 'claude-cloud' && <>
              <li>A shared, server-side database: accounts, connections, consultations, status and messages sync between devices.</li>
              <li>Login uses your Claude account plus an AccessCare password for each role.</li>
              <li>Health records shared between a patient and doctor are end-to-end encrypted (ECDH P-256 + AES-256-GCM). Other users of the app can see that encrypted records exist, not their content.</li>
              <li>Private drafts and doctor notes are encrypted with a key that only your password unlocks.</li>
            </>}
            {mode === 'supabase' && <li>Supabase accounts and a Postgres database with row-level security.</li>}
            {mode === 'local-demo' && <li>Accounts with hashed passwords (PBKDF2) and permission checks, stored in this browser only.</li>}
            <li>Unique Doctor IDs created once and kept permanently.</li>
            <li>Patient Intent Reconstruction: every report item records where it came from (selected, typed, answered, suggested-and-confirmed, corrected), with mismatch detection and a verification record.</li>
            <li>AI assistance through Claude (only if you turn it on, and only inside the Claude app): suggestions from your own words and clearer wording. Every AI output is checked so it adds nothing you didn’t say, and you approve it.</li>
            <li>Silent Signal AI: large buttons, symbol board, Yes/No and single-switch scanning, with calibration and confirmation of every selection.</li>
            <li>Blind Access & Voice Companion: spoken guidance and spoken answers (browser speech services, with your permission), large buttons, typing, optional swipe navigation; voice sign-up with a Patient ID and a recovery code; reports and doctor messages by voice. No audio is recorded or stored.</li>
            <li>Sign language (camera): MediaPipe hand tracking runs on this device. Built in are two ASL signs, YES and NO, recognized by rules from the signs’ dictionary forms; any other sign (for example in Egyptian Sign Language) works only after you teach it 3 times. It recognizes single signs for answers — it does not translate signed sentences and does not read faces, pain or illness. Arabic/Egyptian sign language is not built in: no suitable model was available. No video is recorded or uploaded.</li>
            <li>A realistic 3D human body (MakeHuman base mesh, CC0) with 32 selectable regions, front/back/side views, zoom, plus a 2D map and list.</li>
          </ul>
        </div>
        <div className="card">
          <b>What is not real yet</b>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 5 }}>
            <li>Follow-up questions are chosen by AccessCare rules (by design, so they are predictable); AI only suggests and words. AI status here: {ai.supported ? 'available when you turn it on' : 'not available in this view'}.</li>
            <li>Safety checks are rule-based. AI can only add a warning, never remove one. No check can tell you that you are safe.</li>
            <li>The camera needs a browser that allows it; Claude’s preview does not, so there the app says so and offers other methods. Eye-gaze selection (pointing with the eyes) is not implemented. Speech input works only where the device allows the microphone.</li>
            {mode !== 'supabase' && <li>Password recovery by email.</li>}
            <li>Video calls and push notifications.</li>
            {mode === 'local-demo' && <li>Sync between devices: this copy isn’t connected to the shared database.</li>}
          </ul>
        </div>
        <div className="card">
          <div className="row"><LuMap style={{ color: 'var(--navy-700)', fontSize: '1.2em' }} aria-hidden /><b>3D body model</b></div>
          <p className="small muted">Built from the MakeHuman base mesh, adult proportions and skin weights, released under CC0 1.0 by the MakeHuman project (makehumancommunity.org). AccessCare AI added the 32-region split, smoothing and shading. It shows the body surface only; no internal anatomy is shown.</p>
        </div>
      </div></div>
    </>
  );
}
