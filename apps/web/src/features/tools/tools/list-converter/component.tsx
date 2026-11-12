// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/list-converter/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { DEFAULT_OPTIONS, listStats, transformList, type ListOptions } from './logic';

export default function ListConverterTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'banana\napple\ncherry\napple\n  date  ');
  const [opts, setOpts] = useState<ListOptions>(DEFAULT_OPTIONS);
  const definition = getDefinition('list-converter')!;

  const output = useMemo(() => transformList(input, opts), [input, opts]);
  const stats = useMemo(() => listStats(input), [input]);

  const set = <K extends keyof ListOptions>(key: K, value: ListOptions[K]) =>
    setOpts((o) => ({ ...o, [key]: value }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border border-line bg-surface p-3">
        <Toggle
          label={t('tools.items.list-converter.trim')}
          checked={opts.trim}
          onChange={(v) => set('trim', v)}
        />
        <Toggle
          label={t('tools.items.list-converter.removeEmpty')}
          checked={opts.removeEmpty}
          onChange={(v) => set('removeEmpty', v)}
        />
        <Toggle
          label={t('tools.items.list-converter.dedupe')}
          checked={opts.dedupe}
          onChange={(v) => set('dedupe', v)}
        />
        <Toggle
          label={t('tools.items.list-converter.reverse')}
          checked={opts.reverse}
          onChange={(v) => set('reverse', v)}
        />
        <Field label={t('tools.items.list-converter.sort')}>
          <select
            value={opts.sort}
            onChange={(e) => set('sort', e.target.value as ListOptions['sort'])}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="none">{t('tools.items.list-converter.sortNone')}</option>
            <option value="asc">A → Z</option>
            <option value="desc">Z → A</option>
            <option value="numeric">{t('tools.items.list-converter.sortNumeric')}</option>
            <option value="length">{t('tools.items.list-converter.sortLength')}</option>
          </select>
        </Field>
        <Field label={t('tools.items.list-converter.case')}>
          <select
            value={opts.caseTransform}
            onChange={(e) => set('caseTransform', e.target.value as ListOptions['caseTransform'])}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="none">{t('tools.items.list-converter.caseKeep')}</option>
            <option value="lower">{t('tools.items.list-converter.caseLower')}</option>
            <option value="upper">{t('tools.items.list-converter.caseUpper')}</option>
          </select>
        </Field>
        <Field label={t('tools.items.list-converter.prefix')}>
          <input
            value={opts.prefix}
            onChange={(e) => set('prefix', e.target.value)}
            className="h-8 w-20 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label={t('tools.items.list-converter.suffix')}>
          <input
            value={opts.suffix}
            onChange={(e) => set('suffix', e.target.value)}
            className="h-8 w-20 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </Field>
        <Field label={t('tools.items.list-converter.joinWith')}>
          <select
            value={opts.separator}
            onChange={(e) => set('separator', e.target.value)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value={'\n'}>{t('tools.items.list-converter.sepNewline')}</option>
            <option value={', '}>{t('tools.items.list-converter.sepComma')}</option>
            <option value={' '}>{t('tools.items.list-converter.sepSpace')}</option>
            <option value={' | '}>{t('tools.items.list-converter.sepPipe')}</option>
          </select>
        </Field>
      </div>

      <SplitGrid leftLabel={t('tools.common.input')} rightLabel={t('tools.common.output')}>
        <ToolEditor
          label={t('tools.common.input')}
          value={input}
          onChange={setInput}
          minRows={14}
          footer={t('tools.items.list-converter.stats', {
            total: stats.lines,
            count: stats.unique,
          })}
        />
        <ToolEditor
          label={t('tools.common.output')}
          value={output}
          readOnly
          minRows={14}
          actions={
            <>
              <CopyButton size="sm" variant="ghost" value={output} />
              <SendToMenu source={definition} value={output} />
            </>
          }
        />
      </SplitGrid>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-fg2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg2">{label}</span>
      {children}
    </label>
  );
}
