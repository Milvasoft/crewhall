// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/SplitGrid.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { Children } from 'react';
import { ResizableSplit } from './ResizableSplit';

/**
 * Drop-in replacement for a `grid lg:grid-cols-2` wrapper: takes exactly two
 * children (left, right) and lays them out with {@link ResizableSplit}, so any
 * two-pane tool gains a draggable divider and per-pane collapse without
 * restructuring its markup. A third+ child, if present, is ignored.
 */
export function SplitGrid({
  children,
  leftLabel,
  rightLabel,
  center,
  className,
}: {
  children: React.ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  center?: React.ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const items = Children.toArray(children);
  return (
    <ResizableSplit
      className={className}
      left={items[0] ?? null}
      right={items[1] ?? null}
      center={center}
      leftLabel={leftLabel ?? t('tools.common.input')}
      rightLabel={rightLabel ?? t('tools.common.output')}
    />
  );
}
