// What is on the current screen, read from the real page (the same elements a
// screen reader sees): the title, the controls with their accessible names, the
// form fields and the readable text. Used by Blind Mode to answer "what can I do
// here", to press a control by name and to help fill in forms. Nothing is
// invented: if it is not on the screen, it is not offered.

export type ItemRole = 'button' | 'link' | 'field' | 'select' | 'checkbox' | 'radio' | 'tab';
export interface Item { el: HTMLElement; name: string; role: ItemRole; value?: string; checked?: boolean; disabled: boolean; secret?: boolean; required?: boolean }

/** The visible screen (not the Blind Mode voice bar, not hidden parts). */
export function screenRoot(): HTMLElement {
  return (document.querySelector('[data-screen-root]') as HTMLElement) ?? (document.querySelector('.device') as HTMLElement) ?? document.body;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function hidden(el: HTMLElement): boolean {
  if (el.closest('[data-blind-ui],[aria-hidden="true"],[hidden],[inert]')) return true;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  const st = getComputedStyle(el);
  return st.visibility === 'hidden' || st.display === 'none';
}

/** The accessible name of a control, as assistive technology computes it (simplified). */
export function accessibleName(el: HTMLElement): string {
  const al = el.getAttribute('aria-label'); if (clean(al)) return clean(al);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = lb.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).join(' ').trim(); if (t) return t; }
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const lab = (el.labels && el.labels[0]) || null;
    if (lab) { const c = lab.cloneNode(true) as HTMLElement; c.querySelectorAll('input,select,textarea').forEach((x) => x.remove()); const t = clean(c.textContent); if (t) return t; }
    if (clean(el.getAttribute('placeholder'))) return clean(el.getAttribute('placeholder'));
  }
  const t = clean(el.innerText || el.textContent);
  if (t) return t.length > 90 ? `${t.slice(0, 87)}…` : t;
  return clean(el.getAttribute('title'));
}

/** The controls on the screen, in reading order. */
export function itemsOf(root: HTMLElement = screenRoot()): Item[] {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch]';
  const out: Item[] = [];
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    if (hidden(el)) return;
    const name = accessibleName(el);
    if (!name) return;
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    let role: ItemRole = 'button';
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'checkbox' || el.getAttribute('role') === 'switch') role = 'checkbox';
      else if (t === 'radio') role = 'radio';
      else if (t === 'button' || t === 'submit' || t === 'reset') role = 'button';
      else role = 'field';
    } else if (el instanceof HTMLTextAreaElement) role = 'field';
    else if (el instanceof HTMLSelectElement) role = 'select';
    else if (el.tagName === 'A' || el.getAttribute('role') === 'link') role = 'link';
    else if (el.getAttribute('role') === 'tab') role = 'tab';
    else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch' || el.getAttribute('aria-pressed') !== null) role = el.getAttribute('aria-pressed') !== null ? 'button' : 'checkbox';
    const it: Item = { el, name, role, disabled };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      it.secret = el instanceof HTMLInputElement && el.type === 'password';
      it.value = el.value; it.required = el.required;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) it.checked = el.checked;
    }
    if (el instanceof HTMLSelectElement) it.value = el.selectedOptions[0]?.textContent?.trim() ?? '';
    if (role === 'checkbox' && !(el instanceof HTMLInputElement)) it.checked = el.getAttribute('aria-checked') === 'true';
    out.push(it);
  });
  return out;
}

export const fieldsOf = (root: HTMLElement = screenRoot()) => itemsOf(root).filter((i) => i.role === 'field' || i.role === 'select' || i.role === 'checkbox' || i.role === 'radio');

/** The screen's title: its main heading. */
export function screenTitle(root: HTMLElement = screenRoot()): string {
  const h = Array.from(root.querySelectorAll<HTMLElement>('h1, [role=heading][aria-level="1"]')).find((x) => !hidden(x));
  if (!h) return clean(document.title);
  const eb = h.querySelector('.eyebrow');
  if (eb) { const c = h.cloneNode(true) as HTMLElement; c.querySelector('.eyebrow')?.remove(); return `${clean(eb.textContent)}: ${clean(c.textContent)}`; }
  return clean(h.innerText);
}

/** Readable text in order: headings and paragraphs (not controls), without duplicates. */
export function readableText(root: HTMLElement = screenRoot(), max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, dt, dd, [role=alert], [role=status], .read').forEach((el) => {
    if (out.length >= max || hidden(el) || el.closest('button, a, label, [data-blind-skip]')) return;
    // the innermost text block only (a list item with a paragraph inside is read once)
    if (el.querySelector('p, li, h2, h3, h4')) return;
    const t = clean(el.innerText);
    if (!t || seen.has(t)) return;
    seen.add(t); out.push(t);
  });
  return out;
}

/** Sets a form field's value the way typing would (so the app sees the change). */
export function setFieldValue(el: HTMLElement, value: string) {
  if (el instanceof HTMLSelectElement) {
    const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase()) ?? Array.from(el.options).find((o) => o.text.toLowerCase().includes(value.trim().toLowerCase()));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(el, opt.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/** A spoken description of one control: "Settings, button", "Email, text field, empty". */
export function describe(it: Item, lang: 'en' | 'ar'): string {
  const ar = lang === 'ar';
  const kind = { button: ar ? 'زرار' : 'button', link: ar ? 'رابط' : 'link', field: ar ? 'خانة' : 'text field', select: ar ? 'قائمة اختيار' : 'menu', checkbox: ar ? 'اختيار' : 'checkbox', radio: ar ? 'اختيار' : 'option', tab: ar ? 'تبويب' : 'tab' }[it.role];
  const parts = [it.name, kind];
  if (it.role === 'field') parts.push(it.secret ? (it.value ? (ar ? 'مكتوب فيها' : 'filled in') : (ar ? 'فاضية' : 'empty')) : it.value ? it.value : (ar ? 'فاضية' : 'empty'));
  if (it.role === 'select' && it.value) parts.push(it.value);
  if (it.role === 'checkbox' || it.role === 'radio') parts.push(it.checked ? (ar ? 'متعلّم عليه' : 'checked') : (ar ? 'مش متعلّم عليه' : 'not checked'));
  if (it.el.getAttribute('aria-current') === 'page' || it.el.getAttribute('aria-selected') === 'true') parts.push(ar ? 'الصفحة الحالية' : 'current');
  if (it.disabled) parts.push(ar ? 'مش متاح دلوقتي' : 'unavailable');
  return parts.join(ar ? '، ' : ', ');
}
