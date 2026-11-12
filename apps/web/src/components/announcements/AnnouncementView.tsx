import { type Announcement } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Inline } from '@/components/chat/MessageParts';
import { PersonAvatar } from '@/components/chat/common';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import {
  announcementKeys,
  announcementQuery,
  announcementReadersQuery,
  applyAnnouncement,
} from '@/lib/announcements/queries';
import { errorKey } from '@/lib/errors';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { AnnouncementDialog } from './AnnouncementDialog';
import { AnnouncementTags, publishedLabel, ReadStats } from './AnnouncementParts';

/** One announcement: opening it counts as read; "Okudum" when asked; readers for its managers. */
export function AnnouncementView({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe()?.user.id ?? '';
  const { data: a, isPending, isError } = useQuery(announcementQuery(id));
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const marked = useRef<string | null>(null);

  // Opening counts once; the bell row of it is read with it on the server.
  useEffect(() => {
    if (!a || a.my.readAt || marked.current === a.id) return;
    marked.current = a.id;
    void api
      .call('markAnnouncementRead', { params: { announcementId: a.id } })
      .then((next) => {
        applyAnnouncement(qc, next);
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      })
      .catch(() => undefined);
  }, [a, qc]);

  const run = async (fn: () => Promise<Announcement>, done?: string) => {
    setBusy(true);
    try {
      applyAnnouncement(qc, await fn());
      if (done) toast(done);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.call('deleteAnnouncement', { params: { announcementId: id } });
      qc.removeQueries({ queryKey: announcementKeys.one(id) });
      void qc.invalidateQueries({ queryKey: announcementKeys.all });
      toast(t('announcements.toast.deleted'));
      void navigate({ to: '/announcements' });
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
      setDeleting(false);
    }
  };

  const crumbs = [
    { label: t('announcements.title'), to: '/announcements' },
    ...(a ? [{ label: a.title }] : []),
  ];

  if (isPending) {
    return (
      <Workspace crumbs={crumbs}>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }
  if (isError || !a) {
    return (
      <Workspace crumbs={crumbs}>
        <EmptyState className="m-auto" icon="flag" title={t('announcements.notFound')} />
      </Workspace>
    );
  }

  const paragraphs = a.body.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <Workspace crumbs={crumbs}>
      <article className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <AnnouncementTags a={a} />
          </div>
          <div className="flex items-start gap-3">
            <h1 className="m-0 min-w-0 flex-1 text-wtitle font-bold break-words">{a.title}</h1>
            {a.permissions.manage ? (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton size="sm" tone="plain" aria-label={t('announcements.actions')}>
                    <Icon name="dots" size={17} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem icon="edit" onSelect={() => setEditing(true)}>
                    {t('announcements.edit')}
                  </MenuItem>
                  <MenuItem
                    icon="pin"
                    onSelect={() =>
                      void run(
                        () =>
                          api.call('updateAnnouncement', {
                            params: { announcementId: a.id },
                            body: { pinned: a.pinnedAt === null },
                          }),
                        t(
                          a.pinnedAt
                            ? 'announcements.toast.unpinned'
                            : 'announcements.toast.pinned',
                        ),
                      )
                    }
                  >
                    {t(a.pinnedAt ? 'announcements.unpin' : 'announcements.pin')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon="trash" danger onSelect={() => setDeleting(true)}>
                    {t('announcements.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-cap text-fg2">
            {a.author ? <PersonAvatar user={a.author} size="sm" /> : null}
            <span className="font-semibold text-fg">
              {a.author?.name ?? t('announcements.unknownAuthor')}
            </span>
            <span>· {publishedLabel(a, locale)}</span>
            {a.editedAt ? <span>· {t('announcements.edited')}</span> : null}
          </div>
        </header>
        <div className="flex flex-col gap-3 rounded-2xl bg-surface px-5 py-4 shadow-line">
          {paragraphs.map((p, i) => (
            <p key={i} className="m-0 text-[14.5px] leading-[22px] break-words whitespace-pre-wrap">
              <Inline text={p.trim()} me={me} />
            </p>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ReadStats a={a} />
          {a.requiresAck ? (
            a.my.ackedAt ? (
              <span className="ml-auto flex items-center gap-1 text-cap font-semibold text-success">
                <Icon name="checkC" size={15} />
                {t('announcements.acked', {
                  when: `${formatDate(a.my.ackedAt, locale)} ${formatTime(a.my.ackedAt, locale)}`,
                })}
              </span>
            ) : (
              <Button
                variant="pri"
                className="ml-auto"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.call('acknowledgeAnnouncement', { params: { announcementId: a.id } }),
                    t('announcements.toast.acked'),
                  )
                }
              >
                <Icon name="check" size={15} />
                {t('announcements.ack')}
              </Button>
            )
          ) : null}
        </div>
        {a.permissions.manage ? <Readers a={a} /> : null}
      </article>
      {editing ? <AnnouncementDialog open onOpenChange={setEditing} editing={a} /> : null}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent width={420}>
          <DialogHeader
            title={t('announcements.deleteTitle')}
            description={t('announcements.deleteBody', { title: a.title })}
          />
          <DialogFooter>
            <Button variant="gh" onClick={() => setDeleting(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="dng" disabled={busy} onClick={() => void remove()}>
              {t('announcements.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Workspace>
  );
}

/** Who read it (and confirmed), with the ones who have not. */
function Readers({ a }: { a: Announcement }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<'read' | 'unread'>('unread');
  const { data } = useQuery(announcementReadersQuery(a.id));
  const list = (data?.items ?? []).filter((r) =>
    tab === 'read' ? r.readAt !== null : r.readAt === null || (a.requiresAck && !r.ackedAt),
  );
  const unreadLabel = t(
    a.requiresAck ? 'announcements.readers.notAcked' : 'announcements.readers.unread',
  );
  // The heading names the list the filter shows (B3).
  const heading = tab === 'read' ? t('announcements.readers.read') : unreadLabel;
  return (
    <section className="flex flex-col gap-2" aria-label={heading}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 mr-auto text-[15px] font-bold">{heading}</h2>
        <Chip size="sm" on={tab === 'unread'} onClick={() => setTab('unread')}>
          {unreadLabel}
        </Chip>
        <Chip size="sm" on={tab === 'read'} onClick={() => setTab('read')}>
          {t('announcements.readers.read')}
        </Chip>
      </div>
      {list.length === 0 ? (
        <p className="m-0 text-cap text-fg2">{t('announcements.readers.none')}</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0 sm:grid-cols-2">
          {list.map((r) => (
            <li key={r.user.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <Avatar name={r.user.name} src={r.user.imageUrl} size="sm" />
              <span className="min-w-0 flex-1 truncate text-cap font-semibold">{r.user.name}</span>
              {r.ackedAt ? (
                <Icon name="checkC" size={14} className="text-success" />
              ) : r.readAt ? (
                <span className="text-xs text-fg3">{formatTime(r.readAt, locale)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
