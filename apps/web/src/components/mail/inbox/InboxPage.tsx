import {
  type MailConversationStatus,
  type MailConversationSummary,
  type MailInbox,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  Chip,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Segmented,
  Skeleton,
  Tag,
  Tooltip,
} from '@crewhall/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { VirtualList } from '@/components/vault/VirtualList';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  conversationsQuery,
  inboxKeys,
  mailInboxesQuery,
  type InboxFilter,
} from '@/lib/mail/inbox';
import { inboxOauthStartUrl } from '@/lib/mail/queries';
import { useShellLayout } from '@/lib/shell';
import { mailError } from '@/components/mail/errors';
import { LoadMore } from '@/components/mail/MessageList';
import { useDelayed } from '@/components/mail/useDelayed';
import { ConversationView } from './ConversationView';
import { CannedDialog, InboxSettingsDialog } from './InboxSettingsDialog';
import { InboxSidebar } from './InboxSidebar';
import { ResizablePane } from '@/components/shell/ResizablePane';

export interface InboxSearch {
  conversation?: string;
  status?: MailConversationStatus | 'all';
  assignee?: 'me' | 'none';
  tag?: string;
  q?: string;
}

const ROW_HEIGHT = 74;

/** /mail/inbox/:inboxId: the team's conversations and the open one side by side. */
export function InboxPage({ inboxId, search }: { inboxId: string; search: InboxSearch }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/mail/inbox/$inboxId' });
  const phone = useShellLayout() === 'phone';
  const inboxes = useQuery(mailInboxesQuery);
  const inbox = inboxes.data?.items.find((i) => i.id === inboxId);
  const [settings, setSettings] = useState(false);
  const [canned, setCanned] = useState(false);
  const filter: InboxFilter = {
    status: search.status ?? 'open',
    ...(search.assignee ? { assignee: search.assignee } : {}),
    ...(search.tag ? { tag: search.tag } : {}),
    ...(search.q ? { q: search.q } : {}),
  };
  const setSearch = useCallback(
    (next: Partial<InboxSearch>) =>
      void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true }),
    [navigate],
  );

  if (inboxes.isSuccess && !inbox) {
    return (
      <Workspace sidebar={<InboxSidebar current={inboxId} />} crumbs={[{ label: t('mail.title') }]}>
        <EmptyState icon="inbox" title={t('mail.inbox.notFound')} className="m-auto" />
      </Workspace>
    );
  }

  const signIn = inbox?.needsSignIn ? <SignInBanner inbox={inbox} /> : null;
  const list = (
    <ConversationList
      inboxId={inboxId}
      filter={filter}
      selected={search.conversation ?? null}
      onSelect={(conversation) => setSearch({ conversation })}
      onFilter={(f) => setSearch({ ...f, conversation: undefined })}
    />
  );
  const view =
    search.conversation && inbox ? (
      <ConversationView
        key={search.conversation}
        inbox={inbox}
        conversationId={search.conversation}
        onClose={() => setSearch({ conversation: undefined })}
      />
    ) : (
      <div className="hidden flex-1 md:flex">
        <EmptyState icon="inbox" title={t('mail.inbox.pick')} className="m-auto" />
      </div>
    );

  return (
    <Workspace
      sidebar={<InboxSidebar current={inboxId} />}
      crumbs={[{ label: t('mail.title') }, { label: inbox?.name ?? t('mail.inbox.title') }]}
      tools={
        <>
          {inbox?.canWork ? (
            <Tooltip content={t('mail.inbox.cannedButton')}>
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('mail.inbox.cannedButton')}
                onClick={() => setCanned(true)}
              >
                <Icon name="note" size={18} />
              </IconButton>
            </Tooltip>
          ) : null}
          {inbox?.canManage ? (
            <Tooltip content={t('mail.inbox.settings')}>
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('mail.inbox.settings')}
                onClick={() => setSettings(true)}
              >
                <Icon name="settings" size={18} />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content={t('mail.refresh')}>
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('mail.refresh')}
              onClick={() => void qc.invalidateQueries({ queryKey: inboxKeys.all })}
            >
              <Icon name="refresh" size={18} />
            </IconButton>
          </Tooltip>
        </>
      }
      bodyClassName="flex-row gap-0 overflow-hidden p-0 md:p-0"
    >
      {signIn}
      {phone ? (
        search.conversation ? (
          view
        ) : (
          list
        )
      ) : (
        <>
          {list}
          {view}
        </>
      )}
      {canned && inbox ? <CannedDialog inbox={inbox} onClose={() => setCanned(false)} /> : null}
      {settings && inbox ? (
        <InboxSettingsDialog inbox={inbox} onClose={() => setSettings(false)} />
      ) : null}
    </Workspace>
  );
}

/**
 * An inbox that signs in with Microsoft 365 or Google and has no token yet (or lost it): its
 * admins sign it in with their own account, which must have access to the mailbox.
 */
function SignInBanner({ inbox }: { inbox: MailInbox }) {
  const { t } = useI18n();
  const provider =
    inbox.authMode === 'oauth_google'
      ? t('mail.inbox.signIn.google')
      : t('mail.inbox.signIn.microsoft');
  return (
    <div
      role="status"
      className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-accent10 px-4 py-2 text-sm"
    >
      <Icon name="alert" size={16} />
      <span className="min-w-0 flex-1">
        {inbox.canManage
          ? t('mail.inbox.signIn.body', { name: provider })
          : t('mail.inbox.signIn.ask')}
      </span>
      {inbox.canManage ? (
        <Button asChild size="sm" variant="pri">
          <a href={inboxOauthStartUrl(inbox.id)}>
            {t('mail.inbox.signIn.button', { name: provider })}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function ConversationList({
  inboxId,
  filter,
  selected,
  onSelect,
  onFilter,
}: {
  inboxId: string;
  filter: InboxFilter;
  selected: string | null;
  onSelect: (id: string) => void;
  onFilter: (f: Partial<InboxSearch>) => void;
}) {
  const { t } = useI18n();
  const list = useInfiniteQuery(conversationsQuery(inboxId, filter));
  const slow = useDelayed(list.isPending);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [query, setQuery] = useState(filter.q ?? '');
  useEffect(() => {
    const next = query.trim();
    if (next === (filter.q ?? '')) return;
    const timer = setTimeout(() => onFilter({ q: next || undefined }), 350);
    return () => clearTimeout(timer);
  }, [query, filter.q, onFilter]);

  return (
    <ResizablePane id="inbox-list" side="left" defaultWidth={380} className="max-md:w-full">
      <section
        aria-label={t('mail.inbox.conversations')}
        className="flex w-full min-w-0 flex-col border-r border-line"
      >
        <div className="flex flex-col gap-2 border-b border-line p-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('mail.inbox.search')}
            aria-label={t('mail.inbox.search')}
          />
          <Segmented
            size="sm"
            aria-label={t('mail.inbox.statusFilter')}
            value={filter.status}
            onValueChange={(status) => onFilter({ status: status === 'open' ? undefined : status })}
            options={(['open', 'pending', 'resolved', 'all'] as const).map((s) => ({
              value: s,
              label: t(`mail.inbox.status.${s}`),
            }))}
          />
          <div className="flex flex-wrap gap-1.5">
            <Chip
              size="sm"
              on={filter.assignee === 'me'}
              onClick={() => onFilter({ assignee: filter.assignee === 'me' ? undefined : 'me' })}
            >
              {t('mail.inbox.mine')}
            </Chip>
            <Chip
              size="sm"
              on={filter.assignee === 'none'}
              onClick={() =>
                onFilter({ assignee: filter.assignee === 'none' ? undefined : 'none' })
              }
            >
              {t('mail.inbox.unassigned')}
            </Chip>
            {filter.tag ? (
              <Chip size="sm" on onClick={() => onFilter({ tag: undefined })}>
                #{filter.tag}
                <Icon name="x" size={12} />
              </Chip>
            ) : null}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {list.isPending ? (
            slow ? (
              Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-3 my-2 h-16" />)
            ) : null
          ) : list.isError ? (
            <EmptyState icon="alert" title={mailError(t, list.error)}>
              <Button size="sm" onClick={() => void list.refetch()}>
                {t('common.actions.retry')}
              </Button>
            </EmptyState>
          ) : items.length === 0 ? (
            <EmptyState icon="inbox" title={t('mail.inbox.empty')} className="m-auto" />
          ) : (
            <VirtualList
              items={items}
              rowHeight={ROW_HEIGHT}
              getKey={(c) => c.id}
              aria-label={t('mail.inbox.conversations')}
              footer={
                list.hasNextPage ? (
                  <LoadMore
                    loading={list.isFetchingNextPage}
                    onLoad={() => void list.fetchNextPage()}
                  />
                ) : null
              }
              renderRow={(c) => (
                <ConversationRow
                  c={c}
                  active={c.id === selected}
                  onOpen={() => onSelect(c.id)}
                  onTag={(tag) => onFilter({ tag })}
                />
              )}
            />
          )}
        </div>
      </section>
    </ResizablePane>
  );
}

function ConversationRow({
  c,
  active,
  onOpen,
  onTag,
}: {
  c: MailConversationSummary;
  active: boolean;
  onOpen: () => void;
  onTag: (tag: string) => void;
}) {
  const { t, locale } = useI18n();
  const who = c.customer?.name || c.customer?.address || t('mail.list.unknownSender');
  return (
    <div
      role="button"
      tabIndex={0}
      data-conversation-row
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'mx-1.5 flex h-[70px] cursor-pointer flex-col justify-center gap-1 rounded-lg px-3 hover:bg-bg2',
        active && 'bg-capsule hover:bg-capsule',
      )}
    >
      <div className="flex items-center gap-2">
        {c.unread ? (
          <span
            className="size-2 shrink-0 rounded-full bg-accent"
            aria-label={t('mail.list.unread')}
          />
        ) : null}
        <span className={cn('min-w-0 flex-1 truncate text-sm', c.unread && 'font-semibold')}>
          {who}
        </span>
        {c.sla.breached ? (
          <Badge tone="danger">{t('mail.inbox.sla.breached')}</Badge>
        ) : c.sla.dueAt && !c.firstResponseAt ? (
          <Badge tone="warn">
            {t('mail.inbox.sla.due', { when: formatRelative(c.sla.dueAt, locale) })}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-fg3 tn">
          {formatRelative(c.lastMessageAt, locale)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg2">
          {c.subject || t('mail.list.noSubject')}
        </span>
        {c.tags.slice(0, 2).map((tag) => (
          <Tag
            key={tag}
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onTag(tag);
            }}
          >
            #{tag}
          </Tag>
        ))}
        {c.noteCount ? (
          <span
            className="flex items-center gap-0.5 text-xs text-fg3"
            aria-label={t('mail.inbox.notesCount', { count: c.noteCount })}
          >
            <Icon name="note" size={12} />
            {c.noteCount}
          </span>
        ) : null}
        {c.assignee ? (
          <Avatar name={c.assignee.name} src={c.assignee.imageUrl ?? undefined} size="sm" />
        ) : null}
      </div>
    </div>
  );
}
