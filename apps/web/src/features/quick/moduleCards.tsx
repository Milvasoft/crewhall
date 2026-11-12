import { primarySecret } from '@crewhall/crypto';
import { pagePath, type Card, type Meeting } from '@crewhall/shared';
import { Avatar, Button, cn, Icon, IconButton, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ConversationAvatar } from '@/components/chat/common';
import { CopyButton } from '@/components/vault/fields';
import { vaultName } from '@/components/vault/VaultSidebar';
import { enqueue } from '@/lib/chat/outbox';
import { conversationQuery, messagesQuery } from '@/lib/chat/queries';
import { excerptOf } from '@/lib/chat/names';
import { formatDate, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { meetHomeQuery, meetingsQuery } from '@/lib/meet/queries';
import { api } from '@/lib/api';
import { vaultsQuery } from '@/lib/vault/api';
import { payloadOf, useVaultItems } from '@/lib/vault/items';
import { useVaultSession } from '@/lib/vault/session';
import { CardFrame, CardHeader, NO_DRAG } from './cardFrame';
import { useQuick } from './context';
import { PageTaskList, pageTasks, type DocNode } from './PageTasks';
import { useOpenMeeting } from '@/components/meet/openMeeting';

/**
 * Cards that read another module (design 2.2, H4): a page preview, a chat with quick reply, the
 * next meeting and a vault item. The card stores ids only; each module answers with the
 * viewer's own rights, so the same card can be readable for one person and locked for another.
 */

type Of<T extends Card['type']> = Extract<Card, { type: T }>;

function Locked({
  card,
  title,
  hint,
  icon = 'lock',
  children,
}: {
  card: Card;
  title: string;
  hint: string;
  icon?: 'lock' | 'vault';
  children?: React.ReactNode;
}) {
  return (
    <CardFrame card={card} label={title} className="items-center justify-center text-center">
      <Icon name={icon} size={20} className="text-fg3" />
      <span className="text-cap font-semibold">{title}</span>
      <span className="text-xs text-fg3">{hint}</span>
      {children}
    </CardFrame>
  );
}

// ---- page (preview) ----

/** First lines of the page body as plain text (headings, lists and marks dropped). */
export function pagePreview(markdown: string, max = 600): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
        .replace(/[*_~`]+/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
    .slice(0, max);
}

export function PageCard({ card }: { card: Of<'page'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const page = card.node;
  const contentKey = ['quick', 'pageContent', card.config.nodeId] as const;
  const content = useQuery({
    queryKey: contentKey,
    queryFn: ({ signal }) =>
      api.call('getPageContent', {
        params: { nodeId: card.config.nodeId },
        query: { format: 'json' },
        signal,
      }),
    enabled: Boolean(page),
    staleTime: 30_000,
  });
  if (!page) {
    return (
      <Locked card={card} title={t('quick.node.locked')} hint={t('quick.node.lockedHint')}>
        {q.canEdit ? (
          <Button size="xs" variant="gh" className={NO_DRAG} onClick={() => q.remove(card)}>
            {t('quick.node.removeCard')}
          </Button>
        ) : null}
      </Locked>
    );
  }
  const text = content.data ? pagePreview(content.data.markdown) : '';
  const doc = content.data?.doc as DocNode | undefined;
  const tasks = pageTasks(doc);
  return (
    <CardFrame card={card} label={page.name}>
      <CardHeader
        icon="page"
        title={
          <Link
            to="/p/$pageRef"
            params={{ pageRef: pagePath(page).slice(3) }}
            className={cn('hover:underline', NO_DRAG)}
            onClick={(e) => q.editing && e.preventDefault()}
          >
            {page.name}
          </Link>
        }
        aside={
          tasks.length ? (
            <span className="shrink-0 text-xs font-medium text-fg3">
              {t('quick.todo.progress', {
                done: tasks.filter((x) => x.checked).length,
                total: tasks.length,
              })}
            </span>
          ) : undefined
        }
      />
      {doc && tasks.length ? (
        <PageTaskList
          nodeId={card.config.nodeId}
          doc={doc}
          queryKey={contentKey}
          disabled={q.editing || page.myRole === 'viewer'}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden text-cap leading-[19px] whitespace-pre-line text-fg2 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
          {content.isPending ? (
            <span className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </span>
          ) : text ? (
            text
          ) : (
            <span className="text-fg3">{t('quick.page.empty')}</span>
          )}
        </div>
      )}
      <span className="shrink-0 truncate text-xs text-fg3">
        {t('quick.page.edited', { when: formatRelative(page.updatedAt, locale) })}
      </span>
    </CardFrame>
  );
}

// ---- chat (latest messages, quick reply) ----

export function ChatCard({ card }: { card: Of<'chat'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const navigate = useNavigate();
  const id = card.config.conversationId;
  const conv = useQuery({ ...conversationQuery(id), retry: false });
  const messages = useQuery({ ...messagesQuery(id), enabled: conv.isSuccess, retry: false });
  const [text, setText] = useState('');
  const last = useMemo(
    () => (messages.data?.items ?? []).slice(-card.config.limit),
    [messages.data, card.config.limit],
  );

  if (conv.isError) {
    return <Locked card={card} title={t('quick.chat.locked')} hint={t('quick.chat.lockedHint')} />;
  }
  const c = conv.data;
  const title = c?.title ?? t('quick.gallery.kinds.chat');
  const open = () => {
    if (!q.editing) {
      void navigate({ to: '/chat/c/$conversationId', params: { conversationId: id } });
    }
  };
  return (
    <CardFrame card={card} label={title}>
      <header className="flex min-w-0 shrink-0 items-center gap-2">
        {c ? (
          <ConversationAvatar conv={c} size="sm" />
        ) : (
          <Skeleton className="size-6 rounded-full" />
        )}
        <button
          type="button"
          onClick={open}
          aria-label={t('quick.chat.open')}
          className={cn(
            'min-w-0 flex-1 truncate text-left text-[13px] leading-[18px] font-semibold hover:underline',
            NO_DRAG,
          )}
        >
          {title}
        </button>
      </header>
      <ol
        className={cn(
          'm-0 flex min-h-0 flex-1 list-none flex-col justify-end gap-1.5 overflow-hidden p-0',
          // Newest at the bottom; older lines fade out at the top instead of being cut.
          '[mask-image:linear-gradient(to_bottom,transparent,black_28px)]',
        )}
      >
        {messages.isPending ? (
          <li className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </li>
        ) : last.length === 0 ? (
          <li className="text-cap text-fg3">{t('quick.chat.empty')}</li>
        ) : (
          last.map((m) => (
            <li key={m.id} className="flex min-w-0 items-start gap-2">
              <Avatar
                size="sm"
                name={m.author?.name ?? title}
                src={m.author?.imageUrl ?? undefined}
                className="mt-px shrink-0"
              />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-1.5 text-xs">
                  <span className="truncate font-semibold">{m.author?.name ?? title}</span>
                  <span className="shrink-0 text-fg3">{formatTime(m.createdAt, locale)}</span>
                </span>
                <span className="line-clamp-2 text-cap text-fg2">
                  {m.deletedAt
                    ? t('quick.chat.deleted')
                    : excerptOf(m) || (m.attachments.length ? `${t('quick.chat.attachment')}` : '')}
                </span>
              </span>
            </li>
          ))
        )}
      </ol>
      {c && !c.archivedAt && !q.editing ? (
        <form
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-lg bg-bg2 pr-1 pl-2.5',
            NO_DRAG,
          )}
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            enqueue({ conversationId: id, text: v, replyTo: null, attachments: [] });
            setText('');
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('quick.chat.reply', { name: title })}
            aria-label={t('quick.chat.reply', { name: title })}
            className="h-8 min-w-0 flex-1 bg-transparent text-cap outline-none placeholder:text-fg3"
          />
          <IconButton
            type="submit"
            size="xs"
            tone="plain"
            aria-label={t('quick.chat.send')}
            disabled={!text.trim()}
          >
            <Icon name="send" size={14} />
          </IconButton>
        </form>
      ) : null}
    </CardFrame>
  );
}

// ---- meeting (live now, else next) ----

/** Live meetings first, then the earliest planned one; restricted to a space when set. */
export function pickMeeting(
  live: Meeting[],
  upcoming: Meeting[],
  spaceId: string | null,
  now = Date.now(),
): { meeting: Meeting; live: boolean } | null {
  const inSpace = (m: Meeting) => spaceId === null || m.spaceId === spaceId;
  const on = live.find(inSpace);
  if (on) return { meeting: on, live: true };
  const next = upcoming
    .filter((m) => inSpace(m) && m.startsAt && Date.parse(m.startsAt) + 60 * 60_000 > now)
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))[0];
  return next ? { meeting: next, live: false } : null;
}

export function MeetingCard({ card }: { card: Of<'meeting'> }) {
  const { t, locale } = useI18n();
  const q = useQuick();
  const openMeeting = useOpenMeeting();
  const home = useQuery({ ...meetHomeQuery(), retry: false });
  const upcoming = useQuery({ ...meetingsQuery('upcoming'), retry: false });
  const pick = pickMeeting(home.data?.live ?? [], upcoming.data?.items ?? [], card.config.spaceId);
  const join = (slug: string) => {
    if (!q.editing) openMeeting(slug);
  };
  const when = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? t('quick.meeting.today', { time: formatTime(d, locale) })
      : t('quick.meeting.at', {
          date: formatDate(d, locale, { day: 'numeric', month: 'short' }),
          time: formatTime(d, locale),
        });
  };
  return (
    <CardFrame card={card} label={pick?.meeting.title ?? t('quick.meeting.title')}>
      <CardHeader
        icon="video"
        title={
          pick
            ? t(pick.live ? 'quick.meeting.live' : 'quick.meeting.next')
            : t('quick.meeting.title')
        }
        aside={
          pick?.live ? (
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
          ) : null
        }
      />
      {home.isPending || upcoming.isPending ? (
        <span className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </span>
      ) : pick ? (
        <div className="flex min-h-0 flex-1 items-end justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="line-clamp-2 text-sub leading-[20px] font-semibold">
              {pick.meeting.title}
            </span>
            <span className="truncate text-xs text-fg3">
              {pick.live && pick.meeting.live
                ? t('quick.meeting.people', { count: pick.meeting.live.participantCount })
                : pick.meeting.startsAt
                  ? when(pick.meeting.startsAt)
                  : (pick.meeting.spaceName ?? '')}
            </span>
          </span>
          <Button
            size="sm"
            variant={pick.live ? 'pri' : 'gh'}
            className={cn('shrink-0', NO_DRAG)}
            onClick={() => join(pick.meeting.slug)}
          >
            {t('quick.meeting.join')}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-end justify-between gap-3">
          <span className="text-cap text-fg3">{t('quick.meeting.none')}</span>
          <Link
            to="/meetings"
            className={cn('shrink-0 text-xs font-semibold hover:underline', NO_DRAG)}
          >
            {t('quick.meeting.all')}
          </Link>
        </div>
      )}
    </CardFrame>
  );
}

// ---- vault item (copy in one click) ----

const SECRET_LABEL: Record<string, MessageKey> = {
  login: 'vault.field.password',
  api_key: 'vault.field.key',
  card: 'vault.field.number',
  ssh_key: 'vault.field.key',
};
const SECRET_FIELD: Record<string, string> = {
  login: 'password',
  api_key: 'key',
  card: 'number',
  ssh_key: 'privateKey',
};

export function VaultItemCard({ card }: { card: Of<'vault_item'> }) {
  const { t } = useI18n();
  const { unlocked } = useVaultSession();
  const vaults = useQuery({ ...vaultsQuery, enabled: Boolean(unlocked), retry: false });
  const vault = vaults.data?.find((v) => v.id === card.config.vaultId);
  const { items, isPending } = useVaultItems(vault);
  const found = items.find((d) => d.item.id === card.config.itemId && !d.item.deletedAt);
  // The list holds summaries only (H13); the one secret this card copies is decrypted here.
  const payload = useMemo(() => (found?.summary ? payloadOf(found) : null), [found]);

  // Locked: the name is encrypted too, so the card says only that the vault is locked.
  if (!unlocked) {
    return (
      <CardFrame card={card} label={t('quick.vault.title')} className="justify-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2">
            <Icon name="vault" size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-cap font-semibold">{t('quick.vault.locked')}</span>
            <span className="truncate text-xs text-fg3">{t('quick.vault.lockedHint')}</span>
          </span>
          <Link
            to="/vault"
            className={cn('shrink-0 text-xs font-semibold hover:underline', NO_DRAG)}
          >
            {t('quick.vault.unlock')}
          </Link>
        </div>
      </CardFrame>
    );
  }
  if (!payload) {
    if (vaults.isPending || isPending) {
      return (
        <CardFrame card={card} label={t('quick.vault.title')} className="justify-center">
          <Skeleton className="h-8 w-full" />
        </CardFrame>
      );
    }
    return (
      <Locked
        card={card}
        icon="vault"
        title={t('quick.vault.missing')}
        hint={t('quick.vault.missingHint')}
      />
    );
  }
  const p = payload;
  const secret = primarySecret(p);
  const sub =
    p.type === 'login' || p.type === 'api_key' ? p.username : vault ? vaultName(vault, t) : '';
  return (
    <CardFrame card={card} label={p.name} className="justify-center">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2">
          <Icon name="vault" size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-cap font-semibold">{p.name}</span>
          {sub ? <span className="truncate text-xs text-fg3">{sub}</span> : null}
        </span>
        <span className={NO_DRAG}>
          {secret ? (
            <CopyButton
              value={secret}
              labelKey={SECRET_LABEL[p.type] ?? 'vault.field.password'}
              access={{ vaultId: card.config.vaultId, itemId: card.config.itemId }}
              field={SECRET_FIELD[p.type] ?? 'password'}
            />
          ) : (
            <span className="text-xs text-fg3">{t('quick.vault.noSecret')}</span>
          )}
        </span>
      </div>
    </CardFrame>
  );
}
