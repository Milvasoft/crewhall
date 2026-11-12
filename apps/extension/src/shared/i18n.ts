import enErrorsVault from '@crewhall/i18n/locales/en/errors/vault.json';
import enErrors from '@crewhall/i18n/locales/en/errors.json';
import en from '@crewhall/i18n/locales/en/web/extension.json';
import trErrorsVault from '@crewhall/i18n/locales/tr/errors/vault.json';
import trErrors from '@crewhall/i18n/locales/tr/errors.json';
import tr from '@crewhall/i18n/locales/tr/web/extension.json';

type Tree = { [key: string]: string | Tree };

const dictionaries: Record<'tr' | 'en', { ui: Tree; errors: Tree }> = {
  tr: { ui: tr, errors: { ...trErrors, ...trErrorsVault } },
  en: { ui: en, errors: { ...enErrors, ...enErrorsVault } },
};

export function locale(): 'tr' | 'en' {
  const ui = typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage?.() : undefined;
  return ui?.toLowerCase().startsWith('en') ? 'en' : 'tr';
}

function lookup(tree: Tree, path: string): string | null {
  let node: string | Tree | undefined = tree;
  for (const part of path.split('.')) {
    if (typeof node !== 'object') return null;
    node = node[part];
  }
  return typeof node === 'string' ? node : null;
}

function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in vars ? String(vars[name]) : all,
  );
}

export function t(key: string, vars?: Record<string, string | number>): string {
  return fill(lookup(dictionaries[locale()].ui, key) ?? key, vars);
}

/** The text of an error: `{ code }` from the server or the vault service, else a general one. */
export function errorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    const text = lookup(dictionaries[locale()].errors, code);
    if (text) return text;
    const own = lookup(dictionaries[locale()].ui, `errors.${code}`);
    if (own) return own;
  }
  return t('errors.general');
}
