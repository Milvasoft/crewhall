import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  clearFind,
  findState,
  replaceAll,
  replaceCurrent,
  setFind,
  stepFind,
} from '../extensions/find';
import type { EditorLabels } from '../labels';
import { Icon } from './icons';

/**
 * The find bar (Ctrl+F, with the replace row on Ctrl+H). In-page search for every host, the
 * desktop app included, where the browser has no find of its own. Replace is left out when the
 * editor is read-only.
 */
export function FindBar({
  editor,
  labels,
  replace: replaceOpen,
  focusKey,
  initial,
  onReplaceChange,
  onClose,
}: {
  editor: Editor;
  labels: EditorLabels;
  replace: boolean;
  /** Changes on every Ctrl+F / Ctrl+H, to bring the focus back to the right field. */
  focusKey: number;
  /** The selected text when the bar opened. */
  initial: string;
  onReplaceChange: (open: boolean) => void;
  onClose: () => void;
}): JSX.Element | null {
  const view = editor.view;
  const [query, setQuery] = useState(initial);
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [, rerender] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const editable = editor.isEditable;
  const showReplace = replaceOpen && editable;

  useEffect(() => {
    const on = () => rerender((n) => n + 1);
    editor.on('transaction', on);
    return () => {
      editor.off('transaction', on);
    };
  }, [editor]);

  useEffect(() => {
    setFind(view, query, caseSensitive);
  }, [view, query, caseSensitive]);

  // Leaving takes the highlights away.
  useEffect(
    () => () => {
      if (!editor.isDestroyed) clearFind(editor.view);
    },
    [editor],
  );

  useEffect(() => {
    const target = showReplace && query ? replaceRef.current : queryRef.current;
    target?.focus();
    target?.select();
    // Only when Ctrl+F or Ctrl+H is pressed again; not on every letter typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, showReplace]);

  const f = findState(editor.state);
  const none = f.matches.length === 0;
  const count = none ? labels.findNoResults : `${f.current + 1}/${f.matches.length}`;

  const onQueryKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(view, e.shiftKey ? -1 : 1);
    }
  };
  const onReplaceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent(view, replacement);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="search"
      aria-label={labels.findLabel}
      className="ch-editor-layer ch-find-bar"
      onKeyDown={onKeyDown}
    >
      <div className="ch-find-row">
        {editable ? (
          <button
            type="button"
            className="ch-find-btn"
            aria-label={labels.findToggleReplace}
            aria-expanded={showReplace}
            title={labels.findToggleReplace}
            onClick={() => onReplaceChange(!replaceOpen)}
          >
            <span className={showReplace ? 'ch-find-chevron is-open' : 'ch-find-chevron'}>
              <Icon name="chevron" size={14} />
            </span>
          </button>
        ) : null}
        <input
          ref={queryRef}
          className="ch-find-input"
          value={query}
          placeholder={labels.findPlaceholder}
          aria-label={labels.findPlaceholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKey}
        />
        <span className="ch-find-count" role="status">
          {query ? count : ''}
        </span>
        <button
          type="button"
          className={caseSensitive ? 'ch-find-btn is-active' : 'ch-find-btn'}
          aria-label={labels.findCase}
          aria-pressed={caseSensitive}
          title={labels.findCase}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          type="button"
          className="ch-find-btn"
          aria-label={labels.findPrevious}
          title={labels.findPrevious}
          disabled={none}
          onClick={() => stepFind(view, -1)}
        >
          <Icon name="arrowUp" size={15} />
        </button>
        <button
          type="button"
          className="ch-find-btn"
          aria-label={labels.findNext}
          title={labels.findNext}
          disabled={none}
          onClick={() => stepFind(view, 1)}
        >
          <Icon name="arrowDown" size={15} />
        </button>
        <button
          type="button"
          className="ch-find-btn"
          aria-label={labels.findClose}
          title={labels.findClose}
          onClick={onClose}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      {showReplace ? (
        <div className="ch-find-row ch-find-replace">
          <input
            ref={replaceRef}
            className="ch-find-input"
            value={replacement}
            placeholder={labels.findReplacePlaceholder}
            aria-label={labels.findReplacePlaceholder}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplaceKey}
          />
          <button
            type="button"
            className="ch-find-text-btn"
            disabled={none}
            onClick={() => replaceCurrent(view, replacement)}
          >
            {labels.findReplace}
          </button>
          <button
            type="button"
            className="ch-find-text-btn"
            disabled={none}
            onClick={() => replaceAll(view, replacement)}
          >
            {labels.findReplaceAll}
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** Text worth searching for: a short selection on one line. */
export function selectedSearchText(editor: Editor): string {
  const { from, to, empty } = editor.state.selection;
  if (empty) return '';
  const text = editor.state.doc.textBetween(from, to, '\n');
  return text.length <= 200 && !text.includes('\n') ? text : '';
}
