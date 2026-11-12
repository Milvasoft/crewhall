import type { EditorDoc, JSONNode } from '@crewhall/editor';
import { RichEditor, type RichEditorHandle } from '@crewhall/editor/react';
import '@crewhall/editor/styles.css';
import type { NodeType, PublicBoard, PublicPage } from '@crewhall/shared';
import { cn, Icon, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { editorLabels } from '@/components/portal/PortalEditor';
import { PageOutlineLayout } from '@/components/wiki/PageOutline';
import { COVER_PRESETS } from '@/components/wiki/PageView';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { queryKeys } from '@crewhall/api-client';
import '@/components/wiki/wiki.css';

/**
 * Pages, boards and drawings opened from a public link (H15, design 19): their content,
 * read-only, instead of a file card with a size and no preview.
 */

export const CONTENT_TYPES = new Set<NodeType>(['page', 'board', 'drawing']);

const NODE_SRC = /^node:([0-9a-f-]{36})$/i;

/** `node:<id>` images and links → the URLs the server handed out (unknown ones are dropped). */
function withFiles(doc: EditorDoc, files: Record<string, string>): EditorDoc {
  const url = (v: unknown) => {
    const id = NODE_SRC.exec(String(v ?? ''))?.[1];
    return id ? (files[id] ?? null) : undefined;
  };
  const map = (n: JSONNode): JSONNode | null => {
    if (n.type === 'image') {
      const src = url(n.attrs?.src);
      if (src === null) return null;
      if (src) return { ...n, attrs: { ...n.attrs, src } };
    }
    if (n.type === 'video') {
      const src = url(n.attrs?.src);
      if (src === null) return null;
      if (src) return { ...n, attrs: { ...n.attrs, src } };
    }
    const marks = n.marks
      ?.map((m) => {
        if (m.type !== 'link') return m;
        const href = url(m.attrs?.href);
        if (href === null) return null;
        return href ? { ...m, attrs: { ...m.attrs, href } } : m;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const content = n.content?.map(map).filter((c): c is JSONNode => c !== null);
    return {
      ...n,
      ...(marks ? { marks } : {}),
      ...(content ? { content } : {}),
    };
  };
  return { ...doc, content: (doc.content ?? []).map(map).filter((c): c is JSONNode => c !== null) };
}

export function PublicContentView({
  token,
  grant,
  type,
  nodeId,
  fallback,
}: {
  token: string;
  grant?: string;
  type: NodeType;
  /** A node inside a shared folder; omit for the shared node. */
  nodeId?: string;
  fallback: ReactNode;
}) {
  if (type === 'page') return <PageContent token={token} grant={grant} nodeId={nodeId} />;
  if (type === 'board') return <BoardContent token={token} grant={grant} nodeId={nodeId} />;
  return <DrawingContent token={token} grant={grant} nodeId={nodeId} fallback={fallback} />;
}

function Failed() {
  const { t } = useI18n();
  return <span className="m-auto text-sm text-fg2">{t('publicShare.contentError')}</span>;
}

function PageContent({ token, grant, nodeId }: { token: string; grant?: string; nodeId?: string }) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  const q = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'page', nodeId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicPage', { params: { token }, query: { grant, nodeId }, signal }),
    // File URLs are signed for a few minutes.
    staleTime: 4 * 60_000,
    retry: false,
  });
  const page: PublicPage | undefined = q.data;
  const doc = useMemo(() => (page ? withFiles(page.doc as EditorDoc, page.files) : null), [page]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useCallback(
    (handle: RichEditorHandle | null) => setEditor(handle?.getEditor() ?? null),
    [],
  );
  if (q.isLoading) return <Spinner className="m-auto" />;
  if (!page || !doc) return <Failed />;
  const preset = page.cover?.startsWith('preset:') ? COVER_PRESETS[page.cover.slice(7)] : undefined;
  const cover =
    preset ??
    (page.cover && /^https?:/.test(page.cover) ? `url("${page.cover}") center/cover` : undefined);
  return (
    // Full width became the reader's own choice (UiPrefs); a public page keeps the default.
    <PageOutlineLayout
      editor={editor}
      enabled
      fullWidth={false}
      className="wk-page--public w-full self-start"
    >
      <article
        aria-label={page.name}
        className={cn('wk-public flex flex-col', page.smallText && 'text-[14px]')}
      >
        {cover ? (
          <div className="mb-6 h-[160px] rounded-2xl" style={{ background: cover }} />
        ) : null}
        {page.icon ? <span className="mb-2 text-[40px] leading-none">{page.icon}</span> : null}
        <h1 className="mb-4 text-wtitle font-bold break-words">{page.name}</h1>
        {/* Read-only: no grip, so no gutter in front of the text. */}
        <div style={{ ['--ch-editor-gutter' as string]: '0px' }}>
          <RichEditor
            key={page.updatedAt}
            value={doc}
            editable={false}
            labels={labels}
            editorRef={editorRef}
          />
        </div>
      </article>
    </PageOutlineLayout>
  );
}

function BoardContent({
  token,
  grant,
  nodeId,
}: {
  token: string;
  grant?: string;
  nodeId?: string;
}) {
  const { t, locale } = useI18n();
  const q = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'board', nodeId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicBoard', { params: { token }, query: { grant, nodeId }, signal }),
    retry: false,
  });
  const board: PublicBoard | undefined = q.data;
  if (q.isLoading) return <Spinner className="m-auto" />;
  if (!board) return <Failed />;
  const labels = new Map(board.labels.map((l) => [l.id, l]));
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 self-start">
      <h1 className="text-wtitle font-bold break-words">{board.name}</h1>
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-2">
        {board.columns.map((col) => {
          const cards = board.cards.filter((c) => c.columnId === col.id);
          return (
            <section
              key={col.id}
              aria-label={col.name}
              className="flex w-[260px] shrink-0 flex-col gap-2 rounded-xl bg-surface p-3 shadow-line"
            >
              <header className="flex items-center gap-2 text-sm font-bold">
                {col.isDone ? <Icon name="checkC" size={15} className="text-success" /> : null}
                <span className="min-w-0 flex-1 truncate">{col.name}</span>
                <span className="text-cap text-fg3 tn">{cards.length}</span>
              </header>
              {cards.length === 0 ? (
                <span className="py-2 text-cap text-fg3">{t('publicShare.board.empty')}</span>
              ) : null}
              {cards.map((c) => (
                <article
                  key={c.id}
                  className="flex flex-col gap-1.5 rounded-lg bg-bg p-2.5 shadow-line"
                >
                  {c.labels.length ? (
                    <span className="flex flex-wrap gap-1">
                      {c.labels.map((id) => {
                        const l = labels.get(id);
                        return l ? (
                          <span
                            key={id}
                            className="rounded-full px-2 text-[11px] leading-[18px] font-semibold"
                            style={{
                              background: `color-mix(in srgb, var(--${l.color}) 18%, transparent)`,
                              color: `color-mix(in srgb, var(--${l.color}) 70%, var(--fg))`,
                            }}
                          >
                            {l.name}
                          </span>
                        ) : null;
                      })}
                    </span>
                  ) : null}
                  <span className={cn('text-sm font-semibold', c.doneAt && 'text-fg2')}>
                    {c.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 text-cap text-fg3">
                    <span className="tn">
                      {board.key}-{c.number}
                    </span>
                    {c.dueAt ? (
                      <span className="flex items-center gap-1">
                        <Icon name="calendar" size={12} />
                        {formatDate(c.dueAt, locale)}
                      </span>
                    ) : null}
                    {c.checklist.total ? (
                      <span className="flex items-center gap-1 tn">
                        <Icon name="checkC" size={12} />
                        {c.checklist.done}/{c.checklist.total}
                      </span>
                    ) : null}
                  </span>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DrawingContent({
  token,
  grant,
  nodeId,
  fallback,
}: {
  token: string;
  grant?: string;
  nodeId?: string;
  fallback: ReactNode;
}) {
  // A drawing's thumbnail is not a file version, so its preview state reads "none": ask anyway.
  const q = useQuery({
    queryKey: [...queryKeys.publicShare(token), 'drawing', nodeId ?? null, grant ?? null],
    queryFn: ({ signal }) =>
      api.call('getPublicPreview', {
        params: { token },
        query: { grant, nodeId, kind: 'thumb_1024' },
        signal,
      }),
    retry: false,
  });
  if (q.isLoading) return <Spinner className="m-auto" />;
  if (!q.data) return <>{fallback}</>;
  return (
    <img
      src={q.data.url}
      alt=""
      className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-overlay"
    />
  );
}
