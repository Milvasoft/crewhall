import { type Page, type PageVersion } from '@crewhall/shared';
import { Avatar, Button, cn, Icon, IconButton, Input, Switch, Tag, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { pageVersionQuery, pageVersionsQuery, wikiKeys } from '@/lib/wiki/api';
import { changeCount, diffBlocks, type PMNode } from '@/lib/wiki/diff';
import { DocRender } from './DocRender';
import { ResizablePane } from '@/components/shell/ResizablePane';

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

/** Source badge (doc 17 §13 "Claude ile"). */
function SourceTag({ v }: { v: PageVersion }) {
  const { t } = useI18n();
  if (v.source === 'web') return null;
  return <Tag className="ml-1">{t(`wiki.versions.source.${v.source}`)}</Tag>;
}

/** Version history (design 5.10): grouped by day, named ones in bold; save or name now. */
export function VersionsPanel({
  page,
  selected,
  onSelect,
  onClose,
}: {
  page: Page;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery(pageVersionsQuery(page.id));
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const items = q.data?.items ?? [];
  const now = useNow();
  const today = dayKey(new Date(now).toISOString());
  const yesterday = dayKey(new Date(now - 86_400_000).toISOString());
  const heads = items.map((v, i) => {
    const d = dayKey(v.createdAt);
    if (i > 0 && dayKey(items[i - 1]!.createdAt) === d) return null;
    return d === today
      ? t('wiki.versions.today')
      : d === yesterday
        ? t('wiki.versions.yesterday')
        : formatDate(v.createdAt, locale);
  });

  return (
    <ResizablePane id="page-versions" side="right" defaultWidth={340} className="wk-noprint">
      <aside
        aria-label={t('wiki.versions.title')}
        className="wk-noprint flex w-full min-w-0 flex-col border-l border-line bg-bg"
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <span className="font-semibold">{t('wiki.versions.title')}</span>
          <IconButton
            className="ml-auto"
            aria-label={t('common.actions.close')}
            size="sm"
            tone="plain"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              'flex flex-col rounded-md px-3 py-2 text-left hover:bg-bg2',
              selected === null && 'bg-capsule',
            )}
          >
            <span className="text-[14px] font-semibold">{t('wiki.versions.current')}</span>
            <span className="text-cap text-fg3">
              {page.editedBy?.name ?? ''} · {formatDate(page.editedAt, locale)}{' '}
              {formatTime(page.editedAt, locale)}
            </span>
          </button>
          {items.map((v, i) => {
            const head = heads[i];
            const people = v.editors.length ? v.editors : v.createdBy ? [v.createdBy] : [];
            return (
              <div key={v.id}>
                {head ? <div className="eyebrow px-3 pt-3 pb-1">{head}</div> : null}
                <button
                  type="button"
                  onClick={() => onSelect(v.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-bg2',
                    selected === v.id && 'bg-capsule',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-[14px]',
                        v.label ? 'font-bold' : 'font-medium',
                      )}
                    >
                      {formatTime(v.createdAt, locale)}
                      {v.label ? ` · ${v.label}` : ''}
                      <SourceTag v={v} />
                    </span>
                    <span className="block truncate text-cap text-fg3">
                      {v.restoredFrom
                        ? t('wiki.versions.restoredFrom', { version: v.restoredFrom })
                        : v.version === 1
                          ? t('wiki.versions.created', { name: v.createdBy?.name ?? '' })
                          : people.map((p) => p.name).join(', ')}
                    </span>
                  </span>
                  <span className="flex -space-x-1.5">
                    {people.slice(0, 3).map((p) => (
                      <Avatar key={p.id} size="sm" name={p.name} src={p.imageUrl ?? undefined} />
                    ))}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {page.myRole !== 'viewer' ? (
          <div className="flex flex-col gap-2 border-t border-line p-3">
            <span className="text-cap font-semibold text-fg2">
              {t('wiki.versions.nameCurrent')}
            </span>
            <div className="flex gap-2">
              <Input
                value={label}
                placeholder={t('wiki.versions.labelPlaceholder')}
                onChange={(e) => setLabel(e.target.value)}
              />
              <Button
                size="sm"
                variant="inv"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.call('savePageVersion', {
                      params: { nodeId: page.id },
                      body: { label: label.trim() || null },
                    });
                    setLabel('');
                    toast(t('wiki.versions.saved'));
                    void qc.invalidateQueries({ queryKey: wikiKeys.versions(page.id) });
                  } catch (e) {
                    toast(t(errorKey(e)));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('wiki.versions.save')}
              </Button>
            </div>
          </div>
        ) : null}
      </aside>
    </ResizablePane>
  );
}

/** One version, read-only, with the changes against the one before (design 5.10). */
export function VersionView({
  page,
  versionId,
  onRestored,
  onCopy,
}: {
  page: Page;
  versionId: string;
  onRestored: () => void;
  onCopy: (markdown: string) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery(pageVersionQuery(page.id, versionId));
  const [highlight, setHighlight] = useState(true);
  const [busy, setBusy] = useState(false);
  const v = q.data;
  if (!v) return <p className="text-cap text-fg3">{t('wiki.nav.loading')}</p>;
  const doc = v.doc as { content?: PMNode[] };
  const prev = v.previous?.doc as { content?: PMNode[] } | undefined;
  const changes = prev ? changeCount(diffBlocks(prev.content ?? [], doc.content ?? [])) : 0;
  const canRestore = page.canEdit && !v.current;
  return (
    <div className="flex flex-col gap-4">
      <div className="wk-noprint flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg2 px-4 py-3">
        <span className="min-w-0 flex-1">
          <b className="block text-[14px]">
            {formatDate(v.createdAt, locale)} {formatTime(v.createdAt, locale)}
            {v.createdBy ? ` · ${v.createdBy.name}` : ''}
            {v.label ? ` · ${v.label}` : ''}
          </b>
          <span className="text-cap text-fg3">
            {prev
              ? t('wiki.versions.readOnlyChanges', { count: changes })
              : t('wiki.versions.readOnlyFirst')}
          </span>
        </span>
        <label className="flex items-center gap-2 text-cap text-fg2">
          <Switch checked={highlight} onCheckedChange={setHighlight} />
          {t('wiki.versions.highlight')}
          <span className="wk-add px-1">{t('wiki.versions.added')}</span>
          <span className="wk-del px-1">{t('wiki.versions.removed')}</span>
        </label>
        <Button size="sm" variant="out" onClick={() => onCopy(v.markdown)}>
          {t('wiki.versions.copy')}
        </Button>
        {canRestore ? (
          <Button
            size="sm"
            variant="pri"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.call('restorePageVersion', {
                  params: { nodeId: page.id, versionId: v.id },
                });
                toast(t('wiki.versions.restored'));
                void qc.invalidateQueries({ queryKey: wikiKeys.versions(page.id) });
                void qc.invalidateQueries({ queryKey: wikiKeys.page(page.id) });
                onRestored();
              } catch (e) {
                toast(t(errorKey(e)));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('wiki.versions.restore')}
          </Button>
        ) : null}
      </div>
      <DocRender doc={doc} previous={prev ?? null} highlight={highlight} />
    </div>
  );
}
