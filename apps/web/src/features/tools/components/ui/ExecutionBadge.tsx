// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/ExecutionBadge.tsx. See THIRD_PARTY.md.
import type { ToolExecution } from '@/features/tools/lib/tool-sdk';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cn } from './cn';

const DOT: Record<ToolExecution, string> = {
  local: 'bg-success',
  server: 'bg-warning',
  hybrid: 'bg-warning',
};

/**
 * Privacy indicator sourced entirely from a tool's `execution` metadata, never
 * written by hand per page.
 *
 * - "compact":     dot + label, with the detail as a native tooltip (cards).
 * - "interactive": dot + label, and the detail text reveals inline on hover
 *                  (tool page header).
 * - "full":        dot + label + detail always shown.
 */
export function ExecutionBadge({
  execution,
  variant = 'compact',
  className,
}: {
  execution: ToolExecution;
  variant?: 'compact' | 'interactive' | 'full';
  className?: string;
}) {
  const { t } = useI18n();
  const c = {
    label: t(`tools.common.execution.${execution}`),
    detail: t(`tools.common.execution.${execution}Detail`),
    dot: DOT[execution],
  };

  if (variant === 'full') {
    return (
      <div
        className={cn(
          'flex items-start gap-2.5 rounded-md border border-line bg-bg2 px-3 py-2',
          className,
        )}
      >
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', c.dot)} />
        <div className="text-xs leading-relaxed">
          <span className="font-semibold text-fg">{c.label}</span>
          <span className="text-fg2">, {c.detail}</span>
        </div>
      </div>
    );
  }

  if (variant === 'interactive') {
    return (
      <span
        className={cn(
          'group inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-fg2 transition-colors hover:bg-bg2',
          className,
        )}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.dot)} />
        {c.label}
        <span className="max-w-0 overflow-hidden whitespace-nowrap text-fg3 opacity-0 transition-all duration-200 group-hover:max-w-md group-hover:opacity-100">
          <span>, {c.detail}</span>
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-fg2',
        className,
      )}
      title={c.detail}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', c.dot)} />
      {c.label}
    </span>
  );
}
