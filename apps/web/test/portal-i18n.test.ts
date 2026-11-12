import { editorLabelKeys } from '@crewhall/editor/react';
import { resources } from '@crewhall/i18n';
import { describe, expect, it } from 'vitest';

const keys = (obj: unknown, prefix = ''): string[] =>
  obj && typeof obj === 'object'
    ? Object.entries(obj).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
    : [prefix.slice(0, -1)];

describe('portal dictionaries', () => {
  it('has the same portal keys in Turkish and English', () => {
    expect(keys(resources.en.web.portal).sort()).toEqual(keys(resources.tr.web.portal).sort());
  });

  it.each(['tr', 'en'] as const)('translates every editor label in %s', (locale) => {
    // Shared by portal and wiki: web/editor.json.
    const editor = resources[locale].web.editor as Record<string, string>;
    for (const key of editorLabelKeys) {
      expect(editor[key], key).toBeTruthy();
    }
  });
});
