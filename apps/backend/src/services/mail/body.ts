import type { ImapFlow } from 'imapflow';
import type { MailPartInfo } from '@crewhall/db';
import { bodyParts } from './structure';
import { timed } from './timing';

/**
 * Message bodies: only the text parts and the small inline images are downloaded (one
 * BODY.PEEK of several parts), never the attachments. Bodies do not change, so they are kept
 * in memory (least recently used first out, MAX_BYTES in all) and reopening a message, or
 * opening one the client prefetched, needs no IMAP at all.
 */

export interface Body {
  html: string | null;
  text: string | null;
  /** Content-ID (lower case, no <>) → data URI. */
  inline: Map<string, string>;
  /** Cleaned HTML, per remote-image choice (cleaning a long newsletter takes a while). */
  clean?: Partial<Record<'remote' | 'blocked', { html: string; blockedImages: number }>>;
}

const MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { body: Body; bytes: number }>();
let total = 0;

// The HTML counts twice: its cleaned copies are kept beside it.
const sizeOf = (b: Body) =>
  2 * (b.html?.length ?? 0) +
  (b.text?.length ?? 0) +
  [...b.inline.values()].reduce((n, v) => n + v.length, 0);

function remember(key: string, body: Body) {
  const bytes = sizeOf(body);
  if (bytes > MAX_BYTES / 4) return;
  const old = cache.get(key);
  if (old) total -= old.bytes;
  cache.set(key, { body, bytes });
  total += bytes;
  for (const [k, v] of cache) {
    if (total <= MAX_BYTES) break;
    cache.delete(k);
    total -= v.bytes;
  }
}

export const bodyKey = (accountId: string, folder: string, uidValidity: number, uid: number) =>
  `${accountId}\n${folder}\n${uidValidity}\n${uid}`;

export function cachedBody(key: string): Body | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // Most recently used goes to the end of the eviction order.
  cache.delete(key);
  cache.set(key, hit);
  return hit.body;
}

/** What to download for a message, and how to read it back. */
function plan(parts: MailPartInfo[]) {
  const { html, text, inline } = bodyParts(parts);
  const wanted = [html, text, ...inline].filter((p): p is MailPartInfo => p !== null);
  // A single-part message has no part "1" header block (BODY[1.MIME] fails on some servers):
  // its body is BODY[TEXT]. The parts arrive encoded; they are decoded in `bodyOf`.
  const single = parts.length === 1;
  const section = (p: MailPartInfo) => (single ? 'TEXT' : p.part.toUpperCase());
  return { html, text, inline, wanted, section, sections: wanted.map(section) };
}

function bodyOf(p: ReturnType<typeof plan>, got: Map<string, Buffer> | undefined): Body {
  const body: Body = { html: null, text: null, inline: new Map() };
  const bytes = (part: MailPartInfo | null) => {
    if (!part) return null;
    const key = p.section(part);
    const raw = got?.get(key) ?? got?.get(key.toLowerCase());
    return raw ? decodeTransfer(raw, part.encoding) : null;
  };
  const asText = (part: MailPartInfo | null) => {
    const data = bytes(part);
    return data ? decodeCharset(data, part!.charset) : null;
  };
  body.html = asText(p.html);
  body.text = asText(p.text);
  for (const part of p.inline) {
    const data = bytes(part);
    if (data && part.contentId) {
      body.inline.set(part.contentId, `data:${part.type};base64,${data.toString('base64')}`);
    }
  }
  return body;
}

export interface BodyRequest {
  key: string;
  uid: number;
  parts: MailPartInfo[];
}

/**
 * Bodies of several messages in the folder `c` has selected. Cached ones need no IMAP; the
 * others are fetched with one UID FETCH per distinct list of sections (a conversation of plain
 * messages is one command, not one per message).
 */
export async function fetchBodies(
  c: ImapFlow,
  requests: BodyRequest[],
): Promise<Map<number, Body>> {
  const out = new Map<number, Body>();
  const groups = new Map<string, { plan: ReturnType<typeof plan>; reqs: BodyRequest[] }>();
  for (const r of requests) {
    const hit = cachedBody(r.key);
    if (hit) {
      out.set(r.uid, hit);
      continue;
    }
    const p = plan(r.parts);
    if (p.wanted.length === 0) {
      const empty: Body = { html: null, text: null, inline: new Map() };
      remember(r.key, empty);
      out.set(r.uid, empty);
      continue;
    }
    const g = p.sections.join(' ');
    const group = groups.get(g) ?? { plan: p, reqs: [] };
    group.reqs.push(r);
    groups.set(g, group);
  }
  for (const { plan: p, reqs } of groups.values()) {
    const rows = await timed('body', () =>
      c.fetchAll(
        reqs.map((r) => r.uid),
        { uid: true, bodyParts: p.sections },
        { uid: true },
      ),
    );
    for (const r of reqs) {
      // Same sections, but each message keeps its own encodings and charsets.
      const own = plan(r.parts);
      const body = bodyOf(own, rows.find((m) => m.uid === r.uid)?.bodyParts);
      remember(r.key, body);
      out.set(r.uid, body);
    }
  }
  return out;
}

/** Downloads the body of `uid` in the folder `c` has selected. */
export async function fetchBody(
  c: ImapFlow,
  key: string,
  uid: number,
  parts: MailPartInfo[],
): Promise<Body> {
  return (await fetchBodies(c, [{ key, uid, parts }])).get(uid)!;
}

/** BODY[part] comes as sent: undo base64 / quoted-printable here. */
export function decodeTransfer(raw: Buffer, encoding: string | null | undefined): Buffer {
  switch (encoding) {
    case 'base64':
      return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable': {
      const text = raw.toString('latin1').replace(/=\r?\n/g, '');
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const hex = text[i] === '=' ? text.slice(i + 1, i + 3) : '';
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
        } else {
          out.push(text.charCodeAt(i) & 0xff);
        }
      }
      return Buffer.from(out);
    }
    default:
      return raw;
  }
}

/** Text in its declared charset (TextDecoder knows the WHATWG ones: windows-1254, iso-8859-9…). */
export function decodeCharset(data: Buffer, charset: string | null | undefined): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(data);
  } catch {
    return data.toString('utf8');
  }
}

/** Tests: start cold. */
export function clearBodies() {
  cache.clear();
  total = 0;
}
