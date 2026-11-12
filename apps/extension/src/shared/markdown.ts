/**
 * Page HTML to Markdown for clipping. Only structure and text survive: scripts, styles and
 * attributes never reach the page body, and links keep http(s) addresses only.
 */

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'nav',
  'aside',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'template',
]);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'figure', 'figcaption', 'table', 'tr']);

function safeUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const inlineText = (s: string) => s.replace(/\s+/g, ' ');
/** Also `<` and a line-start `:`, which the page editor would read as HTML or an embed directive. */
const escapeText = (s: string) =>
  s.replace(/([\\`*_[\]<])/g, '\\$1').replace(/(^|\n)(\s*):/g, '$1$2\\:');

/** Parentheses would end a Markdown link early and let a page write its own after it. */
const linkTarget = (url: string) => url.replace(/\(/g, '%28').replace(/\)/g, '%29');

/** A fence longer than any run of backticks in the code, so the code cannot close it. */
function fenceFor(code: string, min: number): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(min, longest + 1));
}

function walk(node: Node, base: string, listDepth: number): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(inlineText(node.textContent ?? ''));
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  const children = () => [...el.childNodes].map((c) => walk(c, base, listDepth)).join('');
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'strong':
    case 'b': {
      const text = children().trim();
      return text ? `**${text}**` : '';
    }
    case 'em':
    case 'i': {
      const text = children().trim();
      return text ? `*${text}*` : '';
    }
    case 'code':
      if (el.closest('pre')) return el.textContent ?? '';
      return `${fenceFor(el.textContent ?? '', 1)}${el.textContent ?? ''}${fenceFor(el.textContent ?? '', 1)}`;
    case 'pre': {
      const code = (el.textContent ?? '').replace(/\n$/, '');
      const fence = fenceFor(code, 3);
      return `\n\n${fence}\n${code}\n${fence}\n\n`;
    }
    case 'a': {
      const text = children().trim();
      const href = safeUrl(el.getAttribute('href'), base);
      return href && text ? `[${text}](${linkTarget(href)})` : text;
    }
    case 'img': {
      const src = safeUrl(el.getAttribute('src'), base);
      return src ? `![${escapeText(el.getAttribute('alt') ?? '')}](${linkTarget(src)})` : '';
    }
    case 'blockquote':
      return `\n\n${children()
        .trim()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')}\n\n`;
    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const indent = '  '.repeat(listDepth);
      const items = [...el.children]
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li, i) => {
          const body = [...li.childNodes]
            .map((c) => walk(c, base, listDepth + 1))
            .join('')
            .trim();
          return `${indent}${ordered ? `${i + 1}.` : '-'} ${body}`;
        });
      return listDepth > 0 ? `\n${items.join('\n')}` : `\n\n${items.join('\n')}\n\n`;
    }
    case 'td':
    case 'th':
      return `${children().trim()} `;
    default:
      return BLOCK.has(tag) ? `\n\n${children()}\n\n` : children();
  }
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  // A DOMParser document runs no scripts and loads no images.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return walk(doc.body, baseUrl, 0)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?![-\d])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The block every clip starts or ends with, so the source stays one click away. */
export function sourceLine(title: string, url: string, label: string): string {
  const safe = safeUrl(url, url);
  return safe ? `> ${label}: [${escapeText(title || safe)}](${linkTarget(safe)})` : '';
}
