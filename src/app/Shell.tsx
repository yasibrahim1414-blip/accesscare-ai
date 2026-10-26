// The app frame shared by every screen: navigation (bottom tabs on phones, a
// side bar on wide screens), the language switch, the Blind Mode control and the
// storage notice. Patients and doctors get their own navigation in one design.
import React, { useEffect, useRef } from 'react';
import { LuHouse, LuClipboardList, LuStethoscope, LuUserRound, LuLayoutDashboard, LuUsers, LuInbox, LuRadioTower, LuAudioLines, LuNotebookPen, LuTrendingUp, LuLanguages, LuSettings, LuHeartPulse, LuHeartHandshake } from 'react-icons/lu';
import { useApp, useLoad, type Route } from './AppContext';
import { useBlind } from '../a11y/BlindLayer';
import { useLang, setLang } from '../i18n/lang';

export const PATIENT_TABS = [
  { route: { name: 'p.home' } as Route, label: 'Home', Icon: LuHouse, also: ['p.consult', 'p.detail', 'p.connect', 'p.prefs', 'p.onboard'] },
  { route: { name: 'p.care' } as Route, label: 'Care', Icon: LuHeartPulse, also: ['p.meds', 'p.boxcheck', 'p.photos', 'p.card', 'p.caregivers', 'interp'] },
  { route: { name: 'ss.home' } as Route, label: 'Signal', Icon: LuRadioTower, also: ['ss.calibrate', 'ss.session', 'ss.camsetup', 'ss.camsession'] },
  { route: { name: 'p.diary' } as Route, label: 'Diary', Icon: LuNotebookPen, also: [] as string[] },
  { route: { name: 'p.history' } as Route, label: 'History', Icon: LuClipboardList, also: [] as string[] },
  { route: { name: 'p.profile' } as Route, label: 'Profile', Icon: LuUserRound, also: ['settings', 'about', 'p.doctor'] },
];
export const DOCTOR_TABS = [
  { route: { name: 'd.overview' } as Route, label: 'Overview', Icon: LuLayoutDashboard, also: ['d.id'] },
  { route: { name: 'd.patients' } as Route, label: 'Patients', Icon: LuUsers, also: ['d.patient'] },
  { route: { name: 'd.consults' } as Route, label: 'Consultations', Icon: LuInbox, also: ['d.workspace'] },
  { route: { name: 'd.progress' } as Route, label: 'Progress', Icon: LuTrendingUp, also: ['d.progressOf'] },
  { route: { name: 'd.profile' } as Route, label: 'Profile', Icon: LuUserRound, also: ['settings', 'about'] },
];
export const CAREGIVER_TABS = [
  { route: { name: 'c.home' } as Route, label: 'People I help', Icon: LuHeartHandshake, also: ['c.patient'] },
  { route: { name: 'settings' } as Route, label: 'Settings', Icon: LuSettings, also: ['about'] },
];
export const TAB_ROUTES = new Set([...[...PATIENT_TABS, ...DOCTOR_TABS, ...CAREGIVER_TABS.slice(0, 1)].map((t) => t.route.name), 'p.doctor']);

function useTabs() {
  const { me, nav, backend } = useApp();
  const isDoctor = me?.profile.role === 'doctor';
  const stats = useLoad(() => (isDoctor ? backend.doctorStats() : Promise.resolve(null)), [isDoctor]);
  const isCaregiver = me?.profile.role === 'caregiver';
  const tabs = isDoctor ? DOCTOR_TABS : isCaregiver ? CAREGIVER_TABS : PATIENT_TABS;
  const current = tabs.find((t) => t.route.name === nav.route.name) ?? tabs.find((t) => t.also.includes(nav.route.name));
  const badge = (name: string) => (isDoctor && name === 'd.consults' ? stats.data?.newCount ?? 0 : 0);
  return { tabs, current, badge, nav, isDoctor, isCaregiver };
}

/** Phones: the bottom tab bar (only on the main screens). */
export function TabBar() {
  const { tabs, current, badge, nav } = useTabs();
  return (
    <nav className={`tabbar n${tabs.length}`} aria-label="Main">
      {tabs.map((t) => {
        const active = current === t && nav.route.name === t.route.name;
        const b = badge(t.route.name);
        return (
          <button key={t.label} className="tab" aria-current={active ? 'page' : undefined} onClick={() => nav.reset(t.route)}>
            <span className="ti"><t.Icon aria-hidden /></span><span className="tl">{t.label}</span>
            {!!b && <span className="dot" aria-label={`${b} new`}>{b}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** Wide screens: the side navigation (always visible when signed in). */
export function SideNav() {
  const { tabs, current, badge, nav, isDoctor, isCaregiver } = useTabs();
  const { me } = useApp();
  return (
    <aside className="sidenav" aria-label="Main">
      <div className="sn-brand"><span className="brand-mark" aria-hidden>A</span><span><b>AccessCare</b><span className="sn-role">{isDoctor ? 'Doctor' : isCaregiver ? 'Caregiver' : 'Patient'}</span></span></div>
      <nav className="sn-list">
        {tabs.map((t) => {
          const b = badge(t.route.name);
          return (
            <button key={t.label} className="sn-item" aria-current={current === t ? 'page' : undefined} onClick={() => nav.reset(t.route)}>
              <t.Icon aria-hidden /><span className="grow">{t.label}</span>{!!b && <span className="sn-badge" aria-label={`${b} new`}>{b}</span>}
            </button>
          );
        })}
        {!isCaregiver && <button className="sn-item" aria-current={nav.route.name === 'settings' ? 'page' : undefined} onClick={() => nav.push({ name: 'settings' })}><LuSettings aria-hidden /><span className="grow">Settings</span></button>}
      </nav>
      <div className="sn-foot">
        <BlindButton wide />
        <LangSwitch wide />
        {me && <p className="sn-user" data-no-tr>{me.profile.fullName}</p>}
      </div>
    </aside>
  );
}

export function LangSwitch({ wide }: { wide?: boolean }) {
  const lang = useLang();
  const next = lang === 'ar' ? 'en' : 'ar';
  return (
    <button className={`util-btn lang${wide ? ' wide' : ''}`} onClick={() => setLang(next)} lang={next} data-no-tr data-testid="lang-switch"
      aria-label={next === 'ar' ? 'التحويل للعربية — Switch to Arabic' : 'Switch to English — التحويل للإنجليزية'}>
      <LuLanguages aria-hidden /><span>{next === 'ar' ? 'العربية' : 'English'}</span>
    </button>
  );
}

export function BlindButton({ wide }: { wide?: boolean }) {
  const blind = useBlind();
  const lang = useLang();
  const ar = lang === 'ar';
  return (
    <button className={`util-btn blind${blind.on ? ' on' : ''}${wide ? ' wide' : ''}`} data-no-tr data-testid="global-blind" aria-pressed={blind.on}
      onClick={() => (blind.on ? blind.disable() : blind.enable('button'))}
      aria-label={blind.on ? (ar ? 'إيقاف الوضع الصوتي. أو اسحب لليمين ٣ مرات' : 'Turn off Blind Mode. You can also swipe right three times') : (ar ? 'تشغيل الوضع الصوتي: تحكم كامل بالصوت. اختصار: Alt+Shift+B، أو اسحب لليسار ٣ مرات' : 'Turn on Blind Mode: control the whole app by voice. Shortcut Alt+Shift+B, or swipe left three times')}>
      <LuAudioLines aria-hidden /><span>{ar ? (blind.on ? 'الوضع الصوتي شغال' : 'الوضع الصوتي') : (blind.on ? 'Blind Mode on' : 'Blind Mode')}</span>
    </button>
  );
}

/** Top strip on phones (and on wide screens without the side bar): storage notice, language, Blind Mode. */
export function UtilityBar({ strip, showBlind }: { strip: { cls: string; text: string }; showBlind: boolean }) {
  const { nav } = useApp();
  return (
    <div className="utilbar" style={{ order: -1 }}>
      <div className={`mode-strip ${strip.cls}`} role="note" data-testid="mode-strip">
        <span className="ms-text"><span className="dot" aria-hidden />{strip.text}</span>
        <button onClick={() => nav.push({ name: 'about' })}>What’s real?</button>
      </div>
      <div className="util-actions">
        <LangSwitch />
        {showBlind && <BlindButton />}
      </div>
    </div>
  );
}

/** After moving to another screen, keyboard and screen-reader focus goes to its heading. */
export function useFocusOnNavigate() {
  const { nav } = useApp();
  const first = useRef(true);
  const key = JSON.stringify(nav.route);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = window.setTimeout(() => {
      const root = document.querySelector('[data-screen-root]');
      const h = root?.querySelector<HTMLElement>('h1');
      if (!h) return;
      if (document.activeElement && document.activeElement !== document.body && root?.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [key]);
}

