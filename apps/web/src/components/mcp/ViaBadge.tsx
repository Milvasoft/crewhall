import { type MessageVia } from '@crewhall/shared';
import { Badge, Icon, Tooltip } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * "Claude Code ile" on content an MCP client or API token wrote on the person's behalf
 * (doc 17 §13). The author stays the person; this only says which tool did the writing.
 */
export function ViaBadge({ via }: { via: MessageVia | null | undefined }) {
  const { t } = useI18n();
  if (!via) return null;
  const label =
    via.kind === 'api'
      ? t('mcp.via.api', { client: via.client })
      : via.kind === 'plugin'
        ? t('mcp.via.plugin', { client: via.client })
        : t('mcp.via.mcp', { client: via.client });
  return (
    <Tooltip content={t('mcp.via.hint', { client: via.client })}>
      <Badge plain tone="accent" className="h-[18px] max-w-[200px] gap-1 px-1.5 text-[10px]">
        <Icon name={via.kind === 'plugin' ? 'plug' : 'bolt'} size={10} />
        <span className="truncate">{label}</span>
      </Badge>
    </Tooltip>
  );
}
