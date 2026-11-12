// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-compare/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useRef, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { WorkerClient } from '@/features/tools/lib/worker/workerClient';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  diffText,
  type DiffOptions,
  type DiffRequest,
  type DiffResult,
  type DiffRowType,
} from './logic';
import { cn } from '@/features/tools/components/ui/cn';

const WORKER_THRESHOLD = 40_000; // chars, below this, diff on the main thread

// Conventional side-by-side coloring per row type: [left cell, right cell].
const SIDE_BG: Record<DiffRowType, [string, string]> = {
  equal: ['', ''],
  added: ['diff-gap', 'diff-add'], // nothing on the left, added on the right
  removed: ['diff-del', 'diff-gap'], // removed on the left, nothing on the right
  modified: ['diff-del', 'diff-add'], // changed: removed left, added right
};

const OPTION_KEYS = ['ignoreWhitespace', 'ignoreCase', 'trim'] as const;

export default function TextCompareTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [a, setA] = useState(initialInput ?? '');
  const [b, setB] = useState('');
  const [opts, setOpts] = useState<DiffOptions>({});
  // Result of the last off-thread diff; small inputs are diffed during render instead.
  const [workerResult, setWorkerResult] = useState<DiffResult | null>(null);
  const clientRef = useRef<WorkerClient<DiffRequest, DiffResult> | null>(null);

  const empty = !a && !b;
  const heavy = a.length + b.length > WORKER_THRESHOLD;

  useEffect(() => {
    return () => clientRef.current?.terminate();
  }, []);

  const syncResult = useMemo(
    () => (empty || heavy ? null : diffText(a, b, opts)),
    [a, b, opts, empty, heavy],
  );

  useEffect(() => {
    if (empty || !heavy) return;
    let cancelled = false;
    if (!clientRef.current) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      clientRef.current = new WorkerClient(worker);
    }
    clientRef.current
      .call({ a, b, options: opts })
      .then((r) => {
        if (!cancelled) setWorkerResult(r);
      })
      .catch(() => {
        if (!cancelled) setWorkerResult(diffText(a, b, opts));
      });
    return () => {
      cancelled = true;
    };
  }, [a, b, opts, empty, heavy]);

  const result = empty ? null : heavy ? workerResult : syncResult;

  const toggle = (key: keyof DiffOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  const summary = result
    ? [
        t('tools.items.text-compare.added', { count: result.added }),
        t('tools.items.text-compare.removed', { count: result.removed }),
        t('tools.items.text-compare.changed', { count: result.changed }),
      ].join(' · ')
    : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        {OPTION_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-1.5 text-xs text-fg2">
            <input type="checkbox" checked={!!opts[key]} onChange={() => toggle(key)} />
            {t(`tools.items.text-compare.${key}`)}
          </label>
        ))}
        {summary && <span className="ml-auto text-xs text-fg3">{summary}</span>}
      </div>

      <SplitGrid
        leftLabel={t('tools.items.text-compare.original')}
        rightLabel={t('tools.items.text-compare.modified')}
        className="mb-3"
      >
        <ToolEditor
          label={t('tools.items.text-compare.original')}
          value={a}
          onChange={setA}
          minRows={10}
          lineNumbers
        />
        <ToolEditor
          label={t('tools.items.text-compare.modified')}
          value={b}
          onChange={setB}
          minRows={10}
          lineNumbers
        />
      </SplitGrid>

      {result && result.rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
            {t('tools.items.text-compare.diff')}
          </div>
          <div className="max-h-[60vh] overflow-auto font-mono text-xs">
            {result.rows.map((row, i) => {
              const [leftBg, rightBg] = SIDE_BG[row.type];
              const marker =
                row.type === 'removed' || row.type === 'modified'
                  ? '-'
                  : row.type === 'added'
                    ? '+'
                    : '';
              return (
                <div key={i} className="grid grid-cols-2">
                  <div className={cn('flex border-b border-line/40', leftBg)}>
                    <span className="w-10 shrink-0 select-none border-r border-line/40 px-2 py-0.5 text-right text-fg3">
                      {row.leftNo ?? ''}
                    </span>
                    <span className="w-4 shrink-0 select-none text-center text-fg3">
                      {row.left !== null ? marker : ''}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap break-all px-2 py-0.5 text-fg">
                      {row.left ?? ''}
                    </pre>
                  </div>
                  <div className={cn('flex border-b border-l border-line/40', rightBg)}>
                    <span className="w-10 shrink-0 select-none border-r border-line/40 px-2 py-0.5 text-right text-fg3">
                      {row.rightNo ?? ''}
                    </span>
                    <span className="w-4 shrink-0 select-none text-center text-fg3">
                      {row.right !== null ? (row.type === 'equal' ? '' : '+') : ''}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap break-all px-2 py-0.5 text-fg">
                      {row.right ?? ''}
                    </pre>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
