import { en, type SiteStrings } from '@/i18n/en';
import { tr } from '@/i18n/tr';

export type { SiteStrings };

const dictionaries: Record<string, SiteStrings> = { en, tr };

/** Site strings for a locale (`tr-TR` → `tr`), English for others. */
export function strings(locale: string): SiteStrings {
  return dictionaries[locale] ?? dictionaries[locale.slice(0, 2)] ?? en;
}

/** Replaces `{name}` placeholders. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

/** Language name in the given locale, e.g. ('tr', 'en') → 'İngilizce'. */
export function languageName(inLocale: string, code: string): string {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** Long date as Docusaurus prints it ("July 20, 2026", "20 Temmuz 2026"); dates are UTC. */
export function formatDate(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** "July 19" for the archive page. */
export function formatMonthDay(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}
