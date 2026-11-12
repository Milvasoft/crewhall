// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ConverterLayout.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { ResizableSplit } from '@/features/tools/components/tool/ResizableSplit';

/**
 * Two-column input/output layout used by converter-style tools. Panes can be
 * resized by dragging the divider and each collapsed to a strip; on small
 * screens they stack. The optional center rail hosts a convert action /
 * direction toggle. Labels are used on the collapsed strips.
 */
export function ConverterLayout({
  input,
  output,
  center,
  leftLabel,
  rightLabel,
  className,
}: {
  input: React.ReactNode;
  output: React.ReactNode;
  center?: React.ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ResizableSplit
      className={className}
      left={input}
      right={output}
      center={center}
      leftLabel={leftLabel ?? t('tools.common.input')}
      rightLabel={rightLabel ?? t('tools.common.output')}
    />
  );
}
