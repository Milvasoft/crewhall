import { type Space } from '@crewhall/shared';
import { cn, Icon, Kbd, Popover, PopoverContent, PopoverTrigger } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { spaceName, spaceSubtitle } from '@/components/spaces/spaceUtils';
import { openDialog } from '@/lib/dialogs';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';

/**
 * Space selector at the top of the sidebar (doc 03 · 3.1). Personal first, Ctrl 1..5 switch,
 * archived spaces listed apart, settings and "Yeni space" at the bottom.
 */
export function SpaceSwitcher({
  current,
  onSelect,
}: {
  current: Space | undefined;
  onSelect: (space: Space) => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { canOrg, canSpace } = usePermissions();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const { data } = useQuery(spacesQuery());
  const archived = useQuery({ ...spacesQuery(true), enabled: open });
  const spaces = useMemo(() => data?.items ?? [], [data]);

  // Ctrl/Cmd + 1..9 switches spaces from anywhere in the space area.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const target = spaces[n - 1];
      if (target) {
        e.preventDefault();
        onSelect(target);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spaces, onSelect]);

  const needle = q.trim().toLocaleLowerCase(locale);
  const visible = needle
    ? spaces.filter((s) => spaceName(s, t).toLocaleLowerCase(locale).includes(needle))
    : spaces;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ('');
      }}
    >
      <PopoverTrigger
        className={cn(
          'mb-1.5 flex h-12 w-full shrink-0 items-center gap-2.5 rounded-lg pr-2.5 pl-2 text-left text-fg hover:bg-bg2',
          open && 'bg-bg2',
        )}
        aria-label={t('spaces.switcher')}
      >
        {current ? <SpaceAvatar space={current} /> : <span className="size-7 rounded-sm bg-bg2" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {current ? spaceName(current, t) : '…'}
          </span>
          <span className="truncate text-[11.5px] leading-[14px] text-fg2">
            {current ? spaceSubtitle(current, t) : ''}
          </span>
        </span>
        <Icon name="chevUD" size={16} className="text-fg2" />
      </PopoverTrigger>
      <PopoverContent className="w-[272px] p-1.5" sideOffset={4}>
        <div className="flex h-9 items-center gap-2 rounded-md bg-bg2 px-2.5">
          <Icon name="search" size={15} className="text-fg2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('spaces.search')}
            aria-label={t('spaces.search')}
            autoFocus
            className="h-full min-w-0 flex-1 bg-transparent text-cap text-fg outline-none placeholder:text-fg3 focus-visible:shadow-none"
          />
        </div>
        <div className="eyebrow px-2.5 pt-3 pb-1.5">{t('spaces.yours')}</div>
        <ul
          role="listbox"
          aria-label={t('spaces.yours')}
          className="m-0 flex list-none flex-col gap-px p-0"
        >
          {visible.map((s) => {
            const index = spaces.indexOf(s);
            const on = s.id === current?.id;
            return (
              <li key={s.id} role="option" aria-selected={on}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(s);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-capsule',
                    on && 'bg-capsule',
                  )}
                >
                  <SpaceAvatar space={s} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] leading-[18px] font-semibold">
                      {spaceName(s, t)}
                    </span>
                    <span className="truncate text-[11.5px] leading-[14px] text-fg2">
                      {spaceSubtitle(s, t)}
                    </span>
                  </span>
                  {on ? (
                    <Icon name="check" size={16} />
                  ) : index < 9 ? (
                    <Kbd>Ctrl {index + 1}</Kbd>
                  ) : null}
                </button>
              </li>
            );
          })}
          {visible.length === 0 ? (
            <li className="px-2.5 py-3 text-cap text-fg2">{t('spaces.noMatch')}</li>
          ) : null}
        </ul>
        <div className="mx-1.5 my-1 h-px bg-line" />
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          aria-expanded={showArchived}
          className="flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg hover:bg-capsule"
        >
          <Icon name="archive" size={16} className="text-fg2" />
          <span className="flex-1 text-left">{t('spaces.archived')}</span>
          <span className="text-xs text-fg3">{archived.data?.items.length ?? ''}</span>
        </button>
        {showArchived
          ? archived.data?.items.map((s) => (
              <div
                key={s.id}
                className="flex h-9 items-center gap-2.5 rounded-sm px-2.5 pl-8 text-cap text-fg2"
              >
                <SpaceAvatar space={s} size="sm" />
                <span className="truncate">{s.name}</span>
              </div>
            ))
          : null}
        {current &&
        canSpace('space.update_settings', current.myRole) &&
        current.kind === 'shared' ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void navigate({
                to: '/spaces/$spaceSlug/settings',
                params: { spaceSlug: current.slug },
              });
            }}
            className="flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg hover:bg-capsule"
          >
            <Icon name="settings" size={16} className="text-fg2" />
            {t('spaces.settingsOf', { name: current.name })}
          </button>
        ) : null}
        {canOrg('org.create_space') ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openDialog('newSpace');
            }}
            className="flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg hover:bg-capsule"
          >
            <Icon name="plus" size={16} className="text-fg2" />
            {t('spaces.new')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
