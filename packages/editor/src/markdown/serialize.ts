import type {
  BlockContent,
  Code,
  Heading,
  Html,
  List,
  ListItem,
  Nodes,
  Paragraph,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import type { ContainerDirective, LeafDirective } from 'mdast-util-directive';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { defaultHandlers, toMarkdown, type Handle } from 'mdast-util-to-markdown';
import type { EditorDoc, JSONMark, JSONNode } from '../model';
import { joinFrontMatter } from './frontmatter';

export interface SerializeOptions {
  /** Front matter written above the body. */
  frontMatter?: Record<string, unknown>;
  /** Add `import Tabs from '@theme/Tabs'` lines when the doc has tabs (Docusaurus MDX). */
  docusaurusImports?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Editor model → Docusaurus-compatible markdown (admonitions, Tabs, code titles, mermaid). */
export function docToMarkdown(doc: EditorDoc, options: SerializeOptions = {}): string {
  const children = blocks(doc.content ?? []);
  const root: Root = { type: 'root', children };
  let body = toMarkdown(root, {
    extensions: [gfmToMarkdown(), MATH_MARKDOWN],
    handlers: {
      containerDirective: containerDirectiveHandler,
      leafDirective: leafDirectiveHandler,
      listItem: listItemHandler,
    } as Record<string, Handle>,
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fence: '`',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
    resourceLink: true,
  });
  if (options.docusaurusImports && hasType(doc, 'tabs')) {
    body = `import Tabs from '@theme/Tabs';\nimport TabItem from '@theme/TabItem';\n\n${body}`;
  }
  return joinFrontMatter(options.frontMatter ?? {}, body);
}

/** `$$` is a formula: when text has it, it is escaped; a single `$` is left as written. */
const MATH_MARKDOWN = {
  unsafe: [{ character: '$', inConstruct: 'phrasing' as const, after: '\\$' }],
  handlers: {
    math: (node: { value: string }) => `$$\n${node.value}\n$$`,
    inlineMath: (node: { value: string }) => `$$${node.value}$$`,
  },
};

function hasType(node: JSONNode | EditorDoc, type: string): boolean {
  if (node.type === type) return true;
  return (node.content ?? []).some((c) => hasType(c, type));
}

function directiveDepth(node: Nodes): number {
  if (!('children' in node)) return 0;
  let max = 0;
  for (const c of node.children as Nodes[]) {
    const d = (c.type === 'containerDirective' ? 1 : 0) + directiveDepth(c);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Toggle summaries are written as directive labels, which are markdown: escape what would
 * otherwise turn into formatting, so the summary reads back as the same plain text.
 */
const escapeLabel = (text: string) =>
  text.replace(/\s*\n\s*/g, ' ').replace(/[\\[\]*_`<&~!]/g, (c) => `\\${c}`);

/**
 * `:::type[Title]` … `:::` (admonitions) and `:::toggle[Summary]` … `:::`; outer fences grow so
 * nested directives stay unambiguous.
 */
/**
 * GFM's task item writer, which also keeps the checkbox of an empty task: GFM matches the
 * space after the bullet, and an empty item has none, so it wrote a bare `-`.
 */
const listItemHandler: Handle = (node, parent, state, info) => {
  const item = node as ListItem;
  const checkable = typeof item.checked === 'boolean' && item.children[0]?.type === 'paragraph';
  if (!checkable) return defaultHandlers.listItem(item, parent as Parents, state, info);
  const checkbox = item.checked ? '[x]' : '[ ]';
  const tracker = state.createTracker(info);
  tracker.move(`${checkbox} `);
  const value = defaultHandlers.listItem(item, parent as Parents, state, {
    ...info,
    ...tracker.current(),
  });
  return value.replace(/^([*+-]|\d+\.)( {1,3}|\r?\n|$)/, (_m, bullet: string, sep: string) =>
    sep.startsWith(' ') ? `${bullet}${sep}${checkbox} ` : `${bullet} ${checkbox}${sep}`,
  );
};

const containerDirectiveHandler: Handle = (node, _parent, state, info) => {
  const directive = node as ContainerDirective;
  const fence = ':'.repeat(3 + directiveDepth(directive));
  let label: string;
  if (directive.name === 'toggle') {
    const summary = str(directive.attributes?.summary ?? null);
    const level = str(directive.attributes?.level ?? null);
    label = `${summary ? `[${escapeLabel(summary)}]` : ''}${level ? `{level=${level}}` : ''}`;
  } else {
    const title = str(directive.attributes?.title ?? null);
    label = title ? `[${title.replace(/[[\]]/g, '')}]` : '';
  }
  const head = `${fence}${directive.name}${label}`;
  const exit = state.enter('containerDirective' as never);
  const inner = state.containerFlow(directive, info);
  exit();
  return inner ? `${head}\n${inner}\n${fence}` : `${head}\n${fence}`;
};

const quoteAttr = (v: string) => `"${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;

/** `::embed{node="…" type="…"}`, the only leaf directive the model writes. */
const leafDirectiveHandler: Handle = (node) => {
  const directive = node as LeafDirective;
  const attrs = Object.entries(directive.attributes ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([k, v]) => `${k}=${quoteAttr(v)}`);
  return `::${directive.name}${attrs.length ? `{${attrs.join(' ')}}` : ''}`;
};

function blocks(nodes: JSONNode[]): RootContent[] {
  return nodes.flatMap(block);
}

function block(node: JSONNode): RootContent[] {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph':
      return [{ type: 'paragraph', children: inline(node.content ?? []) } satisfies Paragraph];
    case 'heading': {
      const children = inline(node.content ?? []);
      const id = str(a.id);
      if (id) children.push({ type: 'text', value: ` {#${id}}` });
      const depth = Math.min(6, Math.max(1, Number(a.level) || 1)) as Heading['depth'];
      return [{ type: 'heading', depth, children } satisfies Heading];
    }
    case 'blockquote':
      return [{ type: 'blockquote', children: blocks(node.content ?? []) as BlockContent[] }];
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const ordered = node.type === 'orderedList';
      const list: List = {
        type: 'list',
        ordered,
        start: ordered ? Number(a.start ?? 1) || 1 : null,
        spread: false,
        children: (node.content ?? []).map((item): ListItem => {
          const children = blocks(item.content ?? []) as BlockContent[];
          // The checkbox is written before a paragraph only; an empty task keeps it (`- [ ]`).
          if (node.type === 'taskList' && children[0]?.type !== 'paragraph') {
            children.unshift({ type: 'paragraph', children: [] });
          }
          return {
            type: 'listItem',
            spread: false,
            checked: node.type === 'taskList' ? item.attrs?.checked === true : null,
            children,
          };
        }),
      };
      return [list];
    }
    case 'codeBlock': {
      const title = str(a.title);
      const meta = [title ? `title="${title.replace(/"/g, "'")}"` : null, str(a.meta)]
        .filter(Boolean)
        .join(' ');
      return [
        {
          type: 'code',
          lang: str(a.language),
          meta: meta || null,
          value: textOf(node),
        } satisfies Code,
      ];
    }
    case 'mermaid':
      return [{ type: 'code', lang: 'mermaid', meta: null, value: textOf(node) }];
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }];
    case 'image':
      return [{ type: 'paragraph', children: inline([node]) }];
    case 'table':
      return [table(node)];
    case 'admonition': {
      const d: ContainerDirective = {
        type: 'containerDirective',
        name: str(a.type) ?? 'note',
        attributes: { title: str(a.title) },
        children: blocks(node.content ?? []) as BlockContent[],
      };
      return [d as unknown as RootContent];
    }
    case 'toggle': {
      const d: ContainerDirective = {
        type: 'containerDirective',
        name: 'toggle',
        attributes: { summary: str(a.summary), ...(a.level ? { level: String(a.level) } : {}) },
        children: blocks(node.content ?? []) as BlockContent[],
      };
      return [d as unknown as RootContent];
    }
    case 'bookmark':
    case 'video': {
      const attributes = Object.fromEntries(
        (node.type === 'bookmark' ? ['url', 'title', 'favicon'] : ['src', 'title']).flatMap(
          (key) => {
            const value = str(a[key]);
            return value ? [[key, value]] : [];
          },
        ),
      );
      if (!Object.keys(attributes).length) return [];
      const d: LeafDirective = { type: 'leafDirective', name: node.type, attributes, children: [] };
      return [d as unknown as RootContent];
    }
    case 'mathBlock': {
      const value = str(a.latex);
      return value ? [{ type: 'math', value } as unknown as RootContent] : [];
    }
    case 'columns':
    case 'column': {
      const d: ContainerDirective = {
        type: 'containerDirective',
        name: node.type,
        attributes: {},
        children: blocks(node.content ?? []) as BlockContent[],
      };
      return [d as unknown as RootContent];
    }
    case 'embed': {
      const nodeId = str(a.nodeId);
      if (!nodeId) return [];
      const nodeType = str(a.nodeType);
      const d: LeafDirective = {
        type: 'leafDirective',
        name: 'embed',
        attributes: nodeType ? { node: nodeId, type: nodeType } : { node: nodeId },
        children: [],
      };
      return [d as unknown as RootContent];
    }
    case 'tabs': {
      const out: RootContent[] = [];
      const group = str(a.groupId);
      out.push(html(`<Tabs${group ? ` groupId="${attr(group)}"` : ''}>`));
      for (const item of node.content ?? []) {
        const ia = item.attrs ?? {};
        const label = str(ia.label);
        out.push(
          html(
            `<TabItem value="${attr(str(ia.value) ?? 'tab')}"${label ? ` label="${attr(label)}"` : ''}${ia.default === true ? ' default' : ''}>`,
          ),
        );
        out.push(...blocks(item.content ?? []));
        out.push(html('</TabItem>'));
      }
      out.push(html('</Tabs>'));
      return out;
    }
    case 'truncate':
      return [html('<!-- truncate -->')];
    case 'toc':
      return [html('<!-- toc -->')];
    case 'htmlBlock':
      return [html(String(a.html ?? ''))];
    default:
      // Unknown block from a newer editor: keep its text.
      return node.content ? blocks(node.content) : [];
  }
}

const attr = (v: string) => v.replace(/"/g, '&quot;');
const html = (value: string): Html => ({ type: 'html', value });

function textOf(node: JSONNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(textOf).join('');
}

function table(node: JSONNode): Table {
  const rows = node.content ?? [];
  const align = (rows[0]?.content ?? []).map((cell) => {
    const v = cell.attrs?.align;
    return v === 'left' || v === 'center' || v === 'right' ? v : null;
  });
  return {
    type: 'table',
    align,
    children: rows.map((row): TableRow => ({
      type: 'tableRow',
      children: (row.content ?? []).map((cell): TableCell => ({
        type: 'tableCell',
        children: cellPhrasing(cell),
      })),
    })),
  };
}

/** Table cells hold one line: paragraphs and breaks become `<br />`. */
function cellPhrasing(cell: JSONNode): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  (cell.content ?? []).forEach((p, i) => {
    if (i > 0) out.push({ type: 'html', value: '<br />' });
    const inlineNodes =
      p.type === 'paragraph' ? (p.content ?? []) : [{ type: 'text', text: textOf(p) }];
    for (const n of inline(inlineNodes, true)) out.push(n);
  });
  return out;
}

// --- inline ---------------------------------------------------------------

const MARK_ORDER = ['link', 'bold', 'italic', 'strike'] as const;

function leaf(node: JSONNode, inTable: boolean): PhrasingContent | null {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      if (!text) return null;
      return (node.marks ?? []).some((m) => m.type === 'code')
        ? { type: 'inlineCode', value: text }
        : { type: 'text', value: text };
    }
    case 'hardBreak':
      return inTable ? { type: 'html', value: '<br />' } : { type: 'break' };
    case 'image':
      return { type: 'image', url: String(a.src ?? ''), alt: str(a.alt), title: str(a.title) };
    case 'htmlInline':
      return { type: 'html', value: String(a.html ?? '') };
    case 'mathInline':
      return { type: 'inlineMath', value: String(a.latex ?? '') } as unknown as PhrasingContent;
    case 'mention': {
      const id = str(a.id);
      const kind = str(a.kind);
      const label = typeof a.label === 'string' ? a.label : '';
      if (!id || !kind) return label ? { type: 'text', value: label } : null;
      return {
        type: 'link',
        url: `mention:${kind}:${id}`,
        title: null,
        children: [{ type: 'text', value: `@${label}` }],
      };
    }
    default:
      return node.content ? { type: 'text', value: textOf(node) } : null;
  }
}

function wrap(child: PhrasingContent, mark: JSONMark): PhrasingContent {
  switch (mark.type) {
    case 'bold':
      return { type: 'strong', children: [child] };
    case 'italic':
      return { type: 'emphasis', children: [child] };
    case 'strike':
      return { type: 'delete', children: [child] };
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs?.href ?? ''),
        title: str(mark.attrs?.title),
        children: [child],
      };
    default:
      return child;
  }
}

function inline(nodes: JSONNode[], inTable = false): PhrasingContent[] {
  const wrapped: PhrasingContent[] = [];
  for (const node of nodes) {
    let n = leaf(node, inTable);
    if (!n) continue;
    const marks = [...(node.marks ?? [])]
      // A mention is a link itself; markdown cannot nest links.
      .filter((m) => m.type !== 'code' && !(node.type === 'mention' && m.type === 'link'))
      .sort(
        (x, y) =>
          MARK_ORDER.indexOf(y.type as (typeof MARK_ORDER)[number]) -
          MARK_ORDER.indexOf(x.type as (typeof MARK_ORDER)[number]),
      );
    // Innermost first: strike, italic, bold, link outermost.
    for (const m of marks) n = wrap(n, m);
    wrapped.push(n);
  }
  return merge(wrapped);
}

function sameWrapper(a: PhrasingContent, b: PhrasingContent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'link' && b.type === 'link') {
    // Two mentions side by side stay two links.
    return a.url === b.url && a.title === b.title && !a.url.startsWith('mention:');
  }
  return a.type === 'strong' || a.type === 'emphasis' || a.type === 'delete';
}

/** Joins neighbours with the same wrapper: `**a****b**` → `**ab**`. */
function merge(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && 'children' in prev && 'children' in n && sameWrapper(prev, n)) {
      prev.children = merge([
        ...(prev.children as PhrasingContent[]),
        ...(n.children as PhrasingContent[]),
      ]) as typeof prev.children;
    } else if (prev && prev.type === 'text' && n.type === 'text') {
      prev.value += n.value;
    } else {
      out.push(n);
    }
  }
  return out;
}
