import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';

/**
 * Suggestion menus: "@" people / pages / dates (design 5.6) and "[[" page links ("/" blocks
 * are the editor package's own menu). Tiptap tracks the trigger and query; a React popup (SuggestMenu) reads this store,
 * renders the filtered items and reports them back so Enter / arrows work.
 */

export type SuggestKind = 'mention' | 'pageLink';

export interface SuggestItem {
  id: string;
  run: (editor: Editor, range: Range) => void;
}

export interface SuggestState {
  kind: SuggestKind;
  query: string;
  range: Range;
  rect: DOMRect | null;
  index: number;
  editor: Editor;
}

let state: SuggestState | null = null;
let items: SuggestItem[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const suggestStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** The popup reports what it shows. */
  setItems(next: SuggestItem[]) {
    items = next;
    if (state && state.index >= next.length) {
      state = { ...state, index: Math.max(0, next.length - 1) };
      emit();
    }
  },
  setIndex(index: number) {
    if (!state) return;
    state = { ...state, index };
    emit();
  },
  choose(i?: number) {
    if (!state) return;
    const item = items[i ?? state.index];
    if (!item) return;
    const { editor, range } = state;
    state = null;
    emit();
    item.run(editor, range);
  },
  close() {
    state = null;
    emit();
  },
};

function makeSuggestion(
  kind: SuggestKind,
  char: string,
  options: { startOfLine?: boolean; allowSpaces?: boolean },
) {
  return Extension.create({
    name: `wikiSuggest-${kind}`,
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: new PluginKey(`wikiSuggest-${kind}`),
          char,
          allowSpaces: options.allowSpaces ?? false,
          startOfLine: options.startOfLine ?? false,
          // Not inside code: "/" and "@" are plain text there.
          allow: ({ state: s, range }) => {
            const $from = s.doc.resolve(range.from);
            return !$from.parent.type.spec.code;
          },
          items: () => [],
          render: () => {
            const update = (p: SuggestionProps) => {
              state = {
                kind,
                query: p.query,
                range: p.range,
                rect: p.clientRect?.() ?? null,
                index: state?.kind === kind && state.query === p.query ? state.index : 0,
                editor: p.editor,
              };
              emit();
            };
            return {
              onStart: update,
              onUpdate: update,
              onExit: () => {
                if (state?.kind === kind) {
                  state = null;
                  emit();
                }
              },
              onKeyDown: ({ event }) => {
                if (!state || state.kind !== kind) return false;
                if (event.key === 'ArrowDown') {
                  suggestStore.setIndex(items.length ? (state.index + 1) % items.length : 0);
                  return true;
                }
                if (event.key === 'ArrowUp') {
                  suggestStore.setIndex(
                    items.length ? (state.index - 1 + items.length) % items.length : 0,
                  );
                  return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  if (!items.length) return false;
                  suggestStore.choose();
                  return true;
                }
                if (event.key === 'Escape') {
                  // The trigger stays as text.
                  suggestStore.close();
                  return true;
                }
                return false;
              },
            };
          },
        }),
      ];
    },
  });
}

export const MentionSuggest = makeSuggestion('mention', '@', { allowSpaces: false });
export const PageLinkSuggest = makeSuggestion('pageLink', '[[', { allowSpaces: true });

/** Normalizes for Turkish-aware, accent-insensitive filtering ("/merm" → Mermaid). */
export function fold(s: string): string {
  return s.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
