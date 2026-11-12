import { queryKeys } from '@crewhall/api-client';
import { markdownToDoc } from '@crewhall/editor/markdown';
import { RichEditor } from '@crewhall/editor/react';
import '@crewhall/editor/styles.css';
import { type DriveNode } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Segmented,
  Spinner,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { editorLabels } from '@/components/portal/PortalEditor';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { invalidateDrive } from './api';
import { languageOf } from './fileKinds';
import { isMarkdown, saveTextVersion, TEXT_EDIT_MAX_BYTES, textMode } from './textEdit';

// CodeMirror is sizeable: it loads only when a text file opens.
const CodeEditor = lazy(() => import('./CodeEditor'));

type View = 'source' | 'preview' | 'split';

/**
 * A text, code or Markdown file in the Drive viewer (roadmap 7): CodeMirror with syntax
 * highlighting, a rendered preview for Markdown, and Save as a new version with a check that
 * nobody saved in between. Read-only for viewers and for files over 2 MB.
 */
export function TextFile({
  node,
  url,
  canEdit,
  onDirty,
}: {
  node: DriveNode;
  url: string;
  canEdit: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const md = isMarkdown(node.name);
  const mode = textMode(node, canEdit);
  const editable = mode === 'edit';
  const content = useQuery({
    queryKey: ['blob-text', url],
    queryFn: async ({ signal }) => (await fetch(url, { signal })).text(),
    staleTime: Infinity,
  });
  const wide = useMediaQuery('(min-width: 768px)');
  const [chosenView, setView] = useState<View>(md ? 'preview' : 'source');
  const view: View = chosenView === 'split' && !wide ? 'source' : chosenView;
  const [wrap, setWrap] = useState(md);
  // `base` is the text of `baseVersion`, the version this editor started from.
  const [base, setBase] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState(node.version);
  const [text, setText] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<DriveNode | null>(null);
  if (base === null && content.data !== undefined) {
    const loaded = content.data.replace(/\r\n/g, '\n');
    setBase(loaded);
    setText(loaded);
  }
  const dirty = base !== null && text !== base;
  // The preview re-renders the whole document: follow typing with a short delay.
  const [previewText, setPreviewText] = useState(text);
  useEffect(() => {
    const id = setTimeout(() => setPreviewText(text), view === 'split' ? 250 : 0);
    return () => clearTimeout(id);
  }, [text, view]);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  /** `checked`: send baseVersion so the server refuses when the file changed meanwhile. */
  const write = async (checked: boolean) => {
    setSaving(true);
    try {
      const res = await saveTextVersion(
        node,
        text,
        checked ? (baseVersion ?? undefined) : undefined,
      );
      setBase(text);
      setBaseVersion(res.node.version);
      // The upload answers a plain node; the viewer's query holds the detail (path, space).
      void qc.invalidateQueries({ queryKey: queryKeys.node(node.id) });
      invalidateDrive(qc);
      toast(t('drive.text.saved', { n: res.version.version }));
    } catch (e) {
      if (checked && isApiError(e, 'version_conflict')) {
        // Someone saved in between: show who won and let the person choose.
        try {
          setConflict(await api.call('getNode', { params: { nodeId: node.id } }));
        } catch (err) {
          toast(t(errorKey(err)));
        }
      } else {
        toast(t(errorKey(e)));
      }
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (!editable || !dirty || saving) return;
    await write(true);
  };
  const reloadLatest = () => {
    setConflict(null);
    setBase(null);
    setEditorKey((k) => k + 1);
    invalidateDrive(qc);
    void qc.invalidateQueries({ queryKey: queryKeys.node(node.id) });
  };

  if (content.isLoading || base === null) return <Spinner />;
  const language = languageOf(node.name);
  const notice =
    mode === 'readonly'
      ? canEdit
        ? t('drive.text.readOnlyLarge', { size: formatBytes(TEXT_EDIT_MAX_BYTES, locale) })
        : t('drive.text.readOnlyRights')
      : null;
  const showSource = !md || view !== 'preview';
  const showPreview = md && view !== 'source';

  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-xl bg-surface shadow-line">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-fg2">
        {md ? (
          <Segmented
            size="sm"
            aria-label={t('drive.text.viewMode')}
            value={view}
            onValueChange={(v) => setView(v as View)}
            options={[
              { value: 'preview', label: t('drive.text.preview') },
              { value: 'source', label: t('drive.text.source') },
              // Side by side needs the width; phones switch between the two instead.
              ...(wide ? [{ value: 'split' as const, label: t('drive.text.split') }] : []),
            ]}
          />
        ) : language ? (
          <span className="rounded-xs bg-bg2 px-1.5 py-0.5 font-semibold">{language}</span>
        ) : null}
        {showSource ? (
          <Tooltip content={t('drive.preview.wrap')}>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('drive.preview.wrap')}
              aria-pressed={wrap}
              onClick={() => setWrap(!wrap)}
            >
              <Icon name="text" size={14} />
            </IconButton>
          </Tooltip>
        ) : null}
        {notice ? <span className="text-fg3">{notice}</span> : null}
        <span className="flex-1" />
        {dirty ? (
          <>
            <span className="flex items-center gap-1.5 font-medium text-fg">
              <span className="size-1.5 rounded-full bg-accent" />
              {t('drive.text.unsaved')}
            </span>
            <Button
              size="xs"
              variant="gh"
              onClick={() => {
                setText(base);
                setEditorKey((k) => k + 1);
              }}
            >
              {t('drive.text.discard')}
            </Button>
          </>
        ) : null}
        {editable ? (
          <Button
            size="xs"
            variant="pri"
            disabled={!dirty}
            loading={saving}
            onClick={() => void save()}
          >
            {t('drive.text.save')}
          </Button>
        ) : null}
      </div>
      <div className={cn('flex min-h-0 flex-1', view === 'split' && 'divide-x divide-line')}>
        {showSource ? (
          <div className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={<Spinner />}>
              <CodeEditor
                key={editorKey}
                initial={text}
                filename={node.name}
                label={t('drive.text.editorLabel', { name: node.name })}
                wrap={wrap}
                readOnly={!editable}
                onChange={setText}
                onSave={() => void save()}
              />
            </Suspense>
          </div>
        ) : null}
        {showPreview ? <MarkdownPreview text={previewText} /> : null}
      </div>

      <Dialog open={conflict !== null} onOpenChange={(o) => (o ? null : setConflict(null))}>
        <DialogContent width={460}>
          <DialogHeader
            icon="alert"
            title={t('drive.text.conflictTitle')}
            description={t('drive.text.conflictBody', {
              name: node.name,
              n: conflict?.version ?? 0,
            })}
          />
          <DialogFooter>
            <Button variant="gh" onClick={reloadLatest}>
              {t('drive.text.conflictReload')}
            </Button>
            <Button
              variant="pri"
              loading={saving}
              onClick={() => {
                setConflict(null);
                void write(false);
              }}
            >
              {t('drive.text.conflictSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Rendered Markdown with the page editor in read mode (no raw HTML, same look as pages). */
function MarkdownPreview({ text }: { text: string }) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  const doc = useMemo(() => markdownToDoc(text).doc, [text]);
  return (
    <div
      data-testid="markdown-preview"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5 max-md:px-4"
    >
      {/* Remount per text: the read-only editor takes its value once. */}
      <RichEditor key={text} value={doc} editable={false} labels={labels} />
    </div>
  );
}
