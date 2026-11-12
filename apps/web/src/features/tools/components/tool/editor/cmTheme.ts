// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/editor/cmTheme.ts. See THIRD_PARTY.md.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * A single CodeMirror theme that adapts to light/dark automatically.
 *
 * Every color is emitted as a CSS `var(--…)`, so the same theme object works in
 * both modes, the values resolve against whatever `[data-theme]` is active.
 * Syntax colors come from `--syntax-*` tokens defined in globals.css and are
 * kept restrained (no rainbow), matching the product's visual direction.
 */
const baseTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '12px 0',
    caretColor: 'var(--foreground)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-secondary)',
    color: 'var(--foreground-subtle)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 4%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
    color: 'var(--foreground-muted)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-muted)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: '1px solid var(--accent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-secondary)',
    border: '1px solid var(--border)',
    color: 'var(--foreground-muted)',
    padding: '0 4px',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--foreground)',
    borderColor: 'var(--border)',
  },
  '.cm-panel button': { color: 'var(--foreground-muted)' },
  '.cm-panel input': {
    backgroundColor: 'var(--surface)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-elevated)',
    border: '1px solid var(--border)',
    color: 'var(--foreground)',
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syntax-key)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syntax-number)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--syntax-atom)' },
  { tag: [t.keyword, t.operatorKeyword], color: 'var(--syntax-keyword)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--foreground-muted)' },
  { tag: [t.heading], color: 'var(--foreground)', fontWeight: '600' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [t.quote], color: 'var(--foreground-muted)' },
  { tag: [t.monospace], color: 'var(--syntax-string)' },
]);

/** Combined extension: base UI theme + syntax highlighting. */
export const editorTheme = [baseTheme, syntaxHighlighting(highlightStyle)];
