// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-wysiwyg-editor/component.tsx. See THIRD_PARTY.md.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, Input } from '@crewhall/ui';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import DOMPurify from 'dompurify';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';

type Translate = ReturnType<typeof useI18n>['t'];

const K = 'tools.items.html-wysiwyg-editor';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sample content in the current language, built once on mount. */
function initialHtml(t: Translate): string {
  const tx = (key: Parameters<Translate>[0], values?: Parameters<Translate>[1]) =>
    escapeHtml(t(key, values));
  const text = t(`${K}.sample.text`, {
    first: `<strong>${tx(`${K}.sample.bold`)}</strong>`,
    second: `<em>${tx(`${K}.sample.italic`)}</em>`,
  });
  return (
    `<h2>${tx(`${K}.sample.title`)}</h2><p>${text}</p>` +
    `<ul><li>${tx(`${K}.sample.item1`)}</li><li>${tx(`${K}.sample.item2`)}</li></ul>`
  );
}

type ToolbarId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'heading1'
  | 'heading2'
  | 'paragraph'
  | 'bulleted'
  | 'numbered'
  | 'link'
  | 'clear';

interface ToolItem {
  id: ToolbarId;
  /** Literal button text; when missing the label comes from the dictionary. */
  label?: string;
  command: string;
  value?: string;
  /** Prompt the user for a value (e.g. a link URL). */
  prompt?: boolean;
}

// Static config: no refs captured here, so it's safe to build outside render.
const TOOLBAR: ToolItem[] = [
  { id: 'bold', label: 'B', command: 'bold' },
  { id: 'italic', label: 'I', command: 'italic' },
  { id: 'underline', label: 'U', command: 'underline' },
  { id: 'heading1', label: 'H1', command: 'formatBlock', value: 'H1' },
  { id: 'heading2', label: 'H2', command: 'formatBlock', value: 'H2' },
  { id: 'paragraph', label: 'P', command: 'formatBlock', value: 'P' },
  { id: 'bulleted', command: 'insertUnorderedList' },
  { id: 'numbered', command: 'insertOrderedList' },
  { id: 'link', command: 'createLink', prompt: true },
  { id: 'clear', command: 'removeFormat' },
];

export default function HtmlWysiwygEditorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => initialHtml(t));
  const [html, setHtml] = useState(() => DOMPurify.sanitize(initial));
  const definition = getDefinition('html-wysiwyg-editor')!;

  const sync = useCallback(() => {
    const el = editorRef.current;
    if (el) setHtml(DOMPurify.sanitize(el.innerHTML));
  }, []);

  // Fill the editable DOM once; `html` already holds the sanitized copy.
  useEffect(() => {
    const el = editorRef.current;
    if (el) el.innerHTML = initial;
  }, [initial]);

  const labelOf = (item: ToolItem): string => {
    if (item.label) return item.label;
    if (item.id === 'bulleted') return `• ${t(`${K}.listLabel`)}`;
    if (item.id === 'numbered') return `1. ${t(`${K}.listLabel`)}`;
    if (item.id === 'link') return t(`${K}.linkLabel`);
    return t('tools.common.clear');
  };

  const apply = useCallback(
    (command: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      sync();
    },
    [sync],
  );

  // A dialog, not `window.prompt`: the desktop app (Electron) has no prompt at all.
  // The dialog takes the focus, so the editor's selection is kept and put back on apply.
  const [linkFor, setLinkFor] = useState<{ command: string; range: Range | null } | null>(null);

  const run = useCallback(
    (item: ToolItem) => {
      if (item.prompt) {
        const sel = window.getSelection();
        const inEditor =
          sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode ?? null);
        setLinkFor({
          command: item.command,
          range: inEditor ? sel.getRangeAt(0).cloneRange() : null,
        });
        return;
      }
      apply(item.command, item.value);
    },
    [apply],
  );

  const applyLink = (url: string) => {
    const target = linkFor;
    setLinkFor(null);
    if (!target) return;
    editorRef.current?.focus();
    if (target.range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(target.range);
    }
    apply(target.command, url);
  };

  return (
    <>
      <SplitGrid leftLabel={t(`${K}.editor`)} rightLabel="HTML">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-1 border-b border-line bg-bg2 px-2 py-1.5">
            {TOOLBAR.map((item) => (
              <button
                key={item.id}
                type="button"
                title={t(`${K}.toolbar.${item.id}`)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the selection
                  run(item);
                }}
                className="h-7 rounded px-2 text-xs font-medium text-fg2 transition-colors hover:bg-surface hover:text-fg"
              >
                {labelOf(item)}
              </button>
            ))}
          </div>
          <div
            ref={editorRef}
            contentEditable
            onInput={sync}
            suppressContentEditableWarning
            className="markdown-preview min-h-[320px] flex-1 overflow-auto px-4 py-3 text-sm text-fg focus:outline-none"
          />
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg2 px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg2">HTML</span>
            <div className="flex items-center gap-1">
              <CopyButton size="sm" variant="ghost" value={html} />
              <SendToMenu source={definition} value={html} />
            </div>
          </div>
          <pre className="min-h-[320px] flex-1 overflow-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs text-fg">
            {html}
          </pre>
        </div>
      </SplitGrid>

      {/* Outside SplitGrid: it lays out only its two panes. */}
      <Dialog open={linkFor !== null} onOpenChange={(open) => !open && setLinkFor(null)}>
        {linkFor ? <LinkBody onApply={applyLink} onClose={() => setLinkFor(null)} /> : null}
      </Dialog>
    </>
  );
}

function LinkBody({ onApply, onClose }: { onApply: (url: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) onApply(url.trim());
  };
  return (
    <DialogContent>
      <DialogHeader title={t(`${K}.linkLabel`)} />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          autoFocus
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label={t(`${K}.linkPrompt`)}
          placeholder="https://"
        />
        <DialogFooter>
          <Button type="button" variant="gh" onClick={onClose}>
            {t(`${K}.linkCancel`)}
          </Button>
          <Button type="submit" variant="inv" disabled={!url.trim()}>
            {t(`${K}.linkApply`)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
