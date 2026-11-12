/**
 * Watches for sign-ins so the extension can offer to save them. It only reads a password field
 * at the moment a person sends a form; nothing is kept here and the prompt lives in an extension
 * frame the page cannot read.
 */

interface Found {
  username: string;
  password: string;
}

const isVisible = (el: HTMLInputElement) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

function credentials(scope: ParentNode): Found | null {
  const inputs = [...scope.querySelectorAll('input')].filter(isVisible);
  const filled = inputs.filter((i) => i.type === 'password' && i.value.length >= 4);
  if (!filled.length) return null;
  // A sign-up repeats the password; a change form starts with the old one: the last one counts.
  const password = filled[filled.length - 1]!;
  const first = filled[0]!;
  const textual = inputs.filter(
    (i) =>
      ['text', 'email', 'tel'].includes(i.type) &&
      i.value &&
      i.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const named = textual.find(
    (i) =>
      i.autocomplete.includes('username') ||
      i.type === 'email' ||
      /user|mail|login|account|kullan|eposta/i.test(`${i.name} ${i.id}`),
  );
  return { username: (named ?? textual[textual.length - 1])?.value ?? '', password: password.value };
}

const MIN_REPORT_GAP_MS = 2000;
let lastReport = 0;

function report(scope: ParentNode) {
  // Only a person's own action: a script cannot try passwords and watch whether we ask to save.
  if (!navigator.userActivation.isActive) return;
  if (Date.now() - lastReport < MIN_REPORT_GAP_MS) return;
  const found = credentials(scope);
  if (!found) return;
  lastReport = Date.now();
  void chrome.runtime
    .sendMessage({ t: 'capture.submitted', p: found })
    .then(() => setTimeout(check, 1500))
    .catch(() => undefined);
}

document.addEventListener(
  'submit',
  (e) => {
    if (e.target instanceof HTMLFormElement) report(e.target);
  },
  true,
);

document.addEventListener(
  'click',
  (e) => {
    const button = (e.target as Element | null)?.closest?.(
      'button, input[type="submit"], [role="button"]',
    );
    if (button) report(button.closest('form') ?? document);
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.type === 'password') report(e.target.form ?? document);
  },
  true,
);

const FRAME_ID = 'crewhall-save-prompt';

function mount() {
  if (document.getElementById(FRAME_ID)) return;
  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.src = chrome.runtime.getURL('prompt.html');
  frame.title = 'Crewhall';
  frame.setAttribute('allow', '');
  frame.style.cssText =
    'all:initial;position:fixed;top:16px;right:16px;width:360px;height:188px;border:0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:2147483647;color-scheme:normal;';
  (document.body ?? document.documentElement).append(frame);
}

function check() {
  if (window.top !== window) return;
  // The password box is still there and filled: the sign-in has not gone through.
  if (credentials(document)) return;
  void chrome.runtime
    .sendMessage({ t: 'capture.check', p: {} })
    .then((reply: { ok?: boolean; value?: { show?: boolean } } | undefined) => {
      if (reply?.ok && reply.value?.show) mount();
    })
    .catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: { t?: string }) => {
  if (message.t === 'capture.close') document.getElementById(FRAME_ID)?.remove();
});

check();
