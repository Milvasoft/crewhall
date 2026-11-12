import { type AppLocale } from '@crewhall/i18n';
import { MCP_SCOPES, type McpScope, type McpSpaceRef, type ToolCall } from '@crewhall/shared';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { type I18nValue } from '@/lib/i18n/I18nContext';

/** "7 kapsam · Kişisel, Milvasoft · 30 gün kaldı" line under a connection or token. */
export function connectionLine(
  i18n: Pick<I18nValue, 't' | 'locale'>,
  c: { scopes: McpScope[]; spaces: McpSpaceRef[] | null; expiresAt: string | null },
  now = new Date(),
): string {
  const { t } = i18n;
  const parts: string[] = [];
  parts.push(
    c.scopes.length === 1 && c.scopes[0] === 'hub:read'
      ? t('mcp.common.readOnly')
      : t('mcp.common.scopesCount', { count: c.scopes.length }),
  );
  parts.push(spacesLabel(i18n, c.spaces));
  parts.push(expiryLabel(i18n, c.expiresAt, now));
  return parts.join(' · ');
}

export function spacesLabel(i18n: Pick<I18nValue, 't'>, spaces: McpSpaceRef[] | null): string {
  if (spaces === null) return i18n.t('mcp.common.allSpaces');
  return spaces
    .map((s) => (s.kind === 'personal' ? i18n.t('mcp.common.personal') : s.name))
    .join(', ');
}

export function expiryLabel(
  i18n: Pick<I18nValue, 't'>,
  expiresAt: string | null,
  now = new Date(),
): string {
  if (!expiresAt) return i18n.t('mcp.common.noExpiry');
  const days = Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return i18n.t('mcp.common.expired');
  return i18n.t('mcp.common.daysLeft', { count: days });
}

export function lastUsedLabel(
  i18n: Pick<I18nValue, 't' | 'locale'>,
  lastUsedAt: string | null,
): string {
  if (!lastUsedAt) return i18n.t('mcp.common.neverUsed');
  return i18n.t('mcp.common.lastUsed', { time: formatRelative(lastUsedAt, i18n.locale) });
}

/** Scopes in catalog order, for stable checkbox lists. */
export const sortScopes = (scopes: readonly McpScope[]) =>
  MCP_SCOPES.filter((s) => scopes.includes(s));

/** Result of a call as one status: an approval's outcome wins over the raw result. */
export type CallState = 'ok' | 'error' | 'pending' | 'undone' | 'rejected' | 'stale' | 'expired';

export function callState(c: ToolCall): CallState {
  if (c.undoneAt) return 'undone';
  if (c.result === 'pending_approval') return 'pending';
  if (c.errorCode === 'rejected') return 'rejected';
  if (c.errorCode === 'stale') return 'stale';
  if (c.errorCode === 'expired') return 'expired';
  return c.result === 'ok' ? 'ok' : 'error';
}

export const CALL_TONE: Record<CallState, 'ok' | 'danger' | 'warn' | 'default'> = {
  ok: 'ok',
  error: 'danger',
  pending: 'warn',
  undone: 'default',
  rejected: 'danger',
  stale: 'default',
  expired: 'default',
};

/** Time of day today, otherwise a short date (activity table). */
export function callTime(at: string, locale: AppLocale, now = new Date()): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? formatDate(d, locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : formatDate(d, locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
