import { IntlMessageFormat } from 'intl-messageformat';

export type DesktopLocale = 'tr' | 'en';
export const DESKTOP_LOCALES: readonly DesktopLocale[] = ['tr', 'en'];

export type Values = Record<string, string | number>;
export type Translate = (key: string, values?: Values) => string;

/** A nested dictionary as in @crewhall/i18n (the `web` namespace). */
export interface Dictionary {
  [key: string]: string | Dictionary;
}

/**
 * Desktop language: the person's language in the web app once known, else the OS language when
 * it is supported, else the org's default, else Turkish (the source language).
 */
export function pickLocale(
  systemLanguages: readonly string[],
  orgDefault?: string | null,
  userLocale?: string | null,
): DesktopLocale {
  for (const lang of [userLocale ?? '', ...systemLanguages, orgDefault ?? '']) {
    const base = lang.trim().slice(0, 2).toLowerCase();
    if ((DESKTOP_LOCALES as readonly string[]).includes(base)) return base as DesktopLocale;
  }
  return 'tr';
}

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: string | Dictionary | undefined = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** ICU MessageFormat over a dictionary; a missing key shows itself so it is noticed. */
export function createTranslator(locale: DesktopLocale, dict: Dictionary): Translate {
  const cache = new Map<string, IntlMessageFormat>();
  return (key, values) => {
    const message = lookup(dict, key);
    if (message === undefined) return key;
    let fmt = cache.get(key);
    if (!fmt) {
      fmt = new IntlMessageFormat(message, locale);
      cache.set(key, fmt);
    }
    return String(fmt.format(values));
  };
}
