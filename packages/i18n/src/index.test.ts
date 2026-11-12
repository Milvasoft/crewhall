import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@crewhall/shared';
import { NAMESPACES, resolveLocale, resources } from './index';

const keys = (obj: unknown, prefix = ''): string[] =>
  obj && typeof obj === 'object'
    ? Object.entries(obj).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
    : [prefix.slice(0, -1)];

describe('dictionaries', () => {
  it.each(NAMESPACES)('en and tr have the same keys in %s', (ns) => {
    expect(keys(resources.en[ns]).sort()).toEqual(keys(resources.tr[ns]).sort());
  });

  it('every error code has a translation', () => {
    for (const code of ERROR_CODES) {
      expect(resources.tr.errors).toHaveProperty(code);
      expect(resources.en.errors).toHaveProperty(code);
    }
  });
});

describe('resolveLocale', () => {
  it('picks the first supported language', () => {
    expect(resolveLocale('de-DE,en-US;q=0.8')).toBe('en');
    expect(resolveLocale(['fr'])).toBe('tr');
  });
});
