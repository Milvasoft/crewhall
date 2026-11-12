import { pwnedCount, pwnedQuery } from '@crewhall/crypto';
import { cn, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { policyQuery } from '@/lib/vault/api';
import { fetchBreachRange } from '@/lib/vault/engine-client';

/**
 * Leaked password check for one password (roadmap 20), next to the strength badge. Only the
 * first five hex digits of its SHA-1 leave the device (as the query key and the request); the
 * suffix is matched here. Hidden when the org turned the check off.
 */
export function BreachBadge({ password }: { password: string }) {
  const { t, locale } = useI18n();
  const policy = useQuery(policyQuery);
  const enabled = policy.data?.breachCheck === true;
  const q = useMemo(() => (password && enabled ? pwnedQuery(password) : null), [password, enabled]);
  const range = useQuery({
    queryKey: ['vault', 'breach', q?.prefix ?? ''],
    queryFn: () => fetchBreachRange(q!.prefix),
    enabled: q !== null,
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });
  if (!q) return null;
  if (range.isPending) {
    return <span className="text-xs text-fg3">{t('vault.breach.checking')}</span>;
  }
  if (range.isError) {
    return <span className="text-xs text-fg3">{t('vault.breach.unavailable')}</span>;
  }
  const n = pwnedCount(range.data, q.suffix);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-semibold',
        n ? 'text-danger' : 'text-success',
      )}
    >
      <Icon name={n ? 'alert' : 'checkC'} size={13} />
      {n ? t('vault.breach.found', { count: formatNumber(n, locale) }) : t('vault.breach.clean')}
    </span>
  );
}
