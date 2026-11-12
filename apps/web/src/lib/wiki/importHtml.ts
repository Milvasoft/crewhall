import TurndownService from 'turndown';

/**
 * HTML of a converted document to the Markdown the page importer reads: GFM tables, fenced code
 * with its language, task lists and `:::` blocks.
 *
 * Elements ask for the last two through attributes, so that format-specific code stays with the
 * format: `data-directive` + `data-title` on a block, `data-task` ("x" or " ") on a list item,
 * `data-lang` on a `pre`.
 */

const el = (node: unknown) => node as HTMLElement;

/** A table cell is one line in GFM: its paragraphs become line breaks. */
const cellText = (content: string) =>
  content
    .trim()
    .replace(/\s*\n\s*/g, '<br>')
    .replace(/\|/g, '\\|');

function fenceFor(code: string) {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

function createService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  service.remove(['script', 'style']);

  service.addRule('pageCode', {
    filter: 'pre',
    replacement: (_content, node) => {
      const pre = el(node);
      const lang =
        pre.getAttribute('data-lang') ??
        /language-([\w+#-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ??
        '';
      const code = (pre.textContent ?? '').replace(/\n$/, '');
      const fence = fenceFor(code);
      return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
    },
  });

  service.addRule('pageStrike', {
    filter: ['del', 's'],
    replacement: (content) => (content.trim() ? `~~${content.trim()}~~` : ''),
  });

  service.addRule('pageDirective', {
    filter: (node) => el(node).hasAttribute('data-directive'),
    replacement: (content, node) => {
      const name = el(node).getAttribute('data-directive')!;
      const title = el(node).getAttribute('data-title')?.replace(/[[\]]/g, '').trim();
      return `\n\n:::${name}${title ? `[${title}]` : ''}\n\n${content.trim()}\n\n:::\n\n`;
    },
  });

  service.addRule('pageTask', {
    filter: (node) => node.nodeName === 'LI' && el(node).hasAttribute('data-task'),
    replacement: (content, node) => {
      const body = content.trim().replace(/\n/g, '\n  ');
      return `- [${el(node).getAttribute('data-task')}] ${body}\n`;
    },
  });

  service.addRule('pageTableCell', {
    filter: ['td', 'th'],
    replacement: (content, node) => {
      const first = !el(node).previousElementSibling;
      return `${first ? '|' : ''} ${cellText(content)} |`;
    },
  });

  service.addRule('pageTableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = el(node) as HTMLTableRowElement;
      // GFM needs a header row: the first row is one, whatever its cells are called.
      const isFirst = row.closest('table')?.querySelector('tr') === row;
      const divider = isFirst ? `\n|${' --- |'.repeat(row.cells.length)}` : '';
      return `${content}${divider}\n`;
    },
  });

  service.addRule('pageTable', {
    filter: 'table',
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  service.addRule('pageTableSection', {
    filter: ['thead', 'tbody', 'tfoot', 'caption', 'colgroup'],
    replacement: (content, node) => (node.nodeName === 'COLGROUP' ? '' : content),
  });

  return service;
}

let service: TurndownService | null = null;

export function htmlToPageMarkdown(html: string | HTMLElement): string {
  service ??= createService();
  return service.turndown(html).trim();
}

/** One path segment of an imported page; the page keeps its real name through its heading. */
export const pathSegment = (name: string) =>
  name
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || '-';

/** The heading that names the page, so that a heading in the body cannot take its place. */
export const titled = (name: string, markdown: string) =>
  `# ${name.replace(/\s+/g, ' ').trim()}\n\n${markdown}`;
