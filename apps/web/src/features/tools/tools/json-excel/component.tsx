// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-excel/component.tsx. See THIRD_PARTY.md.
import { useMemo, useRef, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { columnsOf, normalizeRows } from './logic';

const EXAMPLE = JSON.stringify(
  [
    { id: 1, name: 'Ada', role: 'admin' },
    { id: 2, name: 'Grace', role: 'user' },
  ],
  null,
  2,
);

type CellType = typeof String | typeof Number | typeof Boolean;

function columnType(rows: Record<string, unknown>[], col: string): CellType {
  let type: CellType | null = null;
  for (const row of rows) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    const t: CellType = typeof v === 'number' ? Number : typeof v === 'boolean' ? Boolean : String;
    if (type === null) type = t;
    else if (type !== t) return String; // mixed → text
  }
  return type ?? String;
}

export default function JsonExcelTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [json, setJson] = useState(initialInput ?? EXAMPLE);
  const [fileName, setFileName] = useState('data.xlsx');
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const definition = getDefinition('json-excel')!;

  const { rows, parseError } = useMemo(() => {
    if (!json.trim()) return { rows: null, parseError: null as string | null };
    try {
      return { rows: normalizeRows(json), parseError: null };
    } catch (e) {
      return { rows: null, parseError: e instanceof Error ? e.message : t('tools.common.error') };
    }
  }, [json, t]);

  const error = parseError ?? fileError;

  const exportXlsx = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const { default: writeXlsxFile } = await import('write-excel-file');
      const columns = columnsOf(rows);
      const schema = columns.map((col) => {
        const type = columnType(rows, col);
        return {
          column: col,
          type,
          value: (row: Record<string, unknown>) => {
            const v = row[col];
            if (v === null || v === undefined) return null;
            if (type === String) return typeof v === 'object' ? JSON.stringify(v) : String(v);
            return v as never;
          },
        };
      });
      const name = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
      // Browser build downloads when `fileName` is provided.
      await writeXlsxFile(rows, { schema, fileName: name });
      setFileError(null);
    } catch {
      setFileError(t('tools.items.json-excel.writeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const { default: readXlsxFile } = await import('read-excel-file');
      const grid = await readXlsxFile(file);
      const [header = [], ...body] = grid;
      const objects = body.map((r) =>
        header.reduce<Record<string, unknown>>((obj, key, i) => {
          obj[String(key)] = r[i] ?? null;
          return obj;
        }, {}),
      );
      setJson(JSON.stringify(objects, null, 2));
      setFileError(null);
    } catch {
      setFileError(t('tools.items.json-excel.readFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={exportXlsx} disabled={!rows || busy}>
          {t('tools.items.json-excel.downloadXlsx')}
        </Button>
        <input
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          aria-label={t('tools.items.json-excel.fileName')}
          className="h-8 w-40 rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
        />
        <span className="text-fg3">·</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {t('tools.items.json-excel.open')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            e.target.value = '';
          }}
        />
        {rows && (
          <span className="ml-auto text-xs text-fg3">
            {t('tools.items.json-excel.rows', { count: rows.length })}
          </span>
        )}
      </div>

      <ToolEditor
        label={t('tools.items.json-excel.inputLabel')}
        value={json}
        onChange={setJson}
        language="json"
        lineNumbers
        minRows={20}
        placeholder={t('tools.items.json-excel.placeholder')}
        footer={error ? <span className="text-danger">{error}</span> : undefined}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setJson(EXAMPLE)}>
              {t('tools.common.sample')}
            </Button>
            <CopyButton size="sm" variant="ghost" value={json} />
            <SendToMenu source={definition} value={json} />
          </>
        }
      />

      <p className="mt-2 text-[11px] text-fg3">{t('tools.items.json-excel.localNote')}</p>
    </div>
  );
}
