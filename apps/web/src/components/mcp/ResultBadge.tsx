import { type ToolCall } from '@crewhall/shared';
import { Badge } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { CALL_TONE, callState } from '@/lib/mcp/format';

/** Green applied, orange waiting, red refused (design 18.5, 18.6). */
export function ResultBadge({ call, compact }: { call: ToolCall; compact?: boolean }) {
  const { t } = useI18n();
  const state = callState(call);
  const label =
    state === 'error' && call.errorCode && compact
      ? call.errorCode
      : t(`mcp.activity.result.${state}`);
  return (
    <Badge tone={CALL_TONE[state]} className={compact ? 'h-[18px] px-1.5 text-[11px]' : undefined}>
      {label}
    </Badge>
  );
}
