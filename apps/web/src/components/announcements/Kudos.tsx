import { KUDOS_LIMITS, type Celebration, type Kudos, type UserSummary } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Skeleton,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PersonAvatar } from '@/components/chat/common';
import { api } from '@/lib/api';
import {
  badgeName,
  celebrationsQuery,
  kudosBadgesQuery,
  kudosListQuery,
  refreshKudos,
} from '@/lib/announcements/kudos';
import { errorKey } from '@/lib/errors';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';

/** Duyurular › Teşekkür duvarı: cards, the send dialog and the birthday list. */

/** "Duyurular | Teşekkür duvarı" at the top of both pages. */
export function AnnouncementTabs({ current }: { current: 'feed' | 'kudos' }) {
  const { t } = useI18n();
  const tab = (active: boolean) =>
    cn(
      'inline-flex h-8 items-center rounded-md px-3 text-cap font-semibold',
      active ? 'bg-surface shadow-line' : 'text-fg2 hover:text-fg',
    );
  return (
    <nav
      aria-label={t('announcements.title')}
      className="flex gap-0.5 self-start rounded-lg bg-bg2 p-[3px]"
    >
      <Link
        to="/announcements"
        className={tab(current === 'feed')}
        aria-current={current === 'feed' ? 'page' : undefined}
      >
        {t('announcements.title')}
      </Link>
      <Link
        to="/announcements/kudos"
        className={tab(current === 'kudos')}
        aria-current={current === 'kudos' ? 'page' : undefined}
      >
        {t('announcements.kudos.title')}
      </Link>
    </nav>
  );
}

export function KudosCard({ k }: { k: Kudos }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.call('deleteKudos', { params: { kudosId: k.id } });
      refreshKudos(qc);
      toast(t('announcements.kudos.toast.deleted'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      aria-label={t('announcements.kudos.cardLabel', {
        from: k.from?.name ?? t('announcements.unknownAuthor'),
        to: k.to.name,
      })}
      className="group relative flex gap-3 rounded-2xl bg-surface p-4 shadow-line"
    >
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-bg2 text-[26px]"
      >
        {k.badge?.emoji ?? '🙏'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-cap">
          {k.from ? <PersonAvatar user={k.from} size="sm" /> : null}
          <span className="font-semibold">{k.from?.name ?? t('announcements.unknownAuthor')}</span>
          <Icon name="arrowR" size={13} className="text-fg3" />
          <PersonAvatar user={k.to} size="sm" />
          <span className="font-semibold">{k.to.name}</span>
        </div>
        {k.badge ? (
          <span className="self-start rounded-full bg-accent/15 px-2 py-0.5 text-xs font-bold">
            {badgeName(t, k.badge)}
          </span>
        ) : null}
        {k.message ? (
          <p className="m-0 text-[14px] leading-[21px] break-words whitespace-pre-wrap">
            {k.message}
          </p>
        ) : null}
        <span className="text-xs text-fg3">{formatRelative(k.createdAt, locale)}</span>
      </div>
      {k.permissions.delete ? (
        <IconButton
          size="sm"
          tone="plain"
          disabled={busy}
          aria-label={t('announcements.kudos.delete')}
          onClick={() => void remove()}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="trash" size={15} />
        </IconButton>
      ) : null}
    </article>
  );
}

/** The wall (everyone) or the cards one person received (their profile). */
export function KudosList({ userId = null }: { userId?: string | null }) {
  const { t } = useI18n();
  const { data, isPending } = useQuery(kudosListQuery(userId));
  const items = data?.items ?? [];
  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (!items.length) {
    return userId ? (
      <p className="m-0 text-cap text-fg2">{t('announcements.kudos.noneForPerson')}</p>
    ) : (
      <EmptyState
        icon="sparkle"
        title={t('announcements.kudos.empty')}
        description={t('announcements.kudos.emptyHint')}
      />
    );
  }
  return (
    <ul
      className="stagger-in m-0 flex list-none flex-col gap-2 p-0"
      aria-label={t('announcements.kudos.title')}
    >
      {items.map((k) => (
        <li key={k.id}>
          <KudosCard k={k} />
        </li>
      ))}
    </ul>
  );
}

/** Send a card: one person, one badge, an optional message. */
export function KudosDialog({
  open,
  onOpenChange,
  to: preset = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  to?: UserSummary | null;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe()?.user.id ?? '';
  const [to, setTo] = useState<UserSummary | null>(preset);
  const [q, setQ] = useState('');
  const [badgeId, setBadgeId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const badges = useQuery(kudosBadgesQuery);
  const people = useQuery({
    ...membersQuery({ q: q.trim() || undefined, status: 'active' }),
    enabled: open && !to,
  });
  const choices = (people.data?.items ?? [])
    .filter((m) => m.role !== 'guest' && m.user.id !== me)
    .map((m) => m.user)
    .slice(0, 8);
  const active = (badges.data?.items ?? []).filter((b) => !b.archived);
  const ready = !!to && !!badgeId;

  const send = async () => {
    if (!to || !badgeId || busy) return;
    setBusy(true);
    try {
      await api.call('createKudos', {
        body: { toUserId: to.id, badgeId, message: message.trim() || null },
      });
      refreshKudos(qc);
      toast(t('announcements.kudos.toast.sent', { name: to.name }));
      onOpenChange(false);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader
          title={t('announcements.kudos.dialog.title')}
          description={t('announcements.kudos.dialog.hint')}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Field label={t('announcements.kudos.dialog.to')}>
            {to ? (
              <div className="flex items-center gap-2 rounded-md bg-bg2 px-2.5 py-1.5">
                <PersonAvatar user={to} size="sm" card={false} />
                <span className="min-w-0 flex-1 truncate text-cap font-semibold">{to.name}</span>
                {preset ? null : (
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('announcements.kudos.dialog.changePerson')}
                    onClick={() => setTo(null)}
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <Input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('announcements.kudos.dialog.search')}
                  aria-label={t('announcements.kudos.dialog.search')}
                />
                <ul
                  className="m-0 flex max-h-[200px] list-none flex-col overflow-y-auto p-0"
                  aria-label={t('announcements.kudos.dialog.to')}
                >
                  {choices.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => setTo(u)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
                      >
                        <PersonAvatar user={u} size="sm" card={false} />
                        <span className="min-w-0 flex-1 truncate text-cap font-semibold">
                          {u.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Field>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-cap font-semibold">
              {t('announcements.kudos.dialog.badge')}
            </legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup">
              {active.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={badgeId === b.id}
                  onClick={() => setBadgeId(b.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-cap font-semibold shadow-line',
                    badgeId === b.id
                      ? 'bg-accent/20 shadow-[inset_0_0_0_1.5px_var(--accent)]'
                      : 'hover:bg-bg2',
                  )}
                >
                  <span aria-hidden="true" className="text-[18px]">
                    {b.emoji}
                  </span>
                  <span className="min-w-0 truncate">{badgeName(t, b)}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Field label={t('announcements.kudos.dialog.message')}>
            <Textarea
              rows={3}
              value={message}
              maxLength={KUDOS_LIMITS.messageChars}
              placeholder={t('announcements.kudos.dialog.messagePlaceholder')}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!ready || busy}>
              <Icon name="sparkle" size={15} />
              {t('announcements.kudos.dialog.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CelebrationRow({ c, today }: { c: Celebration; today: boolean }) {
  const { t, locale } = useI18n();
  const what =
    c.kind === 'birthday'
      ? t('announcements.kudos.celebrations.birthday')
      : t('announcements.kudos.celebrations.anniversary', { years: c.years ?? 1 });
  return (
    <li className="flex items-center gap-2.5 py-1">
      <span aria-hidden="true" className="text-[18px]">
        {c.kind === 'birthday' ? '🎂' : '🎉'}
      </span>
      <PersonAvatar user={c.user} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-cap font-semibold">{c.user.name}</span>
        <span className="truncate text-xs text-fg2">{what}</span>
      </span>
      {today ? null : (
        <span className="text-xs text-fg2">
          {formatDate(`${c.date}T12:00:00`, locale, { day: 'numeric', month: 'short' })}
        </span>
      )}
    </li>
  );
}

/** Today's and the coming two weeks' birthdays (shown ones) and work anniversaries. */
export function CelebrationsList({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { data } = useQuery(celebrationsQuery);
  if (!data) return null;
  const upcoming = compact ? data.upcoming.slice(0, 3) : data.upcoming;
  if (!data.today.length && !upcoming.length) {
    return compact ? null : (
      <p className="m-0 text-cap text-fg2">{t('announcements.kudos.celebrations.none')}</p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {data.today.length ? (
        <section aria-label={t('announcements.kudos.celebrations.today')}>
          <h3 className="m-0 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
            {t('announcements.kudos.celebrations.today')}
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {data.today.map((c) => (
              <CelebrationRow key={`${c.kind}-${c.user.id}`} c={c} today />
            ))}
          </ul>
        </section>
      ) : null}
      {upcoming.length ? (
        <section aria-label={t('announcements.kudos.celebrations.upcoming')}>
          <h3 className="m-0 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
            {t('announcements.kudos.celebrations.upcoming')}
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {upcoming.map((c) => (
              <CelebrationRow key={`${c.kind}-${c.user.id}-${c.date}`} c={c} today={false} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Home card: today's celebrations first, a few coming ones; hidden while there are none. */
export function CelebrationsCard() {
  const { t } = useI18n();
  const { data } = useQuery(celebrationsQuery);
  if (!data || (!data.today.length && !data.upcoming.length)) return null;
  return (
    <section
      aria-label={t('announcements.kudos.celebrations.title')}
      className="flex shrink-0 flex-col gap-1 rounded-2xl bg-surface px-5 pt-3 pb-3 shadow-line"
    >
      <div className="flex items-center gap-2 pb-1">
        <span aria-hidden="true">🎉</span>
        <h2 className="m-0 text-[14px] font-bold">{t('announcements.kudos.celebrations.title')}</h2>
        <Link
          to="/announcements/kudos"
          className="ml-auto text-cap font-semibold text-fg2 hover:text-fg hover:underline"
        >
          {t('announcements.kudos.title')}
        </Link>
      </div>
      <CelebrationsList compact />
    </section>
  );
}
