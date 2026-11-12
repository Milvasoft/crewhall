import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

/**
 * CodeMirror 6 for Drive text files (roadmap 7). Loaded lazily with the editor screen; the
 * language pack for the file's extension loads on demand. Colors come from the app's CSS
 * variables, so light, dark and tenant themes apply without a second theme.
 */

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '20px',
  },
  '.cm-content': { caretColor: 'var(--fg)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg3)',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg2) 70%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg2)', color: 'var(--fg2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 35%, transparent) !important',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--bg2)', color: 'var(--fg)' },
  '.cm-panels input, .cm-panels button': { color: 'var(--fg)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line2)',
    color: 'var(--fg)',
  },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--s4)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--s3)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--s6)' },
  { tag: [tags.comment, tags.meta], color: 'var(--fg3)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--s1)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--s5)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--s2)' },
  { tag: tags.tagName, color: 'var(--s4)' },
  { tag: tags.heading, fontWeight: '700', color: 'var(--fg)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--s1)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

export interface CodeEditorProps {
  /** Initial text; the editor owns the text afterwards (remount with a `key` to reset). */
  initial: string;
  filename: string;
  /** Accessible name of the text area. */
  label: string;
  wrap: boolean;
  readOnly?: boolean;
  onChange: (text: string) => void;
  /** Ctrl/Cmd S. */
  onSave: () => void;
}

export default function CodeEditor({
  initial,
  filename,
  label,
  wrap,
  readOnly = false,
  onChange,
  onSave,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const language = useRef(new Compartment());
  // Latest callbacks without rebuilding the editor.
  const handlers = useRef({ onChange, onSave });
  useEffect(() => {
    handlers.current = { onChange, onSave };
  });

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
          ]),
          theme,
          syntaxHighlighting(highlight),
          language.current.of([]),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (desc) {
      void desc
        .load()
        .then((support) => {
          if (view.current === v) {
            v.dispatch({ effects: language.current.reconfigure(support) });
          }
        })
        .catch(() => undefined);
    }
    return () => {
      view.current = null;
      v.destroy();
    };
    // The text, file and label are fixed for one editor instance (remount to change them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div ref={host} data-testid="code-editor" className="h-full min-h-0 overflow-hidden" />;
}
