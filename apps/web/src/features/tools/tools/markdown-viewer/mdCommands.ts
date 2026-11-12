// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/mdCommands.ts. See THIRD_PARTY.md.
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Wrap the current selection with `before`/`after` (e.g. ** … **). */
export function wrapSelection(view: EditorView, before: string, after = before) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || '';
      const insert = before + text + after;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(
          range.from + before.length,
          range.from + before.length + text.length,
        ),
      };
    }),
  );
  view.focus();
}

/** Prepend `prefix` to the start of each line the selection touches. */
export function toggleLinePrefix(view: EditorView, prefix: string) {
  const { state } = view;
  const changes = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        changes.push({ from: line.from, insert: prefix });
      }
      pos = line.to + 1;
      if (line.to >= state.doc.length) break;
    }
  }
  view.dispatch({ changes });
  view.focus();
}

/** Insert a Markdown link around the selection: [text](url). */
export function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || 'text';
      const insert = `[${text}](url)`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(range.from + 1, range.from + 1 + text.length),
      };
    }),
  );
  view.focus();
}

/** Wrap the selection in a fenced code block. */
export function insertCodeBlock(view: EditorView) {
  wrapSelection(view, '```\n', '\n```');
}
