import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion } from '@tiptap/suggestion';

/** One "/" command. `run` replaces the typed `/query` (range) with its block. */
export interface SlashItem {
  id: string;
  title: string;
  description: string;
  /** Extra search terms (not shown). */
  keywords: readonly string[];
  icon: string;
  run: (editor: Editor, range: Range) => void;
}

export interface SlashMenuState {
  items: SlashItem[];
  selected: number;
  query: string;
  /** Caret rectangle in viewport coordinates. */
  rect: { left: number; top: number; bottom: number } | null;
  choose: (item: SlashItem) => void;
}

/** Tiny external store shared by the suggestion plugin and the React menu. */
export class SlashStore {
  private state: SlashMenuState | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SlashMenuState | null => this.state;

  set(state: SlashMenuState | null): void {
    this.state = state;
    for (const l of this.listeners) l();
  }

  select(index: number): void {
    if (!this.state) return;
    this.set({ ...this.state, selected: index });
  }

  /** Arrow keys move, Enter/Tab choose. Returns true when the key was handled. */
  keyDown(event: KeyboardEvent): boolean {
    const s = this.state;
    if (!s) return false;
    const n = s.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!n) return true;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.select((s.selected + delta + n) % n);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const item = s.items[s.selected];
      if (!item) return false;
      s.choose(item);
      return true;
    }
    return false;
  }
}

export interface SlashOptions {
  store: SlashStore;
  /** Items for a query (already filtered); read on every keystroke so labels can change. */
  getItems: (query: string, editor: Editor) => SlashItem[];
}

export const slashPluginKey = new PluginKey('chSlash');

/** "/" opens the block menu (not inside code, mermaid or raw HTML). */
export const SlashCommand = Extension.create<SlashOptions>({
  name: 'chSlash',

  addOptions() {
    return {
      store: new SlashStore(),
      getItems: () => [],
    };
  },

  addProseMirrorPlugins() {
    const { store, getItems } = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        pluginKey: slashPluginKey,
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        decorationClass: 'ch-slash-query',
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !$from.parent.type.spec.code;
        },
        items: ({ query, editor }) => getItems(query, editor),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          const show = (props: {
            items: SlashItem[];
            query: string;
            command: (item: SlashItem) => void;
            clientRect?: (() => DOMRect | null) | null;
          }) => {
            const prev = store.getSnapshot();
            const r = props.clientRect?.() ?? null;
            store.set({
              items: props.items,
              query: props.query,
              selected: prev && prev.query === props.query ? prev.selected : 0,
              rect: r ? { left: r.left, top: r.top, bottom: r.bottom } : null,
              choose: (item) => props.command(item),
            });
          };
          return {
            onStart: show,
            onUpdate: show,
            onExit: () => store.set(null),
            onKeyDown: ({ event }) => (event.key === 'Escape' ? false : store.keyDown(event)),
          };
        },
      }),
    ];
  },
});

/** Case- and locale-insensitive filter: title prefix first, then any match. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return items;
  const scored: { item: SlashItem; score: number }[] = [];
  for (const item of items) {
    const title = item.title.toLocaleLowerCase();
    const terms = [item.id, ...item.keywords].map((t) => t.toLocaleLowerCase());
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (terms.some((t) => t.startsWith(q))) score = 2;
    else if (terms.some((t) => t.includes(q))) score = 3;
    if (score >= 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}
