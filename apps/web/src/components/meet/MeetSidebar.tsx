import { type MeetHome, type Meeting } from '@crewhall/shared';
import { cn, Count, Icon, type IconName } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatTime } from '@/lib/i18n/format';
import { LiveDot } from './bits';
import { type MeetView } from './MeetHome';
import { MeetSettingsDialog } from './MeetSettingsDialog';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { MeetingLink } from './openMeeting';
import { RoomActions } from './RoomActions';

/** Design 7.1 sidebar: lists, open rooms with live dots, persistent rooms. */
export function MeetSidebar({ home, view }: { home: MeetHome | undefined; view: MeetView }) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState(false);
  return (
    <ModuleSidebar label={t('shell.modules.meet')} className="gap-px overflow-hidden px-2.5 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
          <Icon name="video" size={18} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-bold">{t('shell.modules.meet')}</span>
          <span className="truncate text-xs text-fg3">
            {home
              ? t('meet.sidebar.summary', { active: home.live.length, total: home.rooms.length })
              : ''}
          </span>
        </span>
      </div>
      <Nav icon="video" label={t('meet.home.title')} active={view === 'home'} view={undefined} />
      <Nav
        icon="calendar"
        label={t('meet.nav.upcoming')}
        active={view === 'upcoming'}
        view="scheduled"
        count={home?.upcomingCount}
      />
      <Nav
        icon="record"
        label={t('meet.nav.recordings')}
        active={view === 'recordings'}
        view="recordings"
        count={home?.recordingCount}
      />
      <Nav icon="clock" label={t('meet.nav.history')} active={view === 'history'} view="history" />
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {home?.live.length ? (
          <>
            <span className="eyebrow mb-1 px-2.5">{t('meet.sidebar.live')}</span>
            {home.live.map((m) => (
              <RoomLink
                key={m.id}
                slug={m.slug}
                title={m.title}
                aside={String(m.live?.participantCount ?? '')}
                live
              />
            ))}
          </>
        ) : null}
        <span className="eyebrow mt-3 mb-1 px-2.5">{t('meet.home.rooms')}</span>
        {home?.rooms.length ? (
          home.rooms.map((m) => (
            <RoomActions key={m.id} m={m}>
              {(menu) => (
                <RoomRowLink
                  m={m}
                  menu={menu}
                  aside={m.startsAt ? formatTime(m.startsAt, locale) : ''}
                />
              )}
            </RoomActions>
          ))
        ) : (
          <span className="px-2.5 text-xs text-fg3">{t('meet.home.noRooms')}</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setSettings(true)}
        className="mt-2 flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="settings" size={16} />
        {t('meet.sidebar.settings')}
      </button>
      {settings ? <MeetSettingsDialog onOpenChange={setSettings} /> : null}
    </ModuleSidebar>
  );
}

function Nav({
  icon,
  label,
  active,
  view,
  count,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  view: 'scheduled' | 'recordings' | 'history' | undefined;
  count?: number;
}) {
  return (
    <Link
      to="/meetings"
      search={view ? { view } : {}}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
        active && 'bg-capsule font-semibold text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      {label}
      {count ? <Count className="ml-auto">{count}</Count> : null}
    </Link>
  );
}

/** A persistent room in the sidebar: right-click or "…" (always shown on touch) for its menu. */
function RoomRowLink({ m, menu, aside, ...rest }: { m: Meeting; menu: ReactNode; aside: string }) {
  return (
    // One row, the whole sidebar wide: the hover and open backgrounds cover the name and the
    // "…" alike; the name ends with an ellipsis before the button.
    <div
      {...rest}
      className="group flex w-full min-w-0 items-center rounded-sm text-fg2 hover:bg-bg2 hover:text-fg has-[[data-state=open]]:bg-bg2"
    >
      <RoomLink
        slug={m.slug}
        title={m.title}
        live={Boolean(m.live)}
        aside={aside}
        className="min-w-0 flex-1 group-hover:text-fg hover:bg-transparent"
      />
      <span className="flex shrink-0 pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[[data-state=open]]:opacity-100 [@media(pointer:coarse)]:opacity-100">
        {menu}
      </span>
    </div>
  );
}

function RoomLink({
  slug,
  title,
  aside,
  live,
  className,
}: {
  slug: string;
  title: string;
  aside: string;
  live?: boolean;
  className?: string;
}) {
  return (
    <MeetingLink
      slug={slug}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
        className,
      )}
    >
      {live ? <LiveDot /> : <span className="size-2 rounded-full bg-line2" />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="text-xs text-fg3">{aside}</span>
    </MeetingLink>
  );
}
