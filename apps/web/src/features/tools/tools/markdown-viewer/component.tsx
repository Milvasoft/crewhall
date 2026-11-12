// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import type { EditorView } from '@codemirror/view';
import { Icon, type IconName } from '@crewhall/ui';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ResizableSplit } from '@/features/tools/components/tool/ResizableSplit';
import { usePane } from '@/features/tools/components/tool/paneContext';
import { Button } from '@/features/tools/components/ui/Button';
import { cn } from '@/features/tools/components/ui/cn';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { markdownToHtml } from './logic';
import { insertCodeBlock, insertLink, toggleLinePrefix, wrapSelection } from './mdCommands';
import { downloadBlob, EXPORTERS } from './export';

interface Doc {
  id: string;
  name: string;
  content: string;
}

const baseName = (name: string) => name.replace(/\.(md|markdown|txt)$/i, '');

// Small dropdown used for Copy / Export menus.
function Menu({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} disabled={disabled}>
        {label} ▾
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg transition-colors hover:bg-bg2 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

type ToolbarKey =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullets'
  | 'numbered'
  | 'quote'
  | 'codeBlock'
  | 'link';

const TOOLBAR: {
  key: ToolbarKey;
  label: string;
  icon?: IconName;
  run: (v: EditorView) => void;
}[] = [
  { key: 'bold', label: 'B', run: (v) => wrapSelection(v, '**') },
  { key: 'italic', label: 'I', run: (v) => wrapSelection(v, '*') },
  { key: 'strike', label: 'S', run: (v) => wrapSelection(v, '~~') },
  { key: 'inlineCode', label: '‹›', run: (v) => wrapSelection(v, '`') },
  { key: 'h1', label: 'H1', run: (v) => toggleLinePrefix(v, '# ') },
  { key: 'h2', label: 'H2', run: (v) => toggleLinePrefix(v, '## ') },
  { key: 'h3', label: 'H3', run: (v) => toggleLinePrefix(v, '### ') },
  { key: 'bullets', label: '•', run: (v) => toggleLinePrefix(v, '- ') },
  { key: 'numbered', label: '1.', run: (v) => toggleLinePrefix(v, '1. ') },
  { key: 'quote', label: '❝', run: (v) => toggleLinePrefix(v, '> ') },
  { key: 'codeBlock', label: '{ }', run: (v) => insertCodeBlock(v) },
  { key: 'link', label: '', icon: 'link', run: (v) => insertLink(v) },
];

function CollapseGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m15 6-6 6 6 6" />
    </svg>
  );
}

/** Live preview pane. Consumes the pane context to expose its own collapse. */
function PreviewPanel({ html }: { html: string }) {
  const { t } = useI18n();
  const pane = usePane();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-bg2 px-3">
        {pane ? (
          <button
            type="button"
            onClick={pane.collapse}
            title={t('tools.common.collapse')}
            aria-label={t('tools.items.markdown-viewer.collapsePreview')}
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg3 transition-colors hover:bg-surface hover:text-fg"
          >
            <CollapseGlyph className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
          {t('tools.items.markdown-viewer.preview')}
        </span>
      </div>
      <div
        className="markdown-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed text-fg"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export default function MarkdownViewerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const starter = t('tools.items.markdown-viewer.starter');
  const untitled = t('tools.items.markdown-viewer.untitledFile');
  const [docs, setDocs] = useState<Doc[]>(() => [
    { id: newId(), name: untitled, content: initialInput ?? starter },
  ]);
  const [activeId, setActiveId] = useState(() => docs[0]?.id ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // `docs` is never empty: deleting the last file replaces it with a fresh one.
  const active = docs.find((d) => d.id === activeId) ?? docs[0]!;
  const rawHtml = useMemo(() => markdownToHtml(active.content), [active.content]);
  const cleanHtml = useMemo(() => DOMPurify.sanitize(rawHtml), [rawHtml]);

  const updateContent = (content: string) =>
    setDocs((prev) => prev.map((d) => (d.id === activeId ? { ...d, content } : d)));

  const runCommand = (fn: (v: EditorView) => void) => {
    const view = cmRef.current?.view;
    if (view) fn(view);
  };

  const addDoc = (name: string, content: string) => {
    const doc = { id: newId(), name, content };
    setDocs((prev) => [...prev, doc]);
    setActiveId(doc.id);
  };

  const openFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const text = await file.text();
      addDoc(file.name, text);
    }
  };

  const deleteDoc = (id: string) => {
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      const first = next[0];
      if (!first) {
        const fresh = { id: newId(), name: untitled, content: starter };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(first.id);
      return next;
    });
  };

  const rename = (id: string, name: string) =>
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, name: name.trim() || d.name } : d)));

  const copyRich = async () => {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([cleanHtml], { type: 'text/html' }),
        'text/plain': new Blob([active.content], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
    } catch {
      await navigator.clipboard.writeText(active.content);
    }
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      {/* File panel: its own collapse button folds it to a reopen strip. */}
      {filesCollapsed ? (
        <button
          type="button"
          onClick={() => setFilesCollapsed(false)}
          title={t('tools.items.markdown-viewer.showFiles')}
          aria-label={t('tools.items.markdown-viewer.showFiles')}
          className="group flex w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-line bg-bg2 px-3 py-2 text-fg2 transition-colors hover:text-fg lg:h-auto lg:w-9 lg:flex-col lg:px-0 lg:py-3"
        >
          <CollapseGlyph className="h-4 w-4 rotate-180" />
          <span className="text-xs font-semibold uppercase tracking-wide lg:[writing-mode:vertical-rl] lg:rotate-180">
            {t('tools.items.markdown-viewer.files')}
          </span>
        </button>
      ) : (
        <aside className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface lg:w-48">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg2 px-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFilesCollapsed(true)}
                title={t('tools.items.markdown-viewer.hideFiles')}
                aria-label={t('tools.items.markdown-viewer.hideFiles')}
                className="-ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg3 transition-colors hover:bg-surface hover:text-fg"
              >
                <CollapseGlyph className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
                {t('tools.items.markdown-viewer.files')}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() =>
                  addDoc(
                    t('tools.items.markdown-viewer.untitledNumbered', { n: docs.length + 1 }),
                    starter,
                  )
                }
                title={t('tools.items.markdown-viewer.newFile')}
                aria-label={t('tools.items.markdown-viewer.newFile')}
                className="flex h-6 w-6 items-center justify-center rounded text-fg2 hover:bg-surface hover:text-fg"
              >
                ＋
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                title={t('tools.items.markdown-viewer.openFile')}
                aria-label={t('tools.items.markdown-viewer.openFile')}
                className="flex h-6 w-6 items-center justify-center rounded text-fg2 hover:bg-surface hover:text-fg"
              >
                <Icon name="folder" size={14} />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void openFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {docs.map((d) => (
              <div
                key={d.id}
                className={cn(
                  'group flex items-center gap-1 px-2 py-1 text-sm',
                  d.id === activeId ? 'bg-bg2' : 'hover:bg-bg2',
                )}
              >
                {editingId === d.id ? (
                  <input
                    autoFocus
                    defaultValue={d.name}
                    onBlur={(e) => {
                      rename(d.id, e.target.value);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-line bg-surface px-1 text-xs text-fg outline-none"
                  />
                ) : (
                  <button
                    onClick={() => setActiveId(d.id)}
                    onDoubleClick={() => setEditingId(d.id)}
                    className="min-w-0 flex-1 truncate text-left text-fg"
                    title={t('tools.items.markdown-viewer.renameHint', { name: d.name })}
                  >
                    {d.name}
                  </button>
                )}
                <button
                  onClick={() => deleteDoc(d.id)}
                  title={t('tools.items.markdown-viewer.delete')}
                  aria-label={t('tools.items.markdown-viewer.delete')}
                  className="shrink-0 text-fg3 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      {/* Editor + preview */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1.5">
          {TOOLBAR.map((item) => (
            <button
              key={item.key}
              title={t(`tools.items.markdown-viewer.toolbar.${item.key}`)}
              aria-label={t(`tools.items.markdown-viewer.toolbar.${item.key}`)}
              onClick={() => runCommand(item.run)}
              className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 font-mono text-xs text-fg2 transition-colors hover:bg-bg2 hover:text-fg"
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : item.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <Menu label={t('tools.common.copy')}>
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      void copyRich();
                      close();
                    }}
                  >
                    {t('tools.items.markdown-viewer.copyFormatted')}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void navigator.clipboard.writeText(cleanHtml);
                      close();
                    }}
                  >
                    {t('tools.items.markdown-viewer.copyHtml')}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void navigator.clipboard.writeText(active.content);
                      close();
                    }}
                  >
                    {t('tools.items.markdown-viewer.copyMarkdown')}
                  </MenuItem>
                </>
              )}
            </Menu>
            <Menu label={t('tools.items.markdown-viewer.export')}>
              {(close) => (
                <>
                  {EXPORTERS.map((ex) => (
                    <MenuItem
                      key={ex.format}
                      disabled={!ex.enabled}
                      onClick={() => {
                        const title = baseName(active.name);
                        const blob = ex.build({
                          md: active.content,
                          html: cleanHtml,
                          title,
                        });
                        downloadBlob(blob, `${title}.${ex.ext}`);
                        close();
                      }}
                    >
                      {ex.format === 'pdf'
                        ? t('tools.items.markdown-viewer.exportPdfSoon')
                        : ex.label}
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          </div>
        </div>

        <ResizableSplit
          className="min-h-0 flex-1"
          leftLabel={active.name}
          rightLabel={t('tools.items.markdown-viewer.preview')}
          left={
            <ToolEditor
              label={active.name}
              value={active.content}
              onChange={updateContent}
              language="markdown"
              minRows={20}
              cmRef={cmRef}
            />
          }
          right={<PreviewPanel html={cleanHtml} />}
        />
      </div>
    </div>
  );
}
