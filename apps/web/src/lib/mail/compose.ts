import { type MailAddress, type MailMessage } from '@crewhall/shared';

/** Pure helpers of the mail UI: replies, quoting, recipients and the sandboxed body document. */

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface Recipient {
  name: string | null;
  address: string;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export const isEmail = (v: string) => EMAIL.test(v.trim());

/** "Ada Yılmaz <ada@x.com>", "<ada@x.com>" or "ada@x.com"; null when it is not an address. */
export function parseRecipient(raw: string): Recipient | null {
  const text = raw.trim().replace(/[,;]+$/, '');
  const angle = /^(.*)<([^<>]+)>$/.exec(text);
  if (angle) {
    const address = angle[2]!.trim();
    if (!isEmail(address)) return null;
    const name = angle[1]!.trim().replace(/^"|"$/g, '');
    return { name: name || null, address };
  }
  return isEmail(text) ? { name: null, address: text } : null;
}

export const sameAddress = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function unique(list: MailAddress[], exclude: string[]): Recipient[] {
  const seen = new Set(exclude.map((x) => x.toLowerCase()));
  const out: Recipient[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (!a.address || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, address: a.address });
  }
  return out;
}

/** "Re:" / "Fwd:" once, however many times the conversation went back and forth. */
export function prefixed(subject: string, prefix: string): string {
  const bare = subject.replace(/^\s*((re|fwd?|ynt|[iİ]lt|aw|wg|tr)\s*:\s*)+/i, '');
  return `${prefix} ${bare}`.trim();
}

export interface ComposeDraft {
  to: Recipient[];
  cc: Recipient[];
  subject: string;
}

/** Recipients and subject of a reply, reply-all or forward of `m` written from `me`. */
export function draftFor(
  mode: ComposeMode,
  m: MailMessage | null,
  me: string,
  prefixes: { reply: string; forward: string },
): ComposeDraft {
  if (!m || mode === 'new') return { to: [], cc: [], subject: '' };
  if (mode === 'forward') return { to: [], cc: [], subject: prefixed(m.subject, prefixes.forward) };
  const fromMe = m.from ? sameAddress(m.from.address, me) : false;
  // Replying to one's own sent message goes to its recipients again.
  const primary = fromMe ? m.to : m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  const to = unique(primary, [me]);
  const cc =
    mode === 'replyAll'
      ? unique([...(fromMe ? [] : m.to), ...m.cc], [me, ...to.map((r) => r.address)])
      : [];
  return { to, cc, subject: prefixed(m.subject, prefixes.reply) };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text as HTML with clickable links (escaped first). */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, '<br>');
}

/** The original message under a reply or forward (its HTML was sanitized by the server). */
export function quoteBlock(m: MailMessage, header: string): string {
  const body = m.html ?? textToHtml(m.text ?? '');
  return (
    `<p>${escapeHtml(header)}</p>` +
    `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body}</blockquote>`
  );
}

/**
 * The document of the message iframe. The iframe is sandboxed without scripts; this CSP is the
 * second wall after the server's sanitizer: no scripts, no frames, images only from data: (and
 * the web when the reader allowed remote images), styles inline only.
 */
export function bodyDocument(
  m: Pick<MailMessage, 'html' | 'text'>,
  opts: { remoteImages: boolean; dark: boolean },
): string {
  const img = opts.remoteImages ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
  const body = m.html ?? `<div style="white-space:normal">${textToHtml(m.text ?? '')}</div>`;
  // Mail is designed for a white page; only plain text follows the app's dark theme.
  const plainDark = opts.dark && !m.html;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    '<style>',
    `html,body{margin:0;padding:0;background:${plainDark ? '#1c1d1f' : '#fff'};color:${plainDark ? '#e8e8e8' : '#141516'}}`,
    'body{font:14px/1.55 Nunito,system-ui,sans-serif;padding:4px 2px;overflow-wrap:anywhere}',
    'img{max-width:100%;height:auto}img[data-blocked]{display:none}',
    'blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex}',
    `a{color:${plainDark ? '#fbc419' : '#0b57d0'}}pre{white-space:pre-wrap}`,
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('');
}

/** Reads a local file as base64 (without the data: prefix) for an upload attachment. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Folder path → message route search (`/mail?folder=…&uid=…`). */
export interface MailSearch {
  folder?: string;
  uid?: number;
  q?: string;
  filter?: 'unread' | 'flagged';
}
