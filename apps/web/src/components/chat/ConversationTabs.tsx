import {
  Button,
  Chip,
  cn,
  EmptyState,
  Icon,
  Input,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { badgeOf, kindOf } from '@/features/drive/fileKinds';
import { useMessageActions } from './actions';
import { filesQuery, pinnedQuery } from '@/lib/chat/queries';
import { type Conversation } from '@/lib/chat/types';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { PersonAvatar, useMyId } from './common';
import { AlertCardView, Attachments, MessageText } from './MessageParts';

type FileFilter = 'all' | 'docs' | 'media' | 'code';

/** 4.9 "Dosyalar": every file shared here; they live in Drive under the chat's Ekler folder. */
export function FilesTab({ conv }: { conv: Conversation }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { items: spaces } = useSpaces();
  const { data, isPending } = useQuery(filesQuery(conv.id));
  const [filter, setFilter] = useState<FileFilter>('all');
  const [q, setQ] = useState('');
  const space = spaces.find((s) => s.id === conv.spaceId);

  const list = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase(locale);
    return (data?.items ?? []).filter((f) => {
      if (needle && !f.attachment.name.toLocaleLowerCase(locale).includes(needle)) return false;
      if (filter === 'all') return true;
      const k = kindOf(f.attachment.name, f.attachment.mime);
      if (filter === 'media') return k === 'image' || k === 'video' || k === 'audio';
      if (filter === 'code') return k === 'code' || k === 'text';
      return !['image', 'video', 'audio', 'code', 'text'].includes(k);
    });
  }, [data, filter, q, locale]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'docs', 'media', 'code'] as const).map((f) => (
          <Chip key={f} size="sm" on={filter === f} onClick={() => setFilter(f)}>
            {t(`chat.files.filter.${f}`)}
          </Chip>
        ))}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('chat.files.search')}
          aria-label={t('chat.files.search')}
          className="ml-auto w-[220px]"
        />
        {conv.attachmentsNodeId && space ? (
          <Button size="sm" variant="out" asChild>
            <Link
              to="/drive/$spaceSlug/folder/$folderId"
              params={{ spaceSlug: space.slug, folderId: conv.attachmentsNodeId }}
            >
              <Icon name="folder" size={15} />
              {t('chat.files.openInDrive')}
            </Link>
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.length === 0 ? (
        <EmptyState
          className="m-auto"
          icon="file"
          title={t('chat.files.empty')}
          description={t('chat.files.emptyHint')}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t('chat.files.cols.name')}</Th>
              <Th>{t('chat.files.cols.by')}</Th>
              <Th>{t('chat.files.cols.date')}</Th>
              <Th className="text-right">{t('chat.files.cols.size')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <Tr key={`${f.messageId}-${f.attachment.nodeId}`}>
                <Td>
                  <span
                    className={cn(
                      'flex items-center gap-2.5',
                      f.attachment.removed && 'text-fg3 line-through',
                    )}
                  >
                    <span className="flex h-7 min-w-7 items-center justify-center rounded-sm bg-bg2 px-1 font-mono text-[9.5px] font-bold text-fg2">
                      {badgeOf(f.attachment.name)}
                    </span>
                    <span className="truncate font-semibold">{f.attachment.name}</span>
                  </span>
                </Td>
                <Td>
                  {f.author ? (
                    <span className="flex items-center gap-2">
                      <PersonAvatar user={f.author} size="sm" />
                      {f.author.name}
                    </span>
                  ) : null}
                </Td>
                <Td className="text-fg2">
                  {formatDate(f.createdAt, locale, { day: 'numeric', month: 'short' })}{' '}
                  {formatTime(f.createdAt, locale)}
                </Td>
                <Td className="text-right text-fg2">
                  {formatBytes(f.attachment.sizeBytes, locale)}
                </Td>
                <Td className="text-right">
                  <Button
                    size="xs"
                    variant="gh"
                    onClick={() =>
                      void navigate({
                        to: '/chat/c/$conversationId',
                        params: { conversationId: conv.id },
                        search: { seq: f.seq },
                      })
                    }
                  >
                    {t('chat.files.goTo')}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {data ? (
        <p className="m-0 text-xs text-fg2">
          {t('chat.files.total', {
            count: data.totalCount,
            size: formatBytes(data.totalBytes, locale),
          })}
        </p>
      ) : null}
    </div>
  );
}

/** 4.10 "Sabitlenenler": newest pin on top; "Sohbette göster" scrolls and flashes it. */
export function PinnedTab({ conv }: { conv: Conversation }) {
  const { t, locale } = useI18n();
  const me = useMyId();
  const navigate = useNavigate();
  const act = useMessageActions();
  const { data, isPending } = useQuery(pinnedQuery(conv.id));
  const [q, setQ] = useState('');
  const needle = q.trim().toLocaleLowerCase(locale);
  const list = (data ?? []).filter(
    (p) =>
      !needle ||
      `${p.message.text} ${p.message.card?.title ?? ''}`.toLocaleLowerCase(locale).includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex items-center gap-3">
        <span className="text-cap font-semibold">
          {t('chat.pinned.count', { count: data?.length ?? 0 })}
        </span>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('chat.pinned.search')}
          aria-label={t('chat.pinned.search')}
          className="ml-auto w-[240px]"
        />
      </div>
      {isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.length === 0 ? (
        <EmptyState
          className="m-auto"
          icon="pin"
          title={t('chat.pinned.empty')}
          description={t('chat.pinned.emptyHint')}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map(({ message: m, pinnedBy, pinnedAt }) => (
            <li key={m.id} className="flex flex-col gap-2 rounded-xl p-4 shadow-line">
              <div className="flex items-center gap-2.5">
                {m.author ? <PersonAvatar user={m.author} size="md" /> : null}
                <span className="text-cap font-bold">{m.author?.name ?? m.webhook?.name}</span>
                <span className="text-xs text-fg3">
                  {formatDate(m.createdAt, locale, { day: 'numeric', month: 'long' })}{' '}
                  {formatTime(m.createdAt, locale)}
                </span>
                <Button
                  size="xs"
                  variant="gh"
                  className="ml-auto"
                  onClick={() =>
                    void navigate({
                      to: '/chat/c/$conversationId',
                      params: { conversationId: conv.id },
                      search: { seq: m.seq },
                    })
                  }
                >
                  {t('chat.pinned.show')}
                </Button>
                {conv.permissions.pin ? (
                  <Button size="xs" variant="gh" onClick={() => void act.pin(m)}>
                    {t('chat.message.unpin')}
                  </Button>
                ) : null}
              </div>
              {m.card ? <AlertCardView card={m.card} /> : null}
              {m.text ? <MessageText text={m.text} me={me} /> : null}
              {m.attachments.length ? <Attachments m={m} /> : null}
              <span className="text-xs text-fg2">
                {t('chat.pinned.by', {
                  name: pinnedBy?.name ?? '',
                  date: formatDate(pinnedAt, locale, { day: 'numeric', month: 'short' }),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
