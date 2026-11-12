import { type Space } from '@crewhall/shared';
import { cn, Icon, Progress, type IconName } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { SpaceSwitcher } from '@/components/spaces/SpaceSwitcher';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

/** 248px space sidebar: selector on top, module tree (later phases), storage at the bottom. */
export function SpaceSidebar({
  space,
  onSelect,
  children,
  storage,
}: {
  space: Space | undefined;
  onSelect: (s: Space) => void;
  children?: ReactNode;
  /** Org storage instead of the space's (Drive shows the org quota, 3.16). */
  storage?: { usedBytes: number; quotaBytes: number | null; warning?: boolean };
}) {
  const { t, locale } = useI18n();
  const { canSpace } = usePermissions();
  const used = storage?.usedBytes ?? space?.usedBytes ?? 0;
  const quota = storage ? storage.quotaBytes : (space?.quotaBytes ?? null);

  return (
    <ModuleSidebar label={t('spaces.sidebar')} className="gap-px overflow-hidden px-2.5 py-3">
      <SpaceSwitcher current={space} onSelect={onSelect} />
      {children}
      {space && space.kind === 'shared' && canSpace('space.update_settings', space.myRole) ? (
        <NavItem
          icon="settings"
          to="/spaces/$spaceSlug/settings"
          params={{ spaceSlug: space.slug }}
          label={t('spaces.settings')}
        />
      ) : null}
      {space ? (
        <div className="mt-auto flex shrink-0 flex-col gap-1.5 border-t border-line px-2.5 pt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-fg2">{t('spaces.storage')}</span>
            <span className="text-fg3 tn">
              {formatBytes(used, locale)}
              {quota ? ` / ${formatBytes(quota, locale)}` : ''}
            </span>
          </div>
          {quota ? (
            <Progress
              neutral={!storage?.warning}
              value={(used / quota) * 100}
              label={t('spaces.storage')}
            />
          ) : null}
        </div>
      ) : null}
    </ModuleSidebar>
  );
}

export function NavItem({
  icon,
  label,
  to,
  params,
  count,
  exact,
}: {
  icon: IconName;
  label: ReactNode;
  to: string;
  params?: Record<string, string>;
  count?: ReactNode;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      params={params}
      activeOptions={{ exact: exact ?? true }}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium whitespace-nowrap text-fg2 hover:bg-bg2 hover:text-fg',
        'data-[status=active]:bg-capsule data-[status=active]:font-semibold data-[status=active]:text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="text-xs font-medium text-fg3">{count}</span> : null}
    </Link>
  );
}
