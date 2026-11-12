import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { markdownToDoc } from '../../markdown';
import type { JSONNode } from '../../model';

export interface PasteOptions {
  /** Uploads an image file; returns the src to store. Without it image files are ignored. */
  uploadImage?: (file: File) => Promise<{ src: string; alt?: string }>;
  /**
   * Uploads any other file; returns the node to embed. Without it those files are ignored and
   * the default paste or drop applies.
   */
  uploadFile?: (file: File) => Promise<{ nodeId: string; nodeType: string }>;
  /** Called when an upload fails (the host shows a toast). */
  onUploadError?: (error: unknown) => void;
}

/** Text that is very likely markdown: headings, lists, fences, admonitions, quotes, tables. */
export function looksLikeMarkdown(text: string): boolean {
  return [
    /^#{1,6}\s+\S/m,
    /^\s{0,3}[-*+]\s+\S/m,
    /^\s{0,3}\d{1,9}[.)]\s+\S/m,
    /^\s{0,3}(```|~~~)/m,
    /^\s{0,3}:::[a-z]/m,
    /^\s{0,3}>\s/m,
    /^\s*\|?.*\|.*\n\s*\|?\s*:?-{3,}/m,
  ].some((re) => re.test(text));
}

/** Markdown → blocks for insertion (front matter is dropped). */
export function markdownToBlocks(markdown: string): JSONNode[] {
  return markdownToDoc(markdown).doc.content ?? [];
}

/** HTML that only styles plain text (code editors copy it this way): no structural tags. */
const isStyledPlainText = (html: string) =>
  !/<(h[1-6]|ul|ol|li|table|p|blockquote|img|a|strong|em|b|i)[\s>]/i.test(html);

const isImage = (f: File) => f.type.startsWith('image/');
const isVideo = (f: File) => f.type.startsWith('video/');

/** The files the host can take: images with `uploadImage`, the rest with `uploadFile`. */
const accepted = (files: File[], options: PasteOptions): File[] =>
  files.filter((f) => (isImage(f) ? options.uploadImage : options.uploadFile));

/** A screenshot is in `files` in most browsers; some only list it under `items`. */
function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  const files = Array.from(data?.files ?? []);
  if (files.length) return files;
  return Array.from(data?.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
}

/**
 * Office and spreadsheets put a picture of the selection next to its text: the text is what was
 * copied. Text that only names the files (a file manager's copy) is not.
 */
function textWins(data: DataTransfer | null | undefined, files: File[]): boolean {
  const text = data?.getData('text/plain').trim() ?? '';
  return text !== '' && !files.some((f) => f.name !== '' && text.includes(f.name));
}

interface Uploading {
  id: object;
  pos: number;
}

const uploadsKey = new PluginKey<Uploading[]>('chImageUploads');

/**
 * Where a position lands after a transaction. A remote Yjs change replaces the whole document,
 * which would throw everything to its end; there the real change is found by comparing.
 */
function mapThrough(tr: Transaction, pos: number): number {
  if (!tr.getMeta('y-sync$')) return tr.mapping.map(pos, 1);
  const start = tr.before.content.findDiffStart(tr.doc.content);
  const end = tr.before.content.findDiffEnd(tr.doc.content);
  if (start === null || start === undefined || !end) return pos;
  if (pos <= start) return pos;
  if (pos >= end.a) return pos + end.b - end.a;
  return start;
}

function uploadingMark(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'ch-image-uploading';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function insideCode(view: EditorView): boolean {
  return view.state.selection.$from.parent.type.spec.code === true;
}

/** Uploads one after the other; a placeholder holds the place while the page keeps changing. */
export async function uploadAndInsert(
  editor: Editor,
  files: File[],
  pos: number | null,
  options: PasteOptions,
): Promise<void> {
  const id = {};
  const { view } = editor;
  const at = pos ?? view.state.selection.from;
  view.dispatch(view.state.tr.setMeta(uploadsKey, { add: { id, pos: at } }));
  const place = () => uploadsKey.getState(editor.state)?.find((u) => u.id === id)?.pos;
  for (const file of files) {
    try {
      const node = await uploadedNode(file, options);
      if (editor.isDestroyed) return;
      if (!node) continue;
      const to = Math.min(place() ?? at, editor.state.doc.content.size);
      editor.chain().insertContentAt(to, node).run();
    } catch (error) {
      options.onUploadError?.(error);
    }
  }
  if (!editor.isDestroyed) view.dispatch(view.state.tr.setMeta(uploadsKey, { remove: id }));
}

async function uploadedNode(file: File, options: PasteOptions): Promise<JSONNode | null> {
  if (isImage(file)) {
    if (!options.uploadImage) return null;
    const { src, alt } = await options.uploadImage(file);
    return { type: 'image', attrs: { src, alt: alt ?? null, title: null } };
  }
  if (!options.uploadFile) return null;
  const attrs = await options.uploadFile(file);
  if (isVideo(file)) {
    return { type: 'video', attrs: { src: `node:${attrs.nodeId}`, title: file.name || null } };
  }
  return { type: 'embed', attrs };
}

/** The places where uploads will land, shown as small placeholders. */
const uploadPlaceholders = () =>
  new Plugin<Uploading[]>({
    key: uploadsKey,
    state: {
      init: () => [],
      apply: (tr, value) => {
        let next = tr.docChanged ? value.map((u) => ({ ...u, pos: mapThrough(tr, u.pos) })) : value;
        const meta = tr.getMeta(uploadsKey) as { add?: Uploading; remove?: object } | undefined;
        if (meta?.add) next = [...next, meta.add];
        if (meta?.remove) next = next.filter((u) => u.id !== meta.remove);
        return next;
      },
    },
    props: {
      decorations: (state) => {
        const items = uploadsKey.getState(state) ?? [];
        if (!items.length) return DecorationSet.empty;
        return DecorationSet.create(
          state.doc,
          items.map((u) =>
            Decoration.widget(Math.min(u.pos, state.doc.content.size), uploadingMark, {
              side: 1,
              key: 'upload',
            }),
          ),
        );
      },
    },
  });

/**
 * Files (pasted or dropped) go through `uploadImage` or `uploadFile`; pasted markdown text is
 * converted.
 */
export const PasteHandler = Extension.create<PasteOptions>({
  name: 'chPaste',

  addOptions() {
    return { uploadImage: undefined, uploadFile: undefined, onUploadError: undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      uploadPlaceholders(),
      new Plugin({
        key: new PluginKey('chPaste'),
        props: {
          handlePaste: (view, event) => {
            const files = accepted(clipboardFiles(event.clipboardData), options);
            if (files.length && !textWins(event.clipboardData, files)) {
              void uploadAndInsert(editor, files, null, options);
              return true;
            }
            if (insideCode(view)) return false;
            const text = event.clipboardData?.getData('text/plain') ?? '';
            const html = event.clipboardData?.getData('text/html') ?? '';
            // Rich HTML from a page wins; plain text (or code-editor HTML) that looks like
            // markdown is parsed.
            if (!text || (html && !isStyledPlainText(html)) || !looksLikeMarkdown(text)) {
              return false;
            }
            const blocks = markdownToBlocks(text);
            if (!blocks.length) return false;
            editor.chain().insertContent(blocks).run();
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved) return false;
            const files = accepted(Array.from(event.dataTransfer?.files ?? []), options);
            if (!files.length) return false;
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
            event.preventDefault();
            void uploadAndInsert(editor, files, coords?.pos ?? null, options);
            return true;
          },
        },
      }),
    ];
  },
});
