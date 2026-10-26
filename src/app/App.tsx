import React from 'react';
import { useApp, type Route } from './AppContext';
import { SideNav, TabBar, UtilityBar, TAB_ROUTES, useFocusOnNavigate } from './Shell';
import { WelcomeScreen, SignInScreen, SignUpScreen, ForgotScreen } from '../screens/auth/AuthScreens';
import { PatientHome, PatientHistory, PatientDetail, MyDoctorScreen, ConnectScreen, PreferencesScreen, PatientProfile, OnboardingScreen } from '../screens/patient/PatientScreens';
import { SignalHome, SignalCalibrate, SignalSession } from '../screens/signal/SignalScreens';
import { CameraSetup, CameraSession } from '../screens/signal/CameraSignal';
import { ConsultationFlow } from '../screens/patient/ConsultationFlow';
import { DoctorOverview, DoctorConsults, DoctorPatients, DoctorPatientDetail, DoctorWorkspace, DoctorIdScreen, DoctorProfile } from '../screens/doctor/DoctorScreens';
import { SettingsScreen, AboutScreen } from '../screens/shared/SettingsScreens';
import { VoiceCompanion } from '../screens/voice/VoiceCompanion';
import { PatientDiary, DoctorProgress, DoctorPatientProgress } from '../screens/diary/DiaryScreens';
import { PatientCare, MedicinesScreen, BoxCheckScreen } from '../screens/care/MedScreens';
import { PhotosScreen, EmergencyCardScreen, CaregiversScreen } from '../screens/care/CareScreens';
import { InterpreterScreen } from '../screens/care/Interpreter';
import { CareSync, MedReminder } from '../screens/care/CareSync';
import { CaregiverHome, CaregiverPatient } from '../screens/caregiver/CaregiverScreens';

const PUBLIC = new Set(['welcome', 'signin', 'signup', 'forgot']);

function Screen({ route }: { route: Route }) {
  const { me } = useApp();
  // the Voice Companion works signed out (accessible sign-up / log-in) and for patients
  if (route.name === 'va') return me?.profile.role === 'doctor' ? <DoctorOverview /> : <VoiceCompanion />;
  if (route.name === 'talk') return !me ? <SignInScreen /> : me.profile.role === 'doctor' ? <DoctorOverview /> : <VoiceCompanion key="talk" mode="talk" />;
  // Role guard: signed-out users only reach public screens, and each role only its own screens.
  if (!me && !PUBLIC.has(route.name)) return <SignInScreen />;
  const home = () => (me!.profile.role === 'doctor' ? <DoctorOverview /> : me!.profile.role === 'caregiver' ? <CaregiverHome /> : <PatientHome />);
  if (me && PUBLIC.has(route.name)) return home();
  if (me && (route.name.startsWith('p.') || route.name.startsWith('ss.')) && me.profile.role !== 'patient') return home();
  if (me && route.name.startsWith('d.') && me.profile.role !== 'doctor') return home();
  if (me && route.name.startsWith('c.') && me.profile.role !== 'caregiver') return home();
  if (me && route.name === 'interp' && me.profile.role === 'caregiver') return home();
  switch (route.name) {
    case 'welcome': return <WelcomeScreen />;
    case 'signin': return <SignInScreen email={route.email} notice={route.notice} />;
    case 'signup': return <SignUpScreen />;
    case 'forgot': return <ForgotScreen />;
    case 'p.home': return <PatientHome />;
    case 'p.history': return <PatientHistory />;
    case 'p.doctor': return <MyDoctorScreen />;
    case 'p.profile': return <PatientProfile />;
    case 'p.connect': return <ConnectScreen afterSignup={route.afterSignup} initialId={route.initialId} />;
    case 'p.prefs': return <PreferencesScreen onboarding={route.onboarding} />;
    case 'p.consult': return <ConsultationFlow key={route.id} id={route.id} />;
    case 'p.detail': return <PatientDetail key={route.id} id={route.id} />;
    case 'p.diary': return <PatientDiary />;
    case 'p.care': return <PatientCare />;
    case 'p.meds': return <MedicinesScreen />;
    case 'p.boxcheck': return <BoxCheckScreen />;
    case 'p.photos': return <PhotosScreen />;
    case 'p.card': return <EmergencyCardScreen />;
    case 'p.caregivers': return <CaregiversScreen />;
    case 'interp': return <InterpreterScreen key={route.cid ?? 'none'} cid={route.cid} />;
    case 'c.home': return <CaregiverHome />;
    case 'c.patient': return <CaregiverPatient key={route.id} id={route.id} />;
    case 'd.progress': return <DoctorProgress />;
    case 'd.progressOf': return <DoctorPatientProgress key={route.id} id={route.id} />;
    case 'd.overview': return <DoctorOverview />;
    case 'd.patients': return <DoctorPatients />;
    case 'd.consults': return <DoctorConsults filter={route.filter} />;
    case 'd.profile': return <DoctorProfile />;
    case 'd.id': return <DoctorIdScreen justCreated={route.justCreated} />;
    case 'd.patient': return <DoctorPatientDetail id={route.id} />;
    case 'd.workspace': return <DoctorWorkspace key={route.id} id={route.id} />;
    case 'p.onboard': return <OnboardingScreen />;
    case 'ss.home': return <SignalHome />;
    case 'ss.calibrate': return <SignalCalibrate />;
    case 'ss.session': return <SignalSession />;
    case 'ss.camsetup': return <CameraSetup />;
    case 'ss.camsession': return <CameraSession />;
    case 'settings': return <SettingsScreen />;
    case 'about': return <AboutScreen />;
  }
}

export function App() {
  const { me, nav, prefs, backend } = useApp();
  useFocusOnNavigate();
  const signedIn = !!me;
  const voice = nav.route.name === 'va' || nav.route.name === 'talk';
  const showTabs = signedIn && TAB_ROUTES.has(nav.route.name);
  const cls = ['app', prefs.largerText && 'large-text', prefs.largeButtons && 'large-buttons', prefs.reducedMotion && 'reduced-motion', signedIn ? 'has-side' : 'no-side'].filter(Boolean).join(' ');
  const strip = backend.mode === 'claude-cloud' ? { cls: 'cloud', text: 'Synced across your devices' }
    : backend.mode === 'supabase' ? { cls: 'cloud', text: 'Connected to the AccessCare server' }
    : { cls: 'local', text: backend.persistent ? 'Offline demo: this browser only' : 'Offline demo: storage blocked' };
  return (
    <div className={cls}>
      {signedIn && <SideNav />}
      <div className="device">
        <main className="main" data-screen-root id="main" data-route={nav.route.name}>
          <Screen route={nav.route} />
        </main>
        {/* after the screen in reading order (so a screen's own first control comes first), shown on top */}
        <UtilityBar strip={strip} showBlind={!voice} />
        {me?.profile.role === 'patient' && <><CareSync /><MedReminder /></>}
        {showTabs && <TabBar />}
      </div>
    </div>
  );
}
