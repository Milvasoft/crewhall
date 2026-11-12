/**
 * A small allow-list HTML sanitizer for raw HTML in published markdown (`htmlBlock`,
 * `htmlInline`). It never produces an HTML string: the result is a tree that the renderer turns
 * into React elements. Unknown tags (e.g. MDX `<Highlight>`) are dropped but their text is kept;
 * script-like tags are dropped with their content; attributes are filtered per tag.
 */

export type HtmlToken =
  | { type: 'text'; text: string }
  | { type: 'open'; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; tag: string };

export type SafeNode<X = never> =
  | { type: 'text'; text: string }
  | { type: 'element'; tag: AllowedTag; attrs: Record<string, string>; children: SafeNode<X>[] }
  /** A node the caller rendered itself (markdown blocks between HTML tags, images…). */
  | { type: 'external'; value: X };

export const ALLOWED_TAGS = [
  'br',
  'aside',
  'p',
  'div',
  'span',
  'img',
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'mark',
  'small',
  'kbd',
  'sup',
  'sub',
  'code',
  'details',
  'summary',
  // produced by the renderer itself for markdown marks inside inline HTML
  'del',
] as const;
export type AllowedTag = (typeof ALLOWED_TAGS)[number];

const ALLOWED = new Set<string>(ALLOWED_TAGS);
const VOID = new Set([
  'br',
  'img',
  'hr',
  'input',
  'meta',
  'link',
  'source',
  'wbr',
  'col',
  'area',
  'base',
  'embed',
  'param',
  'track',
]);
/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'textarea',
  'title',
  'xmp',
  'select',
  'svg',
  'math',
  'head',
  'frameset',
  'noembed',
  'plaintext',
]);
const ALLOWED_ATTRS: Partial<Record<AllowedTag, string[]>> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  details: ['open'],
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  middot: '·',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  times: '×',
  deg: '°',
  euro: '€',
  check: '✓',
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (m, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (
          !Number.isFinite(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return '�';
        }
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? m;
    },
  );
}

const TAG_RE =
  /<(\/?)([A-Za-z][A-Za-z0-9:._-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Splits HTML into text and tag tokens; comments, doctypes and CDATA are dropped. */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) tokens.push({ type: 'text', text: decodeEntities(text) });
    text = '';
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      flush();
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      flush();
      const end = html.indexOf(']]>', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      flush();
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      // a lone "<" is text
      text += '<';
      i = lt + 1;
      continue;
    }
    flush();
    const tag = (m[2] ?? '').toLowerCase();
    if (m[1]) tokens.push({ type: 'close', tag });
    else {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      const src = m[3] ?? '';
      while ((a = ATTR_RE.exec(src))) {
        const name = (a[1] ?? '').toLowerCase();
        if (!name || name in attrs) continue;
        attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      tokens.push({ type: 'open', tag, attrs, selfClosing: !!m[4] || VOID.has(tag) });
    }
    i = lt + m[0].length;
  }
  flush();
  return tokens;
}

/** Safe link target: http(s), mailto, tel, site-relative and fragment links. */
export function safeHref(href: string): string | null {
  const v = href.trim();
  if (!v) return null;
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data:, vbscript: …
  if (v.startsWith('//')) return `https:${v}`;
  return v;
}

/** Safe image source: http(s) and site-relative paths only. */
export function safeSrc(src: string): string | null {
  const v = src.trim();
  if (!v) return null;
  if (/^https?:/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return null;
  return v;
}

function filterAttrs(
  tag: AllowedTag,
  attrs: Record<string, string>,
): Record<string, string> | null {
  const allowed = ALLOWED_ATTRS[tag] ?? [];
  const out: Record<string, string> = {};
  for (const name of allowed) {
    const value = attrs[name];
    if (value === undefined) continue;
    if (name === 'href') {
      const href = safeHref(value);
      if (href) out.href = href;
    } else if (name === 'src') {
      const src = safeSrc(value);
      if (src) out.src = src;
    } else if (name === 'width' || name === 'height') {
      if (/^\d{1,5}%?$/.test(value.trim())) out[name] = value.trim();
    } else out[name] = value;
  }
  if (tag === 'img' && !out.src) return null;
  return out;
}

/**
 * Builds the safe tree from tokens. Blocks rendered elsewhere can be appended between tokens
 * (`append`), so an opening `<details>` in one HTML block and its closing tag in a later one
 * wrap the markdown in between.
 */
export class SafeTreeBuilder<X = never> {
  private readonly root: SafeNode<X>[] = [];
  private readonly stack: Extract<SafeNode<X>, { type: 'element' }>[] = [];
  private skip: { tag: string; depth: number } | null = null;

  private get children(): SafeNode<X>[] {
    return this.stack.length ? this.stack[this.stack.length - 1]!.children : this.root;
  }

  /** Number of HTML elements still open. */
  get depth(): number {
    return this.stack.length;
  }

  push(token: HtmlToken): void {
    if (this.skip) {
      if (token.type === 'open' && token.tag === this.skip.tag && !token.selfClosing) {
        this.skip.depth++;
      }
      if (token.type === 'close' && token.tag === this.skip.tag && --this.skip.depth === 0) {
        this.skip = null;
      }
      return;
    }
    if (token.type === 'text') {
      if (token.text) this.children.push({ type: 'text', text: token.text });
      return;
    }
    if (token.type === 'open') {
      if (DROP_WITH_CONTENT.has(token.tag)) {
        if (!token.selfClosing) this.skip = { tag: token.tag, depth: 1 };
        return;
      }
      if (!ALLOWED.has(token.tag)) return; // unknown tag: dropped, its content stays
      const tag = token.tag as AllowedTag;
      const attrs = filterAttrs(tag, token.attrs);
      if (attrs === null) return;
      const el: Extract<SafeNode<X>, { type: 'element' }> = {
        type: 'element',
        tag,
        attrs,
        children: [],
      };
      this.children.push(el);
      if (!token.selfClosing && !VOID.has(tag)) this.stack.push(el);
      return;
    }
    // close
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!.tag === token.tag) {
        this.stack.length = i;
        return;
      }
    }
  }

  pushAll(tokens: HtmlToken[]): void {
    for (const t of tokens) this.push(t);
  }

  append(value: X): void {
    if (this.skip) return;
    this.children.push({ type: 'external', value });
  }

  result(): SafeNode<X>[] {
    return this.root;
  }
}

export function sanitizeHtml(html: string): SafeNode[] {
  const b = new SafeTreeBuilder();
  b.pushAll(tokenizeHtml(html));
  return b.result();
}
