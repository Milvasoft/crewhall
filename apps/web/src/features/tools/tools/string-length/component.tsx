// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-length/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nContext';
import { computeTextStats, type TextStats } from './logic';

const FIELDS: (keyof TextStats)[] = [
  'characters',
  'charactersNoSpaces',
  'words',
  'lines',
  'sentences',
  'bytes',
  'utf16',
];

export default function StringLengthTool({ initialInput }: ToolComponentProps) {
  const { t, locale } = useI18n();
  const [text, setText] = useState(initialInput ?? '');

  const stats = useMemo(() => computeTextStats(text), [text]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
      <ToolEditor
        label={t('tools.common.text')}
        value={text}
        onChange={setText}
        placeholder={t('tools.items.string-length.placeholder')}
        minRows={16}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setText(t('tools.items.string-length.example'))}
            >
              {t('tools.common.sample')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setText('')}>
              {t('tools.common.clear')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2 self-start lg:grid-cols-1">
        {FIELDS.map((key) => (
          <div
            key={key}
            className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span className="text-xs text-fg2">{t(`tools.items.string-length.fields.${key}`)}</span>
            <span className="font-mono text-sm font-semibold text-fg tabular-nums">
              {stats[key].toLocaleString(locale)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
