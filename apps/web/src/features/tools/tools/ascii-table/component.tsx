// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-table/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { toolKey } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ASCII_TABLE, filterAscii, type AsciiRow } from './logic';

export default function AsciiTableTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState(initialInput ?? '');
  const rows = useMemo(() => filterAscii(query), [query]);

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('tools.items.ascii-table.filterPlaceholder')}
        spellCheck={false}
        className="h-9 w-full max-w-md rounded-md border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
      />

      {rows.length === 0 ? (
        <p className="text-sm text-fg2">{t('tools.items.ascii-table.noMatches')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-bg2 text-left text-xs uppercase tracking-wide text-fg2">
                <Th>{t('tools.items.ascii-table.colChar')}</Th>
                <Th>Dec</Th>
                <Th>Hex</Th>
                <Th>Oct</Th>
                <Th>{t('tools.items.ascii-table.colBinary')}</Th>
                <Th>{t('tools.items.ascii-table.colName')}</Th>
                <Th>{t('tools.items.ascii-table.colDescription')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AsciiRowView key={r.dec} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-fg3">
        {t('tools.items.ascii-table.footer', { count: ASCII_TABLE.length })}
      </p>
    </div>
  );
}

function AsciiRowView({ row }: { row: AsciiRow }) {
  const { t } = useI18n();
  // Control codes have a fixed mnemonic; their description comes from the dictionary.
  const isControl = row.dec <= 32 || row.dec === 127;
  const desc = isControl
    ? t(toolKey('ascii-table', `control.${row.name.toLowerCase()}`))
    : t('tools.items.ascii-table.charDesc', { text: row.glyph });
  return (
    <tr className="border-t border-line/60 hover:bg-bg2/50">
      <td className="px-3 py-1.5">
        <span
          className={row.printable ? 'font-mono text-base text-fg' : 'font-mono text-xs text-fg3'}
        >
          {row.glyph}
        </span>
      </td>
      <Td>{row.dec}</Td>
      <Td>0x{row.hex}</Td>
      <Td>{row.oct}</Td>
      <Td>{row.binary}</Td>
      <td className="px-3 py-1.5 text-fg">{row.name}</td>
      <td className="px-3 py-1.5 text-fg2">{desc}</td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5 font-mono text-fg2">{children}</td>;
}
