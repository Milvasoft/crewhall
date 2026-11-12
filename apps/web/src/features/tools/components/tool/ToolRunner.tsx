// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ToolRunner.tsx. See THIRD_PARTY.md.
// Crewhall: React.lazy instead of next/dynamic, and a Drive file as the seed input.
import { Spinner } from '@crewhall/ui';
import { lazy, Suspense, useEffect, useState, type LazyExoticComponent } from 'react';
import { getEntry } from '@/features/tools/lib/registry';
import { preferences } from '@/features/tools/lib/preferences/store';
import type { ToolComponent } from '@/features/tools/lib/tool-sdk';
import { consumeTransfer } from '@/features/tools/lib/transfer/transfer';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ToolErrorBoundary } from './ToolErrorBoundary';

/** One lazy component per tool, made once, so a re-render never remounts the tool. */
const lazyTools = new Map<string, LazyExoticComponent<ToolComponent>>();
function lazyTool(toolId: string): LazyExoticComponent<ToolComponent> | null {
  const entry = getEntry(toolId);
  if (!entry) return null;
  let c = lazyTools.get(toolId);
  if (!c) {
    c = lazy(entry.load);
    lazyTools.set(toolId, c);
  }
  return c;
}

/**
 * (1) Records the tool in "recently used", (2) takes a staged "Send To" payload (or the text
 * of a Drive file, `seed`) as the tool's initial input, and (3) loads the tool's component
 * lazily, so a tool's code and heavy libraries download only when it is opened. The input is
 * fixed before the tool mounts: tools take `initialInput` as their initial state only.
 */
export function ToolRunner({ toolId, seed }: { toolId: string; seed?: string }) {
  const { t } = useI18n();
  const [staged] = useState(() => consumeTransfer(toolId)?.value);
  const initialInput = seed ?? staged;

  useEffect(() => {
    preferences.recordRecent(toolId);
  }, [toolId]);

  const Component = lazyTool(toolId);
  if (!Component) return null;
  return (
    <ToolErrorBoundary key={toolId}>
      <Suspense
        fallback={
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-6 text-sm text-fg2">
            <Spinner />
            {t('tools.common.loading')}
          </div>
        }
      >
        {/* A cached lazy component per tool id (lazyTool), not a new one per render. */}
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Component initialInput={initialInput} />
      </Suspense>
    </ToolErrorBoundary>
  );
}
