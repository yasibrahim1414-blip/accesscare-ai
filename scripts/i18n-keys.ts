// Every English text the app can show or say, so French, Urdu and Hindi can be checked
// for completeness (tests/i18n.test.ts) and listed for translators:
//   tsx scripts/i18n-keys.ts            → prints a summary
//   tsx scripts/i18n-keys.ts missing fr → prints the texts French does not have yet (JSON)
// Sources: the Arabic interface dictionary (every screen text that is translated),
// text written in code with an Arabic version (tr/L calls, {en, ar} objects), and the
// app's data with English names (symptoms, body areas, side effects, warning reasons).
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

// works as a CommonJS or an ES module (package.json may say "type": "module")
const HERE = typeof __dirname !== 'undefined' ? __dirname : path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const ROOT = path.resolve(HERE, '..');
const SKIP = /src\/(i18n\/(ar|fr|ur|hi|dict)\.ts|vendor\/|services\/langWords\.ts)/;

export interface Key { en: string; ar?: string; file: string; template?: boolean; jsx?: boolean }

function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(f.name) && !SKIP.test(p)) out.push(p);
  }
  return out;
}

/** A string literal, or a template literal as "text {0} text {1}" (null when it is neither). */
function textOf(n: ts.Node | undefined, sf: ts.SourceFile): { s: string; template: boolean } | null {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return { s: n.text, template: false };
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text; let i = 0;
    for (const span of n.templateSpans) { s += `{${i++}}` + span.literal.text; }
    return { s, template: true };
  }
  if (ts.isParenthesizedExpression(n)) return textOf(n.expression, sf);
  return null;
}

export function staticKeys(): Key[] {
  const keys: Key[] = [];
  for (const file of files(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = path.relative(ROOT, file);
    const add = (en: ts.Node | undefined, ar: ts.Node | undefined) => {
      const e = textOf(en, sf); if (!e || !/[A-Za-z]{2}/.test(e.s)) return;
      const a = textOf(ar, sf);
      keys.push({ en: e.s, ...(a ? { ar: a.s } : {}), file: rel, ...(e.template ? { template: true } : {}) });
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text; const a = n.arguments;
        if (name === 'tr' || name === 'L') {
          // L(en, ar) / tr(en, ar, lang) / L(lang, en, ar)
          if (textOf(a[0], sf)) add(a[0], a[1]); else if (a.length >= 3) add(a[1], a[2]);
        } else if (name === 'opt' && a.length >= 3) add(a[1], a[2]);
      }
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (k: string) => n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ((ts.isIdentifier(p.name) && p.name.text === k) || (ts.isStringLiteral(p.name) && p.name.text === k)));
        const en = prop('en'), ar = prop('ar');
        if (en && ar && textOf(en.initializer, sf)) add(en.initializer, ar.initializer);
        const he = prop('hintEn'), ha = prop('hintAr');
        if (he && ha) add(he.initializer, ha.initializer);
      }
      // screen text and accessible names written in JSX (translated on screen by the dictionaries)
      if (file.endsWith('.tsx')) {
        let t: string | null = null;
        if (ts.isJsxText(n)) t = n.text.replace(/\s+/g, ' ').trim();
        if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && /^(aria-label|placeholder|title|label|hint|desc|alt|aria-description|on|sub)$/.test(n.name.getText(sf))) t = n.initializer.text;
        if (t && /[a-z]{2}/i.test(t) && !/^[A-Z]{2,}-[A-Z0-9X-]+$|^[a-z]+-[a-z]+-\d+$|^https?:/.test(t)) keys.push({ en: t, file: rel, jsx: true });
      }
      // ['English', 'عربي'] and ['id', 'English', 'عربي'] pairs in tables
      if (ts.isArrayLiteralExpression(n) && (n.elements.length === 2 || n.elements.length === 3)) {
        const el = n.elements.map((e) => textOf(e, sf));
        const [en, ar] = n.elements.length === 2 ? [0, 1] : [1, 2];
        if (el.every(Boolean) && /[\u0600-\u06ff]/.test(el[ar]!.s) && /[A-Za-z]{2}/.test(el[en]!.s)) add(n.elements[en], n.elements[ar]);
      }
      // lang === 'ar' ? 'عربي' : 'English'
      if (ts.isConditionalExpression(n) && /=== 'ar'/.test(n.condition.getText(sf))) add(n.whenFalse, n.whenTrue);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
}

export async function runtimeKeys(): Promise<Key[]> {
  const out: Key[] = [];
  const push = (en: string, ar: string | undefined, file: string) => { if (en && /[A-Za-z]{2}/.test(en)) out.push({ en, ...(ar ? { ar } : {}), file }); };
  const { AR } = await import('../src/i18n/ar');
  for (const [en, ar] of Object.entries(AR)) push(en, ar, 'src/i18n/ar.ts');
  const { codePairs } = await import('../src/i18n/codePairs');
  for (const [en, ar] of codePairs()) push(en, ar, 'src/i18n/codePairs.ts');
  const { BODY_REGIONS, REGION_GROUPS, regionLabelIn, groupLabelIn } = await import('../src/domain/bodyRegions');
  for (const r of BODY_REGIONS) push(r.label, regionLabelIn(r.id, 'ar'), 'src/domain/bodyRegions.ts');
  for (const g of REGION_GROUPS) push(g, groupLabelIn(g, 'ar'), 'src/domain/bodyRegions.ts');
  push('Abdomen', 'البطن', 'src/domain/bodyRegions.ts');
  const lex = await import('../src/services/conversation/lexicon');
  for (const list of [lex.SEVERITY, lex.ONSET, lex.ONSET_TYPE, lex.PATTERN, lex.SIDE, lex.SENSATIONS, ...Object.values(lex.LOCATIONS)]) for (const v of list ?? []) push(v.en, v.ar, 'src/services/conversation/lexicon.ts');
  for (const c of lex.CONCEPTS) push(c.en, c.ar, 'src/services/conversation/lexicon.ts');
  const safety = await import('../src/services/safety');
  for (const c of safety.RED_FLAG_CHECKS) push(c.label, undefined, 'src/services/safety.ts');
  push(safety.SAFETY_LIMIT_NOTE, undefined, 'src/services/safety.ts');
  // warning reasons said back to the patient ("You told me: {reason}")
  for (const r of ['chest pain or pressure', 'difficulty breathing', 'fainting', 'face or speech changes', 'a sudden, very severe headache', 'thoughts of self-harm', 'heavy bleeding',
    'sudden weakness, numbness or vision change', 'new trouble speaking', 'headache with trouble speaking, weakness or numbness', 'headache with fever and a stiff neck',
    'chest pressure or pain was mentioned', 'difficulty breathing was mentioned', 'fainting was mentioned', 'face or speech changes were mentioned', 'a sudden severe headache was mentioned',
    'thoughts of self-harm were mentioned', 'heavy bleeding was mentioned', 'trouble breathing was reported', 'chest pain together with other symptoms', 'new weakness or numbness that started recently']) push(r, undefined, 'src/services/conversation/Consult.ts');
  const st = await import('../src/domain/types');
  for (const v of Object.values(st.STATUS_LABELS)) push(String(v), undefined, 'src/domain/types.ts');
  return out;
}

/** not interface text (prompt words, codes, file names) */
const NOT_TEXT = new Set(['English (plain)', 'en-US', 'cloudflare-worker.mjs']);

/** All keys, unique by English text (the first Arabic version seen is kept as a hint). */
export async function allKeys(): Promise<Key[]> {
  const seen = new Map<string, Key>();
  for (const k of [...await runtimeKeys(), ...staticKeys()]) {
    const en = k.en.replace(/\s+/g, ' ').trim();
    if (!en || NOT_TEXT.has(en)) continue;
    const prev = seen.get(en);
    if (!prev) seen.set(en, { ...k, en });
    else if (!prev.ar && k.ar) prev.ar = k.ar;
  }
  return [...seen.values()];
}

if (process.argv[1] && /i18n-keys\.ts$/.test(process.argv[1])) void (async () => {
  const keys = await allKeys();
  if (process.argv[2] === 'missing') {
    const lang = process.argv[3] as 'fr' | 'ur' | 'hi';
    const { translateTo } = await import('../src/i18n/dict');
    const miss = keys.filter((k) => !translateTo(k.en, lang));
    const limit = Number(process.argv[4] ?? 1e9), from = Number(process.argv[5] ?? 0);
    console.log(JSON.stringify(miss.slice(from, from + limit).map((k) => (k.ar ? [k.en, k.ar] : [k.en])), null, 0).replace(/\],\[/g, '],\n['));
    console.error(`${miss.length} of ${keys.length} missing for ${lang}`);
  } else {
    const byFile = new Map<string, number>();
    for (const k of keys) byFile.set(k.file, (byFile.get(k.file) ?? 0) + 1);
    console.log(keys.length, 'texts;', keys.filter((k) => k.template).length, 'with changing parts');
    console.log([...byFile].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n}\t${f}`).join('\n'));
  }
})();
