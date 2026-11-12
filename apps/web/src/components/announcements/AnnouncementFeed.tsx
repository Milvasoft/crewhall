import { Button, EmptyState, Icon, Skeleton, Switch } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { announcementListQuery } from '@/lib/announcements/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { AnnouncementDialog } from './AnnouncementDialog';
import { AnnouncementRow } from './AnnouncementParts';
import { AnnouncementTabs } from './Kudos';

/** Duyurular (roadmap 19): pinned first, then newest; write button for those allowed. */
export function AnnouncementFeed() {
  const { t } = useI18n();
  const { canOrg } = usePermissions();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [writing, setWriting] = useState(false);
  const { data, isPending } = useQuery(announcementListQuery(unreadOnly));
  const items = data?.items ?? [];
  const canWrite = canOrg('announcements.publish');

  return (
    <Workspace crumbs={[{ label: t('announcements.title') }]}>
      <AnnouncementTabs current="feed" />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">{t('announcements.title')}</h1>
          <span className="text-cap text-fg2">{t('announcements.subtitle')}</span>
        </div>
        <label className="ml-auto flex items-center gap-2 text-cap font-semibold">
          <Switch
            checked={unreadOnly}
            onCheckedChange={setUnreadOnly}
            aria-label={t('announcements.unreadOnly')}
          />
          {t('announcements.unreadOnly')}
        </label>
        {canWrite ? (
          <Button variant="pri" size="sm" onClick={() => setWriting(true)}>
            <Icon name="plus" size={15} />
            {t('announcements.new')}
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          className="m-auto"
          icon="flag"
          title={t(unreadOnly ? 'announcements.emptyUnread' : 'announcements.empty')}
          description={canWrite ? t('announcements.emptyWriter') : undefined}
        />
      ) : (
        <ul
          className="stagger-in m-0 flex list-none flex-col gap-2 p-0"
          aria-label={t('announcements.title')}
        >
          {items.map((a) => (
            <li key={a.id}>
              <AnnouncementRow a={a} />
            </li>
          ))}
        </ul>
      )}
      {writing ? <AnnouncementDialog open onOpenChange={setWriting} /> : null}
    </Workspace>
  );
}
