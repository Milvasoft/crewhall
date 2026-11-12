import { Avatar, Button, cn, Icon, IconButton, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes, formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNodeActions } from './actions';
import { nodeQuery, sharesQuery } from './api';
import { NodeIconBox, typeLabel } from './NodeViews';
import { VersionList } from './Previewer';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** Right panel with info, access and versions; follows the selection (3.10). */
export function DetailPanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const node = useQuery(nodeQuery(nodeId));
  const shares = useQuery({ ...sharesQuery(nodeId), retry: false });
  const actions = useNodeActions();
  const [tab, setTab] = useState<'info' | 'versions'>('info');
  const n = node.data;
  const people = shares.data?.items.filter((s) => s.kind === 'user').length ?? 0;
  const links = shares.data?.items.filter((s) => s.kind === 'link').length ?? 0;

  return (
    <ResizablePane id="drive-detail" side="right" defaultWidth={340}>
      <aside
        aria-label={t('drive.details.title')}
        className="flex w-full min-w-0 flex-col border-l border-line bg-bg"
      >
        <header className="flex items-center gap-3 px-4 pt-4 pb-3">
          {n ? <NodeIconBox node={n} /> : <Skeleton className="size-8" />}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{n?.name}</span>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </IconButton>
        </header>
        <div role="tablist" className="flex gap-5 border-b border-line px-4">
          {(n?.type === 'file' ? (['info', 'versions'] as const) : (['info'] as const)).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'relative h-[38px] text-nav font-medium text-fg2',
                tab === k &&
                  'font-semibold text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-[2px] after:bg-accent',
              )}
            >
              {k === 'versions' && n?.version
                ? `${t('drive.preview.tabs.versions')} ${n.version}`
                : t(`drive.preview.tabs.${k}`)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!n ? (
            <Skeleton className="h-40 w-full" />
          ) : tab === 'versions' && n.type === 'file' ? (
            <VersionList node={n} />
          ) : (
            <div className="flex flex-col gap-5">
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-cap">
                <dt className="text-fg2">{t('drive.details.type')}</dt>
                <dd className="m-0">{typeLabel(n, t)}</dd>
                <dt className="text-fg2">{t('drive.details.location')}</dt>
                <dd className="m-0">{[n.space.name, ...n.path.map((p) => p.name)].join(' › ')}</dd>
                <dt className="text-fg2">{t('drive.details.owner')}</dt>
                <dd className="m-0 flex items-center gap-2">
                  {n.createdBy ? (
                    <Avatar name={n.createdBy.name} size="sm" src={n.createdBy.imageUrl} />
                  ) : null}
                  {n.createdBy?.name ?? t('drive.list.system')}
                </dd>
                <dt className="text-fg2">{t('drive.details.updated')}</dt>
                <dd className="m-0">
                  {formatDate(n.updatedAt, locale, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {n.version ? ` · ${t('drive.preview.version', { n: n.version })}` : ''}
                </dd>
                {n.type === 'file' ? (
                  <>
                    <dt className="text-fg2">{t('drive.details.size')}</dt>
                    <dd className="m-0">{formatBytes(n.sizeBytes, locale)}</dd>
                  </>
                ) : null}
                <dt className="text-fg2">{t('drive.details.access')}</dt>
                <dd className="m-0">
                  {shares.data
                    ? t('drive.details.accessValue', {
                        members: shares.data.space.memberCount,
                        people,
                        links,
                      })
                    : '…'}
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                {actions.can(n, 'space.share_user') || actions.can(n, 'space.share_link') ? (
                  <Button size="sm" variant="out" onClick={() => actions.share(n)}>
                    <Icon name="share" size={15} />
                    {t('drive.menu.share')}
                  </Button>
                ) : null}
                {n.type === 'file' ? (
                  <Button size="sm" variant="out" onClick={() => void actions.download([n])}>
                    <Icon name="download" size={15} />
                    {t('drive.menu.download')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="gh"
                  aria-pressed={n.favorite}
                  onClick={() => actions.favorite(n)}
                >
                  <Icon name="star" size={15} fill={n.favorite ? 'currentColor' : 'none'} />
                  {n.favorite ? t('drive.menu.unfavorite') : t('drive.menu.favorite')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </ResizablePane>
  );
}
