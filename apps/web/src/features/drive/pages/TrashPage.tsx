import { type TrashItem } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Checkbox,
  SelectAllCheckbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes, formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { useSpaces } from '@/lib/useSpaces';
import { invalidateDrive, quotaQuery, trashQuery } from '@/features/drive/api';
import { DriveSidebar } from '@/features/drive/DriveSidebar';
import { NodeIconBox } from '@/features/drive/NodeViews';
import { QuotaBanner } from '@/features/drive/QuotaBanner';

const DAY = 86_400_000;

/**
 * Çöp kutusu (3.16): 30 days, then purged; 3 days or less shows in warning color. Restore
 * puts a node back, or at the root when its folder is gone. Only owners and admins empty it.
 */
export function TrashPage({ spaceSlug }: { spaceSlug: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const trash = useQuery({ ...trashQuery(space?.id ?? ''), enabled: Boolean(space) });
  const quota = useQuery({ ...quotaQuery, retry: false });
  const now = useNow(60_000);
  const [confirm, setConfirm] = useState<'empty' | TrashItem | string[] | null>(null);
  const items = trash.data?.items ?? [];
  const selection = useSelection(items.map((n) => n.id));
  useSelectionKeys(selection);
  const selected = selection.selected;
  const canPurge = space ? canSpace('space.purge', space.myRole) : false;
  const fail = (e: unknown) => toast(t(errorKey(e)));
  const done = () => {
    invalidateDrive(qc);
    selection.clear();
  };

  const restore = useMutation({
    mutationFn: (ids: string[]) => api.call('restoreNodes', { body: { nodeIds: ids } }),
    onSuccess: (r) => {
      done();
      toast(t('drive.trash.restored', { count: r.items.length }));
    },
    onError: fail,
  });
  const purge = useMutation({
    mutationFn: async (what: 'empty' | TrashItem | string[]) =>
      what === 'empty'
        ? api.call('emptyTrash', { params: { spaceId: space?.id ?? '' } })
        : api.call('purgeNodes', {
            body: { nodeIds: Array.isArray(what) ? what : [what.id] },
          }),
    onSuccess: () => {
      done();
      setConfirm(null);
      toast(t('drive.trash.purged'));
    },
    onError: fail,
  });

  if (!space) return null;
  const size = items.reduce((a, n) => a + n.sizeBytes, 0);

  return (
    <Workspace
      sidebar={<DriveSidebar space={space} activeFolderId={undefined} />}
      crumbs={[{ label: spaceName(space, t) }, { label: t('drive.nav.trash') }]}
      searchLabel={t('shell.searchIn', { name: spaceName(space, t) })}
    >
      {quota.data?.warning ? <QuotaBanner quota={quota.data} /> : null}
      <div className="flex shrink-0 items-end justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">{t('drive.nav.trash')}</h1>
          <span className="text-[13.5px] leading-[18px] text-fg2">
            {t('drive.trash.summary', { count: items.length, size: formatBytes(size, locale) })}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="out"
            disabled={!selected.size}
            loading={restore.isPending}
            onClick={() => restore.mutate([...selected])}
          >
            {t('drive.trash.restoreSelected')}
          </Button>
          {canPurge && selected.size ? (
            <Button size="sm" variant="dng" onClick={() => setConfirm([...selected])}>
              {t('drive.trash.purgeSelected', { count: selected.size })}
            </Button>
          ) : null}
          {canPurge ? (
            <Button
              size="sm"
              variant="dng"
              disabled={!items.length}
              onClick={() => setConfirm('empty')}
            >
              {t('drive.trash.empty')}
            </Button>
          ) : null}
        </div>
      </div>

      {trash.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : items.length === 0 ? (
        <EmptyState
          icon="trash"
          title={t('drive.trash.nothing')}
          description={t('drive.trash.nothingBody')}
        />
      ) : (
        <table
          className="w-full border-separate border-spacing-0"
          aria-label={t('drive.nav.trash')}
        >
          <thead>
            <tr className="text-left text-xs font-semibold text-fg2 [&>th]:h-9 [&>th]:px-3">
              <th className="w-9">
                <SelectAllCheckbox
                  state={selection.state}
                  onChange={selection.setAll}
                  label={t('ui.selectAll')}
                />
              </th>
              <th>{t('drive.list.name')}</th>
              <th className="w-[170px]">{t('drive.trash.from')}</th>
              <th className="w-[130px]">{t('drive.trash.by')}</th>
              <th className="w-[100px]">{t('drive.trash.deleted')}</th>
              <th className="w-[80px]">{t('drive.trash.left')}</th>
              <th className="w-[90px] text-right">{t('drive.list.size')}</th>
              <th className="w-[120px]" />
            </tr>
          </thead>
          <tbody>
            {items.map((n) => {
              const days = Math.max(0, Math.ceil((new Date(n.purgeAt).getTime() - now) / DAY));
              const on = selected.has(n.id);
              return (
                <tr
                  key={n.id}
                  aria-selected={on}
                  className={cn(
                    'h-12 [&>td]:border-b [&>td]:border-line [&>td]:px-3',
                    on && '[&>td]:bg-capsule',
                  )}
                >
                  <td>
                    <Checkbox
                      checked={on}
                      aria-label={t('drive.list.select', { name: n.name })}
                      onCheckedChange={() => selection.toggle(n.id)}
                    />
                  </td>
                  <td>
                    <span className="flex min-w-0 items-center gap-3">
                      <NodeIconBox node={n} />
                      <span className="truncate text-sm font-semibold">{n.name}</span>
                    </span>
                  </td>
                  <td className="truncate text-cap text-fg2">
                    {n.originalPath || t('drive.trash.root')}
                  </td>
                  <td>
                    {n.deletedBy ? (
                      <span className="flex items-center gap-2 text-cap">
                        <Avatar name={n.deletedBy.name} size="sm" />
                        {n.deletedBy.name.split(' ')[0]}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-cap text-fg2 tn">
                    {formatDate(n.deletedAt, locale, { day: 'numeric', month: 'short' })}
                  </td>
                  <td
                    className={cn(
                      'text-cap font-semibold tn',
                      days <= 3 ? 'text-warning' : 'text-fg2',
                    )}
                  >
                    {t('drive.trash.days', { count: days })}
                  </td>
                  <td className="text-right text-cap text-fg2 tn">
                    {n.type === 'file' ? formatBytes(n.sizeBytes, locale) : '—'}
                  </td>
                  <td className="text-right">
                    <span className="flex justify-end gap-1">
                      <Button size="xs" variant="out" onClick={() => restore.mutate([n.id])}>
                        {t('drive.trash.restore')}
                      </Button>
                      {canPurge ? (
                        <Button
                          size="xs"
                          variant="dng"
                          aria-label={t('drive.trash.purgeOne', { name: n.name })}
                          onClick={() => setConfirm(n)}
                        >
                          {t('drive.trash.purge')}
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="m-0 text-xs text-fg3">{t('drive.trash.rules')}</p>

      <Dialog open={confirm !== null} onOpenChange={(v) => (v ? null : setConfirm(null))}>
        {confirm ? (
          <DialogContent width={440}>
            <DialogHeader
              icon="trash"
              title={
                confirm === 'empty'
                  ? t('drive.trash.emptyTitle')
                  : Array.isArray(confirm)
                    ? t('drive.trash.purgeManyTitle', { count: confirm.length })
                    : t('drive.trash.purgeTitle', { name: confirm.name })
              }
              description={
                confirm === 'empty'
                  ? t('drive.trash.emptyBody', { count: items.length })
                  : t('drive.trash.purgeBody')
              }
            />
            <DialogFooter>
              <Button variant="gh" onClick={() => setConfirm(null)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="dngf"
                loading={purge.isPending}
                onClick={() => purge.mutate(confirm)}
              >
                {confirm === 'empty' ? t('drive.trash.empty') : t('drive.trash.purge')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </Workspace>
  );
}
