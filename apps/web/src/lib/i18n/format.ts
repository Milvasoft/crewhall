import { type AppLocale } from '@crewhall/i18n';

/** Locale-aware formatters (doc 16 §9.6: "4,2 MB", "%64", "19 Eki 2026"). */

const BCP47: Record<AppLocale, string> = { tr: 'tr-TR', en: 'en-US' };

export function formatDate(
  value: string | Date,
  locale: AppLocale,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string {
  return new Intl.DateTimeFormat(BCP47[locale], opts).format(new Date(value));
}

export function formatDateLong(value: string | Date, locale: AppLocale): string {
  return formatDate(value, locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(value: string | Date, locale: AppLocale): string {
  return new Intl.DateTimeFormat(BCP47[locale], { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}

export function formatNumber(value: number, locale: AppLocale, digits = 0): string {
  return new Intl.NumberFormat(BCP47[locale], {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value / 100);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number, locale: AppLocale): string {
  if (bytes < 1024) return `${formatNumber(bytes, locale)} B`;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${formatNumber(v, locale, v < 100 ? 1 : 0)} ${UNITS[u]}`;
}

/** "12 dk önce" / "12 min ago"; switches to a date after a week. */
export function formatRelative(value: string | Date, locale: AppLocale, now = new Date()): string {
  const d = new Date(value);
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(BCP47[locale], { numeric: 'auto', style: 'short' });
  if (abs < 60) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), 'day');
  return formatDate(d, locale);
}

/** "Pazartesi, 19 Ekim" for the greeting line. */
export function formatWeekdayDate(value: Date, locale: AppLocale): string {
  return new Intl.DateTimeFormat(BCP47[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(value);
}

/** Locale aware upper case (i -> İ in Turkish). */
export function upper(value: string, locale: AppLocale): string {
  return value.toLocaleUpperCase(BCP47[locale]);
}
