import { Badge } from '@crewhall/ui';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';

/** "Misafir" next to a person (design doc 17 §5), with the access end when there is one. */
export function GuestBadge({ expiresAt }: { expiresAt?: string | null | undefined }) {
  const { t, locale } = useI18n();
  const until = expiresAt ? formatDateLong(expiresAt, locale) : null;
  const now = useNow(60_000);
  const expired = expiresAt ? new Date(expiresAt).getTime() <= now : false;
  return (
    <Badge
      tone={expired ? 'danger' : 'info'}
      plain
      title={until ? t('identity.guest.until', { date: until }) : undefined}
    >
      {expired ? t('identity.guest.expired') : t('identity.guest.badge')}
    </Badge>
  );
}

/** "yyyy-MM-dd" from the date picker → the end of that local day as an ISO time. */
export function endOfDay(date: string) {
  return new Date(`${date}T23:59:59`).toISOString();
}

/** ISO time → the date picker's local "yyyy-MM-dd". */
export function pickerDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
