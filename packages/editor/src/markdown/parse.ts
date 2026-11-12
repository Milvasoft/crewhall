import type {
  Definition,
  Html,
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import type { ContainerDirective, LeafDirective } from 'mdast-util-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { fromMarkdown, type Options as FromMarkdownOptions } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { directive } from 'micromark-extension-directive';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import {
  isAdmonitionType,
  isMentionKind,
  MAX_COLUMNS,
  videoSource,
  webUrl,
  type CellAlign,
  type EditorDoc,
  type JSONMark,
  type JSONNode,
} from '../model';
import { splitFrontMatter } from './frontmatter';

export type MarkdownWarningType =
  'mdx-import' | 'unsupported-component' | 'unknown-directive' | 'front-matter';

export interface MarkdownWarning {
  type: MarkdownWarningType;
  message: string;
  detail?: string;
}

export interface ParsedMarkdown {
  doc: EditorDoc;
  frontMatter: Record<string, unknown>;
  warnings: MarkdownWarning[];
}

/**
 * Only flow directives: containers (`:::note`, `:::toggle`) and leaves (`::embed{…}`). Text
 * directives would turn ordinary text such as "key:value" into nodes.
 */
type MicromarkExtension = NonNullable<FromMarkdownOptions['extensions']>[number];

function flowDirectivesOnly(): MicromarkExtension {
  // `flow[58]` (":") holds [directiveContainer, directiveLeaf].
  const flow = directive().flow as Record<number, unknown[]>;
  return { flow: { 58: flow[58] } } as unknown as MicromarkExtension;
}

/** `:::tip Title` (Docusaurus v2 style) → `:::tip[Title]` (directive label), outside fences. */
function normalizeAdmonitions(body: string): string {
  const lines = body.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1] ?? '';
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^(\s*)(:{3,})([A-Za-z][\w-]*)[ \t]+([^[{\s].*?)\s*$/.exec(line);
    if (m) {
      const title = (m[4] ?? '').replace(/[[\]]/g, (c) => `\\${c}`);
      lines[i] = `${m[1]}${m[2]}${m[3]}[${title}]`;
    }
  }
  return lines.join('\n');
}

/** Top-of-file MDX `import … from '…'` / `export …` lines (removed, reported when foreign). */
const MDX_STATEMENT = /^(import\s[\s\S]*?from\s+['"][^'"]+['"];?|export\s.*)$/;
const KNOWN_IMPORTS = /@theme\/(Tabs|TabItem|Admonition|CodeBlock)/;

const TAG =
  /<(\/?)([A-Za-z][\w.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

function parseAttrs(src: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const re = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (!name) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? m[5];
    out[name] =
      value === undefined
        ? true
        : m[4] !== undefined
          ? value.trim().replace(/^['"]|['"]$/g, '')
          : value;
  }
  return out;
}

type Token =
  | { kind: 'open'; name: 'Tabs' | 'TabItem'; attrs: Record<string, string | true> }
  | { kind: 'close'; name: 'Tabs' | 'TabItem' }
  /** `source` is the markdown the node's positions point into (a re-parsed HTML part). */
  | { kind: 'node'; node: RootContent; source?: string };

const TABS_TAGS = new Set(['Tabs', 'TabItem']);

/**
 * Splits an HTML block made only of Tabs / TabItem tags and markdown text into tokens; the
 * text between tags is parsed as markdown again. Returns null for other HTML.
 */
function tabTokens(html: Html, ctx: Ctx): Token[] | null {
  const value = html.value;
  if (!/^\s*<\/?(Tabs|TabItem)\b/.test(value)) return null;
  const tokens: Token[] = [];
  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string) => {
    if (!text.trim()) return;
    const source = dedent(text);
    const sub = fromMarkdown(source, ctx.options);
    for (const child of sub.children) tokens.push({ kind: 'node', node: child, source });
  };
  while ((m = TAG.exec(value))) {
    const name = m[2] ?? '';
    if (!TABS_TAGS.has(name)) continue;
    pushText(value.slice(last, m.index));
    last = m.index + m[0].length;
    const tagName = name as 'Tabs' | 'TabItem';
    if (m[1]) tokens.push({ kind: 'close', name: tagName });
    else {
      tokens.push({ kind: 'open', name: tagName, attrs: parseAttrs(m[3] ?? '') });
      if (m[4]) tokens.push({ kind: 'close', name: tagName });
    }
  }
  pushText(value.slice(last));
  return tokens;
}

function dedent(text: string): string {
  const lines = text.replace(/^\n+/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

interface Ctx {
  options: FromMarkdownOptions;
  /** The markdown the current nodes' positions point into. */
  source: string;
  definitions: Map<string, Definition>;
  warnings: MarkdownWarning[];
}

const normalizeLabel = (label: string) => label.toLowerCase().replace(/\s+/g, ' ').trim();

/** Parses markdown (with optional front matter) into the editor model. */
export function markdownToDoc(markdown: string): ParsedMarkdown {
  const split = splitFrontMatter(markdown);
  const warnings: MarkdownWarning[] = [];
  if (split.error) {
    warnings.push({
      type: 'front-matter',
      message: 'Front matter is not valid YAML',
      detail: split.error,
    });
  }
  const options: FromMarkdownOptions = {
    // A single $ stays text: "$5 ve $10" is not a formula.
    extensions: [gfm(), flowDirectivesOnly(), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown(), mathFromMarkdown()],
  };
  const source = normalizeAdmonitions(split.body);
  const tree = fromMarkdown(source, options);
  const ctx: Ctx = { options, source, definitions: new Map(), warnings };
  collectDefinitions(tree, ctx);
  stripMdxStatements(tree, ctx);
  const content = flowToBlocks(tree.children, ctx);
  return {
    doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    frontMatter: split.frontMatter,
    warnings,
  };
}

function collectDefinitions(node: Nodes, ctx: Ctx) {
  if (node.type === 'definition') ctx.definitions.set(normalizeLabel(node.identifier), node);
  if ('children' in node) for (const c of node.children as Nodes[]) collectDefinitions(c, ctx);
}

function stripMdxStatements(tree: Root, ctx: Ctx) {
  tree.children = tree.children.filter((node) => {
    if (node.type !== 'paragraph') return true;
    const text = node.children.map((c) => ('value' in c ? c.value : '')).join('');
    const statements = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!statements.length || !statements.every((s) => MDX_STATEMENT.test(s))) return true;
    for (const s of statements) {
      if (!KNOWN_IMPORTS.test(s)) {
        ctx.warnings.push({ type: 'mdx-import', message: 'MDX import removed', detail: s });
      }
    }
    return false;
  });
}

function flowToBlocks(nodes: RootContent[], ctx: Ctx): JSONNode[] {
  // Flatten Tabs HTML into tokens, then rebuild the nesting with a stack.
  const tokens: Token[] = [];
  for (const node of nodes) {
    // `<Tabs><TabItem …>` on one line is a paragraph of inline HTML, not an HTML block.
    const tagsOnly =
      node.type === 'paragraph' &&
      node.children.length > 0 &&
      node.children.every(
        (c) =>
          (c.type === 'html' && /^<\/?(Tabs|TabItem)\b/.test(c.value)) ||
          (c.type === 'text' && !c.value.trim()),
      );
    const html: Html | null =
      node.type === 'html'
        ? node
        : tagsOnly
          ? {
              type: 'html',
              value: node.children.map((c) => ('value' in c ? c.value : '')).join(''),
            }
          : null;
    const t = html ? tabTokens(html, ctx) : null;
    if (t) tokens.push(...t);
    else tokens.push({ kind: 'node', node });
  }
  if (!tokens.some((t) => t.kind !== 'node')) {
    return nodes.flatMap((n) => blockToNodes(n, ctx));
  }
  interface Frame {
    node: JSONNode;
    name: 'root' | 'Tabs' | 'TabItem';
  }
  const root: Frame = { node: { type: 'root', content: [] }, name: 'root' };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  for (const token of tokens) {
    if (token.kind === 'node') {
      const blocks = blockToNodes(
        token.node,
        token.source === undefined ? ctx : { ...ctx, source: token.source },
      );
      const frame = top();
      if (frame.name === 'Tabs') {
        // Content directly in <Tabs> outside a TabItem: keep it after the tabs.
        root.node.content!.push(...blocks);
      } else frame.node.content!.push(...blocks);
    } else if (token.kind === 'open') {
      if (token.name === 'Tabs') {
        const tabs: JSONNode = {
          type: 'tabs',
          attrs: { groupId: typeof token.attrs.groupId === 'string' ? token.attrs.groupId : null },
          content: [],
        };
        top().node.content!.push(tabs);
        stack.push({ node: tabs, name: 'Tabs' });
      } else {
        let frame = top();
        if (frame.name !== 'Tabs') {
          // TabItem without Tabs: open an implicit Tabs.
          const tabs: JSONNode = { type: 'tabs', attrs: { groupId: null }, content: [] };
          frame.node.content!.push(tabs);
          stack.push({ node: tabs, name: 'Tabs' });
          frame = top();
        }
        const value =
          typeof token.attrs.value === 'string'
            ? token.attrs.value
            : `tab${(frame.node.content?.length ?? 0) + 1}`;
        const item: JSONNode = {
          type: 'tabItem',
          attrs: {
            value,
            label: typeof token.attrs.label === 'string' ? token.attrs.label : null,
            default: token.attrs.default === true || token.attrs.default === 'true',
          },
          content: [],
        };
        frame.node.content!.push(item);
        stack.push({ node: item, name: 'TabItem' });
      }
    } else {
      const idx = stack.map((f) => f.name).lastIndexOf(token.name);
      if (idx > 0) stack.length = idx;
    }
  }
  return fixTabs(root.node.content ?? []);
}

/** Every tabItem needs at least one block; empty tabs are dropped. */
function fixTabs(nodes: JSONNode[]): JSONNode[] {
  return nodes
    .map((n) => {
      if (n.type === 'tabItem' && !n.content?.length) {
        return { ...n, content: [{ type: 'paragraph' }] };
      }
      if (n.type === 'tabs' || n.type === 'tabItem') {
        return { ...n, content: fixTabs(n.content ?? []) };
      }
      return n;
    })
    .filter((n) => n.type !== 'tabs' || (n.content?.length ?? 0) > 0);
}

function blockToNodes(node: RootContent, ctx: Ctx): JSONNode[] {
  switch (node.type) {
    case 'math':
      return [{ type: 'mathBlock', attrs: { latex: node.value } }];
    case 'paragraph': {
      // `$$x$$` alone on its line reads as a formula on its own line, as other editors show it.
      const only = node.children.length === 1 ? node.children[0] : null;
      if (only?.type === 'inlineMath') {
        return [{ type: 'mathBlock', attrs: { latex: only.value } }];
      }
      const content = inlineNodes(node.children, [], ctx);
      return [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }];
    }
    case 'heading': {
      const children = [...node.children];
      let id: string | null = null;
      const lastChild = children[children.length - 1];
      if (lastChild?.type === 'text') {
        const m = /\s*\{#([^}\s]+)\}\s*$/.exec(lastChild.value);
        if (m) {
          id = m[1] ?? null;
          children[children.length - 1] = {
            ...lastChild,
            value: lastChild.value.slice(0, m.index),
          };
        }
      }
      const content = inlineNodes(children, [], ctx);
      return [
        {
          type: 'heading',
          attrs: { level: node.depth, id },
          ...(content.length ? { content } : {}),
        },
      ];
    }
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'blockquote':
      return [{ type: 'blockquote', content: ensureBlocks(flowToBlocks(node.children, ctx)) }];
    case 'list':
      return [listNode(node, ctx)];
    case 'code': {
      if (node.lang === 'mermaid') {
        return [
          {
            type: 'mermaid',
            ...(node.value ? { content: [{ type: 'text', text: node.value }] } : {}),
          },
        ];
      }
      const { title, rest } = splitMeta(node.meta ?? null);
      return [
        {
          type: 'codeBlock',
          attrs: { language: node.lang ?? null, title, meta: rest },
          ...(node.value ? { content: [{ type: 'text', text: node.value }] } : {}),
        },
      ];
    }
    case 'html': {
      const value = node.value.trim();
      if (/^<!--\s*truncate\s*-->$/i.test(value)) return [{ type: 'truncate' }];
      if (/^<!--\s*toc\s*-->$/i.test(value)) return [{ type: 'toc' }];
      reportComponents(value, ctx);
      return [{ type: 'htmlBlock', attrs: { html: node.value } }];
    }
    case 'table':
      return [tableNode(node, ctx)];
    case 'containerDirective':
      return directiveNode(node, ctx);
    case 'leafDirective':
      return leafDirectiveNode(node, ctx);
    case 'definition':
      return [];
    case 'footnoteDefinition': {
      const blocks = flowToBlocks(node.children, ctx);
      const first = blocks[0];
      if (first?.type === 'paragraph') {
        first.content = [
          { type: 'text', text: `[^${node.identifier}]: ` },
          ...(first.content ?? []),
        ];
        return blocks;
      }
      return [
        { type: 'paragraph', content: [{ type: 'text', text: `[^${node.identifier}]:` }] },
        ...blocks,
      ];
    }
    default: {
      // Text directives are not enabled; anything else is kept as text.
      const text = 'value' in node && typeof node.value === 'string' ? node.value : '';
      return text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [];
    }
  }
}

function ensureBlocks(blocks: JSONNode[]): JSONNode[] {
  return blocks.length ? blocks : [{ type: 'paragraph' }];
}

function splitMeta(meta: string | null): { title: string | null; rest: string | null } {
  if (!meta) return { title: null, rest: null };
  const m = /title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  if (!m) return { title: null, rest: meta.trim() || null };
  const rest = (meta.slice(0, m.index) + meta.slice(m.index + m[0].length)).trim();
  return { title: m[1] ?? m[2] ?? m[3] ?? null, rest: rest || null };
}

/**
 * GFM needs text after a task checkbox, so an empty task (`- [ ]`, `- [x]`) parses as a plain
 * item whose paragraph is the literal `[ ]`. Templates (meeting notes) and our own serializer
 * write empty tasks that way; they are read back as tasks with an empty paragraph.
 */
function withBareCheckbox(item: ListItem): ListItem {
  if (typeof item.checked === 'boolean') return item;
  const [first, ...rest] = item.children;
  if (first?.type !== 'paragraph' || first.children.length !== 1) return item;
  const only = first.children[0];
  const m = only?.type === 'text' ? /^\[([ xX])\]$/.exec(only.value.trim()) : null;
  if (!m) return item;
  return { ...item, checked: m[1] !== ' ', children: rest };
}

function listNode(list: List, ctx: Ctx): JSONNode {
  const children = list.children.map(withBareCheckbox);
  const isTask = children.some((i) => typeof i.checked === 'boolean');
  const items = children.map((item) => listItemNode(item, isTask, ctx));
  if (isTask) return { type: 'taskList', content: items };
  if (list.ordered) {
    return { type: 'orderedList', attrs: { start: list.start ?? 1 }, content: items };
  }
  return { type: 'bulletList', content: items };
}

function listItemNode(item: ListItem, task: boolean, ctx: Ctx): JSONNode {
  const blocks = flowToBlocks(item.children, ctx);
  // Tiptap list items start with a paragraph.
  if (blocks[0]?.type !== 'paragraph') blocks.unshift({ type: 'paragraph' });
  return task
    ? { type: 'taskItem', attrs: { checked: item.checked === true }, content: blocks }
    : { type: 'listItem', content: blocks };
}

function tableNode(table: Table, ctx: Ctx): JSONNode {
  const align = table.align ?? [];
  const width = Math.max(align.length, ...table.children.map((row) => row.children.length));
  return {
    type: 'table',
    content: table.children.map((row, r) => ({
      type: 'tableRow',
      // Short rows are padded, as GFM renders them.
      content: Array.from(
        { length: width },
        (_, c) => row.children[c] ?? { type: 'tableCell' as const, children: [] },
      ).map((cell, c) => {
        const inline = inlineNodes(cell.children, [], ctx);
        return {
          type: r === 0 ? 'tableHeader' : 'tableCell',
          attrs: { colspan: 1, rowspan: 1, colwidth: null, align: (align[c] ?? null) as CellAlign },
          content: [inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }],
        };
      }),
    })),
  };
}

/** Two to MAX_COLUMNS columns; whatever does not fit in that follows as ordinary blocks. */
function columnsNode(children: RootContent[], ctx: Ctx): JSONNode[] {
  const isColumn = (c: RootContent) => c.type === 'containerDirective' && c.name === 'column';
  const columns = children.filter(isColumn).slice(0, MAX_COLUMNS);
  const rest = children.filter((c) => !columns.includes(c));
  const after = flowToBlocks(rest, ctx);
  if (columns.length < 2) return [...flowToBlocks(columns, ctx), ...after];
  return [
    {
      type: 'columns',
      content: columns.map((c) => ({
        type: 'column',
        content: ensureBlocks(
          flowToBlocks((c as ContainerDirective).children as RootContent[], ctx),
        ),
      })),
    },
    ...after,
  ];
}

function directiveNode(node: ContainerDirective, ctx: Ctx): JSONNode[] {
  const children = [...node.children];
  let title: string | null = null;
  const first = children[0];
  if (
    first?.type === 'paragraph' &&
    first.data &&
    'directiveLabel' in first.data &&
    first.data.directiveLabel
  ) {
    title = phrasingText(first.children);
    children.shift();
  }
  if (node.name === 'columns') return columnsNode(children as RootContent[], ctx);
  const blocks = flowToBlocks(children as RootContent[], ctx);
  // Only meaningful inside `columns`, which reads it above; its blocks are kept anywhere else.
  if (node.name === 'column') return blocks;
  if (node.name === 'toggle') {
    const level = Number(node.attributes?.level);
    return [
      {
        type: 'toggle',
        attrs: { summary: title ?? '', ...(level >= 1 && level <= 3 ? { level } : {}) },
        content: ensureBlocks(blocks),
      },
    ];
  }
  if (!isAdmonitionType(node.name)) {
    ctx.warnings.push({
      type: 'unknown-directive',
      message: `Unknown directive :::${node.name}; its content was kept`,
      detail: node.name,
    });
    return blocks;
  }
  return [{ type: 'admonition', attrs: { type: node.name, title }, content: ensureBlocks(blocks) }];
}

/** `::embed{node="…" type="…"}`; other leaf directives stay as their source text. */
function leafDirectiveNode(node: LeafDirective, ctx: Ctx): JSONNode[] {
  const nodeId = node.attributes?.node;
  if (node.name === 'embed' && typeof nodeId === 'string' && nodeId !== '') {
    const type = node.attributes?.type;
    return [
      {
        type: 'embed',
        attrs: { nodeId, nodeType: typeof type === 'string' && type !== '' ? type : null },
      },
    ];
  }
  const attribute = (key: string) => {
    const value = node.attributes?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const url = attribute('url');
  if (node.name === 'bookmark' && url && webUrl(url)) {
    return [
      {
        type: 'bookmark',
        attrs: { url, title: attribute('title'), favicon: attribute('favicon') },
      },
    ];
  }
  const src = attribute('src');
  if (node.name === 'video' && src && (webUrl(src) || videoSource(src))) {
    return [{ type: 'video', attrs: { src, title: attribute('title') } }];
  }
  ctx.warnings.push({
    type: 'unknown-directive',
    message: `Unknown directive ::${node.name}; it was kept as text`,
    detail: node.name,
  });
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const text =
    start !== undefined && end !== undefined
      ? ctx.source.slice(start, end).trim()
      : `::${node.name}${node.children.length ? `[${phrasingText(node.children)}]` : ''}`;
  return [{ type: 'paragraph', content: [{ type: 'text', text }] }];
}

/** `[@label](mention:<kind>:<id>)` → mention node; null for any other link. */
function mentionNode(url: string, children: PhrasingContent[], marks: JSONMark[]): JSONNode | null {
  const m = /^mention:([a-z]+):(.+)$/.exec(url);
  const kind = m?.[1] ?? '';
  const id = m?.[2];
  if (!id || !isMentionKind(kind)) return null;
  const label = phrasingText(children).replace(/^@/, '');
  const kept = marks.filter((mark) => mark.type !== 'link' && mark.type !== 'code');
  return {
    type: 'mention',
    attrs: { id, label, kind },
    ...(kept.length ? { marks: kept } : {}),
  };
}

function phrasingText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      if ('value' in n) return n.value;
      if ('children' in n) return phrasingText(n.children as PhrasingContent[]);
      return '';
    })
    .join('');
}

function reportComponents(html: string, ctx: Ctx) {
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html))) {
    const name = m[2] ?? '';
    if (!m[1] && /^[A-Z]/.test(name) && !TABS_TAGS.has(name)) {
      ctx.warnings.push({
        type: 'unsupported-component',
        message: `MDX component <${name}> is not supported; kept as raw HTML`,
        detail: name,
      });
    }
  }
}

/** Marks kept in one canonical order so equal formatting compares equal. */
const MARK_RANK = ['link', 'bold', 'italic', 'strike', 'code'];

function withMark(marks: JSONMark[], mark: JSONMark): JSONMark[] {
  return [...marks.filter((m) => m.type !== mark.type), mark].sort(
    (a, b) => MARK_RANK.indexOf(a.type) - MARK_RANK.indexOf(b.type),
  );
}

function textNode(text: string, marks: JSONMark[]): JSONNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

function inlineNodes(nodes: PhrasingContent[], marks: JSONMark[], ctx: Ctx): JSONNode[] {
  const out: JSONNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.value) out.push(textNode(node.value, marks));
        break;
      case 'emphasis':
        out.push(...inlineNodes(node.children, withMark(marks, { type: 'italic' }), ctx));
        break;
      case 'strong':
        out.push(...inlineNodes(node.children, withMark(marks, { type: 'bold' }), ctx));
        break;
      case 'delete':
        out.push(...inlineNodes(node.children, withMark(marks, { type: 'strike' }), ctx));
        break;
      case 'inlineCode':
        if (node.value) {
          const linkMarks = marks.filter((m) => m.type === 'link');
          out.push(textNode(node.value, [...linkMarks, { type: 'code' }]));
        }
        break;
      case 'link': {
        const mention = mentionNode(node.url, node.children, marks);
        if (mention) {
          out.push(mention);
          break;
        }
        out.push(
          ...inlineNodes(
            node.children,
            withMark(marks, { type: 'link', attrs: { href: node.url, title: node.title ?? null } }),
            ctx,
          ),
        );
        break;
      }
      case 'linkReference': {
        const def = ctx.definitions.get(normalizeLabel(node.identifier));
        const mention = def ? mentionNode(def.url, node.children, marks) : null;
        if (mention) out.push(mention);
        else if (def) {
          out.push(
            ...inlineNodes(
              node.children,
              withMark(marks, { type: 'link', attrs: { href: def.url, title: def.title ?? null } }),
              ctx,
            ),
          );
        } else {
          out.push(...inlineNodes(node.children, marks, ctx));
        }
        break;
      }
      case 'image':
        out.push({
          type: 'image',
          attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
        });
        break;
      case 'imageReference': {
        const def = ctx.definitions.get(normalizeLabel(node.identifier));
        if (def) {
          out.push({
            type: 'image',
            attrs: { src: def.url, alt: node.alt ?? null, title: def.title ?? null },
          });
        }
        break;
      }
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'html':
        if (/^<br\s*\/?>$/i.test(node.value.trim())) out.push({ type: 'hardBreak' });
        else {
          reportComponents(node.value, ctx);
          out.push({ type: 'htmlInline', attrs: { html: node.value } });
        }
        break;
      case 'inlineMath':
        out.push({ type: 'mathInline', attrs: { latex: node.value } });
        break;
      case 'footnoteReference':
        out.push(textNode(`[^${node.identifier}]`, marks));
        break;
      default:
        break;
    }
  }
  // A hard break cannot end a paragraph in markdown; drop trailing ones.
  while (out.length && out[out.length - 1]?.type === 'hardBreak') out.pop();
  return mergeText(out);
}

const sameMarks = (a?: JSONMark[], b?: JSONMark[]) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function mergeText(nodes: JSONNode[]): JSONNode[] {
  const out: JSONNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && n.type === 'text' && sameMarks(prev.marks, n.marks)) {
      prev.text = (prev.text ?? '') + (n.text ?? '');
    } else out.push({ ...n });
  }
  return out;
}
