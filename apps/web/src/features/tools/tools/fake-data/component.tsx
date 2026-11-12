// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/fake-data/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
import type { ToolComponentProps, ToolDataType } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { usePreference } from '@/features/tools/lib/preferences/hooks';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  FAKE_TYPES,
  formatOutput,
  formatRows,
  generateRows,
  type FakeField,
  type FakeType,
  type OutputFormat,
} from './logic';

const DEFAULT_FIELDS: FakeField[] = [
  { name: 'id', type: 'uuid' },
  { name: 'name', type: 'fullName' },
  { name: 'email', type: 'email' },
  { name: 'age', type: 'int' },
  { name: 'active', type: 'boolean' },
];

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
    </svg>
  );
}

/** Compact per-row copy button that shows a tick briefly after copying. */
function RowCopy({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={t('tools.items.fake-data.copyRow')}
      aria-label={t('tools.items.fake-data.copyRow')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="shrink-0 rounded p-1 text-fg3 opacity-0 transition-opacity hover:bg-bg2 hover:text-fg focus:opacity-100 group-hover:opacity-100"
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-success" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export default function FakeDataTool(_props: ToolComponentProps) {
  // Remembered setup (schema, count, format, table) so the tool reopens exactly
  // as the user left it, e.g. configured purely as a VKN generator. Only the
  // configuration is persisted, never the generated rows.
  const { t } = useI18n();
  const [saved, setSaved] = usePreference('fakeData');
  const [fields, setFields] = useState<FakeField[]>(() =>
    saved?.fields?.length
      ? saved.fields.map((f) => ({ name: f.name, type: f.type as FakeType }))
      : DEFAULT_FIELDS,
  );
  const [count, setCount] = useState(() => saved?.count ?? 10);
  const [format, setFormat] = useState<OutputFormat>(
    () => (saved?.format as OutputFormat) ?? 'json',
  );
  const [tableName, setTableName] = useState(() => saved?.tableName ?? 'users');
  const [sqlBulk, setSqlBulk] = useState(() => saved?.sqlBulk ?? false);
  // Bumped by Generate to re-randomise the same schema.
  const [nonce, setNonce] = useState(0);
  const definition = getDefinition('fake-data')!;

  // Persist the configuration whenever it changes.
  useEffect(() => {
    setSaved({ fields, count, format, tableName, sqlBulk });
  }, [fields, count, format, tableName, sqlBulk, setSaved]);

  // Auto-generate on field/count changes (and on Generate); changing only the
  // format re-renders the existing rows without re-randomising them.
  const rows = useMemo(() => {
    void nonce;
    const valid = fields.filter((f) => f.name.trim());
    return valid.length === 0 ? [] : generateRows(valid, count);
  }, [fields, count, nonce]);
  const regenerate = () => setNonce((n) => n + 1);

  const output = useMemo(
    () => formatOutput(rows, format, tableName, sqlBulk),
    [rows, format, tableName, sqlBulk],
  );
  const rowLines = useMemo(
    () => formatRows(rows, format, tableName, sqlBulk),
    [rows, format, tableName, sqlBulk],
  );
  const csvHeader = format === 'csv' && rows.length > 0 ? Object.keys(rows[0]!).join(',') : null;

  // The Send-To destinations should follow the chosen output format, not the
  // tool's static JSON type, so SQL/CSV targets appear when relevant.
  const sendType: ToolDataType =
    format === 'sql' ? 'sql' : format === 'csv' ? 'csv' : format === 'plain' ? 'text' : 'json';

  const updateField = (i: number, patch: Partial<FakeField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));
  const addField = () =>
    setFields((prev) => [...prev, { name: `field${prev.length + 1}`, type: 'word' }]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
      <div className="flex flex-col gap-3 self-start">
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            <span>{t('tools.items.fake-data.fields')}</span>
            <button onClick={addField} className="text-fg2 hover:text-fg">
              + {t('tools.items.fake-data.add')}
            </button>
          </div>
          {fields.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-2 border-b border-line/60 px-2 py-1.5 last:border-0"
            >
              <input
                value={f.name}
                onChange={(e) => updateField(i, { name: e.target.value })}
                className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
              />
              <select
                value={f.type}
                onChange={(e) => updateField(i, { type: e.target.value as FakeType })}
                className="h-7 rounded border border-line bg-surface px-1 text-xs outline-none"
              >
                {FAKE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`tools.items.fake-data.types.${type}`)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeField(i)}
                title={t('tools.items.fake-data.remove')}
                aria-label={t('tools.items.fake-data.remove')}
                className="shrink-0 text-fg3 hover:text-danger"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.fake-data.rows')}
            <input
              type="number"
              min={1}
              max={5000}
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              className="h-8 w-20 rounded-md border border-line bg-surface px-2 text-right text-sm outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.fake-data.format')}
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as OutputFormat)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="sql">SQL</option>
              <option value="plain">{t('tools.items.fake-data.plain')}</option>
            </select>
          </label>
          {format === 'sql' && (
            <>
              <input
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder={t('tools.items.fake-data.table')}
                className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-sm outline-none"
              />
              <label className="flex items-center gap-1.5 text-xs text-fg2">
                <input
                  type="checkbox"
                  checked={sqlBulk}
                  onChange={(e) => setSqlBulk(e.target.checked)}
                />
                {t('tools.items.fake-data.multiRow')}
              </label>
            </>
          )}
        </div>

        <Button variant="primary" onClick={regenerate}>
          {t('tools.common.generate')}
        </Button>
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg2 px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
            {t('tools.common.output')}
            {rowLines.length > 0 ? ` (${rowLines.length})` : ''}
          </span>
          <div className="flex items-center gap-1">
            <CopyButton
              size="sm"
              variant="ghost"
              value={output}
              label={t('tools.items.fake-data.copyAll')}
            />
            <SendToMenu source={definition} value={output} outputType={sendType} />
          </div>
        </div>

        {csvHeader && (
          <div className="shrink-0 border-b border-line px-3 py-1.5 font-mono text-xs text-fg3">
            {csvHeader}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {rowLines.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-fg3">
              {t('tools.items.fake-data.empty')}
            </p>
          ) : (
            rowLines.map((line, i) => (
              <div
                key={i}
                className="group flex items-start gap-2 border-b border-line/50 px-3 py-1.5 font-mono text-xs last:border-0"
              >
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-fg">{line}</span>
                <RowCopy value={line} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
