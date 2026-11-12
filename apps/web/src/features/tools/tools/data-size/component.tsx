// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/data-size/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SIZE_UNITS, convertAll, formatNumber, humanize, toBytes, type SizeUnit } from './logic';
import { useI18n } from '@/lib/i18n/I18nContext';

type Group = SizeUnit['group'];

export default function DataSizeTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(() => {
    const n = Number(initialInput);
    return initialInput && Number.isFinite(n) ? String(n) : '1';
  });
  const [fromId, setFromId] = useState('mib');

  const num = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(num);

  const rows = useMemo(() => (valid ? convertAll(num, fromId) : []), [num, fromId, valid]);

  const bytes = valid ? toBytes(num, fromId) : 0;

  const grouped = useMemo(() => {
    const groups: Record<Group, typeof rows> = { bits: [], decimal: [], binary: [] };
    for (const r of rows) groups[r.unit.group].push(r);
    return groups;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.data-size.value')}</span>
          <input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 w-40 rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.data-size.fromUnit')}
          </span>
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {SIZE_UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {valid && (
        <div className="rounded-lg border border-line bg-bg2 px-4 py-3 text-sm">
          <span className="text-fg2">{t('tools.items.data-size.bestFit')} </span>
          <span className="font-mono font-semibold text-fg">{humanize(bytes, true)}</span>
          <span className="text-fg3"> · {humanize(bytes, false)}</span>
        </div>
      )}

      {!valid && <p className="text-sm text-danger">{t('tools.items.data-size.invalid')}</p>}

      {valid && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(['bits', 'decimal', 'binary'] as const satisfies readonly Group[]).map((group) => (
            <div key={group} className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className="border-b border-line bg-bg2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg2">
                {t(`tools.items.data-size.groups.${group}`)}
              </div>
              {grouped[group].map((r) => (
                <div
                  key={r.unit.id}
                  className={`group flex items-center gap-2 border-b border-line/60 px-3 py-1.5 last:border-0 ${
                    r.unit.id === fromId ? 'bg-accent/10' : ''
                  }`}
                >
                  <span className="w-12 shrink-0 text-xs text-fg3">{r.unit.label}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                    {formatNumber(r.value)}
                  </span>
                  <CopyButton
                    size="sm"
                    variant="ghost"
                    value={formatNumber(r.value)}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
