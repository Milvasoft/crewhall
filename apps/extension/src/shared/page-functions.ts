/**
 * Functions run inside a web page through chrome.scripting. Chrome copies their source, so each
 * must stand alone: no imports and nothing from this module's scope.
 */

export interface FormProbe {
  url: string;
  hasPassword: boolean;
  hasUsername: boolean;
  hasOtp: boolean;
}

export function probeLoginForm(): FormProbe {
  const visible = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // jsdom has no layout: rect is zero there, so size only counts when something has one.
    const measured = document.documentElement.getBoundingClientRect().width > 0;
    return s.visibility !== 'hidden' && s.display !== 'none' && (!measured || r.width > 0);
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const otp = /otp|totp|2fa|mfa|one.?time|verification.?code/i;
  return {
    url: location.href,
    hasPassword: inputs.some((i) => i.type === 'password'),
    hasUsername: inputs.some(
      (i) =>
        ['text', 'email', 'tel', ''].includes(i.type) &&
        (i.autocomplete.includes('username') ||
          i.type === 'email' ||
          /user|mail|login|account|kullan|eposta|e-posta/i.test(`${i.name} ${i.id} ${i.placeholder}`)),
    ),
    hasOtp: inputs.some(
      (i) => i.autocomplete === 'one-time-code' || otp.test(`${i.name} ${i.id}`),
    ),
  };
}

export interface FillInput {
  /** The frame must still be this origin when the secret arrives. */
  origin: string;
  username?: string;
  password?: string;
  otp?: string;
  /** Generated password: every new-password field, not a login. */
  allPasswords?: boolean;
}

export function fillLoginForm(input: FillInput): boolean {
  if (location.origin !== input.origin) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const put = (el: HTMLInputElement, value: string) => {
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  };
  const visible = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const measured = document.documentElement.getBoundingClientRect().width > 0;
    return s.visibility !== 'hidden' && s.display !== 'none' && (!measured || r.width > 0);
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwords = inputs.filter((i) => i.type === 'password');
  let filled = false;

  if (input.allPasswords && input.password) {
    const fresh = passwords.filter((p) => p.autocomplete !== 'current-password');
    for (const p of fresh.length ? fresh : passwords) {
      put(p, input.password);
      filled = true;
    }
    return filled;
  }

  const password = passwords[0];
  if (password && input.password) {
    put(password, input.password);
    filled = true;
  }
  if (input.username) {
    const scope = password?.form ? [...password.form.querySelectorAll('input')] : inputs;
    const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', ''].includes(i.type);
    const before = password
      ? scope.filter(
          (i) =>
            textual(i) &&
            visible(i) &&
            i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
        )
      : scope.filter((i) => textual(i) && visible(i));
    const named = before.find(
      (i) =>
        i.autocomplete.includes('username') ||
        i.type === 'email' ||
        /user|mail|login|account|kullan|eposta|e-posta/i.test(`${i.name} ${i.id} ${i.placeholder}`),
    );
    const target = named ?? before[before.length - 1];
    if (target) {
      put(target, input.username);
      filled = true;
    }
  }
  if (input.otp) {
    const otp = /otp|totp|2fa|mfa|one.?time|verification.?code/i;
    const field = inputs.find(
      (i) => i.autocomplete === 'one-time-code' || otp.test(`${i.name} ${i.id}`),
    );
    if (field) {
      put(field, input.otp);
      filled = true;
    }
  }
  return filled;
}

export interface PageContent {
  title: string;
  /** The selection when there is one, else the article or main part of the page. */
  html: string;
  selection: boolean;
}

const MAX_PAGE_HTML = 400_000;

export function readPageContent(limit: number = MAX_PAGE_HTML): PageContent {
  const pick = () => {
    const s = getSelection();
    if (s && !s.isCollapsed && s.rangeCount > 0) {
      const box = document.createElement('div');
      for (let i = 0; i < s.rangeCount; i++) box.append(s.getRangeAt(i).cloneContents());
      return { html: box.innerHTML, selection: true };
    }
    const root = document.querySelector('article, main, [role="main"]') ?? document.body;
    return { html: root.innerHTML, selection: false };
  };
  const { html, selection } = pick();
  return { title: document.title, html: html.slice(0, limit), selection };
}
