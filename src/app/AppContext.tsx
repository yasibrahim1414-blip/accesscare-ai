import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { Backend, Me } from '../services/backend/Backend';
import type { IntentBridge } from '../services/intentBridge/IntentBridge';
import { aiConsent, type AIAssist } from '../services/ai/AIAssist';
import type { CommunicationPreferences } from '../domain/types';
import { DEFAULT_PREFERENCES } from '../domain/types';
import { deviceBlind } from '../screens/voice/blindMode';

export type Route =
  // public
  | { name: 'welcome' } | { name: 'signin'; email?: string; notice?: string } | { name: 'signup' } | { name: 'forgot' }
  // patient
  | { name: 'p.home' } | { name: 'p.history' } | { name: 'p.doctor' } | { name: 'p.profile' }
  | { name: 'p.connect'; afterSignup?: boolean; initialId?: string } | { name: 'p.prefs'; onboarding?: boolean }
  | { name: 'p.consult'; id: string } | { name: 'p.detail'; id: string } | { name: 'p.diary' }
  | { name: 'p.care' } | { name: 'p.meds' } | { name: 'p.boxcheck' } | { name: 'p.photos' } | { name: 'p.card' } | { name: 'p.caregivers' }
  // caregiver
  | { name: 'c.home' } | { name: 'c.patient'; id: string }
  // patient or doctor
  | { name: 'interp'; cid?: string }
  // doctor
  | { name: 'd.overview' } | { name: 'd.patients' } | { name: 'd.consults'; filter?: string } | { name: 'd.profile' }
  | { name: 'd.id'; justCreated?: boolean } | { name: 'd.patient'; id: string } | { name: 'd.workspace'; id: string }
  | { name: 'd.progress' } | { name: 'd.progressOf'; id: string }
  // shared
  | { name: 'p.onboard' }
  // Silent Signal AI
  | { name: 'ss.home' } | { name: 'ss.calibrate' } | { name: 'ss.session'; id?: string } | { name: 'ss.camsetup' } | { name: 'ss.camsession' }
  | { name: 'va'; consult?: boolean; say?: string } | { name: 'talk' }
  | { name: 'settings' } | { name: 'about' };

export interface Nav {
  route: Route;
  canGoBack: boolean;
  push(r: Route): void;
  back(): void;
  replace(r: Route): void;
  reset(r: Route): void;
}

interface AppCtx {
  backend: Backend;
  bridge: IntentBridge;
  ai: AIAssist;
  me: Me | null;
  setMe(me: Me | null): void;
  prefs: CommunicationPreferences;
  nav: Nav;
  toast(msg: string): void;
  /** bump to make screens re-read data */
  version: number;
  refresh(): void;
  force2D: boolean;
  setForce2D(v: boolean): void;
}

const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

export const homeFor = (me: Me | null): Route =>
  !me ? { name: 'welcome' } : me.profile.role === 'doctor' ? { name: 'd.overview' } : me.profile.role === 'caregiver' ? { name: 'c.home' } : { name: 'p.home' };

export function AppProvider({ backend, bridge, ai, initialMe, children }: {
  backend: Backend; bridge: IntentBridge; ai: AIAssist; initialMe: Me | null; children: React.ReactNode;
}) {
  const [me, setMe] = useState<Me | null>(initialMe);
  // Blind Mode remembered on this device starts the voice guide straight away
  const [stack, setStack] = useState<Route[]>(() => {
    const blind = deviceBlind();
    return blind?.enabled && (!initialMe || initialMe.profile.role === 'patient') ? [{ name: 'va' }] : [homeFor(initialMe)];
  });
  const [toastMsg, setToast] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [force2D, setForce2D] = useState(false);
  const timer = useRef<number>(0);

  const toast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const nav: Nav = useMemo(() => ({
    route: stack[stack.length - 1],
    canGoBack: stack.length > 1,
    push: (r) => setStack((s) => [...s, r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    reset: (r) => setStack([r]),
  }), [stack]);

  // live updates from other devices (cloud backends) re-read the visible data
  React.useEffect(() => {
    if (!me || !backend.onChange) return;
    return backend.onChange(() => setVersion((v) => v + 1));
  }, [me?.profile.id, backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI may only be called while the signed-in patient has opted in
  aiConsent.on = !!me && me.profile.role === 'patient' && !!me.preferences.aiAssist;

  const value: AppCtx = {
    backend, bridge, ai, me, setMe, prefs: me?.preferences ?? DEFAULT_PREFERENCES, nav, toast,
    version, refresh: () => setVersion((v) => v + 1), force2D, setForce2D,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <div className="toast" role="status" aria-live="polite">{toastMsg}</div>}
    </Ctx.Provider>
  );
}

/** Small data hook: runs an async loader and re-runs when deps or app version change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { version } = useApp();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  React.useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => alive && setState({ data, loading: false }))
      .catch((e: Error) => alive && setState({ error: e.message || 'Something went wrong.', loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick, ...deps]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
