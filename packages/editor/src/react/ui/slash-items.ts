import type { Editor, Range } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { AdmonitionType, JSONNode } from '../../model';
import type { SlashItem } from '../extensions/slash';
import type { EditorLabels } from '../labels';
import { admonitionLabelKey } from './views';

export interface SlashContext {
  labels: EditorLabels;
  enableTruncate: boolean;
  /** Opens the image picker (upload) or URL prompt and inserts the result. */
  pickImage: (editor: Editor) => void;
  /** Opens the file picker and embeds the uploads; absent where files cannot be uploaded. */
  pickFile?: (editor: Editor) => void;
  /** Opens "turn into" for the block under the caret. */
  openTurnInto?: (editor: Editor) => void;
}

/**
 * Replaces the typed "/query" with a block and puts the caret in its first text block (or
 * after it for atoms).
 */
function insertBlock(editor: Editor, range: Range, node: JSONNode): void {
  editor.chain().focus().deleteRange(range).insertContent(node).run();
  // After insertion the caret sits at the end of the new block (e.g. in the last tab);
  // move it to the block's first text block.
  const { state } = editor;
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const block = $from.node(d);
    if (block.type.name !== node.type) continue;
    const start = $from.before(d);
    let target: number | null = null;
    block.descendants((child, pos) => {
      if (target !== null) return false;
      if (child.isTextblock) {
        target = start + 1 + pos + 1;
        return false;
      }
      return true;
    });
    if (target !== null) {
      editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)));
    }
    return;
  }
}

const ADMONITION_ITEMS: readonly AdmonitionType[] = ['note', 'tip', 'info', 'warning', 'danger'];

/** The "/" menu items in display order. */
export function slashItems(ctx: SlashContext): SlashItem[] {
  const { labels: l } = ctx;
  const items: SlashItem[] = [
    {
      id: 'text',
      title: l.slashText,
      description: l.slashTextDesc,
      keywords: ['paragraph', 'p'],
      icon: 'text',
      run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
    },
    ...([1, 2, 3] as const).map((level): SlashItem => ({
      id: `h${level}`,
      title: l[`slashHeading${level}`],
      description: l[`slashHeading${level}Desc`],
      keywords: ['heading', 'title', '#'.repeat(level)],
      icon: `h${level}`,
      run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level }).run(),
    })),
    {
      id: 'bulletList',
      title: l.slashBulletList,
      description: l.slashBulletListDesc,
      keywords: ['ul', 'list', 'bullet', '-'],
      icon: 'bulletList',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
    },
    {
      id: 'orderedList',
      title: l.slashOrderedList,
      description: l.slashOrderedListDesc,
      keywords: ['ol', 'list', 'numbered', '1.'],
      icon: 'orderedList',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
    },
    {
      id: 'taskList',
      title: l.slashTaskList,
      description: l.slashTaskListDesc,
      keywords: ['todo', 'task', 'checkbox', '[]'],
      icon: 'taskList',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
    },
    {
      id: 'quote',
      title: l.slashQuote,
      description: l.slashQuoteDesc,
      keywords: ['blockquote', '>'],
      icon: 'quote',
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
    },
    {
      id: 'codeBlock',
      title: l.slashCodeBlock,
      description: l.slashCodeBlockDesc,
      keywords: ['code', 'fence', '```', 'snippet'],
      icon: 'codeBlock',
      run: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run(),
    },
    ...(ctx.openTurnInto
      ? [
          {
            id: 'turnInto',
            title: l.blockTurnInto,
            description: l.slashTurnIntoDesc,
            keywords: ['turn', 'convert', 'change', 'tür', 'dönüştür', 'değiştir', 'çevir'],
            icon: 'turnInto',
            run: (e: Editor, r: Range) => {
              e.chain().focus().deleteRange(r).run();
              ctx.openTurnInto?.(e);
            },
          } satisfies SlashItem,
        ]
      : []),
    {
      id: 'table',
      title: l.slashTable,
      description: l.slashTableDesc,
      keywords: ['table', 'grid'],
      icon: 'table',
      run: (e, r) =>
        e
          .chain()
          .focus()
          .deleteRange(r)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    ...ADMONITION_ITEMS.map((type): SlashItem => ({
      id: `admonition-${type}`,
      title: l[admonitionLabelKey[type]],
      description: l.slashAdmonitionDesc,
      keywords: ['admonition', 'callout', type, ':::'],
      icon: type,
      run: (e, r) => {
        const chain = e.chain().focus().deleteRange(r);
        if (!chain.setAdmonition(type).run()) {
          insertBlock(
            e,
            { from: e.state.selection.from, to: e.state.selection.from },
            {
              type: 'admonition',
              attrs: { type, title: null },
              content: [{ type: 'paragraph' }],
            },
          );
        }
      },
    })),
    {
      id: 'tabs',
      title: l.slashTabs,
      description: l.slashTabsDesc,
      keywords: ['tabs', 'tab'],
      icon: 'tabs',
      run: (e, r) =>
        insertBlock(e, r, {
          type: 'tabs',
          attrs: { groupId: null },
          content: [1, 2].map((n) => ({
            type: 'tabItem',
            attrs: { value: `tab${n}`, label: `${l.tabsNewTab} ${n}`, default: false },
            content: [{ type: 'paragraph' }],
          })),
        }),
    },
    ...([2, 3] as const).map((count): SlashItem => ({
      id: `columns${count}`,
      title: l[`slashColumns${count}`],
      description: l.slashColumnsDesc,
      keywords: ['columns', 'layout', 'side', 'sütun', 'kolon'],
      icon: 'columns',
      run: (e, r) =>
        insertBlock(e, r, {
          type: 'columns',
          content: Array.from({ length: count }, () => ({
            type: 'column',
            content: [{ type: 'paragraph' }],
          })),
        }),
    })),
    {
      id: 'toggle',
      title: l.slashToggle,
      description: l.slashToggleDesc,
      keywords: ['toggle', 'collapse', 'details', 'accordion', 'fold'],
      icon: 'toggle',
      run: (e, r) =>
        insertBlock(e, r, {
          type: 'toggle',
          attrs: { summary: '' },
          content: [{ type: 'paragraph' }],
        }),
    },
    ...([1, 2, 3] as const).map((level): SlashItem => ({
      id: `toggleH${level}`,
      title: l[`slashToggleHeading${level}`],
      description: l.slashToggleHeadingDesc,
      keywords: ['toggle', 'collapse', 'heading', 'title', '#'.repeat(level)],
      icon: 'toggle',
      run: (e, r) =>
        insertBlock(e, r, {
          type: 'toggle',
          attrs: { summary: '', level },
          content: [{ type: 'paragraph' }],
        }),
    })),
    {
      id: 'bookmark',
      title: l.slashBookmark,
      description: l.slashBookmarkDesc,
      keywords: ['bookmark', 'link', 'url', 'card', 'yer imi', 'bağlantı'],
      icon: 'link',
      run: (e, r) => insertBlock(e, r, { type: 'bookmark', attrs: { url: '' } }),
    },
    {
      id: 'video',
      title: l.slashVideo,
      description: l.slashVideoDesc,
      keywords: ['video', 'youtube', 'vimeo', 'mp4', 'film'],
      icon: 'play',
      run: (e, r) => insertBlock(e, r, { type: 'video', attrs: { src: '' } }),
    },
    {
      id: 'mathBlock',
      title: l.slashMath,
      description: l.slashMathDesc,
      keywords: ['math', 'latex', 'katex', 'formula', 'equation', 'formül', 'denklem'],
      icon: 'math',
      run: (e, r) => insertBlock(e, r, { type: 'mathBlock', attrs: { latex: '' } }),
    },
    {
      id: 'mathInline',
      title: l.slashMathInline,
      description: l.slashMathInlineDesc,
      keywords: ['math', 'latex', 'katex', 'inline', 'formül'],
      icon: 'math',
      run: (e, r) =>
        e
          .chain()
          .focus()
          .deleteRange(r)
          .insertContent({ type: 'mathInline', attrs: { latex: '' } })
          .run(),
    },
    {
      id: 'mermaid',
      title: l.slashMermaid,
      description: l.slashMermaidDesc,
      keywords: ['mermaid', 'diagram', 'chart', 'flowchart'],
      icon: 'mermaid',
      run: (e, r) => insertBlock(e, r, { type: 'mermaid' }),
    },
    {
      id: 'image',
      title: l.slashImage,
      description: l.slashImageDesc,
      keywords: ['image', 'img', 'picture', 'photo'],
      icon: 'image',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        ctx.pickImage(e);
      },
    },
    ...(ctx.pickFile
      ? [
          {
            id: 'file',
            title: l.slashFile,
            description: l.slashFileDesc,
            keywords: ['file', 'attach', 'attachment', 'upload', 'pdf', 'dosya', 'ek', 'yükle'],
            icon: 'file',
            run: (e: Editor, r: Range) => {
              e.chain().focus().deleteRange(r).run();
              ctx.pickFile?.(e);
            },
          } satisfies SlashItem,
        ]
      : []),
    {
      id: 'divider',
      title: l.slashDivider,
      description: l.slashDividerDesc,
      keywords: ['hr', 'divider', 'rule', '---'],
      icon: 'divider',
      run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
    },
  ];
  if (ctx.enableTruncate) {
    items.push({
      id: 'truncate',
      title: l.slashTruncate,
      description: l.slashTruncateDesc,
      keywords: ['truncate', 'summary', 'more', 'excerpt'],
      icon: 'truncate',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'truncate' }).run(),
    });
  }
  items.push({
    id: 'html',
    title: l.slashHtml,
    description: l.slashHtmlDesc,
    keywords: ['html', 'raw', 'embed'],
    icon: 'html',
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertContent({ type: 'htmlBlock', attrs: { html: '' } })
        .run(),
  });
  return items;
}
