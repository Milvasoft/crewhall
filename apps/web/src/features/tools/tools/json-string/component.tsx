// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-string/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { useI18n } from '@/lib/i18n/I18nContext';
import { jsonToString, stringToJson } from './logic';

const EXAMPLE = JSON.stringify({ name: 'Ada', roles: ['admin'], active: true }, null, 2);

export default function JsonStringTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  return (
    <BiConverter
      definition={getDefinition('json-string')!}
      leftLabel="JSON"
      rightLabel={t('tools.items.json-string.string')}
      leftLanguage="json"
      forward={jsonToString}
      backward={(s) => stringToJson(s)}
      example={EXAMPLE}
      initialInput={initialInput}
    />
  );
}
