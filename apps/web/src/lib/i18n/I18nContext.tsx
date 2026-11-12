import { LOCALES, resolveLocale, resources, type AppLocale } from '@crewhall/i18n';
import { PickerLocaleProvider, type PickerLabels } from '@crewhall/ui';
import { type ErrorCode } from '@crewhall/shared';
import { IntlMessageFormat } from 'intl-messageformat';
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { setApiLocale } from '@/lib/api';
import { I18nContext } from './context';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

type WebDict = (typeof resources)['tr']['web'];
type CommonDict = (typeof resources)['tr']['common'];

export type WebKey = Leaves<WebDict>;
export type MessageKey = WebKey | `common.${Leaves<CommonDict>}` | `errors.${ErrorCode}`;
export type MessageValues = Record<string, string | number | Date | null | undefined>;
export type RichValues = Record<
  string,
  string | number | Date | ReactNode | ((chunks: ReactNode[]) => ReactNode)
>;

function lookup(locale: AppLocale, key: string): string | undefined {
  const dict = resources[locale];
  let ns: unknown = dict.web;
  let path = key;
  if (key.startsWith('common.')) {
    ns = dict.common;
    path = key.slice(7);
  } else if (key.startsWith('errors.')) {
    ns = dict.errors;
    path = key.slice(7);
  }
  let node: unknown = ns;
  for (const part of path.split('.')) {
    if (node && typeof node === 'object' && part in node) {
      node = (node as Record<string, unknown>)[part];
    } else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

const cache = new Map<string, IntlMessageFormat>();

function format(locale: AppLocale, key: string, values?: RichValues): string | ReactNode[] {
  const message = lookup(locale, key) ?? lookup('tr', key);
  if (message === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key ${key}`);
    return key;
  }
  const id = `${locale}:${key}`;
  let fmt = cache.get(id);
  if (!fmt) {
    fmt = new IntlMessageFormat(message, locale, undefined, { ignoreTag: false });
    cache.set(id, fmt);
  }
  return fmt.format(values as Record<string, never>) as string | ReactNode[];
}

/** Initial locale: stored choice, then the browser, then Turkish (source language). */
export function initialLocale(): AppLocale {
  const stored = readStorage(StorageKey.locale);
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as AppLocale;
  return resolveLocale(typeof navigator === 'undefined' ? null : navigator.languages);
}

export interface I18nValue {
  locale: AppLocale;
  /** `persist: false` applies a default (org, account) without recording a personal choice. */
  setLocale: (l: AppLocale, opts?: { persist?: boolean }) => void;
  /** Plain-text message (aria-label, title, placeholder). */
  t: (key: MessageKey, values?: MessageValues) => string;
  /** Message with tags like <b>…</b> mapped to React nodes. */
  rich: (key: MessageKey, values?: RichValues) => ReactNode;
}

function buildI18n(locale: AppLocale, setLocale: I18nValue['setLocale']): I18nValue {
  return {
    locale,
    setLocale,
    t: (key, values) => {
      const out = format(locale, key, values);
      return Array.isArray(out) ? out.join('') : String(out);
    },
    rich: (key, values) => {
      const withDefaults: RichValues = {
        b: (c: ReactNode[]) => <b className="font-semibold text-fg">{c}</b>,
        ...values,
      };
      const out = format(locale, key, withDefaults);
      if (!Array.isArray(out)) return out;
      return out.map((part, i) => <Fragment key={i}>{part}</Fragment>);
    },
  };
}

export function I18nProvider({
  children,
  locale: forced,
}: {
  children: ReactNode;
  /** Tests pin the locale. */
  locale?: AppLocale;
}) {
  const [locale, setLocaleState] = useState<AppLocale>(forced ?? initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    setApiLocale(locale);
  }, [locale]);

  const setLocale = useCallback((l: AppLocale, opts?: { persist?: boolean }) => {
    if (opts?.persist !== false) writeStorage(StorageKey.locale, l);
    setLocaleState(l);
  }, []);

  const value = useMemo(() => buildI18n(locale, setLocale), [locale, setLocale]);
  const pickerLabels = useMemo(() => buildPickerLabels(value.t), [value]);

  return (
    <I18nContext.Provider value={value}>
      <PickerLocaleProvider locale={PICKER_LOCALE[locale]} labels={pickerLabels}>
        {children}
      </PickerLocaleProvider>
    </I18nContext.Provider>
  );
}

/** Date format and first weekday of the shared pickers (tr: 18.10.2026, Monday first). */
const PICKER_LOCALE: Record<AppLocale, string> = { tr: 'tr-TR', en: 'en-US' };

function buildPickerLabels(t: I18nValue['t']): PickerLabels {
  return {
    datePlaceholder: t('ui.picker.datePlaceholder'),
    rangePlaceholder: t('ui.picker.rangePlaceholder'),
    timePlaceholder: t('ui.picker.timePlaceholder'),
    chooseDate: t('ui.picker.chooseDate'),
    chooseRange: t('ui.picker.chooseRange'),
    chooseTime: t('ui.picker.chooseTime'),
    clear: t('ui.picker.clear'),
    previousMonth: t('ui.picker.previousMonth'),
    nextMonth: t('ui.picker.nextMonth'),
    previousYear: t('ui.picker.previousYear'),
    nextYear: t('ui.picker.nextYear'),
    previousYears: t('ui.picker.previousYears'),
    nextYears: t('ui.picker.nextYears'),
    chooseMonthYear: t('ui.picker.chooseMonthYear'),
    chooseYear: t('ui.picker.chooseYear'),
    hours: t('ui.picker.hours'),
    minutes: t('ui.picker.minutes'),
    pickEnd: (from) => t('ui.picker.pickEnd', { from }),
    presets: {
      today: t('ui.picker.presets.today'),
      yesterday: t('ui.picker.presets.yesterday'),
      last7: t('ui.picker.presets.last7'),
      last30: t('ui.picker.presets.last30'),
      thisMonth: t('ui.picker.presets.thisMonth'),
      lastMonth: t('ui.picker.presets.lastMonth'),
      custom: t('ui.picker.presets.custom'),
    },
  };
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/**
 * For screens that may render above the provider (the root error boundary): falls back to
 * the stored or browser language instead of throwing.
 */
export function useI18nOrDefault(): I18nValue {
  const ctx = useContext(I18nContext);
  return useMemo(
    () => ctx ?? buildI18n(initialLocale(), (l) => writeStorage(StorageKey.locale, l)),
    [ctx],
  );
}

export function useT() {
  return useI18n().t;
}
