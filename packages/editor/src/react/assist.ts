import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { docToMarkdown } from '../markdown';
import type { EditorDoc } from '../model';
import { markdownToBlocks } from './extensions/paste';

/**
 * Helpers for writing assistants (the host's AI menu): read a range as markdown, mark the range
 * while a suggestion is previewed, and put the accepted text into the document as one undoable
 * step (Ctrl+Z, or the Yjs undo manager when collaborating). The editor itself never calls a model.
 */

export interface AssistRange {
  from: number;
  to: number;
}

const assistKey = new PluginKey<AssistRange | null>('chAssist');

/**
 * Highlights the range a suggestion is about (`.ch-assist-range`) and keeps it in place while
 * others edit. Add it through `RichEditorProps.extensions`.
 */
export const AssistHighlight = Extension.create({
  name: 'assistHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<AssistRange | null>({
        key: assistKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(assistKey) as AssistRange | null | undefined;
            if (meta !== undefined) return meta;
            if (!value || !tr.docChanged) return value;
            const from = tr.mapping.map(value.from, 1);
            const to = tr.mapping.map(value.to, -1);
            return from < to ? { from, to } : null;
          },
        },
        props: {
          decorations(state) {
            const r = assistKey.getState(state);
            if (!r) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(r.from, r.to, { class: 'ch-assist-range' }),
            ]);
          },
        },
      }),
    ];
  },
});

/** Shows (or with null clears) the highlighted range. No-op without AssistHighlight. */
export function setAssistRange(editor: Editor, range: AssistRange | null): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(assistKey, range).setMeta('addToHistory', false));
}

/** The highlighted range after everyone's edits so far, or null. */
export function assistRange(editor: Editor): AssistRange | null {
  return assistKey.getState(editor.state) ?? null;
}

/** The range as markdown (lists, headings and marks kept); plain text when it cannot be. */
export function rangeMarkdown(editor: Editor, from: number, to: number): string {
  const doc = editor.state.doc;
  try {
    const content = doc.slice(from, to).content.toJSON() as JSONContent[] | null;
    const md = docToMarkdown({ type: 'doc', content: content ?? [] } as EditorDoc).trim();
    if (md) return md;
  } catch {
    // Partial tables and other open nodes: fall back to the text.
  }
  return doc.textBetween(from, to, '\n\n', ' ').trim();
}

/** Up to `maxChars` of markdown that ends at `pos` (context for "continue writing"). */
export function markdownBefore(editor: Editor, pos: number, maxChars: number): string {
  const md = rangeMarkdown(editor, 0, pos);
  return md.length > maxChars ? md.slice(md.length - maxChars) : md;
}

export type AssistApplyMode = 'replace' | 'below' | 'continue';

/**
 * Puts markdown into the document in one transaction:
 * - `replace`: instead of the range (a one-paragraph answer stays inline in its paragraph);
 * - `below`: as new blocks after the top-level block that holds the end of the range;
 * - `continue`: right after the range's end (inline when it is one paragraph).
 * Returns false when nothing could be inserted.
 */
export function applyAssistResult(
  editor: Editor,
  range: AssistRange,
  markdown: string,
  mode: AssistApplyMode,
): boolean {
  const text = markdown.trim();
  if (!text || editor.isDestroyed) return false;
  const size = editor.state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, size));
  const to = Math.max(from, Math.min(range.to, size));
  let blocks: JSONContent[];
  try {
    blocks = markdownToBlocks(text) as JSONContent[];
  } catch {
    blocks = [{ type: 'paragraph', content: [{ type: 'text', text }] }];
  }
  if (blocks.length === 0) return false;
  const single = blocks.length === 1 && blocks[0]!.type === 'paragraph';
  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  const sameTextblock = $from.sameParent($to) && $from.parent.isTextblock;

  const insert = (at: number | AssistRange, content: JSONContent | JSONContent[]) => {
    try {
      return editor
        .chain()
        .focus()
        .insertContentAt(at, content, { errorOnInvalidContent: true })
        .run();
    } catch {
      return editor.chain().focus().insertContentAt(at, text).run();
    }
  };

  if (mode === 'replace') {
    if (single && sameTextblock) return insert({ from, to }, blocks[0]!.content ?? []);
    return insert({ from, to }, blocks);
  }
  if (mode === 'continue' && single && $to.parent.isTextblock) {
    const before = $to.parent.textBetween(0, $to.parentOffset);
    const space = before && !/\s$/.test(before) ? ' ' : '';
    const inline = blocks[0]!.content ?? [];
    return insert(to, space ? [{ type: 'text', text: space }, ...inline] : inline);
  }
  const after = $to.depth >= 1 ? $to.after(1) : to;
  return insert(after, blocks);
}
