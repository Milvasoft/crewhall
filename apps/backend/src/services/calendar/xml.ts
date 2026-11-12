/**
 * A small namespace-aware XML reader for WebDAV request bodies (PROPFIND, REPORT, PROPPATCH).
 * DAV bodies are tiny and well-formed in practice; this keeps a dependency out. No DTDs,
 * no entity definitions (only the five predefined entities and character references), so
 * there is nothing to expand maliciously.
 */

export interface XmlElement {
  /** Namespace URI ('' when none). */
  ns: string;
  /** Local name. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const MAX_BYTES = 1_000_000;
const MAX_DEPTH = 64;

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Frame {
  el: XmlElement;
  scope: Map<string, string>;
  qname: string;
}

/** Parses a document; returns the root element or null when the text is not usable XML. */
export function parseXml(text: string, maxBytes = MAX_BYTES): XmlElement | null {
  if (!text || text.length > maxBytes) return null;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  const baseScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textPart = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (textPart && stack.length) stack[stack.length - 1]!.el.text += decode(textPart);
    if (lt < 0) break;
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) return null;
      if (stack.length) stack[stack.length - 1]!.el.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) return null; // DOCTYPE and friends are refused.
    const gt = findTagEnd(src, lt);
    if (gt < 0) return null;
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const qname = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) return null;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (!m) return null;
    const qname = m[1]!;
    const attrsRaw: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2]!))) attrsRaw[am[1]!] = decode(am[3] ?? am[4] ?? '');
    const parentScope = stack.length ? stack[stack.length - 1]!.scope : baseScope;
    const scope = new Map(parentScope);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrsRaw)) {
      if (k === 'xmlns') scope.set('', v);
      else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v);
      else attrs[k] = v;
    }
    const colon = qname.indexOf(':');
    const prefix = colon >= 0 ? qname.slice(0, colon) : '';
    const name = colon >= 0 ? qname.slice(colon + 1) : qname;
    const el: XmlElement = { ns: scope.get(prefix) ?? '', name, attrs, children: [], text: '' };
    if (stack.length) stack[stack.length - 1]!.el.children.push(el);
    else if (root) return null;
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) return null;
      stack.push({ el, scope, qname });
    }
  }
  if (stack.length) return null;
  return root;
}

function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let j = from + 1; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return j;
  }
  return -1;
}

export const child = (el: XmlElement | null | undefined, ns: string, name: string) =>
  el?.children.find((c) => c.ns === ns && c.name === name) ?? null;

export const childrenOf = (el: XmlElement | null | undefined, ns: string, name: string) =>
  el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
