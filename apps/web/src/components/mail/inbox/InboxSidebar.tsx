import { cn, Count, Icon, IconButton, Tooltip } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mailInboxesQuery } from '@/lib/mail/inbox';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { InboxSettingsDialog } from './InboxSettingsDialog';

/**
 * "Ortak kutular" in the mail sidebar: the shared inboxes of the caller's spaces, with their
 * open conversations, and adding one where the caller manages a space.
 */
export function InboxNav({ current }: { current?: string }) {
  const { t } = useI18n();
  const inboxes = useQuery(mailInboxesQuery);
  const spaces = useSpaces();
  const { canSpace } = usePermissions();
  const manageable = spaces.items.filter(
    (s) => s.kind === 'shared' && !s.archivedAt && canSpace('mail.inbox.manage', s.myRole),
  );
  const [adding, setAdding] = useState(false);
  const items = inboxes.data?.items ?? [];
  if (items.length === 0 && manageable.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-px pt-3">
      <div className="mb-1 flex items-center px-2.5">
        <span className="eyebrow flex-1">{t('mail.inbox.shared')}</span>
        {manageable.length ? (
          <Tooltip content={t('mail.inbox.add')}>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('mail.inbox.add')}
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={14} />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
      <nav aria-label={t('mail.inbox.shared')} className="flex flex-col gap-px">
        {items.map((i) => (
          <Link
            key={i.id}
            to="/mail/inbox/$inboxId"
            params={{ inboxId: i.id }}
            aria-current={i.id === current ? 'page' : undefined}
            className={cn(
              'flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
              i.id === current && 'bg-capsule font-semibold text-fg hover:bg-capsule',
            )}
          >
            <Icon name="inbox" size={16} />
            <span className="min-w-0 flex-1 truncate">{i.name}</span>
            {i.status === 'auth_failed' ? (
              <Icon name="alert" size={14} className="text-danger" />
            ) : i.counts.open > 0 ? (
              <Count aria-label={t('mail.inbox.openCount', { count: i.counts.open })}>
                {i.counts.open}
              </Count>
            ) : null}
          </Link>
        ))}
      </nav>
      {adding ? <InboxSettingsDialog spaces={manageable} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/**
 * The sidebar of a shared inbox page (and of /mail before a personal mailbox is connected):
 * the personal mailbox, then the inboxes.
 */
export function InboxSidebar({ current }: { current?: string }) {
  const { t } = useI18n();
  return (
    <ModuleSidebar label={t('mail.sidebar')} className="gap-px overflow-hidden px-2.5 py-3">
      <Link
        to="/mail"
        className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="mail" size={16} />
        {t('mail.inbox.personal')}
      </Link>
      <InboxNav current={current} />
    </ModuleSidebar>
  );
}
