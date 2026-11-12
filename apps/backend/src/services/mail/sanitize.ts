import sanitize from 'sanitize-html';

/**
 * HTML mail is hostile input. The server keeps an allow list of layout tags and attributes
 * (no script, style sheets with remote URLs, forms, frames, objects, event handlers or
 * javascript: links), embeds `cid:` images as data URIs and removes remote images unless
 * the reader asked for them. Clients render the result in a sandboxed iframe without scripts
 * and with a CSP, so this is the first of two walls.
 */

const TAGS = [
  'a',
  'abbr',
  'address',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'style',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
];

const COMMON_ATTRS = [
  'style',
  'class',
  'dir',
  'lang',
  'title',
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'color',
  'border',
];

const ATTRS: Record<string, string[]> = {
  '*': COMMON_ATTRS,
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'data-blocked'],
  font: ['face', 'size', 'color'],
  table: ['cellpadding', 'cellspacing', 'summary'],
  td: ['colspan', 'rowspan', 'nowrap', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'nowrap', 'headers', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  time: ['datetime'],
};

/** Remote `url(...)` in CSS (images, fonts); `data:` URLs stay. */
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
/** CSS that loads other sheets or runs old IE expressions. */
const CSS_DANGEROUS = /@import[^;]*;?|expression\s*\(|behavior\s*:|-moz-binding/gi;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;

export interface SanitizeOptions {
  /** Keep http(s) images; otherwise they are removed and counted. */
  remoteImages: boolean;
  /** `cid` (without <>) → data URI of the inline part. */
  inlineImages?: Map<string, string>;
}

export interface SanitizedHtml {
  html: string;
  blockedImages: number;
}

export function sanitizeHtml(input: string, opts: SanitizeOptions): SanitizedHtml {
  let blocked = 0;
  const cleanCss = (css: string) => {
    let out = css.replace(CSS_DANGEROUS, '');
    if (!opts.remoteImages) {
      out = out.replace(CSS_REMOTE_URL, () => {
        blocked += 1;
        return 'none';
      });
    }
    return out;
  };

  const html = sanitize(input, {
    allowedTags: TAGS,
    allowedAttributes: ATTRS,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    // <style> is kept for newsletter layouts; its text goes through cleanCss afterwards.
    allowVulnerableTags: true,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object'],
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attribs) => {
        if (attribs.style) attribs.style = cleanCss(attribs.style);
        return { tagName, attribs };
      },
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const next: Record<string, string> = { ...attribs };
        if (attribs.style) next.style = cleanCss(attribs.style);
        if (/^cid:/i.test(src)) {
          const data = opts.inlineImages?.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase());
          if (data) next.src = data;
          else delete next.src;
        } else if (/^data:/i.test(src)) {
          if (!DATA_IMAGE.test(src)) delete next.src;
        } else if (/^https?:\/\//i.test(src)) {
          if (!opts.remoteImages) {
            blocked += 1;
            delete next.src;
            next['data-blocked'] = '1';
          }
        } else {
          delete next.src;
        }
        return { tagName, attribs: next };
      },
    },
  });
  // sanitize-html passes <style> text through untouched (textFilter skips it); the output is
  // already well formed, so the sheets can be found and cleaned here.
  const out = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open: string, css: string, close: string) => `${open}${cleanCss(css)}${close}`,
  );
  return { html: out, blockedImages: blocked };
}

/** Plain text alternative of an outgoing HTML body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML-escapes text (quoted plain-text messages in replies). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
