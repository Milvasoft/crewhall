// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ToolEditor.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMemo, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { usePreference } from '@/features/tools/lib/preferences/hooks';
import { cn } from '@/features/tools/components/ui/cn';
import { usePane } from './paneContext';
import { editorTheme } from './editor/cmTheme';
import { languageExtension, type EditorLanguage } from './editor/cmLanguages';

function CollapseChevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

export interface ToolEditorProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  /** Toolbar rendered on the right of the panel header. */
  actions?: React.ReactNode;
  /** Show a left gutter with line numbers (good for code/data). */
  lineNumbers?: boolean;
  /** Status text shown under the editor (e.g. errors, counts). */
  footer?: React.ReactNode;
  minRows?: number;
  className?: string;
  monospace?: boolean;
  /** Syntax highlighting language. Defaults to plain text. */
  language?: EditorLanguage;
  /** Access the underlying CodeMirror instance (for toolbars/commands). */
  cmRef?: React.Ref<ReactCodeMirrorRef>;
  /**
   * Show a collapse control in the header (default true). Inside a
   * {@link ResizableSplit} it folds the whole pane; standalone it collapses the
   * card body to just its header. Set false for tiny always-open panels.
   */
  collapsible?: boolean;
}

/**
 * The shared editor surface for every tool, a CodeMirror 6 instance with
 * theme-adaptive syntax highlighting, line numbers, code folding and in-editor
 * search (Ctrl/⌘F). It keeps a stable, tool-agnostic API (label, value,
 * onChange, actions, footer…) so tools don't touch CodeMirror directly, and it
 * never persists its value.
 *
 * Rendered client-only (tool components are loaded with `ssr: false`), so there
 * is no SSR/hydration concern.
 */
export function ToolEditor({
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
  actions,
  lineNumbers = false,
  footer,
  minRows = 12,
  className,
  language,
  cmRef,
  collapsible = true,
}: ToolEditorProps) {
  const { t } = useI18n();
  const [fontSize] = usePreference('editorFontSize');
  const pane = usePane();
  const [selfCollapsed, setSelfCollapsed] = useState(false);
  // Read-only viewers (converter/formatter outputs) are still rendered as a
  // fully editable CodeMirror so the built-in find & replace panel (Ctrl/⌘-F)
  // works there just like in the inputs. Edits live in a local draft seeded
  // from `value`; whenever the upstream value recomputes, the draft resets, so
  // the viewer keeps reflecting the tool's output.
  const [draft, setDraft] = useState(value);
  // Reset the draft when the upstream value changes (adjusting state during render, no effect).
  const [shown, setShown] = useState(value);
  if (readOnly && value !== shown) {
    setShown(value);
    setDraft(value);
  }
  const editorValue = readOnly ? draft : value;
  const editorOnChange = readOnly ? setDraft : onChange;
  // Inside a split the parent folds the whole pane, so we never render our own
  // collapsed state; standalone we hide the body ourselves.
  const inSplit = pane !== null;
  const bodyHidden = !inSplit && selfCollapsed;

  const extensions = useMemo(
    () => [...languageExtension(language), EditorView.lineWrapping],
    [language],
  );

  const minHeight = `${Math.round(minRows * (fontSize * 1.6 + 0.5))}px`;

  const onCollapse = () => (inSplit ? pane!.collapse() : setSelfCollapsed((v) => !v));

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface',
        className,
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {collapsible ? (
            <button
              type="button"
              onClick={onCollapse}
              title={bodyHidden ? t('tools.common.expand') : t('tools.common.collapse')}
              aria-label={
                bodyHidden ? t('tools.common.expandPanel') : t('tools.common.collapsePanel')
              }
              aria-expanded={!bodyHidden}
              className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg3 transition-colors hover:bg-surface hover:text-fg"
            >
              <CollapseChevron
                className={cn(
                  'h-3.5 w-3.5 transition-transform',
                  inSplit ? 'rotate-90' : bodyHidden ? '-rotate-90' : '',
                )}
              />
            </button>
          ) : null}
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-fg2">
            {label}
          </span>
        </div>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>

      <div
        className={cn('min-h-0 flex-1 overflow-auto', bodyHidden && 'hidden')}
        style={{ fontSize }}
      >
        <CodeMirror
          ref={cmRef}
          value={editorValue}
          onChange={editorOnChange}
          placeholder={placeholder}
          theme={editorTheme}
          extensions={extensions}
          basicSetup={{
            lineNumbers,
            foldGutter: lineNumbers,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            autocompletion: false,
            searchKeymap: true,
          }}
          style={{ minHeight }}
          aria-label={label}
        />
      </div>

      {footer && !bodyHidden ? (
        <div className="shrink-0 border-t border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
