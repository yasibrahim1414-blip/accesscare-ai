import React, { useEffect, useState } from 'react';
import { LuHeartPulse, LuPersonStanding, LuSparkles, LuShieldCheck, LuStethoscope, LuUserRound, LuCloud, LuLock, LuLogOut, LuHeartHandshake } from 'react-icons/lu';
import { homeFor, useApp, useLoad } from '../../app/AppContext';
import { Banner, Button, Field, Steps, TopBar } from '../../ui/components';
import type { Role } from '../../domain/types';
import { DOCTOR_ID_PATTERN, normalizeDoctorId } from '../../services/crypto';
import type { LocalDemoBackend } from '../../services/backend/LocalDemoBackend';
import { activateBlindMode } from '../voice/VoiceCompanion';
import { GestureRecognizer, TripleSwipeDetector, TripleTapDetector } from '../../services/voice/Gestures';

// "Accounts on this device" shortcut (email/password modes only). Stores names
// and emails, never passwords.
const recentKey = 'accesscare.recent.v1';
export function rememberAccount(email: string, name: string, role: Role) {
  if (!email) return;
  try {
    const list = JSON.parse(localStorage.getItem(recentKey) || '[]') as { email: string; name: string; role: Role }[];
    localStorage.setItem(recentKey, JSON.stringify([{ email, name, role }, ...list.filter((x) => x.email !== email)].slice(0, 5)));
  } catch { /* storage unavailable */ }
}
export function recentAccounts(): { email: string; name: string; role: Role }[] {
  try { return JSON.parse(localStorage.getItem(recentKey) || '[]'); } catch { return []; }
}
export function forgetAccount(email: string) {
  try { localStorage.setItem(recentKey, JSON.stringify(recentAccounts().filter((a) => a.email !== email))); } catch { /* ignore */ }
}

export function WelcomeScreen() {
  const { nav, backend, setMe, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const local = backend.mode === 'local-demo';
  const blind = () => { activateBlindMode(); nav.reset({ name: 'va' }); };
  // three deliberate left swipes anywhere on this screen turn on Blind Mode (touch only; scrolling never counts)
  const rec = React.useMemo(() => new GestureRecognizer(), []);
  const tri = React.useMemo(() => new TripleSwipeDetector(), []);
  const taps = React.useMemo(() => new TripleTapDetector(), []);
  const pendingClick = React.useRef(0);
  const lastClickAt = React.useRef(0);
  useEffect(() => () => window.clearTimeout(pendingClick.current), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.altKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); blind(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // three quick taps anywhere (or three left swipes) start Blind Mode — nothing has to be seen
  const touch = {
    onPointerDown: (e: React.PointerEvent) => { rec.down(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); },
    onPointerMove: (e: React.PointerEvent) => { rec.move(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); },
    onPointerUp: (e: React.PointerEvent) => {
      const g = rec.up(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      const swiped = e.pointerType === 'touch' && tri.feed(g);
      if (swiped || taps.feed(g)) blind();
    },
    onPointerCancel: () => { rec.cancel(); tri.reset(); taps.reset(); },
    // a tap on a button waits a moment: if more taps follow quickly, it was the Blind Mode triple tap, not a press
    onClickCapture: (e: React.MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!e.isTrusted || !btn || btn.dataset.testid === 'blind-mode') return;
      e.preventDefault(); e.stopPropagation();
      window.clearTimeout(pendingClick.current);
      if (performance.now() - lastClickAt.current < 450) { lastClickAt.current = performance.now(); return; }
      lastClickAt.current = performance.now();
      pendingClick.current = window.setTimeout(() => { if (performance.now() - lastClickAt.current >= 440) btn.click(); }, 450);
    },
  };

  const tryDemo = async (role: Role) => {
    setBusy(role);
    try {
      const demo = backend as LocalDemoBackend;
      const d = await demo.seedDemo!();
      const me = await backend.signIn({ email: role === 'doctor' ? d.doctorEmail : d.patientEmail, password: d.password });
      rememberAccount(me.profile.email, me.profile.fullName, me.profile.role);
      setMe(me); nav.reset(homeFor(me));
      toast(`Signed in as the demo ${role}`);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="screen screen-in" {...touch} style={{ touchAction: 'pan-y' }} data-testid="welcome">
      <div className="welcome">
        {/* not shown on screen; it is the first thing VoiceOver / TalkBack / the keyboard reach */}
        <button className="sr-only" onClick={blind} data-testid="blind-mode"
          aria-label="Blind Mode: voice guidance. Double tap to start. You can also tap the screen three times.">
          Blind Mode
        </button>
        <section className="welcome-hero">
          <div className="rings" aria-hidden />
          <div className="brand"><span className="brand-mark"><LuHeartPulse /></span>AccessCare AI</div>
          <h1>Show where it hurts. Your doctor understands.</h1>
          <p>The Adaptive Digital Clinic turns simple taps on a 3D body and short questions into a summary you check and approve before your doctor sees it.</p>
        </section>
        <div className="pad" style={{ paddingTop: 20 }}>
          <div className="stack" style={{ gap: 16 }}>
            <div className="feature"><div className="fi"><LuPersonStanding /></div><div><b>Point to it on the body</b><p className="small muted">Turn a detailed 3D body and tap the area. A flat map and a simple list work too.</p></div></div>
            <div className="feature"><div className="fi"><LuSparkles /></div><div><b>Questions that fit you</b><p className="small muted">Yes/No, pictures or short choices fill in what’s missing. Nothing is guessed.</p></div></div>
            <div className="feature"><div className="fi"><LuShieldCheck /></div><div><b>You approve every word</b><p className="small muted">Only the summary you confirm goes to the doctor you chose{backend.mode === 'claude-cloud' || backend.mode === 'server' ? ', encrypted so only the two of you can read it' : ''}.</p></div></div>
          </div>
          <div className="stack">
            <Button big block onClick={() => nav.push({ name: 'signup' })}>Create an account</Button>
            <Button variant="secondary" big block onClick={() => nav.push({ name: 'signin' })}>Log in</Button>
          </div>
          <p className="tiny muted" style={{ textAlign: 'center' }}>AccessCare AI helps you communicate. It does not diagnose. In an emergency, call your local emergency number.</p>
          {local && (
            <div className="card tinted">
              <b>Offline demo</b>
              <p className="small muted">This copy isn’t connected to the shared database, so accounts stay in this browser only. Ready-made demo accounts:</p>
              <div className="grid2">
                <Button variant="secondary" onClick={() => tryDemo('patient')} busy={busy === 'patient'}><LuUserRound /> Patient</Button>
                <Button variant="secondary" onClick={() => tryDemo('doctor')} busy={busy === 'doctor'}><LuStethoscope /> Doctor</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shows who is signed in to Claude (the login identity in cloud mode). */
function ClaudeIdentity({ name }: { name: string }) {
  return (
    <div className="identity">
      <div className="avatar navy"><LuCloud /></div>
      <div className="grow">
        <div className="tiny muted strong">Signed in to Claude as</div>
        <div className="strong">{name || 'Your Claude account'}</div>
      </div>
    </div>
  );
}

export function SignInScreen({ email: initialEmail, notice }: { email?: string; notice?: string }) {
  const { backend, setMe, nav, toast } = useApp();
  const info = useLoad(() => backend.authInfo(), []);
  const cloud = info.data?.kind === 'claude-account';
  const roles = info.data?.existingRoles ?? [];
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recents = cloud ? [] : recentAccounts();
  useEffect(() => { if (cloud && roles.length === 1 && !role) setRole(roles[0]); }, [cloud, roles.join()]); // eslint-disable-line

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr(null);
    if (cloud && !role) { setErr('Choose which account to open.'); return; }
    if (!cloud && !email.trim()) { setErr('Enter your email.'); return; }
    if (!password) { setErr('Enter your password.'); return; }
    setBusy(true);
    try {
      const me = await backend.signIn({ email, role: role ?? undefined, password });
      rememberAccount(me.profile.email, me.profile.fullName, me.profile.role);
      setMe(me); nav.reset(homeFor(me));
      toast(`Welcome back, ${me.profile.fullName}`);
    } catch (ex) { setErr((ex as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <TopBar title="Log in" />
      <div className="screen screen-in">
        <form className="pad" onSubmit={submit} noValidate>
          {notice && <Banner kind="ok"><span data-testid="logout-notice">{notice}</span></Banner>}
          <div><h2 className="title">Welcome back</h2><p className="muted">{cloud ? 'Open your AccessCare account with its password.' : 'Log in to continue.'}</p></div>
          {info.loading && !info.data && <div className="skeleton" style={{ height: 60 }} />}
          {cloud && <>
            <ClaudeIdentity name={info.data!.identityName ?? ''} />
            {roles.length === 0 ? (
              <Banner kind="info">There’s no AccessCare account on this Claude account yet. <button type="button" className="link-btn" style={{ padding: 0 }} onClick={() => nav.replace({ name: 'signup' })}>Create one</button></Banner>
            ) : (
              <div className="stack" role="radiogroup" aria-label="Account to open">
                {(['patient', 'doctor', 'caregiver'] as Role[]).filter((r) => roles.includes(r)).map((r) => (
                  <button type="button" key={r} role="radio" aria-checked={role === r} className={`role-card ${r}`} onClick={() => setRole(r)} data-testid={`signin-role-${r}`}>
                    <span className="ri">{r === 'doctor' ? <LuStethoscope /> : r === 'caregiver' ? <LuHeartHandshake /> : <LuUserRound />}</span>
                    <span className="stack" style={{ gap: 2 }}><b>{r === 'doctor' ? 'Doctor account' : r === 'caregiver' ? 'Caregiver account' : 'Patient account'}</b><span className="small muted">Saved in the shared AccessCare database</span></span>
                  </button>
                ))}
              </div>
            )}
          </>}
          {!cloud && info.data && <>
            {recents.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {recents.map((a) => (
                  <button type="button" key={a.email} className="chip" onClick={() => { setEmail(a.email); setPassword(''); setErr(null); }}>
                    {a.role === 'doctor' ? <LuStethoscope /> : a.role === 'caregiver' ? <LuHeartHandshake /> : <LuUserRound />}{a.name}
                  </button>
                ))}
              </div>
            )}
            <Field id="signin-email" label="Email or Patient ID" value={email} onChange={setEmail} autoComplete="username" />
          </>}
          {(!cloud || roles.length > 0) && <Field id="signin-password" label={cloud ? 'AccessCare password' : 'Password'} type="password" value={password} onChange={setPassword} autoComplete="current-password" />}
          {!cloud && email.endsWith('@accesscare.demo') && <p className="small muted">Demo account password: <span className="mono">demo-pass-123</span></p>}
          {err && <Banner kind="danger">{err}</Banner>}
          {(!cloud || roles.length > 0) && <Button big block type="submit" busy={busy}><LuLock aria-hidden /> Log in</Button>}
          <div className="row between">
            <button type="button" className="link-btn" onClick={() => nav.push({ name: 'forgot' })}>Forgot password?</button>
            <button type="button" className="link-btn" onClick={() => nav.replace({ name: 'signup' })}>Create account</button>
          </div>
        </form>
      </div>
    </>
  );
}

export function ForgotScreen() {
  const { backend } = useApp();
  const info = useLoad(() => backend.authInfo(), []);
  const [email, setEmail] = useState('');
  const [res, setRes] = useState<boolean | null>(null);
  const cloud = info.data?.kind === 'claude-account';
  return (
    <>
      <TopBar title="Reset password" />
      <div className="screen screen-in"><div className="pad">
        {cloud ? (
          <Banner kind="info">Your AccessCare password protects the encryption keys for your health records, so it can’t be reset without losing that data. If you’ve forgotten it, you can delete the account from Settings after logging in, or ask the app owner to remove it, then create a new one.</Banner>
        ) : <>
          <Field id="forgot-email" label="Email" type="email" value={email} onChange={setEmail} />
          <Button block onClick={async () => setRes((await backend.requestPasswordReset(email)).supported)}>Send reset link</Button>
          {res === false && <Banner kind="warn">Password reset by email isn’t available in the offline demo. Demo accounts can be recreated from Settings → Reset demo data.</Banner>}
          {res === true && <Banner kind="ok">If an account exists for that email, a reset link is on its way.</Banner>}
        </>}
      </div></div>
    </>
  );
}

type Step = 'role' | 'form';

export function SignUpScreen() {
  const { backend, setMe, nav, toast } = useApp();
  const info = useLoad(() => backend.authInfo(), []);
  const cloud = info.data?.kind === 'claude-account';
  const existing = info.data?.existingRoles ?? [];
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role | null>(null);
  const [f, setF] = useState({ fullName: '', email: '', password: '', confirm: '', doctorId: '', specialty: '', clinic: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => { setF((s) => ({ ...s, [k]: v })); setErrs((e) => ({ ...e, [k]: '' })); };

  const validate = () => {
    const e: Record<string, string> = {};
    if (f.fullName.trim().length < 2) e.fullName = 'Please enter your full name.';
    if (!cloud && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = 'Please enter a valid email address.';
    if (f.password.length < 8) e.password = 'Use at least 8 characters.';
    if (cloud && f.confirm !== f.password) e.confirm = 'The passwords don’t match.';
    if (role === 'patient' && f.doctorId.trim() && !DOCTOR_ID_PATTERN.test(normalizeDoctorId(f.doctorId))) {
      e.doctorId = 'This doesn’t look like a Doctor ID (example: AC-DOC-7K4P9X). Fix it or leave it empty to skip.';
    }
    setErrs(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    setFormErr(null);
    if (!role || !validate()) return;
    setBusy(true);
    try {
      const me = await backend.signUp({ role, fullName: f.fullName, email: f.email, password: f.password, specialty: f.specialty, clinic: f.clinic });
      rememberAccount(me.profile.email, me.profile.fullName, role);
      setMe(me);
      if (role === 'doctor') { nav.reset({ name: 'd.id', justCreated: true }); toast('Doctor account created'); return; }
      if (role === 'caregiver') { nav.reset({ name: 'c.home' }); toast('Caregiver account created'); return; }
      if (f.doctorId.trim()) nav.reset({ name: 'p.connect', afterSignup: true, initialId: normalizeDoctorId(f.doctorId) });
      else nav.reset({ name: 'p.onboard' });
    } catch (e) { setFormErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (step === 'role') {
    return (
      <>
        <TopBar title="Create account" />
        <div className="screen screen-in"><div className="pad">
          <Steps total={3} current={0} label="Account type" />
          <div><h2 className="title">Who is this account for?</h2><p className="muted">Your choice decides which app you see. It can’t be changed later.</p></div>
          {cloud && <ClaudeIdentity name={info.data!.identityName ?? ''} />}
          <div className="stack" role="radiogroup" aria-label="Account type">
            {([['patient', 'I am a Patient', 'Tell your doctor what you feel with the 3D body and simple questions.', LuUserRound],
               ['doctor', 'I am a Doctor', 'Get a Doctor ID, connect with patients and review their approved reports.', LuStethoscope],
               ['caregiver', 'I am a Caregiver', 'Help a family member: see their medicines and alerts after they add you.', LuHeartHandshake]] as const).map(([r, t, d, Icon]) => {
              const taken = cloud && existing.includes(r);
              return (
                <button key={r} role="radio" aria-checked={role === r} className={`role-card ${r}`} onClick={() => !taken && setRole(r)} data-testid={`role-${r}`} aria-disabled={taken}
                  style={taken ? { opacity: .6, cursor: 'not-allowed' } : undefined}>
                  <span className="ri"><Icon /></span>
                  <span className="stack" style={{ gap: 2 }}><b style={{ fontSize: '1.06em' }}>{t}</b><span className="small muted">{taken ? 'You already have this account — log in instead.' : d}</span></span>
                </button>
              );
            })}
          </div>
          <Button big block disabled={!role} onClick={() => setStep('form')}>Continue</Button>
          <button className="link-btn" onClick={() => nav.replace({ name: 'signin' })}>I already have an account</button>
        </div></div>
      </>
    );
  }

  return (
    <>
      <TopBar title={role === 'doctor' ? 'Doctor sign up' : role === 'caregiver' ? 'Caregiver sign up' : 'Patient sign up'} onBack={() => setStep('role')} />
      <div className="screen screen-in">
        <form className="pad" onSubmit={submit} noValidate>
          <Steps total={3} current={0} label="Your details" />
          <Field id="su-name" label="Full name" value={f.fullName} onChange={set('fullName')} error={errs.fullName} autoComplete="name" />
          {!cloud && <Field id="su-email" label="Email address" type="email" value={f.email} onChange={set('email')} error={errs.email} autoComplete="email" inputMode="email" />}
          <Field id="su-password" label={cloud ? 'Create an AccessCare password' : 'Password'} type="password" value={f.password} onChange={set('password')} error={errs.password}
            hint={cloud ? 'At least 8 characters. It encrypts your records and is needed to log in on each device. It can’t be recovered.' : 'At least 8 characters.'} autoComplete="new-password" />
          {cloud && <Field id="su-confirm" label="Confirm password" type="password" value={f.confirm} onChange={set('confirm')} error={errs.confirm} autoComplete="new-password" />}
          {role === 'doctor' ? (
            <>
              <Field id="su-specialty" label="Specialty — optional" value={f.specialty} onChange={set('specialty')} placeholder="e.g. Neurology" />
              <Field id="su-clinic" label="Clinic or hospital — optional" value={f.clinic} onChange={set('clinic')} />
              <Banner kind="info">A unique Doctor ID is created for you automatically. Patients use it to connect with you.</Banner>
            </>
          ) : role === 'caregiver' ? (
            <Banner kind="info">You get a Caregiver ID. Give it to the person you help; they add you from their app. You only see what their app shares with you.</Banner>
          ) : (
            <div className="card tinted">
              <Field id="su-doctor-id" label="Doctor ID — Optional" value={f.doctorId} onChange={(v) => set('doctorId')(v.toUpperCase())} error={errs.doctorId}
                placeholder="AC-DOC-7K4P9X" maxLength={20} mono
                hint="Already have a doctor on AccessCare AI? Enter their Doctor ID to connect with them now. You can also skip this step and connect later." />
              {f.doctorId && <Button type="button" variant="ghost" onClick={() => set('doctorId')('')}>Skip for now</Button>}
            </div>
          )}
          {formErr && <Banner kind="danger">{formErr}</Banner>}
          <Button big block type="submit" busy={busy}>Continue Registration</Button>
          <p className="tiny muted">{backend.mode === 'claude-cloud' ? 'Saved to the shared AccessCare database, so you can log in from any device signed in to this Claude account.'
            : backend.mode === 'server' ? 'Saved to the AccessCare server, encrypted on this device — log in from any phone or computer with your email and password.'
            : backend.mode === 'supabase' ? 'Saved to the AccessCare server.' : 'Offline demo: this account lives only in this browser.'}</p>
        </form>
      </div>
    </>
  );
}

/** Logout confirmation, used from Profile and Settings. */
export function useLogout() {
  const { backend, setMe, nav } = useApp();
  return async () => {
    await backend.signOut();
    setMe(null);
    nav.reset({ name: 'signin', notice: 'You have logged out. Your data is saved and stays private until you log in again.' });
  };
}
export const LogoutIcon = LuLogOut;
