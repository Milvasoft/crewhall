/**
 * Descriptions and comments between the three shapes: Crewhall's plain text (`- ` for bullets),
 * Azure DevOps HTML and Jira's document format. Only structure that survives plain text is kept;
 * comparison always happens on the plain form, so a lossy conversion cannot look like an edit.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One form for comparing: LF, bullets as `- `, no trailing space, no runs of blank lines. */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^\s*[•*]\s+/, '- '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|blockquote|pre)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|tr|blockquote|pre)(\s[^>]*)?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return normalizeText(decode(text));
}

export function textToHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of normalizeText(text).split('\n')) {
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(escapeHtml(bullet[1]!));
      continue;
    }
    flush();
    out.push(line ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>');
  }
  flush();
  return out.join('');
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

function adfInline(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return String(node.attrs?.text ?? '');
  if (node.type === 'emoji') return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
  if (node.type === 'inlineCard') return String(node.attrs?.url ?? '');
  return (node.content ?? []).map(adfInline).join('');
}

function adfBlocks(nodes: AdfNode[], indent: string): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      for (const item of n.content ?? []) {
        const inner = adfBlocks(item.content ?? [], `${indent}  `);
        out.push(`${indent}- ${inner.shift()?.trimStart() ?? ''}`, ...inner);
      }
    } else if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') {
      out.push(adfInline(n));
    } else if (n.content) {
      out.push(...adfBlocks(n.content, indent));
    } else {
      out.push(adfInline(n));
    }
  }
  return out;
}

export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return normalizeText(doc);
  if (!doc || typeof doc !== 'object') return '';
  return normalizeText(adfBlocks((doc as AdfNode).content ?? [], '').join('\n'));
}

export function textToAdf(text: string) {
  const content: AdfNode[] = [];
  let list: AdfNode | null = null;
  const para = (s: string): AdfNode => ({
    type: 'paragraph',
    content: s ? [{ type: 'text', text: s }] : [],
  });
  for (const line of normalizeText(text).split('\n')) {
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = { type: 'bulletList', content: [] };
        content.push(list);
      }
      list.content!.push({ type: 'listItem', content: [para(bullet[1]!)] });
      continue;
    }
    list = null;
    content.push(para(line));
  }
  return { type: 'doc', version: 1, content };
}

/** Jira Server wiki text, read as plain text. */
export function wikiToText(s: string): string {
  return normalizeText(
    s
      .replace(/^h[1-6]\.\s*/gm, '')
      .replace(/^\s*#+\s+/gm, '- ')
      .replace(/\{(code|noformat|quote)(:[^}]*)?\}/g, ''),
  );
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** `YYYY-MM-DD` of a timestamp in a time zone. */
export function dateIn(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Noon UTC stays on the same calendar day in nearly every zone. */
export const dateToTimestamp = (d: string | null) => (d ? `${d}T12:00:00.000Z` : null);
