// Arabic interface: translates the app's own English interface text in place.
//
// Every screen is written once (in English). When Arabic is chosen, this layer
// replaces interface text and accessible names (aria-label, placeholder, title)
// with their Arabic versions from the dictionary, and puts them back when English
// is chosen again. It never touches what people typed or wrote: form values,
// messages, reports and anything inside [data-no-tr] stay exactly as written.
// Text with no dictionary entry stays as it is (never machine-guessed).
import { AR, AR_PATTERNS } from './ar';
import { getLang, onLang } from './lang';

const ATTRS = ['aria-label', 'placeholder', 'title', 'alt', 'aria-description'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);

const extra = new Map<string, string>();
/** Adds translations known in code (e.g. symptom words that already carry an Arabic name). */
export function addTranslations(pairs: [string, string][]) { for (const [en, ar] of pairs) if (en && ar && !AR[en]) extra.set(en, ar); }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
export function toArabic(text: string): string | null {
  const k = norm(text);
  if (!k || !/[A-Za-z]/.test(k)) return null;
  const hit = AR[k] ?? extra.get(k);
  if (hit) return hit;
  // the same text written in capitals ("WHERE IS THE PAIN?") or with a trailing colon
  if (k === k.toUpperCase()) { const sc = k.charAt(0) + k.slice(1).toLowerCase(); const h = AR[sc] ?? extra.get(sc); if (h) return h; }
  const m = k.match(/^(.*?)([:.])$/); if (m) { const h = AR[m[1]] ?? extra.get(m[1]); if (h) return h + m[2]; }
  for (const [re, f] of AR_PATTERNS) { const m = k.match(re); if (m) { const r = f(m); if (r) return r; } }
  return null;
}

// what we changed, so it can be put back (or redone when React changes the text)
const textOrig = new WeakMap<Text, { orig: string; shown: string }>();
const attrOrig = new WeakMap<Element, Map<string, { orig: string; shown: string }>>();


function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName) || e.hasAttribute('data-no-tr') || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function doText(n: Text, ar: boolean) {
  const rec = textOrig.get(n);
  const now = n.nodeValue ?? '';
  const orig = rec && now === rec.shown ? rec.orig : now; // React may have written new text since
  if (!ar) { if (rec && now === rec.shown && rec.orig !== now) n.nodeValue = rec.orig; textOrig.delete(n); return; }
  const t = toArabic(orig);
  if (!t) { textOrig.delete(n); return; }
  const lead = orig.match(/^\s*/)?.[0] ?? '', trail = orig.match(/\s*$/)?.[0] ?? '';
  const shown = lead + t + trail;
  if (now !== shown) n.nodeValue = shown;
  textOrig.set(n, { orig, shown });
}

function doAttrs(el: Element, ar: boolean) {
  let map = attrOrig.get(el);
  for (const a of ATTRS) {
    const now = el.getAttribute(a);
    const rec = map?.get(a);
    if (now === null) { map?.delete(a); continue; }
    const orig = rec && now === rec.shown ? rec.orig : now;
    if (!ar) { if (rec && now === rec.shown && rec.orig !== now) el.setAttribute(a, rec.orig); map?.delete(a); continue; }
    const t = toArabic(orig);
    if (!t) { map?.delete(a); continue; }
    if (now !== t) el.setAttribute(a, t);
    if (!map) { map = new Map(); attrOrig.set(el, map); }
    map.set(a, { orig, shown: t });
  }
}

function walk(root: Node, ar: boolean) {
  if (root.nodeType === Node.TEXT_NODE) { if (!skipped((root as Text).parentElement)) doText(root as Text, ar); return; }
  if (!(root instanceof Element) || skipped(root)) return;
  doAttrs(root, ar);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n instanceof Element && (SKIP_TAGS.has(n.tagName) || n.hasAttribute('data-no-tr') || (n as HTMLElement).isContentEditable) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text, ar); else doAttrs(n as Element, ar);
  }
}

let observer: MutationObserver | null = null;
let busy = false;
/** Starts translating everything under `root` (and keeps up with changes). */
export function startTranslation(root: HTMLElement = document.body) {
  const run = (nodes: Node[]) => {
    if (busy) return; busy = true;
    try { const ar = getLang() === 'ar'; for (const n of nodes) walk(n, ar); } finally { busy = false; }
  };
  observer?.disconnect();
  observer = new MutationObserver((muts) => {
    if (busy) return;
    const nodes: Node[] = [];
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => nodes.push(n));
      else if (m.type === 'characterData') nodes.push(m.target);
      else if (m.type === 'attributes' && m.target instanceof Element) nodes.push(m.target);
    }
    // only the element itself for attribute changes (not its subtree)
    run(nodes);
    observer?.takeRecords();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  run([root]);
  observer.takeRecords();
  onLang(() => { run([root]); observer?.takeRecords(); });
}
