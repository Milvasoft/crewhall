import { type OrgQuota } from '@crewhall/shared';
import { Button, cn, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { formatBytes, formatPercent } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';

/** Org storage at 90 % or more (3.16); at 100 % new uploads stop, pages and chat go on. */
export function QuotaBanner({ quota }: { quota: OrgQuota }) {
  const { t, locale } = useI18n();
  const { canOrg } = usePermissions();
  if (!quota.quotaBytes) return null;
  const pct = (quota.usedBytes / quota.quotaBytes) * 100;
  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-xl px-4 py-3',
        quota.full
          ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]'
          : 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]',
      )}
    >
      <Icon name="disk" size={20} className={quota.full ? 'text-danger' : 'text-warning'} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-cap font-semibold">
          {t(quota.full ? 'drive.quota.full' : 'drive.quota.warning', {
            pct: formatPercent(pct, locale),
            used: formatBytes(quota.usedBytes, locale),
            total: formatBytes(quota.quotaBytes, locale),
          })}
        </span>
        <span className="text-xs text-fg2">
          {t('drive.quota.trash', { size: formatBytes(quota.trashBytes, locale) })}
        </span>
      </span>
      {canOrg('org.update_settings') ? (
        <Button size="xs" variant="inv" asChild>
          <Link to="/admin/general">{t('drive.quota.manage')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
