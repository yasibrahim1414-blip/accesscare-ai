import { runtimeConfig } from './services/config';
import { BlindProvider } from './a11y/BlindLayer';
import { applyDocumentLang } from './i18n/lang';
import { startTranslation, addTranslations } from './i18n/translate';
import { codePairs } from './i18n/codePairs';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LuHeartPulse } from 'react-icons/lu';
import { AppProvider } from './app/AppContext';
import { App } from './app/App';
import { CSS } from './ui/styles';
import type { Backend } from './services/backend/Backend';
import { LocalDemoBackend } from './services/backend/LocalDemoBackend';
import { WebSyncBackend } from './services/backend/WebSyncBackend';
import { CloudBackend } from './services/backend/CloudBackend';
import { SupabaseBackend } from './services/backend/SupabaseBackend';
import type { CloudDb, CloudUser } from './services/backend/cloudDb';
import { DemoIntentBridge } from './services/intentBridge/DemoIntentBridge';
import { createDefaultStore } from './services/storage';
import { ClaudeAI, NoAI, aiConsent, type AIAssist, type SampleFn } from './services/ai/AIAssist';
import { probeNaturalVoice, naturalVoice } from './services/voice/Speech';
import { remoteSample } from './services/ai/RemoteSample';
declare const __AI_ENDPOINT__: string;

// Composition root. Backend selection, in order:
//  1. Supabase, when the build was given ACCESSCARE_SUPABASE_URL / _ANON_KEY
//     (standalone deployment outside Claude).
//  2. Claude's shared artifact database, when running inside Claude and the
//     viewer is signed in with access to it.
//  3. The offline single-device demo, clearly labeled.
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

function Boot({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="app"><div className="device"><div className="boot"><div>
      <div className="mark"><LuHeartPulse /></div>
      <b style={{ color: 'var(--ink)', fontFamily: 'var(--font-head)' }}>AccessCare AI</b>
      <p className="small" style={{ marginTop: 6 }}>{message}</p>
      {detail && <p className="tiny" style={{ marginTop: 6, maxWidth: 300 }}>{detail}</p>}
    </div></div></div></div>
  );
}

async function pickAI(): Promise<SampleFn | null> {
  const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
  const endpoint = typeof __AI_ENDPOINT__ === 'string' ? __AI_ENDPOINT__ : '';
  if (!claude?.use) return endpoint ? remoteSample(endpoint) : null; // web version: Claude through the AccessCare proxy
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 12_000));
  return (await Promise.race([claude.use('sample'), timeout]).catch(() => null)) as SampleFn | null;
}

async function pickBackend(): Promise<{ backend: Backend; note?: string }> {
  const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
  const key = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : '';
  if (url && key) return { backend: new SupabaseBackend({ url, anonKey: key }) };

  const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
  if (claude?.use) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 12_000));
    const [db, user] = await Promise.all([
      Promise.race([claude.use('db'), timeout]).catch(() => null),
      Promise.race([claude.use('user'), timeout]).catch(() => null),
    ]) as [CloudDb | null, CloudUser | null];
    if (db && user && (await user.id())) return { backend: new CloudBackend(db, user) };
    return { backend: new LocalDemoBackend(createDefaultStore()), note: 'The shared database is not available in this view (you may be signed out of Claude or have view-only access), so the offline demo is open.' };
  }
  // website: the AccessCare worker's shared storage, when it is set up (worker v7 with a D1 database)
  const endpoint = typeof __AI_ENDPOINT__ === 'string' ? __AI_ENDPOINT__ : '';
  if (endpoint) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
      const st = await fetch(endpoint.replace(/\/+$/, '') + '/status', { signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).finally(() => clearTimeout(t));
      if (st?.db) return { backend: new WebSyncBackend(endpoint) };
    } catch { /* server unreachable: offline demo below */ }
  }
  return { backend: new LocalDemoBackend(createDefaultStore()) };
}

async function boot() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  applyDocumentLang();
  startTranslation(document.getElementById('root')!);
  addTranslations(codePairs());
  const root = createRoot(document.getElementById('root')!);
  root.render(<Boot message="Connecting securely…" />);

  const endpoint = typeof __AI_ENDPOINT__ === 'string' ? __AI_ENDPOINT__ : '';
  runtimeConfig.aiEndpoint = endpoint;
  // the natural (server) voice exists only when the AccessCare worker has a speech key; checked once, in the background
  if (endpoint) void probeNaturalVoice(endpoint); else naturalVoice.available = false;
  const [{ backend, note }, sample] = await Promise.all([pickBackend(), pickAI()]);
  let me = null;
  try { me = await backend.restoreSession(); } catch { me = null; }
  // AI is used only while the signed-in patient has AI assistance turned on (see AppProvider)
  const ai: AIAssist = sample ? new ClaudeAI(sample, () => aiConsent.on) : new NoAI();
  if (note) console.info(note);

  root.render(
    <AppProvider backend={backend} bridge={new DemoIntentBridge()} ai={ai} initialMe={me}>
      <BlindProvider>
        <App />
      </BlindProvider>
    </AppProvider>,
  );
}
boot();
