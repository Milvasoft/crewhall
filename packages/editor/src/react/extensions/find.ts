import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/**
 * Find and replace inside the document (Ctrl+F / Ctrl+H, see ui/FindBar): matches are computed
 * from the document and shown as decorations, so nothing is stored in it and other people's
 * edits simply recompute them. A replacement is one transaction: over Yjs it syncs and undoes
 * as one step, "replace all" included.
 */

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: FindMatch[];
  /** Index in `matches`; -1 with no match. */
  current: number;
  decorations: DecorationSet;
}

type FindMeta =
  | { query: string; caseSensitive: boolean; from: number }
  | { current: number }
  /** The transaction replaced text ending at `after`: the next match starts from there. */
  | { after: number };

export const findKey = new PluginKey<FindState>('chFind');

const EMPTY: FindState = {
  query: '',
  caseSensitive: false,
  matches: [],
  current: -1,
  decorations: DecorationSet.empty,
};

/**
 * One character to one, so positions stay valid. I, İ, ı and i count as the same letter:
 * people type either on a Turkish or an English keyboard.
 */
function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === 'I' || c === 'İ' || c === 'ı') {
      out += 'i';
    } else {
      const lower = c.toLowerCase();
      out += lower.length === 1 ? lower : c;
    }
  }
  return out;
}

/** Matches in document order; one block at a time, so a match never spans two blocks. */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): FindMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : fold(query);
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One character per position: inline atoms (mentions, images) never match.
    let text = '';
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '') : '￼'.repeat(child.nodeSize);
    });
    const hay = caseSensitive ? text : fold(text);
    let at = hay.indexOf(needle);
    while (at >= 0) {
      out.push({ from: pos + 1 + at, to: pos + 1 + at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
    return false;
  });
  return out;
}

const firstFrom = (matches: FindMatch[], pos: number) => {
  if (!matches.length) return -1;
  const at = matches.findIndex((m) => m.from >= pos);
  return at < 0 ? 0 : at;
};

function withDecorations(doc: PMNode, state: Omit<FindState, 'decorations'>): FindState {
  const decorations = state.matches.length
    ? DecorationSet.create(
        doc,
        state.matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class: i === state.current ? 'ch-find-match ch-find-current' : 'ch-find-match',
          }),
        ),
      )
    : DecorationSet.empty;
  return { ...state, decorations };
}

export const FindReplace = Extension.create({
  name: 'chFind',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply: (tr, prev) => {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (meta && 'query' in meta) {
              const matches = findMatches(tr.doc, meta.query, meta.caseSensitive);
              return withDecorations(tr.doc, {
                query: meta.query,
                caseSensitive: meta.caseSensitive,
                matches,
                current: firstFrom(matches, meta.from),
              });
            }
            if (meta && 'current' in meta) {
              return withDecorations(tr.doc, { ...prev, current: meta.current });
            }
            if (!prev.query || !tr.docChanged) return prev;
            const matches = findMatches(tr.doc, prev.query, prev.caseSensitive);
            let current: number;
            if (meta && 'after' in meta) {
              current = firstFrom(matches, meta.after);
            } else if (tr.getMeta('y-sync$')) {
              // A remote change replaces the whole document: positions do not map through it.
              current = Math.min(prev.current, matches.length - 1);
            } else {
              const old = prev.matches[prev.current];
              current = old
                ? firstFrom(matches, tr.mapping.map(old.from, -1))
                : firstFrom(matches, 0);
            }
            return withDecorations(tr.doc, { ...prev, matches, current });
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

export const findState = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY;

const send = (view: EditorView, meta: FindMeta) =>
  view.dispatch(view.state.tr.setMeta(findKey, meta).setMeta('addToHistory', false));

/** Brings the current match into view; the caret stays where it was. */
export function scrollToMatch(view: EditorView): void {
  const f = findState(view.state);
  const match = f.matches[f.current];
  if (!match) return;
  const { node } = view.domAtPos(match.from);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  el?.scrollIntoView?.({ block: 'center' });
}

/** Sets what to look for; the first match at or after the caret becomes current. */
export function setFind(view: EditorView, query: string, caseSensitive: boolean): void {
  send(view, { query, caseSensitive, from: view.state.selection.from });
  scrollToMatch(view);
}

/** Next (1) or previous (-1) match, around the ends. */
export function stepFind(view: EditorView, dir: 1 | -1): void {
  const f = findState(view.state);
  if (!f.matches.length) return;
  const current = (f.current + dir + f.matches.length) % f.matches.length;
  send(view, { current });
  scrollToMatch(view);
}

/** Replaces the current match and moves to the next one. */
export function replaceCurrent(view: EditorView, text: string): boolean {
  const f = findState(view.state);
  const match = f.matches[f.current];
  if (!match || !view.editable) return false;
  const tr = view.state.tr.insertText(text, match.from, match.to);
  tr.setMeta(findKey, { after: match.from + text.length } satisfies FindMeta);
  view.dispatch(tr);
  scrollToMatch(view);
  return true;
}

/** Replaces every match in one transaction; returns how many. */
export function replaceAll(view: EditorView, text: string): number {
  const f = findState(view.state);
  if (!f.matches.length || !view.editable) return 0;
  const tr = view.state.tr;
  // Backwards, so earlier positions stay valid.
  for (let i = f.matches.length - 1; i >= 0; i--) {
    const m = f.matches[i]!;
    tr.insertText(text, m.from, m.to);
  }
  view.dispatch(tr);
  return f.matches.length;
}

/** Ends the search: no highlights, nothing recomputed. */
export function clearFind(view: EditorView): void {
  send(view, { query: '', caseSensitive: false, from: 0 });
}
