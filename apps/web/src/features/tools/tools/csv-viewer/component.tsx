// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csv-viewer/component.tsx. See THIRD_PARTY.md.
import { useMemo, useRef, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { cn } from '@/features/tools/components/ui/cn';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parseCsv } from '@/features/tools/tools/json-csv/logic';

const EXAMPLE =
  'id,name,role,active\n1,Ada,admin,true\n2,Grace,user,false\n3,Linus,maintainer,true';

export default function CsvViewerTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [text, setText] = useState(initialInput ?? EXAMPLE);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { header, rows } = useMemo(() => {
    const grid = parseCsv(text.trim());
    if (grid.length === 0) return { header: [] as string[], rows: [] as string[][] };
    return { header: grid[0]!, rows: grid.slice(1) };
  }, [text]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a[col] ?? '';
      const bv = b[col] ?? '';
      const an = Number(av);
      const bn = Number(bv);
      const cmp =
        !Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== ''
          ? an - bn
          : av.localeCompare(bv);
      return cmp * dir;
    });
  }, [rows, sort]);

  const toggleSort = (col: number) =>
    setSort((s) => (s && s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }));

  const openFile = async (file: File) => setText(await file.text());

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            {t('tools.items.csv-viewer.open')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
          <span className="text-xs text-fg3">
            {t('tools.items.csv-viewer.rows', { count: rows.length })}
          </span>
        </div>
        <ToolEditor label="CSV" value={text} onChange={setText} minRows={18} />
      </div>

      <div className="min-w-0 overflow-auto rounded-lg border border-line bg-surface">
        {header.length === 0 ? (
          <div className="px-3 py-3 text-sm text-fg3">{t('tools.items.csv-viewer.empty')}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-bg2">
                <th className="border-b border-line px-2 py-1.5 text-right text-xs text-fg3">#</th>
                {header.map((h, i) => (
                  <th
                    key={i}
                    onClick={() => toggleSort(i)}
                    className="cursor-pointer whitespace-nowrap border-b border-line px-3 py-1.5 text-left font-semibold text-fg hover:bg-surface"
                  >
                    {h}
                    {sort?.col === i ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, ri) => (
                <tr key={ri} className={cn(ri % 2 ? 'bg-bg2/40' : '')}>
                  <td className="border-b border-line/50 px-2 py-1 text-right text-xs text-fg3">
                    {ri + 1}
                  </td>
                  {header.map((_, ci) => (
                    <td
                      key={ci}
                      className="whitespace-nowrap border-b border-line/50 px-3 py-1 font-mono text-xs text-fg"
                    >
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
