import {
  headings as docHeadings,
  markdownToDoc,
  nodeText,
  type EditorDoc,
  type Heading,
  type JSONMark,
  type JSONNode,
  videoSource,
} from '@crewhall/editor';
import { createElement, Fragment, type CSSProperties, type ReactNode } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { fill, type SiteStrings } from '@/i18n';
import { Admonition } from '@/render/Admonition';
import { CodeBlock } from '@/render/CodeBlock';
import { Mermaid } from '@/render/client/Mermaid';
import { Tabs, type TabMeta } from '@/render/client/Tabs';
import {
  SafeTreeBuilder,
  safeHref,
  safeSrc,
  tokenizeHtml,
  type HtmlToken,
  type SafeNode,
} from '@/render/sanitize';
import katex from 'katex';

/**
 * Published markdown → the editor document model → React, with the markup of the Docusaurus
 * classic theme, so the copied CSS styles it the same way.
 */

export interface TocItem {
  id: string;
  text: string;
  level: number;
  children: TocItem[];
}

export interface RenderedDoc {
  /** Text of a leading `# Title`, which the page shows in its header. */
  title: string | null;
  content: ReactNode;
  /** h2-h3 headings, nested. */
  toc: TocItem[];
  /** The content still has a top-level h1 (e.g. after an image): no separate page title then. */
  hasH1: boolean;
}

export function parseMarkdown(markdown: string): EditorDoc {
  return markdownToDoc(markdown).doc;
}

/** Nests h2/h3 headings (or another range) as Docusaurus' table of contents. */
export function buildToc(headings: Heading[], min = 2, max = 3): TocItem[] {
  const root: TocItem[] = [];
  const stack: TocItem[] = [];
  for (const h of headings) {
    if (h.level < min || h.level > max) continue;
    const item: TocItem = { id: h.id, text: h.text, level: h.level, children: [] };
    while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : root).push(item);
    stack.push(item);
  }
  return root;
}

const MARK_TAG: Record<string, 'strong' | 'em' | 'del' | 'code'> = {
  bold: 'strong',
  italic: 'em',
  strike: 'del',
  code: 'code',
};
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'];

const linkHref = (node: JSONNode): string | null => {
  const link = node.marks?.find((m) => m.type === 'link');
  return link && typeof link.attrs?.href === 'string' ? link.attrs.href : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Visible text of a text node; a wiki mention is its plain label (no `@`, no Hub link). */
const inlineText = (node: JSONNode): string | null =>
  node.type === 'text'
    ? (node.text ?? '')
    : node.type === 'mention'
      ? (str(node.attrs?.label) ?? '')
      : null;

/** Docusaurus `<Details>` markup (raw `<details>` HTML and wiki toggles). */
function DetailsBlock({
  summary,
  open,
  children,
}: {
  summary: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="details_lb9f alert alert--info details_b_Ee"
      {...(open ? { open: true } : {})}
    >
      {summary}
      <div>
        <div className="collapsibleContent_i85q">{children}</div>
      </div>
    </details>
  );
}

/** MathML needs no stylesheet; KaTeX escapes what it is given and active commands stay off. */
const mathHtml = (node: JSONNode, displayMode: boolean) =>
  katex.renderToString(str(node.attrs?.latex) ?? '', {
    displayMode,
    output: 'mathml',
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  });

class Renderer {
  private headingIndex = 0;

  constructor(
    private readonly strings: SiteStrings,
    private readonly headings: Heading[],
  ) {}

  nextHeading(): Heading | undefined {
    return this.headings[this.headingIndex++];
  }

  // ----- blocks

  blocks(nodes: JSONNode[] | undefined, keyPrefix = 'b'): ReactNode[] {
    const list = nodes ?? [];
    if (!list.some((n) => n.type === 'htmlBlock')) {
      return list.map((n, i) => this.block(n, `${keyPrefix}${i}`));
    }
    // Raw HTML blocks may open an element (e.g. <details>) that a later block closes: the
    // markdown blocks between them become its children.
    const builder = new SafeTreeBuilder<ReactNode>();
    list.forEach((n, i) => {
      if (n.type === 'htmlBlock') builder.pushAll(tokenizeHtml(str(n.attrs?.html) ?? ''));
      else builder.append(this.block(n, `${keyPrefix}${i}`));
    });
    return this.safe(builder.result(), keyPrefix, true);
  }

  block(node: JSONNode, key: string): ReactNode {
    switch (node.type) {
      case 'paragraph': {
        if (!node.content?.length) return null;
        return <p key={key}>{this.inline(node.content)}</p>;
      }
      case 'heading':
        return this.heading(node, key);
      case 'blockquote':
        return <blockquote key={key}>{this.blocks(node.content, `${key}-`)}</blockquote>;
      case 'bulletList':
        return <ul key={key}>{this.listItems(node)}</ul>;
      case 'orderedList': {
        const start = Number(node.attrs?.start ?? 1);
        return (
          <ol key={key} {...(Number.isInteger(start) && start !== 1 ? { start } : {})}>
            {this.listItems(node)}
          </ol>
        );
      }
      case 'taskList':
        return (
          <ul key={key} className="contains-task-list containsTaskList_mC6p">
            {this.listItems(node)}
          </ul>
        );
      case 'codeBlock':
        return (
          <CodeBlock
            key={key}
            code={nodeText(node)}
            language={str(node.attrs?.language)}
            title={str(node.attrs?.title)}
            meta={str(node.attrs?.meta)}
            strings={this.strings}
          />
        );
      case 'mermaid':
        return <Mermaid key={key} code={nodeText(node)} />;
      case 'bookmark': {
        const url = str(node.attrs?.url);
        if (!url) return null;
        return <p key={key}>{this.link(url, str(node.attrs?.title) ?? url, `${key}-link`)}</p>;
      }
      case 'video':
        return this.video(node, key);
      case 'mathBlock':
        return <div key={key} dangerouslySetInnerHTML={{ __html: mathHtml(node, true) }} />;
      case 'horizontalRule':
        return <hr key={key} />;
      case 'table':
        return this.table(node, key);
      case 'admonition':
        return (
          <Admonition
            key={key}
            type={str(node.attrs?.type) ?? 'note'}
            title={str(node.attrs?.title)}
            strings={this.strings}
          >
            {this.blocks(node.content, `${key}-`)}
          </Admonition>
        );
      case 'tabs': {
        const items = (node.content ?? []).filter((c) => c.type === 'tabItem');
        if (!items.length) return null;
        const tabs: TabMeta[] = items.map((item, i) => {
          const value = str(item.attrs?.value) ?? `tab${i + 1}`;
          return {
            value,
            label: str(item.attrs?.label) ?? value,
            default: item.attrs?.default === true,
          };
        });
        return (
          <Tabs key={key} groupId={str(node.attrs?.groupId)} tabs={tabs}>
            {items.map((item, i) => (
              <Fragment key={i}>{this.blocks(item.content, `${key}-${i}-`)}</Fragment>
            ))}
          </Tabs>
        );
      }
      case 'tabItem':
        return <Fragment key={key}>{this.blocks(node.content, `${key}-`)}</Fragment>;
      case 'toggle':
        return (
          <DetailsBlock key={key} summary={<summary>{str(node.attrs?.summary) ?? ''}</summary>}>
            {this.blocks(node.content, `${key}-`)}
          </DetailsBlock>
        );
      case 'truncate':
      case 'embed':
        // Embeds point into the Hub; published content never shows them.
        return null;
      case 'htmlBlock':
        return (
          <Fragment key={key}>
            {this.safe(this.sanitize(str(node.attrs?.html) ?? ''), key, true)}
          </Fragment>
        );
      case 'image':
        return this.image(node, key);
      default:
        // Unknown block: keep its text rather than lose content.
        return node.content ? (
          <Fragment key={key}>{this.blocks(node.content, `${key}-`)}</Fragment>
        ) : null;
    }
  }

  private video(node: JSONNode, key: string): ReactNode {
    const src = str(node.attrs?.src);
    const title = str(node.attrs?.title);
    const source = src ? videoSource(src) : null;
    if (source?.kind === 'player') {
      return (
        <iframe
          key={key}
          src={source.url}
          title={title ?? source.host}
          loading="lazy"
          allow="fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          style={{ width: '100%', aspectRatio: '16 / 9', border: 0 }}
        />
      );
    }
    if (source?.kind === 'file' && safeHref(source.src)) {
      return (
        <video
          key={key}
          src={source.src}
          controls
          preload="metadata"
          playsInline
          style={{ width: '100%' }}
        />
      );
    }
    return src ? <p key={key}>{this.link(src, title ?? src, `${key}-link`)}</p> : null;
  }

  private heading(node: JSONNode, key: string): ReactNode {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)));
    const h = this.nextHeading();
    const tag = `h${level}` as 'h1';
    const children = this.inline(node.content);
    if (level === 1 || !h) return createElement(tag, { key }, children);
    const label = fill(this.strings.directLink, { heading: h.text });
    return createElement(
      tag,
      { key, className: 'anchor anchorTargetStickyNavbar_Vzrq', id: h.id },
      children,
      <a
        key="hash"
        href={`#${h.id}`}
        className="hash-link"
        aria-label={label}
        title={label}
        translate="no"
      >
        {'​'}
      </a>,
    );
  }

  private listItems(list: JSONNode): ReactNode[] {
    const items = list.content ?? [];
    // Tight list: every item is one paragraph (plus nested lists), rendered without <p>.
    const tight = items.every(
      (item) => (item.content ?? []).filter((c) => c.type === 'paragraph').length <= 1,
    );
    return items.map((item, i) => {
      const children = (item.content ?? []).map((c, j) =>
        tight && c.type === 'paragraph' ? (
          <Fragment key={j}>{this.inline(c.content)}</Fragment>
        ) : (
          this.block(c, `li${i}-${j}`)
        ),
      );
      if (item.type === 'taskItem') {
        return (
          <li key={i} className="task-list-item">
            <input type="checkbox" disabled readOnly checked={item.attrs?.checked === true} />{' '}
            {children}
          </li>
        );
      }
      return <li key={i}>{children}</li>;
    });
  }

  private table(node: JSONNode, key: string): ReactNode {
    const rows = node.content ?? [];
    const cell = (c: JSONNode, j: number, header: boolean) => {
      const align = str(c.attrs?.align);
      const style: CSSProperties | undefined =
        align === 'left' || align === 'center' || align === 'right'
          ? { textAlign: align }
          : undefined;
      const content: ReactNode[] = (c.content ?? []).map((p, k) =>
        p.type === 'paragraph' ? (
          <Fragment key={k}>{this.inline(p.content)}</Fragment>
        ) : (
          this.block(p, `c${k}`)
        ),
      );
      return header ? (
        <th key={j} style={style}>
          {content}
        </th>
      ) : (
        <td key={j} style={style}>
          {content}
        </td>
      );
    };
    const [head, ...body] = rows;
    const headIsHeader = head?.content?.every((c) => c.type === 'tableHeader') ?? false;
    return (
      <table key={key}>
        {head && headIsHeader && (
          <thead>
            <tr>{(head.content ?? []).map((c, j) => cell(c, j, true))}</tr>
          </thead>
        )}
        <tbody>
          {(headIsHeader ? body : rows).map((row, i) => (
            <tr key={i}>
              {(row.content ?? []).map((c, j) => cell(c, j, c.type === 'tableHeader'))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  private image(node: JSONNode, key: string): ReactNode {
    const src = safeSrc(str(node.attrs?.src) ?? '');
    if (!src) return null;
    const title = str(node.attrs?.title);
    return (
      <img
        key={key}
        decoding="async"
        loading="lazy"
        alt={str(node.attrs?.alt) ?? ''}
        src={src}
        {...(title ? { title } : {})}
        className="img_ev3q"
      />
    );
  }

  // ----- inline

  inline(nodes: JSONNode[] | undefined): ReactNode[] {
    const list = nodes ?? [];
    if (list.some((n) => n.type === 'htmlInline')) return this.inlineWithHtml(list);
    const out: ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;
      const href = linkHref(node);
      if (!href) {
        out.push(this.inlineNode(node, `i${i}`));
        continue;
      }
      // consecutive nodes with the same link become one anchor
      const group: JSONNode[] = [node];
      while (i + 1 < list.length && linkHref(list[i + 1]!) === href) group.push(list[++i]!);
      out.push(
        this.link(
          href,
          group.map((n, j) => this.inlineNode(n, `l${j}`)),
          `i${i}`,
        ),
      );
    }
    return out;
  }

  private link(href: string, children: ReactNode, key: string): ReactNode {
    const safe = safeHref(href);
    if (!safe) return <Fragment key={key}>{children}</Fragment>;
    return (
      <SiteLink key={key} href={safe}>
        {children}
      </SiteLink>
    );
  }

  private inlineNode(node: JSONNode, key: string): ReactNode {
    if (node.type === 'hardBreak') return <br key={key} />;
    if (node.type === 'image') return this.image(node, key);
    if (node.type === 'mathInline') {
      return <span key={key} dangerouslySetInnerHTML={{ __html: mathHtml(node, false) }} />;
    }
    const text = inlineText(node);
    if (text === null) return null;
    let el: ReactNode = text;
    const marks = [...(node.marks ?? [])]
      .filter((m) => m.type !== 'link')
      .sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type));
    marks.forEach((m, j) => {
      const tag = MARK_TAG[m.type];
      if (tag) el = createElement(tag, { key: `${key}m${j}` }, el);
    });
    return <Fragment key={key}>{el}</Fragment>;
  }

  /** Inline content mixed with raw HTML: one token stream through the sanitizer. */
  private inlineWithHtml(nodes: JSONNode[]): ReactNode[] {
    const builder = new SafeTreeBuilder<ReactNode>();
    nodes.forEach((node, i) => {
      if (node.type === 'htmlInline') {
        builder.pushAll(tokenizeHtml(str(node.attrs?.html) ?? ''));
      } else if (node.type === 'hardBreak') {
        builder.push({ type: 'open', tag: 'br', attrs: {}, selfClosing: true });
      } else if (node.type === 'image') {
        builder.append(this.image(node, `img${i}`));
      } else if (node.type === 'mathInline') {
        builder.append(this.inlineNode(node, `math${i}`));
      } else if (inlineText(node) !== null) {
        const marks: JSONMark[] = [...(node.marks ?? [])].sort(
          (a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
        );
        const opens: HtmlToken[] = [];
        for (const m of marks) {
          if (m.type === 'link' && typeof m.attrs?.href === 'string') {
            opens.push({
              type: 'open',
              tag: 'a',
              attrs: { href: m.attrs.href },
              selfClosing: false,
            });
          } else if (MARK_TAG[m.type]) {
            opens.push({ type: 'open', tag: MARK_TAG[m.type]!, attrs: {}, selfClosing: false });
          }
        }
        builder.pushAll(opens);
        builder.push({ type: 'text', text: inlineText(node) ?? '' });
        for (const o of [...opens].reverse()) {
          if (o.type === 'open') builder.push({ type: 'close', tag: o.tag });
        }
      }
    });
    return this.safe(builder.result(), 'h', false);
  }

  // ----- sanitized HTML

  private sanitize(html: string): SafeNode<ReactNode>[] {
    const b = new SafeTreeBuilder<ReactNode>();
    b.pushAll(tokenizeHtml(html));
    return b.result();
  }

  safe(nodes: SafeNode<ReactNode>[], keyPrefix: string, block: boolean): ReactNode[] {
    return nodes.map((n, i) => {
      const key = `${keyPrefix}s${i}`;
      if (n.type === 'text') {
        // whitespace between block elements is not content
        return block && !n.text.trim() ? null : <Fragment key={key}>{n.text}</Fragment>;
      }
      if (n.type === 'external') return <Fragment key={key}>{n.value}</Fragment>;
      const children = this.safe(n.children, `${key}-`, block);
      switch (n.tag) {
        case 'br':
          return <br key={key} />;
        case 'img':
          return (
            <img
              key={key}
              src={n.attrs.src}
              alt={n.attrs.alt ?? ''}
              {...(n.attrs.width ? { width: n.attrs.width } : {})}
              {...(n.attrs.height ? { height: n.attrs.height } : {})}
              loading="lazy"
              decoding="async"
            />
          );
        case 'a':
          return n.attrs.href ? (
            <SiteLink key={key} href={n.attrs.href}>
              {children}
            </SiteLink>
          ) : (
            <Fragment key={key}>{children}</Fragment>
          );
        case 'details': {
          // Docusaurus <Details>: summary first, the rest in a collapsible body
          const summaryIndex = n.children.findIndex(
            (c) => c.type === 'element' && c.tag === 'summary',
          );
          const summary = summaryIndex >= 0 ? children[summaryIndex] : null;
          const rest = children.filter((_, j) => j !== summaryIndex);
          return (
            <DetailsBlock key={key} summary={summary} open={n.attrs.open !== undefined}>
              {rest}
            </DetailsBlock>
          );
        }
        default:
          return createElement(n.tag, { key }, ...children);
      }
    });
  }
}

/**
 * Renders a parsed document. With `extractTitle`, a leading level-1 heading is returned as the
 * title instead of being rendered (the page renders it in its header, as Docusaurus does).
 */
export function renderDocument(
  doc: EditorDoc,
  options: { strings: SiteStrings; extractTitle?: boolean },
): RenderedDoc {
  const all = docHeadings(doc);
  const renderer = new Renderer(options.strings, all);
  let blocks = doc.content ?? [];
  let title: string | null = null;
  const first = blocks[0];
  if (options.extractTitle && first?.type === 'heading' && Number(first.attrs?.level) === 1) {
    title = nodeText(first).trim();
    renderer.nextHeading();
    blocks = blocks.slice(1);
  }
  const content = renderer.blocks(blocks);
  const toc = buildToc(title ? all.slice(1) : all);
  const hasH1 = blocks.some((b) => b.type === 'heading' && Number(b.attrs?.level) === 1);
  return { title, content, toc, hasH1 };
}

/** Markdown string straight to React (excerpts, home "markdown" sections). */
export function renderMarkdown(
  markdown: string,
  strings: SiteStrings,
  extractTitle = false,
): RenderedDoc {
  return renderDocument(parseMarkdown(markdown), { strings, extractTitle });
}
