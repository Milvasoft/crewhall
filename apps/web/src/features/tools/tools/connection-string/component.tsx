// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/connection-string/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { useI18n } from '@/lib/i18n/I18nContext';
import { connectionStringToJson, jsonToConnectionString } from './logic';

const EXAMPLE =
  'Server=localhost;Database=AppDb;User Id=sa;Password=Str0ng!;TrustServerCertificate=True';

export default function ConnectionStringTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  return (
    <BiConverter
      definition={getDefinition('connection-string')!}
      leftLabel={t('tools.items.connection-string.connectionString')}
      rightLabel="JSON"
      rightLanguage="json"
      forward={(s) => connectionStringToJson(s)}
      backward={jsonToConnectionString}
      example={EXAMPLE}
      initialInput={initialInput}
    />
  );
}
