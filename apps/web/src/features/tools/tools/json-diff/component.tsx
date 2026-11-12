// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-diff/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import { useWorkerTransform } from '@/features/tools/lib/worker/useWorkerTransform';
import { useI18n } from '@/lib/i18n/I18nContext';
import { diffJson, type ChangeType, type JsonDiffResult } from './logic';

const EMPTY: JsonDiffResult = { changes: [], added: 0, removed: 0, changed: 0 };

const BADGE: Record<ChangeType, string> = {
  added: 'text-success',
  removed: 'text-danger',
  changed: 'text-warning',
};
const SYMBOL: Record<ChangeType, string> = { added: '+', removed: '−', changed: '~' };

function preview(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 120 ? s.slice(0, 117) + '…' : s;
}

export default function JsonDiffTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [a, setA] = useState(initialInput ?? '{\n  "name": "Ada",\n  "age": 30\n}');
  const [b, setB] = useState('{\n  "name": "Ada",\n  "age": 31,\n  "active": true\n}');

  const hasBoth = a.trim().length > 0 && b.trim().length > 0;
  const { result: rawResult, error: rawError } = useWorkerTransform<
    { a: string; b: string },
    JsonDiffResult
  >({
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    buildRequest: () => ({ a, b }),
    compute: (r) => (!r.a.trim() || !r.b.trim() ? EMPTY : diffJson(r.a, r.b)),
    size: a.length + b.length,
    deps: [a, b],
  });
  const result = hasBoth ? rawResult : null;
  const error = hasBoth ? rawError : null;

  return (
    <div className="flex flex-col gap-3">
      <SplitGrid leftLabel="A" rightLabel="B">
        <ToolEditor label="A" value={a} onChange={setA} language="json" lineNumbers minRows={12} />
        <ToolEditor label="B" value={b} onChange={setB} language="json" lineNumbers minRows={12} />
      </SplitGrid>

      {error && <p className="text-sm text-danger">{error}</p>}

      {result && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            <span>{t('tools.items.json-diff.changes')}</span>
            <span className="text-fg3">
              <span className="text-success">+{result.added}</span>{' '}
              <span className="text-danger">−{result.removed}</span>{' '}
              <span className="text-warning">~{result.changed}</span>
            </span>
          </div>
          {result.changes.length === 0 ? (
            <div className="px-3 py-3 text-sm text-fg3">{t('tools.items.json-diff.identical')}</div>
          ) : (
            <div className="max-h-[50vh] overflow-auto">
              {result.changes.map((c, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 border-b border-line/50 px-3 py-1.5 font-mono text-xs last:border-0"
                >
                  <span className={`w-3 shrink-0 font-bold ${BADGE[c.type]}`}>
                    {SYMBOL[c.type]}
                  </span>
                  <span className="w-56 shrink-0 truncate text-[var(--syntax-key)]">{c.path}</span>
                  <span className="min-w-0 flex-1 text-fg">
                    {c.type === 'changed' ? (
                      <>
                        <span className="text-danger">{preview(c.left)}</span>
                        {' → '}
                        <span className="text-success">{preview(c.right)}</span>
                      </>
                    ) : c.type === 'added' ? (
                      <span className="text-success">{preview(c.right)}</span>
                    ) : (
                      <span className="text-danger">{preview(c.left)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
