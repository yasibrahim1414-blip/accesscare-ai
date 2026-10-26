// AccessCare AI design system — "Clear Harbor".
// A calm clinical palette (slate structure, Nile teal for action) with one
// signature colour: saffron, used only for keyboard focus and Blind Mode, so the
// accessibility features are the most visible thing in the app. One typeface
// family for everything: Atkinson Hyperlegible (designed for low-vision readers),
// with IBM Plex Sans Arabic for Arabic. Layout: phone-first single column with a
// bottom tab bar; on wide screens a side navigation and a centred reading column.
// All spacing uses logical properties so Arabic (right-to-left) mirrors correctly.
export const CSS = `
:root {
  --slate-900: #142833; --slate-800: #1E3442; --slate-700: #2F4A5A; --slate-100: #E5ECEF;
  --navy-900: var(--slate-900); --navy-800: var(--slate-800); --navy-700: var(--slate-700); --navy-100: var(--slate-100);
  --teal: #0B6E79; --teal-strong: #08575F; --teal-ink: #07525A; --teal-50: #E3F1F2; --teal-100: #C3E1E4;
  --saffron: #F2B01E; --on-saffron: #2A1D00; --saffron-soft: #FFF4D6;
  --bg: #F3F6F7; --surface: #FFFFFF; --surface-2: #F7F9FA; --surface-3: #EBF0F2;
  --line: #DCE3E7; --line-strong: #C3CED4;
  --ink: #13212B; --ink-2: #32434E; --muted: #5C6E79; --on-accent: #FFFFFF; --on-navy: #FFFFFF; --on-navy-muted: #B7C7D0;
  --danger: #B42318; --danger-soft: #FCEBE9; --warn: #8A5300; --warn-soft: #FFF3DA; --ok: #17704A; --ok-soft: #E3F3EA; --info: #245B8F; --info-soft: #E7EFF7;
  --shadow-1: 0 1px 2px rgba(20, 40, 51, .06); --shadow-2: 0 8px 24px rgba(20, 40, 51, .10);
  --stage-top: #F7F9FA; --stage-bottom: #E2E9EC; --frame: #C3CED4;
  --focus: var(--saffron);
  --font-body: "Atkinson Hyperlegible", "IBM Plex Sans Arabic", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-head: var(--font-body);
  --fs: 16px; --tap: 48px; --r-sm: 8px; --r: 10px; --r-lg: 14px;
  --side-w: 264px; --col: 760px;
}
:root[dir="rtl"] { --font-body: "IBM Plex Sans Arabic", "Atkinson Hyperlegible", "Segoe UI", Tahoma, system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --slate-900: #DCE7EC; --slate-800: #C2D3DB; --slate-700: #A3BAC5; --slate-100: #1B2C35;
  --teal: #3BB3BE; --teal-strong: #5CC6CF; --teal-ink: #7DD3DA; --teal-50: #0E2E32; --teal-100: #154248;
  --saffron-soft: #3A2C08;
  --bg: #0B151B; --surface: #111F27; --surface-2: #15252E; --surface-3: #1A2C36;
  --line: #22363F; --line-strong: #30495A;
  --ink: #E6EEF2; --ink-2: #C3D1D8; --muted: #93A7B2; --on-accent: #04262A; --on-navy-muted: #A9BCC6;
  --danger: #FF8E84; --danger-soft: #3A1816; --warn: #F2C26B; --warn-soft: #33270F; --ok: #79D6A2; --ok-soft: #11301F; --info: #9CC1F4; --info-soft: #14263D;
  --shadow-1: 0 1px 2px rgba(0,0,0,.35); --shadow-2: 0 8px 24px rgba(0,0,0,.35);
  --stage-top: #15252E; --stage-bottom: #0B151B; --frame: #22363F; color-scheme: dark; } }
:root[data-theme="dark"] {
  --slate-900: #DCE7EC; --slate-800: #C2D3DB; --slate-700: #A3BAC5; --slate-100: #1B2C35;
  --teal: #3BB3BE; --teal-strong: #5CC6CF; --teal-ink: #7DD3DA; --teal-50: #0E2E32; --teal-100: #154248;
  --saffron-soft: #3A2C08;
  --bg: #0B151B; --surface: #111F27; --surface-2: #15252E; --surface-3: #1A2C36;
  --line: #22363F; --line-strong: #30495A;
  --ink: #E6EEF2; --ink-2: #C3D1D8; --muted: #93A7B2; --on-accent: #04262A; --on-navy-muted: #A9BCC6;
  --danger: #FF8E84; --danger-soft: #3A1816; --warn: #F2C26B; --warn-soft: #33270F; --ok: #79D6A2; --ok-soft: #11301F; --info: #9CC1F4; --info-soft: #14263D;
  --shadow-1: 0 1px 2px rgba(0,0,0,.35); --shadow-2: 0 8px 24px rgba(0,0,0,.35);
  --stage-top: #15252E; --stage-bottom: #0B151B; --frame: #22363F; color-scheme: dark; }

html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: var(--fs); line-height: 1.5; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
#root { height: 100%; }
* { box-sizing: border-box; }
button, input, textarea, select { font: inherit; color: inherit; }
button { -webkit-tap-highlight-color: transparent; }
/* focus: a saffron ring with a dark edge, visible on every background */
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; box-shadow: 0 0 0 5px var(--on-saffron); border-radius: 6px; }
h1:focus, h1:focus-visible { outline: none; box-shadow: none; }

/* ---------- app frame ---------- */
.app { height: 100%; display: flex; font-size: var(--fs); }
.app.large-text { --fs: 19px; }
.app.large-buttons { --tap: 60px; }
.app.reduced-motion *, .app.reduced-motion *::before, .app.reduced-motion *::after { transition: none !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
.device { position: relative; flex: 1; min-width: 0; height: 100%; background: var(--bg); display: flex; flex-direction: column; overflow: hidden; }
.main { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.screen { flex: 1; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.screen-in { animation: screenIn .18s ease-out; }
@keyframes screenIn { from { opacity: .6 } to { opacity: 1 } }
.pad { padding: 8px 16px 32px; display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: var(--col); margin-inline: auto; }
.stack { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; gap: 12px; align-items: center; }
.row.wrap { flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.grow { flex: 1; min-width: 0; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 340px) { .grid2 { grid-template-columns: 1fr; } }

/* utility strip: storage notice, language, Blind Mode */
.utilbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px; padding-top: calc(6px + env(safe-area-inset-top, 0px)); background: var(--surface); border-bottom: 1px solid var(--line); min-height: 48px; }
.mode-strip { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-size: .78em; font-weight: 700; color: var(--muted); }
.mode-strip .ms-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 440px) { .mode-strip .ms-text { font-size: 0; } .mode-strip .ms-text .dot { font-size: 12px; } }
.mode-strip.cloud .dot { background: var(--ok); }
.mode-strip.local .dot { background: var(--warn); }
.mode-strip button { flex: none; border: 0; background: transparent; color: var(--teal-ink); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; font-size: 1em; font-weight: 700; min-height: 36px; padding: 0 4px; }
.mode-strip .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-inline-end: 6px; vertical-align: 1px; }
.util-actions { display: flex; gap: 6px; flex: none; }
.util-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font-weight: 700; font-size: .82em; cursor: pointer; white-space: nowrap; }
.util-btn svg { font-size: 1.15em; flex: none; }
.util-btn.blind { background: var(--saffron); border-color: var(--saffron); color: var(--on-saffron); }
.util-btn.blind.on { background: var(--on-saffron); color: var(--saffron); border-color: var(--on-saffron); }
.util-btn.lang span { font-family: "IBM Plex Sans Arabic", var(--font-body); }
.util-btn.wide { width: 100%; justify-content: flex-start; min-height: 44px; border-radius: var(--r); font-size: .9em; padding: 0 12px; }
@media (max-width: 380px) { .util-btn:not(.wide) span { display: none; } .util-btn:not(.wide) { padding: 0; width: 40px; justify-content: center; } .util-btn.blind span { display: inline; } .util-btn.blind { width: auto; padding: 0 10px; } }

/* side navigation (wide screens) */
.sidenav { display: none; }
@media (min-width: 900px) {
  .app.has-side .sidenav { display: flex; flex-direction: column; gap: 18px; width: var(--side-w); flex: none; height: 100%; overflow-y: auto; background: var(--surface); border-inline-end: 1px solid var(--line); padding: 20px 14px; }
  .app.has-side .tabbar { display: none; }
  .app.has-side .utilbar .util-actions { display: none; }
  .pad { padding: 12px 32px 48px; }
}
.sn-brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
.sn-brand b { display: block; font-size: 1.05em; line-height: 1.2; }
.sn-role { display: block; font-size: .78em; color: var(--muted); font-weight: 700; }
.sn-list { display: flex; flex-direction: column; gap: 2px; }
.sn-item { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 0 12px; border: 0; border-radius: var(--r); background: transparent; color: var(--ink-2); font-weight: 700; cursor: pointer; text-align: start; width: 100%; position: relative; }
.sn-item svg { font-size: 1.25em; flex: none; color: var(--muted); }
.sn-item:hover { background: var(--surface-3); }
.sn-item[aria-current="page"] { background: var(--teal-50); color: var(--teal-ink); }
.sn-item[aria-current="page"] svg { color: var(--teal-ink); }
.sn-item[aria-current="page"]::before { content: ""; position: absolute; inset-inline-start: -14px; top: 10px; bottom: 10px; width: 4px; border-radius: 0 4px 4px 0; background: var(--teal); }
.sn-badge { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: var(--danger); color: #fff; font-size: .75em; display: grid; place-items: center; }
.sn-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
.sn-user { margin: 4px 6px 0; font-size: .85em; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- headers ---------- */
.topbar { flex: none; display: flex; align-items: center; gap: 4px; min-height: 56px; padding: 4px 8px; background: var(--bg); width: 100%; max-width: calc(var(--col) + 32px); margin-inline: auto; }
.topbar.bordered { background: var(--surface); border-bottom: 1px solid var(--line); max-width: none; }
.topbar h1 { font-size: 1.08em; font-weight: 700; margin: 0; flex: 1; text-align: center; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar .spacer { width: 48px; flex: none; }
:root[dir="rtl"] .topbar .iconbtn svg { transform: scaleX(-1); }
.largebar { flex: none; padding: 18px 16px 6px; display: flex; align-items: flex-end; gap: 12px; width: 100%; max-width: var(--col); margin-inline: auto; }
@media (min-width: 900px) { .largebar { padding: 28px 32px 8px; } }
.largebar h1 { font-size: 1.75em; line-height: 1.15; letter-spacing: -.01em; margin: 0; flex: 1; color: var(--ink); text-wrap: balance; }
.largebar .eyebrow { display: block; font-size: .48em; font-weight: 700; letter-spacing: 0; color: var(--muted); margin-bottom: 4px; }
.iconbtn { min-width: 48px; min-height: 48px; border: 0; background: transparent; border-radius: var(--r); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--ink-2); font-size: 1.3em; }
.iconbtn:hover { background: var(--surface-3); }
.iconbtn.round { background: var(--surface); border: 1px solid var(--line); border-radius: 50%; min-width: 44px; min-height: 44px; font-size: 1.15em; }

/* ---------- tab bar (phones) ---------- */
.tabbar { flex: none; display: grid; grid-template-columns: repeat(4, 1fr); background: var(--surface); border-top: 1px solid var(--line); padding: 4px 4px calc(4px + env(safe-area-inset-bottom, 0px)); }
.tabbar.n5 { grid-template-columns: repeat(5, 1fr); }
.tabbar.n6 { grid-template-columns: repeat(6, 1fr); }
.tabbar.n6 .tab { font-size: .64em; } .tabbar.n6 .tab .ti { width: 40px; }
.tab { border: 0; background: transparent; min-height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  font-size: .72em; font-weight: 700; color: var(--muted); cursor: pointer; position: relative; border-radius: var(--r); padding: 4px 2px; }
.tab .tl { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab .ti { width: 48px; height: 28px; border-radius: 14px; display: grid; place-items: center; font-size: 1.5em; }
.tab[aria-current="page"] { color: var(--teal-ink); }
.tab[aria-current="page"] .ti { background: var(--teal-50); }
.tab .dot { position: absolute; top: 2px; inset-inline-start: calc(50% + 8px); min-width: 18px; height: 18px; border-radius: 9px; background: var(--danger); color: #fff; font-size: 11px; display: grid; place-items: center; padding: 0 5px; }

/* ---------- type ---------- */
h2.title { font-size: 1.4em; line-height: 1.25; margin: 0; color: var(--ink); text-wrap: balance; letter-spacing: -.01em; }
h3.section { font-size: .95em; color: var(--ink-2); margin: 8px 2px -6px; font-weight: 700; }
p { margin: 0; }
.muted { color: var(--muted); }
.small { font-size: .88em; }
.tiny { font-size: .78em; }
.lead { font-size: 1.04em; color: var(--ink-2); }
.strong { font-weight: 700; }
.num { font-variant-numeric: tabular-nums; }

/* ---------- surfaces ---------- */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.card.flat { box-shadow: none; }
.card.raised { box-shadow: var(--shadow-2); border-color: var(--line); }
.card.tinted { background: var(--surface-2); }
.card.button { text-align: start; cursor: pointer; font: inherit; color: inherit; width: 100%; transition: border-color .15s, background .15s; }
.card.button:hover { border-color: var(--teal); background: var(--surface-2); }
.hero-card { background: var(--teal); color: var(--on-accent); border-radius: var(--r-lg); padding: 18px; display: flex; flex-direction: column; gap: 12px; position: relative; overflow: hidden; }
.hero-card .muted { color: color-mix(in srgb, var(--on-accent) 80%, transparent); }
.hero-card h2 { font-size: 1.25em; margin: 0; line-height: 1.25; }
.hero-card .pulse-ring { display: none; }
.hero-card .btn.primary { background: var(--surface); color: var(--teal-ink); box-shadow: none; }
.hero-card .btn.primary:hover:not([disabled]) { background: var(--teal-50); }

/* ---------- buttons ---------- */
.btn { min-height: var(--tap); border-radius: var(--r); border: 1px solid transparent; padding: 10px 18px; font-weight: 700; cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center; gap: 8px; text-align: center; transition: background .15s, border-color .15s; font-size: 1em; line-height: 1.25; }
.btn svg { font-size: 1.15em; flex: none; }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn.primary { background: var(--teal); color: var(--on-accent); }
.btn.primary:hover:not([disabled]) { background: var(--teal-strong); }
.btn.navy { background: var(--slate-800); color: var(--surface); }
.btn.secondary { background: var(--surface); color: var(--ink); border-color: var(--line-strong); }
.btn.secondary:hover:not([disabled]) { background: var(--surface-3); }
.btn.ghost { background: transparent; color: var(--teal-ink); }
.btn.ghost:hover:not([disabled]) { background: var(--teal-50); }
.btn.danger { background: var(--danger); color: #fff; }
.btn.danger-outline { background: var(--surface); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.btn.on-navy { background: rgba(255,255,255,.12); color: #fff; border-color: rgba(255,255,255,.3); }
.btn.block { width: 100%; }
.btn.big { min-height: calc(var(--tap) + 8px); font-size: 1.04em; }
.btn .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
.link-btn { border: 0; background: transparent; color: var(--teal-ink); font-weight: 700; cursor: pointer; padding: 6px; min-height: 40px; align-self: center; text-decoration: underline; text-underline-offset: 2px; }

/* ---------- forms ---------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font-weight: 700; font-size: .92em; color: var(--ink-2); }
.field .hint { font-size: .84em; color: var(--muted); }
.field .err { font-size: .86em; color: var(--danger); font-weight: 700; }
.input { min-height: var(--tap); border-radius: var(--r); border: 1.5px solid var(--line-strong); background: var(--surface); padding: 11px 14px; width: 100%; transition: border-color .15s, box-shadow .15s; }
.input::placeholder { color: color-mix(in srgb, var(--muted) 80%, transparent); }
.input:focus { border-color: var(--teal); outline: none; box-shadow: 0 0 0 3px var(--saffron); }
.input.bad { border-color: var(--danger); }
textarea.input { min-height: 104px; resize: vertical; }
.input-wrap { display: flex; gap: 8px; align-items: stretch; }
.pw-wrap { position: relative; flex: 1; }
.pw-wrap .input { padding-inline-end: 52px; }
.pw-wrap .reveal { position: absolute; inset-inline-end: 2px; top: 50%; transform: translateY(-50%); }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .04em; direction: ltr; }

/* ---------- choices ---------- */
.choice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.choice { min-height: calc(var(--tap) + 4px); border: 1.5px solid var(--line); background: var(--surface); border-radius: var(--r); padding: 10px 14px; display: flex; align-items: center;
  gap: 10px; cursor: pointer; text-align: start; font-weight: 700; color: var(--ink); transition: border-color .15s, background .15s; }
.choice:hover { border-color: var(--line-strong); }
.choice .ico { font-size: 1.3em; width: 1.5em; height: 1.5em; display: grid; place-items: center; flex: none; }
.choice .check { margin-inline-start: auto; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line-strong); flex: none; display: grid; place-items: center; font-size: 13px; color: transparent; }
.choice[aria-pressed="true"], .choice[aria-checked="true"] { border-color: var(--teal); background: var(--teal-50); color: var(--teal-ink); box-shadow: inset 0 0 0 1px var(--teal); }
.choice[aria-pressed="true"] .check, .choice[aria-checked="true"] .check { background: var(--teal); border-color: var(--teal); color: var(--on-accent); }
.choice.yesno { justify-content: center; font-size: 1.15em; min-height: calc(var(--tap) + 28px); flex-direction: column; gap: 4px; }
.choice.yesno .ico { font-size: 1.6em; }
.choice.yes[aria-pressed="true"] { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); box-shadow: inset 0 0 0 1px var(--ok); }
.role-card { display: flex; gap: 14px; align-items: flex-start; padding: 16px; border-radius: var(--r-lg); border: 1.5px solid var(--line); background: var(--surface); cursor: pointer; text-align: start; width: 100%; }
.role-card[aria-checked="true"] { border-color: var(--teal); box-shadow: inset 0 0 0 1px var(--teal); background: var(--teal-50); }
.role-card .ri { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; font-size: 1.4em; flex: none; background: var(--teal-50); color: var(--teal-ink); }
.role-card.doctor .ri { background: var(--slate-100); color: var(--slate-800); }
.scale { display: grid; grid-template-columns: repeat(10, 1fr); gap: 4px; direction: ltr; }
.scale button { min-height: var(--tap); border-radius: 8px; border: 1.5px solid var(--line); background: var(--surface); font-weight: 700; cursor: pointer; }
.scale button[aria-checked="true"] { background: var(--teal); border-color: var(--teal); color: var(--on-accent); }
.scale-labels { display: flex; justify-content: space-between; font-size: .78em; color: var(--muted); font-weight: 700; }

/* ---------- chips, tags, status ---------- */
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: .82em; font-weight: 700; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2); }
.chip.teal { background: var(--teal-50); color: var(--teal-ink); border-color: transparent; }
.chip button { border: 0; background: transparent; cursor: pointer; color: inherit; padding: 0; font-size: 1.15em; line-height: 1; min-width: 24px; min-height: 24px; }
.status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border-radius: 999px; font-size: .78em; font-weight: 700; white-space: nowrap; }
.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.status.new { background: var(--info-soft); color: var(--info); }
.status.in_review { background: var(--warn-soft); color: var(--warn); }
.status.completed { background: var(--ok-soft); color: var(--ok); }
.status.draft, .status.cancelled { background: var(--surface-3); color: var(--muted); }
.tag { display: inline-block; margin-inline-start: 6px; font-size: .74em; font-weight: 700; padding: 2px 7px; border-radius: 6px; vertical-align: 1px; white-space: nowrap; }
.tag.confirmed { background: var(--ok-soft); color: var(--ok); }
.tag.unanswered { background: var(--surface-3); color: var(--muted); }
.tag.unsure { background: var(--warn-soft); color: var(--warn); }
.tag.needs_clarification { background: var(--danger-soft); color: var(--danger); }

/* ---------- banners ---------- */
.banner { border-radius: var(--r); padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start; font-size: .92em; line-height: 1.45; border: 1px solid transparent; }
.banner.info { background: var(--info-soft); color: var(--ink-2); border-color: color-mix(in srgb, var(--info) 18%, transparent); }
.banner.warn { background: var(--warn-soft); color: var(--warn); border-color: color-mix(in srgb, var(--warn) 22%, transparent); }
.banner.danger { background: var(--danger-soft); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent); }
.banner.ok { background: var(--ok-soft); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 22%, transparent); }
.banner > svg { flex: none; margin-top: 2px; font-size: 1.2em; }

/* ---------- lists (grouped rows) ---------- */
.list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; }
.list-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; min-height: calc(var(--tap) + 12px); border: 0; border-top: 1px solid var(--line);
  background: transparent; width: 100%; text-align: start; cursor: pointer; color: inherit; font: inherit; }
.list-item:first-child { border-top: 0; }
.list-item:hover { background: var(--surface-2); }
.list-item .chev { color: var(--muted); flex: none; }
:root[dir="rtl"] .list-item .chev { transform: scaleX(-1); }
:root[dir="rtl"] .linkbtn .flip, :root[dir="rtl"] .card.button .flip { transform: scaleX(-1); }
.list-item .li-ico { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--surface-3); color: var(--slate-700); flex: none; font-size: 1.15em; }
.list-item.danger, .list-item.danger .li-ico { color: var(--danger); }
.list-item.danger .li-ico { background: var(--danger-soft); }
.avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--teal-50); color: var(--teal-ink); display: grid; place-items: center; font-weight: 700; flex: none; font-size: .95em; }
.avatar.navy { background: var(--slate-100); color: var(--slate-800); }
.avatar.lg { width: 64px; height: 64px; font-size: 1.3em; }

/* ---------- stats ---------- */
.stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
@media (min-width: 700px) { .stat-grid { grid-template-columns: repeat(4, 1fr); } }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px; text-align: start; cursor: pointer; display: flex; flex-direction: column; gap: 8px; font: inherit; color: inherit; }
.stat:hover { border-color: var(--teal); }
.stat .si { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; font-size: 1.05em; }
.stat b { font-size: 1.75em; line-height: 1; color: var(--ink); font-variant-numeric: tabular-nums; }
.stat span { font-size: .82em; color: var(--muted); font-weight: 700; }

/* ---------- doctor id card ---------- */
.idcard { border-radius: var(--r-lg); padding: 18px; background: var(--slate-800); color: #fff; display: flex; flex-direction: column; gap: 10px; position: relative; overflow: hidden; }
:root .idcard { background: #1E3442; }
.idcard .lbl { font-size: .8em; color: #BFE3E7; font-weight: 700; }
.idcard .code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.6em; letter-spacing: .08em; font-weight: 700; user-select: all; word-break: break-all; direction: ltr; text-align: start; }
.idcard .btn.secondary { background: rgba(255,255,255,.1); color: #fff; border-color: rgba(255,255,255,.3); position: relative; z-index: 1; }

/* ---------- steps ---------- */
.stepper { display: flex; flex-direction: column; gap: 8px; }
.stepper .bars { display: flex; gap: 4px; }
.stepper .bars i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); transition: background .2s; }
.stepper .bars i.on { background: var(--teal); }
.stepper .lbl { font-size: .82em; font-weight: 700; color: var(--muted); }
.footer-bar { flex: none; padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px)); background: var(--surface); border-top: 1px solid var(--line); display: flex; gap: 10px; }
.footer-bar > * { max-width: var(--col); }
.footer-bar .btn { flex: 1; }
.footer-bar .btn.secondary, .footer-bar .btn.ghost { flex: 0 0 auto; }
@media (min-width: 900px) { .footer-bar { justify-content: center; } .footer-bar .btn { flex: 0 1 360px; } }

/* ---------- toggles ---------- */
.toggle-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--line); min-height: calc(var(--tap) + 10px); cursor: pointer; }
.toggle-row:first-child { border-top: 0; }
.switch { width: 52px; height: 32px; border-radius: 16px; background: var(--line-strong); position: relative; flex: none; border: 0; cursor: pointer; transition: background .15s; }
.switch::after { content: ""; position: absolute; top: 3px; inset-inline-start: 3px; width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: inset-inline-start .15s; }
.switch[aria-checked="true"] { background: var(--teal); }
.switch[aria-checked="true"]::after { inset-inline-start: 23px; }

/* ---------- sheets & toasts ---------- */
.sheet-backdrop { position: absolute; inset: 0; background: rgba(10, 22, 29, .5); display: flex; align-items: flex-end; justify-content: center; z-index: 30; animation: fade .16s; }
.sheet { background: var(--surface); width: 100%; max-width: 560px; border-radius: 20px 20px 0 0; padding: 22px 18px calc(18px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column;
  gap: 14px; max-height: 90%; overflow-y: auto; animation: up .2s cubic-bezier(.2,.8,.2,1); }
@media (min-width: 700px) { .sheet-backdrop { align-items: center; } .sheet { border-radius: 16px; } .sheet .grab { display: none; } }
.sheet h3 { margin: 0; font-size: 1.2em; color: var(--ink); }
.sheet .grab { width: 40px; height: 5px; border-radius: 3px; background: var(--line-strong); align-self: center; margin: -10px 0 2px; }
.sheet .sheet-ico { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; font-size: 1.5em; background: var(--surface-3); color: var(--slate-800); }
.sheet .sheet-ico.danger { background: var(--danger-soft); color: var(--danger); }
@keyframes up { from { transform: translateY(24px); opacity: .5 } to { transform: none; opacity: 1 } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.toast { position: fixed; inset-inline: 16px; bottom: calc(88px + env(safe-area-inset-bottom, 0px)); margin-inline: auto; max-width: 480px; background: var(--slate-900); color: var(--bg); border-radius: var(--r); padding: 12px 16px; z-index: 60; font-weight: 700;
  box-shadow: var(--shadow-2); animation: up .2s; display: flex; gap: 10px; align-items: center; }

/* ---------- loading / empty ---------- */
.skeleton { border-radius: var(--r); background: linear-gradient(90deg, var(--surface-3) 0%, var(--surface-2) 50%, var(--surface-3) 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
@keyframes shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
.empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 28px 18px; border: 1px solid var(--line); background: var(--surface); border-radius: var(--r-lg); }
.empty .ei { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center; background: var(--teal-50); color: var(--teal-ink); font-size: 1.5em; margin-bottom: 4px; }
.empty b { font-weight: 700; font-size: 1.05em; }
.boot { flex: 1; display: grid; place-items: center; text-align: center; gap: 14px; color: var(--muted); height: 100%; }
.boot .mark { width: 60px; height: 60px; border-radius: 16px; background: var(--teal); color: #fff; display: grid; place-items: center; font-size: 1.9em; font-weight: 700; margin: 0 auto 12px; }

/* ---------- welcome ---------- */
.welcome { display: flex; flex-direction: column; min-height: 100%; }
.welcome-hero { background: var(--slate-800); color: #fff; padding: 28px 20px 30px; display: flex; flex-direction: column; gap: 14px; position: relative; overflow: hidden; }
:root .welcome-hero { background: #1E3442; }
.welcome-hero h1 { font-size: 2em; line-height: 1.12; margin: 0; letter-spacing: -.02em; text-wrap: balance; position: relative; max-width: 20ch; }
.welcome-hero p { color: #C9D7DE; position: relative; max-width: 52ch; }
.welcome-hero .rings { display: none; }
@media (min-width: 900px) { .welcome-hero { padding: 56px max(32px, calc((100% - var(--col)) / 2)); } .welcome-hero h1 { font-size: 2.6em; } }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; position: relative; }
.brand-mark { width: 34px; height: 34px; border-radius: 9px; background: var(--teal); display: grid; place-items: center; color: #fff; font-size: 1.1em; font-weight: 700; flex: none; }
.feature { display: flex; gap: 14px; align-items: flex-start; }
.feature .fi { width: 40px; height: 40px; border-radius: 10px; background: var(--teal-50); color: var(--teal-ink); display: grid; place-items: center; flex: none; font-size: 1.2em; }
.identity { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: var(--r); background: var(--surface-2); border: 1px solid var(--line); }
.urgent-btn { border: 1.5px solid color-mix(in srgb, var(--danger) 55%, transparent); color: var(--danger); background: var(--surface); border-radius: 999px; min-height: 40px; padding: 4px 12px;
  font-weight: 700; font-size: .82em; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
.num-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); }
.num-row b { font-size: 1.4em; user-select: all; color: var(--danger); direction: ltr; }
.speak { border: 1px solid var(--line); background: var(--surface); border-radius: var(--r); min-width: 44px; min-height: 44px; cursor: pointer; color: var(--teal-ink); font-size: 1.15em; display: grid; place-items: center; flex: none; }
.timeline { display: flex; flex-direction: column; gap: 0; }
.timeline .t { display: grid; grid-template-columns: 18px 1fr; gap: 10px; font-size: .88em; }
.timeline .t .d { position: relative; }
.timeline .t .d::before { content: ""; position: absolute; inset-inline-start: 5px; top: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--teal); }
.timeline .t .d::after { content: ""; position: absolute; inset-inline-start: 8.5px; top: 16px; bottom: -6px; width: 1px; background: var(--line-strong); }
.timeline .t:last-child .d::after { display: none; }
.timeline .t > div:last-child { padding-bottom: 10px; }

/* ---------- diary & progress ---------- */
.diary-items { margin: 0; padding-inline-start: 18px; display: grid; gap: 2px; }
.diary-edit { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.ref-chip { display: inline-block; font-size: .75em; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: var(--surface-3); color: var(--ink-2); direction: ltr; }
.change-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.change { display: flex; gap: 10px; justify-content: space-between; align-items: flex-start; padding: 10px 12px; border-radius: var(--r); background: var(--surface); border: 1px solid var(--line); border-inline-start: 4px solid var(--line-strong); font-size: .94em; }
.change.urgent { border-inline-start-color: var(--danger); background: var(--danger-soft); }
.change.attention { border-inline-start-color: var(--warn); }
.change.ai { border-inline-start-color: #7c5cff; }
.change .refs { display: flex; gap: 4px; flex-wrap: wrap; flex: none; }
.mini-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
.mini-table td { padding: 4px 6px; border-top: 1px solid var(--line); }

/* ---------- Blind Mode voice bar (whole app) ---------- */
.voicebar { position: fixed; inset-inline: 0; bottom: 0; z-index: 70; background: var(--slate-900); color: var(--bg); padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; gap: 8px;
  border-top: 4px solid var(--saffron); max-height: 55vh; overflow-y: auto; }
:root .voicebar { background: #142833; color: #F3F6F7; }
@media (min-width: 900px) { .app.has-side ~ .voicebar { inset-inline-start: var(--side-w); } }
.vb-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 1.02em; }
.vb-dot { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.12); flex: none; }
.vb-status.listening .vb-dot { background: #D92D20; color: #fff; }
.vb-status.speaking .vb-dot { background: var(--saffron); color: var(--on-saffron); }
.vb-heard { opacity: .85; font-size: .92em; }
.vb-said { margin: 0; font-size: .95em; line-height: 1.45; color: #DDE7EB; max-height: 5.8em; overflow-y: auto; }
.vb-err { margin: 0; font-weight: 700; color: #FFC9C2; font-size: .92em; }
.vb-note { margin: 0; font-size: .88em; color: #C9D7DE; }
.vb-row { display: flex; gap: 8px; flex-wrap: wrap; }
.vb-btn { flex: 1 1 auto; min-height: 48px; padding: 0 14px; border-radius: var(--r); border: 1.5px solid rgba(255,255,255,.35); background: transparent; color: #fff; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; font: inherit; font-weight: 700; }
.vb-btn.primary { background: var(--saffron); border-color: var(--saffron); color: var(--on-saffron); flex: 2 1 auto; }
.vb-btn.big { min-height: 64px; font-size: 1.12em; }
.vb-btn[disabled] { opacity: .45; cursor: not-allowed; }
body:has(.voicebar) .device { padding-bottom: 170px; }

/* ---------- report ---------- */
.report { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; background: var(--surface); margin: 0; }
.report .r { display: grid; grid-template-columns: 38% 1fr; gap: 10px; padding: 11px 14px; border-top: 1px solid var(--line); font-size: .92em; }
.report .r:first-child { border-top: 0; }
.report .r dt { color: var(--muted); font-weight: 700; }
.report .r dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pre { white-space: pre-wrap; font-size: .92em; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); padding: 14px; overflow-wrap: anywhere; line-height: 1.55; }

/* ---------- 3D body ---------- */
.body3d { display: flex; flex-direction: column; gap: 10px; }
.body-stage { position: relative; border-radius: var(--r-lg); overflow: hidden; border: 1px solid var(--line);
  background: radial-gradient(120% 70% at 50% 30%, var(--stage-top) 0%, var(--stage-bottom) 100%); }
.body-canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.body-canvas:active { cursor: grabbing; }
.body-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); font-weight: 700; padding: 20px; text-align: center; }
.body-loader { display: flex; gap: 6px; }
.body-loader span { width: 10px; height: 10px; border-radius: 50%; background: var(--teal); animation: bounce 1s infinite ease-in-out; }
.body-loader span:nth-child(2) { animation-delay: .15s; } .body-loader span:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(.5); opacity: .5 } 40% { transform: scale(1); opacity: 1 } }
.stage-chip { position: absolute; font-size: .74em; font-weight: 700; color: var(--ink-2); background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid var(--line);
  border-radius: 999px; padding: 4px 10px; pointer-events: none; backdrop-filter: blur(6px); }
.stage-tl { top: 12px; inset-inline-start: 12px; }
.stage-bottom { bottom: 12px; left: 50%; transform: translateX(-50%); color: var(--teal-ink); }
.side-mark { position: absolute; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: .72em; font-weight: 700;
  color: var(--muted); background: color-mix(in srgb, var(--surface) 80%, transparent); border: 1px solid var(--line); pointer-events: none; }
.stage-tools { position: absolute; top: 10px; inset-inline-end: 10px; display: flex; flex-direction: column; gap: 6px; }
.tool { width: 42px; height: 42px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); color: var(--navy-800); display: grid; place-items: center; cursor: pointer; font-size: 1.1em; box-shadow: var(--shadow-1); }
.view-bar { display: flex; gap: 6px; align-items: center; justify-content: center; }
.view-btn { flex: 1; min-height: 42px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); font-weight: 700; font-size: .85em; cursor: pointer; color: var(--ink-2); }
.view-btn[aria-pressed="true"] { background: var(--navy-800); color: var(--surface); border-color: var(--navy-800); }
.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--surface-3); border-radius: var(--r); padding: 4px; gap: 4px; }
.seg button { border: 0; background: transparent; min-height: 40px; border-radius: 11px; font-weight: 700; cursor: pointer; color: var(--muted); font-size: .88em; }
.seg button[aria-pressed="true"], .seg button[aria-selected="true"] { background: var(--surface); color: var(--navy-900); box-shadow: var(--shadow-1); }
.seg button[disabled] { opacity: .45; cursor: not-allowed; }
.map2d { width: 100%; max-width: 100%; height: auto; display: block; }
.map2d .rg { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.2; cursor: pointer; transition: fill .12s; }
.map2d .rg:hover { fill: var(--teal-50); }
.map2d .rg.on { fill: var(--teal); stroke: var(--teal-strong); }
.map2d .rg.focus { fill: #f59e33; stroke: #b4630a; }
.map2d text { fill: var(--muted); font-size: 10px; font-weight: 700; font-family: var(--font-body); }

/* ---------- messages ---------- */
.bubble-list { display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: 84%; padding: 10px 13px; border-radius: 18px; font-size: .95em; overflow-wrap: anywhere; line-height: 1.4; }
.bubble.me { align-self: flex-end; border-end-end-radius: 6px; background: var(--teal); color: var(--on-accent); }
.bubble.them { align-self: flex-start; background: var(--surface); border: 1px solid var(--line); border-end-start-radius: 6px; }
.bubble .meta { display: block; font-size: .72em; opacity: .78; margin-top: 4px; }
.bubble.question { border: 2px solid var(--teal); }
.composer { display: flex; gap: 8px; align-items: flex-end; }
.composer .input { border-radius: 24px; }
.composer .send { width: var(--tap); height: var(--tap); border-radius: 50%; padding: 0; flex: none; }

/* ---------- provenance ---------- */
.prov { display: inline-flex; align-items: center; gap: 4px; font-size: .7em; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; flex: none; }
.prov svg { font-size: 1.05em; }
.prov-patient { background: var(--ok-soft); color: var(--ok); }
.prov-template { background: var(--navy-100); color: var(--navy-800); }
.prov-ai { background: color-mix(in srgb, #7c5cff 16%, var(--surface)); color: color-mix(in srgb, #6d4fe0 85%, var(--ink)); }
.prov-unknown { background: var(--surface-3); color: var(--muted); border: 1px dashed var(--line-strong); }
.prov-clinician { background: var(--info-soft); color: var(--info); }
.tag.suggested { background: color-mix(in srgb, #7c5cff 14%, var(--surface)); color: color-mix(in srgb, #6d4fe0 85%, var(--ink)); }
.status.urgent-chip { background: var(--danger-soft); color: var(--danger); }
.status.warn-chip { background: var(--warn-soft); color: var(--warn); }
.linkish { background: none; border: 0; padding: 0; color: inherit; font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }
.cie .card.cie-warn { gap: 6px; border-inline-start: 5px solid var(--info); }
.cie .card.cie-warn.danger { border-inline-start-color: var(--danger); background: color-mix(in srgb, var(--danger-soft) 55%, var(--surface)); }
.cie .card.cie-warn.warn { border-inline-start-color: var(--warn); }
.cie-ev { margin: 2px 0 0; padding-inline-start: 18px; display: grid; gap: 2px; font-size: .86em; overflow-wrap: anywhere; }
.cie-refs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; color: var(--muted); }
.cie-refs a, .cie a { color: var(--teal-ink); overflow-wrap: anywhere; }
.cie-item { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.cie-item .row.between, .cie .card .row.between { flex-wrap: wrap; gap: 6px; }
.cie-label { display: grid; gap: 4px; padding: 10px; border-radius: 10px; background: var(--surface-2, var(--surface-3)); overflow-wrap: anywhere; }
.cie-decide { gap: 6px; align-items: center; }
.cie-decide .chip { cursor: pointer; border: 1px solid var(--line-strong); background: var(--surface); min-height: 36px; display: inline-flex; align-items: center; gap: 4px; }
.cie-decide .chip.on.accepted { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.cie-decide .chip.on.rejected { background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
.cie-decide .chip.on.needs_assessment { background: var(--warn-soft); color: var(--warn); border-color: var(--warn); }
.danger-text { color: var(--danger); }
.warn-text { color: color-mix(in srgb, var(--warn) 85%, var(--ink)); }
.rx-card { display: grid; gap: 4px; padding: 12px; border-radius: 14px; border: 2px solid var(--teal, #0d9488); background: var(--surface); color: var(--ink); text-align: start; }
.rx-card .rx-row { display: grid; grid-template-columns: minmax(90px, 34%) 1fr; gap: 8px; font-size: .92em; }
.rx-card .rx-row span:first-child { color: var(--muted); }
.tag.corrected { background: var(--teal-50); color: var(--teal-ink); }

/* ---------- reconstruction ---------- */
.recon-item.suggested { background: color-mix(in srgb, #7c5cff 5%, var(--surface)); }
.recon-item.needs_clarification { background: var(--warn-soft); }
.recon-item.removed { opacity: .65; }
.recon3d { display: flex; flex-direction: column; gap: 10px; }
.recon-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 12px 14px; font-size: .9em; }
.recon-facts > div { min-width: 0; overflow-wrap: anywhere; }
.metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.metric { background: var(--surface-2); border-radius: var(--r-sm); padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.metric b { font-size: 1.3em; color: var(--navy-900); line-height: 1.1; }
.metric span { font-size: .72em; color: var(--muted); font-weight: 700; line-height: 1.25; }
.brief { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; }
.bs { padding: 11px 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.bs:first-child { border-top: 0; }
.bs-h { display: flex; align-items: center; gap: 8px; font-size: .86em; font-weight: 700; color: var(--muted); }
.bs-n { width: 20px; height: 20px; border-radius: 6px; background: var(--surface-3); color: var(--navy-800); display: grid; place-items: center; font-size: .95em; flex: none; }
.bs-l { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; font-size: .94em; }
.bubble-tag { display: block; font-size: .7em; letter-spacing: .04em; margin-bottom: 2px; }

/* ---------- Silent Signal ---------- */
.signal-hero { background: #0d3a4f; }
.signal-board { display: flex; flex-direction: column; gap: 12px; }
.sb-prompt { font-family: var(--font-head); font-size: 1.25em; font-weight: 600; color: var(--navy-900); text-align: center; text-wrap: balance; }
.sb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.sb-grid.small { grid-template-columns: repeat(3, 1fr); }
.sb-grid.small .sb-btn { min-height: 64px; }
.sb-grid.small .sb-sym { font-size: 1.3em; }
.sb-btn { min-height: calc(var(--tap) + 54px); border-radius: var(--r-lg); border: 2px solid var(--line); background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; cursor: pointer; padding: 10px; font-weight: 700; color: var(--ink); transition: border-color .12s, background .12s, transform .08s; text-align: center; }
.sb-btn:active { transform: scale(.98); }
.sb-btn[aria-pressed="true"] { border-color: var(--teal); background: var(--teal-50); }
.sb-btn.yes { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
.sb-btn.lit { border-color: var(--teal); background: var(--teal-50); box-shadow: 0 0 0 4px color-mix(in srgb, var(--teal) 30%, transparent); transform: scale(1.02); }
.sb-sym { font-size: 2.1em; line-height: 1; }
.sb-grid.symbols .sb-sym { font-size: 2.6em; }
.sb-lbl { font-size: 1em; line-height: 1.2; }
.sb-single { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px; border-radius: 20px; background: var(--surface); border: 2px solid var(--teal); text-align: center; font-size: 1.15em; }
.sb-single .sb-sym { font-size: 3em; }
.sb-feedback { min-height: 1.4em; text-align: center; font-weight: 700; color: var(--teal-ink); font-size: .92em; }
.switch-btn { min-height: 110px; border-radius: var(--r-lg); border: 0; background: var(--slate-800); color: var(--surface); font-weight: 700; font-size: 1.15em; cursor: pointer; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; width: 100%; box-shadow: var(--shadow-2); }
.switch-btn.live { background: var(--danger); color: #fff; }
.switch-btn .tiny { opacity: .75; font-weight: 700; }
input[type="range"] { width: 100%; accent-color: var(--teal); min-height: 36px; }

/* Silent Signal camera mode */
.cam { gap: 10px; }
.cam-view { position: relative; border-radius: var(--r); overflow: hidden; background: #0d1b2a; aspect-ratio: 4 / 3; max-height: 300px; width: 100%; }
.cam.compact .cam-view { max-height: 170px; }
.cam-video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
.cam-view[data-live="false"] .cam-video { visibility: hidden; }
.cam-overlay { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); pointer-events: none; }
.cam-view[data-live="false"] .cam-overlay { visibility: hidden; }
.cam-off { position: absolute; inset: 0; display: grid; place-items: center; color: #7f93a8; font-size: 40px; }
.cam-badge { position: absolute; top: 8px; inset-inline-start: 8px; background: rgba(13,27,42,.78); color: #fff; font-size: .75em; font-weight: 700; padding: 4px 9px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px; }
.cam-badge.on { background: rgba(190,30,45,.92); }
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; display: inline-block; animation: recpulse 1.4s infinite; }
@keyframes recpulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .rec-dot { animation: none; } }
.cam-face { position: absolute; top: 8px; inset-inline-end: 8px; font-size: .75em; font-weight: 700; padding: 4px 9px; border-radius: 999px; display: inline-flex; align-items: center; gap: 5px; }
.cam-face.ok { background: rgba(16,120,80,.9); color: #fff; }
.cam-face.lost { background: rgba(180,110,0,.92); color: #fff; }
.cam-flash { position: absolute; left: 8px; right: 8px; bottom: 8px; padding: 8px 12px; border-radius: 12px; font-weight: 700; font-size: .9em; text-align: center; }
.cam-flash.ok { background: rgba(16,120,80,.94); color: #fff; }
.cam-flash.warn { background: rgba(180,110,0,.95); color: #fff; }
.cam-flash.info { background: rgba(13,27,42,.88); color: #fff; }
.cam-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.cam-controls .btn { flex: 1; min-width: 120px; }
.cam-privacy { display: flex; gap: 6px; align-items: flex-start; margin: 0; }
.cam-privacy svg { flex: none; margin-top: 2px; }
.cam-hint { display: flex; gap: 6px; align-items: center; color: var(--muted); }
.meter { display: grid; gap: 4px; }
.meter-label { font-size: .78em; font-weight: 700; color: var(--muted); }
.meter-track { position: relative; height: 12px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.meter-fill { position: absolute; inset: 0 auto 0 0; background: var(--teal); border-radius: 999px; transition: width .12s linear; }
.meter-mark { position: absolute; top: -2px; bottom: -2px; width: 3px; background: var(--navy-900); }
.qcard { gap: 6px; position: relative; padding-inline-end: 52px; }
.qcard .iconbtn { position: absolute; top: 10px; inset-inline-end: 10px; }
.qtext { font-size: 1.25em; line-height: 1.35; }
.opt-list { display: grid; gap: 10px; }
.opt-list.yesno { grid-template-columns: repeat(3, 1fr); }
.opt-list.yesno .opt { flex-direction: column; justify-content: center; min-height: calc(var(--tap) + 30px); font-size: 1.1em; gap: 4px; }
.opt.lit { border-color: var(--teal); background: var(--teal-50); box-shadow: inset 0 0 0 2px var(--teal); color: var(--teal-ink); }
.interp { align-items: center; text-align: center; gap: 8px; border: 2px solid var(--teal); }
.interp-val { font-size: 1.5em; }
.scan-chip { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-size: 1.4em; border: 2px solid var(--line); }
.scan-chip.lit { border-color: var(--teal); background: var(--teal-50); }
.map-row select { min-height: 44px; border-radius: 10px; border: 1.5px solid var(--line); padding: 0 10px; background: var(--surface); color: var(--ink); font: inherit; max-width: 60%; }

/* Blind Access & Voice Companion */
.blind-entry { display: flex; gap: 12px; align-items: center; width: calc(100% - 32px); max-width: var(--col); margin: 12px auto 0; padding: 14px 16px; border-radius: var(--r-lg); border: 2px solid var(--saffron); background: var(--saffron); color: var(--on-saffron); text-align: start; cursor: pointer; font: inherit; min-height: 64px; }
.blind-entry svg { font-size: 1.8em; flex: none; }
.blind-entry > span { display: grid; gap: 2px; }
.blind-entry:focus-visible { outline: 4px solid var(--focus, #f5a524); outline-offset: 3px; }
.va { touch-action: pan-y; }
.va-status { display: flex; gap: 8px; align-items: center; padding: 12px 14px; border-radius: var(--r); background: var(--surface-3); font-size: 1.05em; flex-wrap: wrap; }
.va-status.listening { background: #B42318; color: #fff; }
.va-status.speaking { background: var(--teal-50); color: var(--teal-ink); }
.va-status.thinking { background: var(--info-soft); }
.va-controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.va-controls .btn:not(.big) { min-height: 48px; padding: 0 8px; font-size: .92em; white-space: nowrap; }
.va-controls .btn.big { grid-column: 1 / -1; min-height: 72px; font-size: 1.2em; }
.va-options { display: grid; gap: 10px; }
.va-methods { display: grid; gap: 8px; }
.va-sum { white-space: pre-wrap; font-family: inherit; font-size: .9em; line-height: 1.55; margin: 6px 0 0; background: var(--surface-2); border-radius: var(--r); padding: 10px 12px; max-height: 340px; overflow: auto; }
.ok-text { color: var(--ok); font-weight: 700; }
.warn-text { color: var(--warn); font-weight: 700; }
.va-talk .va-controls { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
.va-opt { min-height: 60px; border-radius: var(--r); border: 2px solid var(--line-strong); background: var(--surface); color: var(--ink); font: inherit; font-size: 1.12em; font-weight: 700; text-align: start; padding: 10px 16px; cursor: pointer; }
.va-opt:focus-visible, .va [data-va-item]:focus-visible { outline: 4px solid var(--focus, #f5a524); outline-offset: 2px; }
.va-type .row { gap: 8px; }
.va-type .input { min-height: 52px; border-radius: var(--r); border: 1.5px solid var(--line-strong); padding: 0 12px; font: inherit; background: var(--surface); color: var(--ink); }
.va-log { display: grid; gap: 6px; max-height: min(46vh, 380px); overflow: auto; overscroll-behavior: contain; padding: 2px; }
.va-log:empty { display: none; }
.va-line { padding: 9px 12px; border-radius: 14px; font-size: .97em; line-height: 1.5; max-width: 92%; overflow-wrap: anywhere; }
.va-line.assistant { background: var(--surface-3); justify-self: start; }
.va-line.patient { background: var(--teal-50); justify-self: end; max-width: 85%; }

.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- care: shared ---------- */
h3.title { font-size: 1.12em; line-height: 1.3; margin: 0 0 6px; color: var(--ink); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2.title svg, h3.title svg { flex: none; }
.linkbtn { border: 0; background: transparent; color: var(--teal-ink); font: inherit; font-weight: 700; cursor: pointer; padding: 4px 2px; min-height: 36px; display: inline-flex; align-items: center; gap: 4px; text-decoration: underline; text-underline-offset: 2px; }
.linkbtn.small { font-size: .88em; }
.big-num { font-size: 1.6em; font-family: var(--font-head); color: var(--teal-ink); }
.guide-list { margin: 0; padding-inline-start: 1.2em; display: grid; gap: 4px; }
.iconbtn.sm { min-width: 36px; min-height: 36px; }
.iconbtn.ok { color: var(--ok); } .iconbtn.warn { color: var(--warn); }
.iconbtn:disabled { opacity: .45; cursor: not-allowed; }
.status.ok-chip { background: var(--ok-soft); color: var(--ok); }
.status.due-chip { background: var(--saffron-soft); color: var(--on-saffron); }
.li-ico.danger { background: var(--danger-soft); color: var(--danger); } .li-ico.warn { background: var(--warn-soft); color: var(--warn); }
.alert-card { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger-soft) 55%, var(--surface)); }
.ref-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; vertical-align: middle; }
.ref { display: inline-block; font-size: .74em; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: var(--surface-3); color: var(--ink-2); direction: ltr; }

/* hub */
.care-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@media (min-width: 720px) { .care-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.care-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: start; padding: 14px; min-height: 132px; border-radius: var(--r-lg); border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; box-shadow: var(--shadow-1); font: inherit; }
.care-tile:hover { border-color: var(--line-strong); }
.care-tile b { font-size: 1em; line-height: 1.25; }
.care-tile .small { line-height: 1.35; }
.care-ico { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; font-size: 1.3em; flex: none; background: var(--teal-50); color: var(--teal-ink); }
.care-ico.sm { width: 36px; height: 36px; font-size: 1.1em; }
.tone-teal .care-ico, .care-ico.tone-teal { background: var(--teal-50); color: var(--teal-ink); }
.tone-saffron .care-ico { background: var(--saffron-soft); color: var(--on-saffron); }
.tone-blue .care-ico { background: var(--info-soft); color: var(--info); }
.tone-red .care-ico { background: var(--danger-soft); color: var(--danger); }
.tone-violet .care-ico { background: color-mix(in srgb, #7c5cff 14%, var(--surface)); color: color-mix(in srgb, #5b3fd6 85%, var(--ink)); }
.tone-green .care-ico, .care-ico.tone-green { background: var(--ok-soft); color: var(--ok); }

/* medicines */
.next-dose .title { display: flex; align-items: center; gap: 8px; font-size: 1.15em; }
.next-dose-line { margin: 4px 0; font-size: 1.15em; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dose-time { font-family: var(--font-head); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 52px; direction: ltr; display: inline-block; }
.dose-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r); background: var(--surface-2); border: 1px solid var(--line); }
.dose-row.st-due { border-color: var(--saffron); background: color-mix(in srgb, var(--saffron-soft) 60%, var(--surface)); }
.dose-row.st-taken { opacity: .85; }
.dose-acts { display: flex; gap: 2px; flex: none; }
.adh-bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; align-items: end; height: 92px; margin-top: 6px; }
.adh-day { display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
.adh-col { flex: 1; width: 100%; max-width: 30px; background: var(--surface-3); border-radius: 6px; display: flex; align-items: flex-end; overflow: hidden; }
.adh-col span { display: block; width: 100%; background: var(--teal); border-radius: 6px 6px 0 0; }
.adh-col span.part { background: var(--warn); }
.med-card.ended { opacity: .7; }
.med-reminder { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--saffron-soft); color: var(--on-saffron); border-bottom: 1px solid var(--saffron); font-size: .95em; }
.med-reminder svg { flex: none; font-size: 1.2em; }
.med-reminder .linkbtn { color: inherit; text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.med-reminder .chip { cursor: pointer; min-height: 36px; background: var(--surface); }

/* camera capture */
.cam-capture { display: grid; gap: 10px; }
.cam-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cam-btns .span2 { grid-column: 1 / -1; }
.cam-frame { position: relative; border-radius: var(--r-lg); overflow: hidden; background: var(--surface-3); aspect-ratio: 4 / 3; display: grid; place-items: center; border: 1px dashed var(--line-strong); }
.cam-frame.live { border-style: solid; background: #000; }
.cam-frame video { width: 100%; height: 100%; object-fit: cover; }
.cam-placeholder { display: grid; justify-items: center; gap: 6px; padding: 16px; text-align: center; color: var(--muted); }
.cam-placeholder svg { font-size: 2em; }
.capture-hint { position: absolute; inset-inline: 8px; bottom: 8px; margin: 0; padding: 6px 10px; border-radius: 8px; background: rgba(0,0,0,.65); color: #fff; font-size: .9em; text-align: center; }
.box-verdict.v-match { border-color: var(--ok); }
.box-verdict.v-match .title { color: var(--ok); }
.box-verdict.v-not_prescribed, .box-verdict.v-warn { border-color: var(--danger); }
.box-verdict.v-not_prescribed .title, .box-verdict.v-warn .title { color: var(--danger); }
.box-verdict p:first-of-type { font-size: 1.12em; }

/* photos */
.ph-preview { width: 100%; max-height: 360px; object-fit: contain; border-radius: var(--r); background: var(--surface-3); }
.photo-strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; scroll-snap-type: x proximity; }
.photo-thumb { position: relative; margin: 0; flex: none; width: 128px; scroll-snap-align: start; }
.photo-thumb img { width: 128px; height: 128px; object-fit: cover; border-radius: var(--r); display: block; background: var(--surface-3); }
.photo-thumb figcaption { margin-top: 4px; line-height: 1.3; }
.photo-thumb .iconbtn { position: absolute; top: 4px; inset-inline-end: 4px; background: rgba(255,255,255,.9); }
.photo-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
.photo-compare figure { margin: 0; }
.photo-compare img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--r); background: var(--surface-3); }

/* emergency card */
.em-card { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
.em-card .title { color: var(--danger); }
.em-list { display: grid; grid-template-columns: minmax(96px, 34%) 1fr; gap: 6px 12px; margin: 0; }
.em-list dt { font-weight: 700; color: var(--muted); font-size: .9em; }
.em-list dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.em-list a { color: var(--teal-ink); font-weight: 700; display: inline-flex; align-items: center; gap: 4px; }
.qr { width: min(300px, 80vw); height: auto; display: block; margin: 8px auto; border-radius: 8px; border: 1px solid var(--line); }
.qr.big { width: min(360px, 86vw); }
.em-full { position: fixed; inset: 0; z-index: 200; background: #fff; color: #000; overflow: auto; padding: 56px 20px 24px; display: grid; justify-items: center; align-content: start; gap: 12px; }
.em-full h2 { margin: 0; color: #b00020; font-size: 1.6em; letter-spacing: .02em; }
.em-full pre { white-space: pre-wrap; font: 600 1.12em/1.5 var(--font-body); margin: 0; max-width: 560px; width: 100%; }
.em-close { position: absolute; top: 8px; inset-inline-end: 8px; background: #eee; color: #000; }

/* interpreter */
.interp-sides { display: grid; grid-template-columns: 1fr; gap: 10px; }
@media (min-width: 640px) { .interp-sides { grid-template-columns: 1fr 1fr; } }
.interp-side { display: grid; gap: 8px; padding: 12px; border-radius: var(--r-lg); border: 1px solid var(--line); background: var(--surface); }
.interp-side.side-patient { border-color: color-mix(in srgb, var(--teal) 45%, var(--line)); }
.interp-side.side-doctor { border-color: color-mix(in srgb, var(--navy-700) 35%, var(--line)); }
.interp-side form { gap: 6px; }
.interp-log { display: grid; gap: 10px; }
.interp-line { padding: 10px 12px; border-radius: var(--r-lg); background: var(--surface-2); border: 1px solid var(--line); }
.interp-line.from-patient { border-inline-start: 4px solid var(--teal); }
.interp-line.from-doctor { border-inline-start: 4px solid var(--navy-700); }
.interp-tr { font-size: 1.35em; line-height: 1.4; margin: 4px 0; font-weight: 600; overflow-wrap: anywhere; }

/* caregiver */
.cg-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.6em; font-weight: 700; letter-spacing: .06em; margin: 4px 0; direction: ltr; text-align: start; }
.brief-sec.sec-urgent { border-color: var(--danger); }
.brief-sec ul, .alert-card ul { margin: 0; padding-inline-start: 1.2em; display: grid; gap: 6px; }
`;
