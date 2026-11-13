import { InputRule, Mark, mergeAttributes, Node } from '@tiptap/core';
import {
  columnWidth,
  isAdmonitionType,
  isBlockColor,
  isMentionKind,
  type AdmonitionType,
  MAX_COLUMNS,
} from '../../model';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    admonition: {
      /** Wraps the selected blocks in an admonition (`:::type`). */
      setAdmonition: (type: AdmonitionType) => ReturnType;
    };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Docusaurus admonition (`:::note[Title]`). The title is plain text; the body is blocks. */
export const Admonition = Node.create({
  name: 'admonition',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'note',
        parseHTML: (el: HTMLElement) => {
          const t = el.getAttribute('data-admonition-type') ?? '';
          return isAdmonitionType(t) ? t : 'note';
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-admonition-type': String(attrs.type),
        }),
      },
      title: {
        default: null,
        parseHTML: (el: HTMLElement) => str(el.getAttribute('data-title')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const title = str(attrs.title);
          return title ? { 'data-title': title } : {};
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="admonition"]',
        contentElement: (el: HTMLElement) =>
          el.querySelector<HTMLElement>(':scope > [data-admonition-content]') ?? el,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'admonition' }),
      ['div', { 'data-admonition-content': '' }, 0],
    ];
  },

  addCommands() {
    return {
      setAdmonition:
        (type) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type, title: null }),
    };
  },
});

/** Docusaurus `<Tabs groupId>`; holds one or more tab items. */
export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tabItem+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      groupId: {
        default: null,
        parseHTML: (el: HTMLElement) => str(el.getAttribute('data-group-id')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const id = str(attrs.groupId);
          return id ? { 'data-group-id': id } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tabs"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tabs' }), 0];
  },
});

/** Docusaurus `<TabItem value label default>`. */
export const TabItem = Node.create({
  name: 'tabItem',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      value: {
        default: 'tab',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-value') ?? 'tab',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-value': String(attrs.value) }),
      },
      label: {
        default: null,
        parseHTML: (el: HTMLElement) => str(el.getAttribute('data-label')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const label = str(attrs.label);
          return label ? { 'data-label': label } : {};
        },
      },
      default: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute('data-default'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.default === true ? { 'data-default': '' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tab-item"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tab-item' }), 0];
  },
});

/** A ```mermaid fence: plain text content, rendered as a diagram by the host when possible. */
export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    return [{ tag: 'pre[data-type="mermaid"]', preserveWhitespace: 'full' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { 'data-type': 'mermaid' }), ['code', 0]];
  },

  addKeyboardShortcuts() {
    return {
      // Leave the diagram with three Enters at the end, like a code block.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type !== this.type) return false;
        const atEnd = $from.parentOffset === $from.parent.content.size;
        if (!atEnd || !$from.parent.textContent.endsWith('\n\n')) return false;
        return editor
          .chain()
          .command(({ tr }) => {
            tr.delete($from.pos - 2, $from.pos);
            return true;
          })
          .exitCode()
          .run();
      },
    };
  },
});

/** Docusaurus `<!-- truncate -->`: the blog summary ends here. */
export const Truncate = Node.create({
  name: 'truncate',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="truncate"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'truncate' })];
  },
});

/** "İçindekiler": draws the document's headings where it is placed; it holds no text itself. */
export const Toc = Node.create({
  name: 'toc',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="toc"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toc' })];
  },
});

/** Raw HTML block kept as written. It is shown as text and never rendered. */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      html: { default: '', rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-type="html-block"]',
        getAttrs: (el: HTMLElement) => ({ html: el.textContent ?? '' }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-type': 'html-block' }),
      String(node.attrs.html ?? ''),
    ];
  },
});

/** Raw inline HTML kept as written. It is shown as text and never rendered. */
export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: { default: '', rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'code[data-type="html-inline"]',
        getAttrs: (el: HTMLElement) => ({ html: el.textContent ?? '' }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'code',
      mergeAttributes(HTMLAttributes, { 'data-type': 'html-inline' }),
      String(node.attrs.html ?? ''),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.html ?? '');
  },
});

/**
 * Wiki collapsible block (`:::toggle[Summary]`, as a heading `:::toggle[Summary]{level=2}`).
 * Open/closed is view state, not stored. A client that does not know `level` shows a plain toggle.
 */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-summary') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => {
          const summary = str(attrs.summary);
          return summary ? { 'data-summary': summary } : {};
        },
      },
      level: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-level')) || null,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.level ? { 'data-level': String(attrs.level) } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="toggle"]',
        contentElement: (el: HTMLElement) =>
          el.querySelector<HTMLElement>(':scope > [data-toggle-content]') ?? el,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'toggle' }),
      ['div', { 'data-toggle-content': '' }, 0],
    ];
  },
});

const latexAttr = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? '',
    renderHTML: (attrs: Record<string, unknown>) => ({ 'data-latex': str(attrs.latex) }),
  },
};

/** LaTeX on its own lines; the React view draws it with KaTeX. */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return latexAttr;
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mathBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mathBlock' })];
  },
});

/** LaTeX inside a line; typing `$$x$$` makes one. */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return latexAttr;
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mathInline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mathInline' })];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\$\$([^$\n]+)\$\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },
});

/** A card for a web page; the host may fill in its title and icon. */
export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: '', rendered: false },
      title: { default: null, rendered: false },
      favicon: { default: null, rendered: false },
      description: { default: null, rendered: false },
      image: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'a[data-type="bookmark"]',
        getAttrs: (el: HTMLElement) => ({
          url: el.getAttribute('href') ?? '',
          title: el.textContent || null,
          description: el.getAttribute('data-description') || null,
          image: el.getAttribute('data-image') || null,
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const url = str(node.attrs.url) ?? '';
    const description = str(node.attrs.description);
    const image = str(node.attrs.image);
    return [
      'a',
      {
        'data-type': 'bookmark',
        href: url,
        ...(description ? { 'data-description': description } : {}),
        ...(image ? { 'data-image': image } : {}),
      },
      str(node.attrs.title) ?? url,
    ];
  },
});

/** A video: a player of a known host or a file (`videoSource`), drawn by the React view. */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-src') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-src': str(attrs.src) }),
      },
      title: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="video"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'video' })];
  },
});

/** Side by side blocks (`::::columns` + `:::column`). Narrow screens stack them (editor.css). */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: `column{2,${MAX_COLUMNS}}`,
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns' }), 0];
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  // Backspace at the start of a column does not pull it into its neighbour.
  isolating: true,

  addAttributes() {
    return {
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => columnWidth(el.getAttribute('data-width')),
        renderHTML: (attrs: Record<string, unknown>) => columnWidthAttrs(attrs.width),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column' }), 0];
  },
});

/** A resized column's DOM attributes: its width for the markup and its share for the layout. */
export function columnWidthAttrs(value: unknown): Record<string, string> {
  const width = columnWidth(value);
  return width === null ? {} : { 'data-width': String(width), style: `--ch-col: ${width}` };
}

/** Wiki embed of another Hub node (`::embed{node="…" type="…"}`); the host draws the preview. */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      nodeId: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-node-id') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-node-id': String(attrs.nodeId) }),
      },
      nodeType: {
        default: null,
        parseHTML: (el: HTMLElement) => str(el.getAttribute('data-node-type')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const type = str(attrs.nodeType);
          return type ? { 'data-node-type': type } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embed"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'embed' })];
  },
});

/** Wiki mention of a user, node or date (`[@label](mention:<kind>:<id>)`), shown as a chip. */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-id': String(attrs.id) }),
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-label': String(attrs.label) }),
      },
      kind: {
        default: 'user',
        parseHTML: (el: HTMLElement) => {
          const kind = el.getAttribute('data-kind') ?? '';
          return isMentionKind(kind) ? kind : 'user';
        },
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-kind': String(attrs.kind) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = isMentionKind(String(node.attrs.kind)) ? String(node.attrs.kind) : 'user';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'mention',
        class: `ch-mention ch-mention-${kind}`,
      }),
      `@${String(node.attrs.label ?? '')}`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs.label ?? '')}`;
  },
});

/**
 * Text color or tinted background (model: the `color` mark, `BlockColor`). The block menu sets it
 * over a whole block; one color per text, a new one replaces the old.
 */
export const ColorMark = Mark.create({
  name: 'color',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-color');
          return isBlockColor(v) ? v : null;
        },
        renderHTML: (attrs) => (isBlockColor(attrs.color) ? { 'data-color': attrs.color } : {}),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-color]',
        getAttrs: (el) => (isBlockColor(el.getAttribute('data-color')) ? null : false),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'ch-color' }, HTMLAttributes), 0];
  },
});
