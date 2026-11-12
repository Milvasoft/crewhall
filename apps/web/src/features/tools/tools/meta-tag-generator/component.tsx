// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/meta-tag-generator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateMetaTags, type MetaInput } from './logic';

type FieldKey = Exclude<keyof MetaInput, 'twitterCard'>;

// Placeholders are sample data, not prose; labels come from the dictionary.
const FIELDS: { key: FieldKey; placeholder: string }[] = [
  { key: 'title', placeholder: 'Crewhall' },
  { key: 'description', placeholder: 'Local-first dev utilities' },
  { key: 'url', placeholder: 'https://example.com' },
  { key: 'image', placeholder: 'https://example.com/og.png' },
  { key: 'siteName', placeholder: 'Crewhall' },
  { key: 'type', placeholder: 'website' },
  { key: 'twitterSite', placeholder: '@crewhall' },
  { key: 'themeColor', placeholder: '#1f6feb' },
  { key: 'keywords', placeholder: 'json, regex, tools' },
];

export default function MetaTagGeneratorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [meta, setMeta] = useState<MetaInput>({
    title: 'Crewhall',
    description: 'Developer utilities that run locally in your browser.',
    url: 'https://example.com',
  });
  const definition = getDefinition('meta-tag-generator')!;

  const output = useMemo(() => generateMetaTags(meta), [meta]);

  return (
    <SplitGrid leftLabel={t('tools.items.meta-tag-generator.fieldsTitle')}>
      <div className="space-y-2.5">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t(`tools.items.meta-tag-generator.fields.${f.key}`)}
            </span>
            <input
              value={meta[f.key] ?? ''}
              onChange={(e) => setMeta((m) => ({ ...m, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              spellCheck={false}
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>
        ))}
      </div>

      <ToolEditor
        label={t('tools.items.meta-tag-generator.metaTags')}
        value={output}
        readOnly
        language="xml"
        lineNumbers
        minRows={20}
        actions={
          <>
            <CopyButton size="sm" variant="ghost" value={output} />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </SplitGrid>
  );
}
