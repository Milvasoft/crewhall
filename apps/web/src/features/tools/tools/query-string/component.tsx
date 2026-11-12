// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/query-string/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { useI18n } from '@/lib/i18n/I18nContext';
import { buildQueryString, parseQueryString } from './logic';

const EXAMPLE = JSON.stringify({ q: 'hello world', page: 2, tags: ['new', 'featured'] }, null, 2);

export default function QueryStringTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();

  // logic.ts throws an English message for non-object JSON; JSON.parse errors stay as they are.
  const forward = (s: string) => {
    try {
      return buildQueryString(s);
    } catch (e) {
      if (e instanceof Error && /provide a json object/i.test(e.message)) {
        throw new Error(t('tools.items.query-string.notObject'), { cause: e });
      }
      throw e;
    }
  };

  return (
    <BiConverter
      definition={getDefinition('query-string')!}
      leftLabel="JSON"
      rightLabel={t('tools.items.query-string.queryString')}
      leftLanguage="json"
      forward={forward}
      backward={(s) => parseQueryString(s)}
      example={EXAMPLE}
      initialInput={initialInput}
    />
  );
}
