import { type DriveNode } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  Input,
  Skeleton,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

export type PickedFile = Pick<DriveNode, 'id' | 'name' | 'sizeBytes'>;

/** Attach from Drive: recently opened files, or a name search over every space the user sees. */
export function DrivePicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (files: PickedFile[]) => void;
}) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<Map<string, PickedFile>>(new Map());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const recent = useQuery({
    queryKey: ['mail', 'drive-picker', 'recent'],
    queryFn: ({ signal }) => api.call('listRecent', { query: { limit: 30 }, signal }),
    enabled: open && !debounced,
  });
  const search = useQuery({
    queryKey: ['mail', 'drive-picker', 'search', debounced],
    queryFn: ({ signal }) =>
      api.call('searchNodes', { query: { q: debounced, type: 'file', limit: 30 }, signal }),
    enabled: open && Boolean(debounced),
  });
  const files: PickedFile[] = debounced
    ? (search.data?.items ?? []).map((h) => h.node)
    : (recent.data?.items ?? []).filter((n) => n.type === 'file');
  const pending = debounced ? search.isPending : recent.isPending;

  const toggle = (f: PickedFile) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(f.id)) next.delete(f.id);
      else next.set(f.id, f);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader
          icon="folder"
          title={t('mail.drivePicker.title')}
          description={t('mail.drivePicker.description')}
        />
        <Input
          type="search"
          aria-label={t('mail.drivePicker.search')}
          placeholder={t('mail.drivePicker.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="eyebrow">
          {debounced ? t('mail.drivePicker.results') : t('mail.drivePicker.recent')}
        </span>
        <ul className="m-0 flex max-h-[320px] min-h-[120px] list-none flex-col overflow-y-auto p-0">
          {pending ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="my-1 h-9" />)
          ) : files.length === 0 ? (
            <EmptyState icon="file" title={t('mail.drivePicker.empty')} />
          ) : (
            files.map((f) => (
              <li key={f.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-bg2">
                  <Checkbox checked={picked.has(f.id)} onCheckedChange={() => toggle(f)} />
                  <Icon name="file" size={16} className="shrink-0 text-fg2" />
                  <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                  <span className="shrink-0 text-xs text-fg3">
                    {formatBytes(f.sizeBytes, locale)}
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            disabled={picked.size === 0}
            onClick={() => {
              onPick([...picked.values()]);
              onOpenChange(false);
            }}
          >
            {picked.size
              ? t('mail.drivePicker.addCount', { count: picked.size })
              : t('mail.drivePicker.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
