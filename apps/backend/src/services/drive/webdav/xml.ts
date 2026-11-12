/**
 * The little XML WebDAV needs (RFC 4918 §14): request bodies of PROPFIND, PROPPATCH and LOCK
 * are small, so a namespace-aware parser of our own is enough. It never reads a DTD or
 * expands entities beyond the five predefined ones and character references.
 */

export const DAV_NS = 'DAV:';

export interface XmlElement {
  ns: string;
  name: string;
  children: XmlElement[];
  text: string;
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;
const MAX_BODY = 256 * 1024;
const MAX_DEPTH = 32;

export class XmlError extends Error {}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Parses a document into its root element; throws XmlError on anything malformed. */
export function parseXml(input: string): XmlElement {
  if (input.length > MAX_BODY) throw new XmlError('body too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new XmlError('DTDs are not accepted');
  let i = 0;
  const stack: { el: XmlElement; scope: Map<string, string>; qname: string }[] = [];
  let root: XmlElement | null = null;

  const skipMisc = () => {
    for (;;) {
      if (input.startsWith('<?', i)) {
        const end = input.indexOf('?>', i);
        if (end < 0) throw new XmlError('unterminated declaration');
        i = end + 2;
      } else if (input.startsWith('<!--', i)) {
        const end = input.indexOf('-->', i);
        if (end < 0) throw new XmlError('unterminated comment');
        i = end + 3;
      } else return;
    }
  };

  while (i < input.length) {
    skipMisc();
    if (i >= input.length) break;
    const lt = input.indexOf('<', i);
    const text = lt < 0 ? input.slice(i) : input.slice(i, lt);
    const top = stack.at(-1);
    if (text) {
      if (top) top.el.text += decodeEntities(text);
      else if (text.trim()) throw new XmlError('text outside the root');
    }
    if (lt < 0) break;
    i = lt;
    if (input.startsWith('<?', i) || input.startsWith('<!--', i)) continue;
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i);
      if (end < 0 || !top) throw new XmlError('bad CDATA');
      top.el.text += input.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (input.startsWith('</', i)) {
      const end = input.indexOf('>', i);
      if (end < 0) throw new XmlError('unterminated end tag');
      const qname = input.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname) throw new XmlError('mismatched end tag');
      i = end + 1;
      continue;
    }
    // Start tag
    i++;
    const m = NAME.exec(input.slice(i, i + 256));
    if (!m) throw new XmlError('bad element name');
    const qname = m[0];
    i += qname.length;
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(input[i] ?? '')) i++;
      if (input.startsWith('/>', i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (input[i] === '>') {
        i++;
        break;
      }
      const an = NAME.exec(input.slice(i, i + 256));
      if (!an) throw new XmlError('bad attribute');
      i += an[0].length;
      while (/\s/.test(input[i] ?? '')) i++;
      if (input[i] !== '=') throw new XmlError('attribute without value');
      i++;
      while (/\s/.test(input[i] ?? '')) i++;
      const quote = input[i];
      if (quote !== '"' && quote !== "'") throw new XmlError('unquoted attribute');
      const end = input.indexOf(quote, i + 1);
      if (end < 0) throw new XmlError('unterminated attribute');
      attrs.set(an[0], decodeEntities(input.slice(i + 1, end)));
      i = end + 1;
    }
    const scope = new Map(top?.scope ?? []);
    for (const [k, v] of attrs) {
      if (k === 'xmlns') scope.set('', v);
      else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v);
    }
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const ns = scope.get(prefix);
    if (prefix && ns === undefined) throw new XmlError(`unbound prefix ${prefix}`);
    const el: XmlElement = { ns: ns ?? '', name: local, children: [], text: '' };
    if (top) top.el.children.push(el);
    else if (root) throw new XmlError('two root elements');
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError('too deep');
      stack.push({ el, scope, qname });
    }
  }
  if (stack.length || !root) throw new XmlError('unexpected end');
  return root;
}

export const child = (el: XmlElement | undefined, name: string, ns = DAV_NS) =>
  el?.children.find((c) => c.ns === ns && c.name === name);

export function escapeXml(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // XML 1.0 has no place for control characters.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  );
}

/** Writes an element back out with explicit namespaces (lock owners, unknown properties). */
export function serialize(el: XmlElement): string {
  const tag = el.ns === DAV_NS ? `D:${el.name}` : `x:${el.name}`;
  const xmlns = el.ns === DAV_NS ? '' : ` xmlns:x="${escapeXml(el.ns)}"`;
  const inner = el.children.length ? el.children.map(serialize).join('') : escapeXml(el.text);
  return inner ? `<${tag}${xmlns}>${inner}</${tag}>` : `<${tag}${xmlns}/>`;
}

/** An empty element naming a property, for 404 propstats and propname answers. */
export function propName(ns: string, name: string): string {
  return ns === DAV_NS ? `<D:${name}/>` : `<x:${name} xmlns:x="${escapeXml(ns)}"/>`;
}

export const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  423: 'Locked',
  424: 'Failed Dependency',
};

export const statusLine = (status: number) =>
  `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`;

export interface PropStat {
  status: number;
  /** Serialized property elements. */
  props: string[];
}

export function davResponse(href: string, propstats: PropStat[]): string {
  const blocks = propstats
    .filter((p) => p.props.length > 0)
    .map(
      (p) =>
        `<D:propstat><D:prop>${p.props.join('')}</D:prop><D:status>${statusLine(p.status)}</D:status></D:propstat>`,
    )
    .join('');
  return `<D:response><D:href>${escapeXml(href)}</D:href>${blocks}</D:response>`;
}

export const multistatus = (responses: string[]) =>
  `${XML_HEAD}<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;

export const davError = (condition: string) =>
  `${XML_HEAD}<D:error xmlns:D="DAV:"><D:${condition}/></D:error>`;
