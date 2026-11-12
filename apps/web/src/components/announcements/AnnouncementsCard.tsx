import { type Announcement } from '@crewhall/shared';
import { Button, Count, Icon, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import {
  announcementCountsQuery,
  announcementListQuery,
  applyAnnouncement,
} from '@/lib/announcements/queries';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { AnnouncementRow } from './AnnouncementParts';

const HOME_ITEMS = 3;

/**
 * Duyuru kartı on the home page (roadmap 19): the pinned and newest few, with the unread
 * count and a link to the feed. Hidden for guests and while there is nothing to show.
 */
export function AnnouncementsCard() {
  const { t } = useI18n();
  const { role } = usePermissions();
  const enabled = role !== 'guest';
  const { data } = useQuery({ ...announcementListQuery(false, HOME_ITEMS), enabled });
  const { data: counts } = useQuery({ ...announcementCountsQuery, enabled });
  const items = data?.items ?? [];
  if (!enabled || items.length === 0) return null;
  return (
    <section
      aria-label={t('announcements.title')}
      className="flex shrink-0 flex-col gap-1 rounded-2xl bg-surface px-2 pt-2.5 pb-2 shadow-line"
    >
      <div className="flex items-center gap-2 px-3 pb-1">
        <Icon name="flag" size={15} />
        <h2 className="m-0 text-[14px] font-bold">{t('announcements.title')}</h2>
        {counts?.unread ? (
          <Count
            tone="accent"
            aria-label={t('announcements.unreadCount', { count: counts.unread })}
          >
            {counts.unread}
          </Count>
        ) : null}
        <Link
          to="/announcements"
          className="ml-auto text-cap font-semibold text-fg2 hover:text-fg hover:underline"
        >
          {t('announcements.seeAll')}
        </Link>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((a) => (
          <li key={a.id}>
            <div className="flex items-center gap-1 pr-2">
              <div className="min-w-0 flex-1">
                <AnnouncementRow a={a} compact />
              </div>
              {a.requiresAck && !a.my.ackedAt ? <AckButton a={a} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Okudum" right on the card for announcements that ask for it. */
function AckButton({ a }: { a: Announcement }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const ack = async () => {
    setBusy(true);
    try {
      applyAnnouncement(
        qc,
        await api.call('acknowledgeAnnouncement', { params: { announcementId: a.id } }),
      );
      toast(t('announcements.toast.acked'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="xs"
      variant="out"
      disabled={busy}
      aria-label={t('announcements.ackFor', { title: a.title })}
      onClick={() => void ack()}
    >
      <Icon name="check" size={13} />
      {t('announcements.ack')}
    </Button>
  );
}
