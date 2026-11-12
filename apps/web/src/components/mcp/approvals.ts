import { type ApprovalSummary } from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { type I18nValue } from '@/lib/i18n/I18nContext';

export const ACTION_ICON: Record<string, IconName> = {
  'node.trash': 'x',
  bulk: 'list',
  'share.external': 'link',
  'portal.publish': 'arrowUR',
  'chat.space_message': 'chat',
  'ai.action': 'sparkle',
};

export const STATUS_TONE = {
  pending: 'warn',
  approved: 'info',
  applied: 'ok',
  rejected: 'danger',
  failed: 'danger',
  stale: 'default',
  expired: 'default',
} as const;

/** "3 öğeyi Çöp'e taşı" from the action and the item count. */
export function approvalTitle(t: I18nValue['t'], a: Pick<ApprovalSummary, 'action' | 'itemCount'>) {
  const key = a.action.replace('.', '_') as 'node_trash';
  return t(`mcp.approvals.action.${key}`, { count: a.itemCount });
}
