import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';

/**
 * Comment anchors (design 5.9, doc 17 "anchor bytea (Yjs göreli konum)"): a thread stores
 * the Yjs relative positions of its range, so it follows the text through everyone's edits.
 * The plugin underlines anchored ranges; the active thread is darker.
 */

export interface CommentAnchor {
  id: string;
  start: string;
  end: string;
}

interface PluginState {
  anchors: CommentAnchor[];
  active: string | null;
}

export const commentsKey = new PluginKey<PluginState>('wikiComments');

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Binding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Parameters<typeof absolutePositionToRelativePosition>[2];
}

function binding(state: EditorState): Binding | null {
  const ys = ySyncPluginKey.getState(state) as
    { binding?: Binding; type?: Y.XmlFragment; doc?: Y.Doc } | undefined;
  if (!ys?.binding) return null;
  return ys.binding;
}

/** The current selection as relative positions (null outside collab or when empty). */
export function selectionAnchor(
  editor: Editor,
): { start: string; end: string; quote: string } | null {
  const { from, to } = editor.state.selection;
  if (from === to || !editor.state.doc.textBetween(from, to, ' ').trim()) return null;
  const b = binding(editor.state);
  if (!b) return null;
  const start = absolutePositionToRelativePosition(from, b.type, b.mapping);
  const end = absolutePositionToRelativePosition(to, b.type, b.mapping);
  return {
    start: toB64(Y.encodeRelativePosition(start)),
    end: toB64(Y.encodeRelativePosition(end)),
    quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 500),
  };
}

/** Absolute range of an anchor, or null when its text is gone ("Sayfa geneli"). */
export function anchorRange(state: EditorState, a: { start: string; end: string }) {
  const b = binding(state);
  if (!b) return null;
  try {
    const from = relativePositionToAbsolutePosition(
      b.doc,
      b.type,
      Y.decodeRelativePosition(fromB64(a.start)),
      b.mapping,
    );
    const to = relativePositionToAbsolutePosition(
      b.doc,
      b.type,
      Y.decodeRelativePosition(fromB64(a.end)),
      b.mapping,
    );
    if (from === null || to === null || to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

export function setCommentAnchors(editor: Editor, anchors: CommentAnchor[], active: string | null) {
  editor.view.dispatch(editor.state.tr.setMeta(commentsKey, { anchors, active }));
}

export function CommentHighlights(onClick: (threadId: string) => void) {
  return Extension.create({
    name: 'wikiComments',
    addProseMirrorPlugins() {
      return [
        new Plugin<PluginState>({
          key: commentsKey,
          state: {
            init: () => ({ anchors: [], active: null }),
            apply: (tr, prev) => (tr.getMeta(commentsKey) as PluginState | undefined) ?? prev,
          },
          props: {
            decorations(state) {
              const s = commentsKey.getState(state);
              if (!s?.anchors.length) return null;
              const decos: Decoration[] = [];
              for (const a of s.anchors) {
                const r = anchorRange(state, a);
                if (!r) continue;
                decos.push(
                  Decoration.inline(r.from, r.to, {
                    class: a.id === s.active ? 'wk-comment wk-comment-active' : 'wk-comment',
                    'data-thread': a.id,
                  }),
                );
              }
              return DecorationSet.create(state.doc, decos);
            },
            handleClick(view, _pos, event) {
              const el = (event.target as HTMLElement | null)?.closest?.('[data-thread]');
              const id = el?.getAttribute('data-thread');
              if (id) {
                onClick(id);
                return false;
              }
              void view;
              return false;
            },
          },
        }),
      ];
    },
  });
}

/** Scrolls the editor to an anchored range. */
export function scrollToAnchor(editor: Editor, a: { start: string; end: string }) {
  const r = anchorRange(editor.state, a);
  if (!r) return false;
  const dom = editor.view.domAtPos(r.from).node;
  const el = dom instanceof HTMLElement ? dom : dom.parentElement;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}
