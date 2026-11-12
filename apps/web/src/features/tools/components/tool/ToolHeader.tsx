// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ToolHeader.tsx. See THIRD_PARTY.md.
// Crewhall: localized name and description; the breadcrumb lives in the Crewhall top bar.
import type { ToolDefinition } from '@/features/tools/lib/tool-sdk';
import { ExecutionBadge } from '@/features/tools/components/ui/ExecutionBadge';
import { FavoriteButton } from '@/features/tools/components/ui/FavoriteButton';
import { useLocalizedTool } from '@/features/tools/i18n';

export function ToolHeader({ definition }: { definition: ToolDefinition }) {
  const localize = useLocalizedTool();
  const tool = localize(definition);
  return (
    <header className="mb-4 flex items-start justify-between gap-4 border-b border-line pb-4">
      <div className="min-w-0">
        <h1 className="m-0 text-wtitle font-bold">{tool.name}</h1>
        <p className="mt-1 mb-0 max-w-2xl text-sm text-fg2">{tool.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ExecutionBadge execution={definition.execution} variant="interactive" />
        <FavoriteButton toolId={definition.id} />
      </div>
    </header>
  );
}
