// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/number-base/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { toolKey } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { COMMON_BASES, convertBases, parseInBase, toBase } from './logic';

export default function NumberBaseTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const baseName = (base: number) => t(toolKey('number-base', `bases.b${base}`));
  const [input, setInput] = useState(initialInput ?? '255');
  const [fromBase, setFromBase] = useState(10);
  const [customBase, setCustomBase] = useState(36);
  const definition = getDefinition('number-base')!;

  const { rows, custom, error } = useMemo(() => {
    if (!input.trim()) return { rows: [], custom: '', error: null as string | null };
    try {
      const value = parseInBase(input, fromBase);
      return {
        rows: convertBases(input, fromBase),
        custom: toBase(value, customBase),
        error: null,
      };
    } catch (e) {
      return {
        rows: [],
        custom: '',
        error: e instanceof Error ? e.message : t('tools.items.number-base.invalid'),
      };
    }
  }, [input, fromBase, customBase, t]);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.number-base.number')}
          </span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="h-9 w-full rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.number-base.inputBase')}
          </span>
          <select
            value={fromBase}
            onChange={(e) => setFromBase(Number(e.target.value))}
            className="h-9 w-36 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {COMMON_BASES.map((b) => (
              <option key={b.base} value={b.base}>
                {baseName(b.base)} ({b.base})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((r) => (
            <Row
              key={r.base}
              label={t('tools.items.number-base.rowLabel', { name: baseName(r.base), n: r.base })}
              value={r.value}
              highlight={r.base === fromBase}
              definition={definition}
            />
          ))}
          <div className="flex items-center gap-2 bg-bg2 px-3 py-2">
            <span className="text-xs text-fg2">{t('tools.items.number-base.customBase')}</span>
            <input
              type="number"
              min={2}
              max={36}
              value={customBase}
              onChange={(e) =>
                setCustomBase(Math.min(36, Math.max(2, Number(e.target.value) || 2)))
              }
              className="h-7 w-16 rounded border border-line bg-surface px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
            />
          </div>
          <Row
            label={t('tools.items.number-base.baseN', { n: customBase })}
            value={custom}
            definition={definition}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
  definition,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  definition: ReturnType<typeof getDefinition>;
}) {
  return (
    <div
      className={`group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0 ${
        highlight ? 'bg-accent/10' : ''
      }`}
    >
      <span className="w-32 shrink-0 text-xs text-fg3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{value || '—'}</span>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton size="sm" variant="ghost" value={value} />
        {definition ? <SendToMenu source={definition} value={value} /> : null}
      </div>
    </div>
  );
}
