import type { AnyExtension, Extensions, NodeViewRenderer } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import type { Doc as YDoc } from 'yjs';
import { starterKitMembers } from './kit';
import { createCodeBlock, createImage } from './media';
import {
  Admonition,
  Bookmark,
  ColorMark,
  Column,
  Columns,
  Embed,
  HtmlBlock,
  HtmlInline,
  MathBlock,
  MathInline,
  Mention,
  Mermaid,
  TabItem,
  Tabs,
  Toggle,
  Toc,
  Truncate,
  Video,
} from './nodes';
import { PasteHandler, type PasteOptions } from './paste';
import { BlockKeys, ColumnKeys, ListItemDrop } from './blocks';
import { ColumnWidths } from './columns';
import { FindReplace } from './find';
import { TouchBlockDrag } from './touch-drag';
import { SlashCommand, type SlashOptions } from './slash';
import { TaskItem, TaskList } from './task-list';
import { UnknownBlock, UnknownMark } from './unknown';

/** Nodes that the React editor draws with its own views. */
export type ViewNodeName =
  | 'admonition'
  | 'tabs'
  | 'mermaid'
  | 'codeBlock'
  | 'truncate'
  | 'toc'
  | 'unknownBlock'
  | 'htmlBlock'
  | 'htmlInline'
  | 'toggle'
  | 'embed'
  | 'mathBlock'
  | 'mathInline'
  | 'bookmark'
  | 'video'
  | 'column';

export interface CollaborationOptions {
  /** The shared document. The provider (Hocuspocus, y-websocket …) is the host's job. */
  doc: YDoc;
  /** Y.XmlFragment name inside the doc; default `'default'`. */
  field?: string;
  /**
   * The provider connected to `doc` (Hocuspocus …); with it, remote carets and selections
   * are shown (`@tiptap/extension-collaboration-caret`). Null/absent = offline, no carets.
   */
  provider?: CollaborationCaretProvider | null;
  /** This person as others see their caret. */
  user?: { name: string; color: string };
}

/** What CollaborationCaret needs from a provider: its Yjs awareness. */
export interface CollaborationCaretProvider {
  awareness: unknown;
}

export interface CreateExtensionsOptions {
  /** Placeholder for the empty block under the caret (empty = none). */
  placeholder?: string | (() => string);
  /**
   * Yjs-ready: with a Y.Doc the editor content lives in `doc.getXmlFragment(field)` and
   * StarterKit's undo/redo is replaced by the Yjs undo manager. To add real-time editing later,
   * connect a provider to the same Y.Doc (e.g. `new HocuspocusProvider({ document: doc, … })`)
   * and add `@tiptap/extension-collaboration-caret` with that provider for remote cursors.
   * The initial content then comes from the Y.Doc (seed it on the server), not from `value`.
   */
  collaboration?: CollaborationOptions;
  /** Maps a stored image src to a loadable URL (editor display only). */
  resolveImageUrl?: (src: string) => string;
  /** Uploads pasted / dropped image files. */
  uploadImage?: PasteOptions['uploadImage'];
  uploadFile?: PasteOptions['uploadFile'];
  onUploadError?: PasteOptions['onUploadError'];
  /** Interactive views (the React editor passes them; headless use leaves them out). */
  nodeViews?: Partial<Record<ViewNodeName, NodeViewRenderer>>;
  /** "/" menu (React editor only). */
  slash?: SlashOptions;
  /** Column resizing writes `colwidth`, which markdown cannot store; off by default. */
  resizableTables?: boolean;
  /**
   * Host extensions added after the built-in ones (e.g. the wiki's "@" / "[[" suggestions and
   * comment highlights). They must not add nodes or marks: the schema is the document model.
   */
  extensions?: Extensions;
}

function withView(ext: AnyExtension, view: NodeViewRenderer | undefined): AnyExtension {
  return view ? ext.extend({ addNodeView: () => view }) : ext;
}

/**
 * The editor extensions; their schema is exactly the document model in `src/model.ts`, so
 * `getJSON()` of a document from `markdownToDoc` is unchanged. Without options it is the
 * headless set used for validation (`validateDoc`) and server-side rendering.
 */
export function createExtensions(options: CreateExtensionsOptions = {}): Extensions {
  const views = options.nodeViews ?? {};
  const placeholder = options.placeholder ?? '';
  const extensions: Extensions = [
    ...starterKitMembers({ undoRedo: !options.collaboration }),
    withView(createCodeBlock(), views.codeBlock),
    createImage(options.resolveImageUrl),
    TaskList,
    TaskItem,
    Table.configure({
      resizable: options.resizableTables ?? false,
      allowTableNodeSelection: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    withView(Admonition, views.admonition),
    withView(Tabs, views.tabs),
    TabItem,
    withView(Mermaid, views.mermaid),
    withView(Truncate, views.truncate),
    withView(Toc, views.toc),
    withView(UnknownBlock, views.unknownBlock),
    withView(HtmlBlock, views.htmlBlock),
    withView(HtmlInline, views.htmlInline),
    withView(Toggle, views.toggle),
    withView(Embed, views.embed),
    Columns,
    withView(Column, views.column),
    ColumnWidths,
    withView(MathBlock, views.mathBlock),
    withView(MathInline, views.mathInline),
    withView(Bookmark, views.bookmark),
    withView(Video, views.video),
    Mention,
    ColorMark,
    UnknownMark,
    Placeholder.configure({
      placeholder: () => (typeof placeholder === 'function' ? placeholder() : placeholder),
      showOnlyCurrent: true,
      includeChildren: true,
    }),
    BlockKeys,
    ColumnKeys,
    ListItemDrop,
    TouchBlockDrag,
    FindReplace,
    PasteHandler.configure({
      uploadImage: options.uploadImage,
      uploadFile: options.uploadFile,
      onUploadError: options.onUploadError,
    }),
  ];
  if (options.slash) extensions.push(SlashCommand.configure(options.slash));
  if (options.collaboration) {
    extensions.push(
      Collaboration.configure({
        document: options.collaboration.doc,
        field: options.collaboration.field ?? 'default',
      }),
    );
    const { provider, user } = options.collaboration;
    if (provider) {
      extensions.push(
        CollaborationCaret.configure({
          provider,
          user: user ?? { name: '', color: '#F38424' },
        }),
      );
    }
  }
  if (options.extensions) extensions.push(...options.extensions);
  return extensions;
}

export {
  Admonition,
  ColorMark,
  Column,
  Columns,
  Embed,
  HtmlBlock,
  HtmlInline,
  Mention,
  Mermaid,
  TabItem,
  Tabs,
  TaskItem,
  TaskList,
  Toggle,
  Truncate,
};
export { SlashStore, filterSlashItems, type SlashItem, type SlashMenuState } from './slash';
export { looksLikeMarkdown, markdownToBlocks } from './paste';
