import { paths, withQuery } from '@crewhall/shared';
import { Button, Icon, Menu, MenuContent, MenuItem, MenuTrigger, toast } from '@crewhall/ui';
import { Link, useNavigate, type LinkProps } from '@tanstack/react-router';
import { useCallback, useRef, type MouseEvent, type ReactNode } from 'react';
import { useDesktopTitleBar, useTitleBarProps } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMeetingsOnOtherDevices } from '@/lib/meet/active';
import {
  focusMeetingWindow,
  isMeetingWindow,
  leaveMeetingWindow,
  openMeetingWindow,
  prefersSameTab,
  useMeetingElsewhere,
} from '@/lib/meet/window';

/**
 * Opens a meeting room in its own tab (lib/meet/window.ts): join buttons, answering a call,
 * the calendar and chat commands all go through here. Inside a meeting tab, or when the
 * browser blocks new windows, the room opens in this tab (the latter with a hint).
 */
export function useOpenMeeting() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return useCallback(
    (slug: string, search: { call?: string; device?: 'transfer' | 'add' } = {}) => {
      const here = () => void navigate({ to: '/meetings/room/$slug', params: { slug }, search });
      if (isMeetingWindow() || prefersSameTab()) return here();
      const result = openMeetingWindow(slug, withQuery(paths.meetingRoom(slug), search));
      if (result === 'blocked') {
        toast(t('meet.window.blocked'));
        here();
      }
    },
    [navigate, t],
  );
}

/**
 * A link to a meeting room that opens its tab (middle-click and copy keep the plain link).
 */
export function MeetingLink({
  slug,
  children,
  ...props
}: { slug: string; children: ReactNode } & Omit<LinkProps, 'to' | 'params' | 'children'> & {
    className?: string;
  }) {
  const open = useOpenMeeting();
  return (
    <Link
      to="/meetings/room/$slug"
      params={{ slug }}
      {...props}
      onClick={(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (prefersSameTab() || isMeetingWindow()) return;
        e.preventDefault();
        open(slug);
      }}
    >
      {children}
    </Link>
  );
}

/** Main tab: "Toplantıdasın · Sekmeye geç" while a meeting runs in another tab. */
export function MeetingElsewhereBar() {
  const meeting = useMeetingElsewhere();
  if (isMeetingWindow()) return null;
  if (!meeting) return <ActiveMeetingBar />;
  return <MeetingElsewhereStrip title={meeting.title} slug={meeting.slug} />;
}

/**
 * "Şu an bu toplantıdasın": I am in a meeting on another device. Joining here either moves it
 * here or adds this device.
 */
export function ActiveMeetingBar() {
  const { t } = useI18n();
  const meetings = useMeetingsOnOtherDevices();
  const open = useOpenMeeting();
  const titleBar = useTitleBarProps<HTMLDivElement>();
  const meeting = meetings[0];
  if (!meeting || isMeetingWindow()) return null;
  return (
    <div
      {...titleBar}
      role="status"
      className="flex h-9 shrink-0 items-center justify-center gap-3 bg-success/15 px-4 text-sm font-semibold"
    >
      <span className="size-2 animate-pulse rounded-full bg-success" />
      <span className="truncate">{t('meet.otherDevices.here', { title: meeting.title })}</span>
      <Menu>
        <MenuTrigger asChild>
          <Button size="xs" variant="out">
            {t('meet.actions.join')}
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon="arrowL" onSelect={() => open(meeting.slug, { device: 'transfer' })}>
            {t('meet.otherDevices.transfer')}
          </MenuItem>
          <MenuItem icon="plus" onSelect={() => open(meeting.slug, { device: 'add' })}>
            {t('meet.otherDevices.add')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/**
 * The strip itself: in the desktop app it runs to the right edge, under the window buttons,
 * which take its colour (it is the window's top bar while shown).
 */
function MeetingElsewhereStrip({ title, slug }: { title: string; slug: string }) {
  const { t } = useI18n();
  const titleBar = useTitleBarProps<HTMLDivElement>();
  return (
    <div
      {...titleBar}
      role="status"
      className="flex h-9 shrink-0 items-center justify-center gap-3 bg-success/15 px-4 text-sm font-semibold"
    >
      <span className="size-2 animate-pulse rounded-full bg-success" />
      <span className="truncate">{t('meet.window.inMeeting', { title })}</span>
      <Button size="xs" variant="out" onClick={() => focusMeetingWindow(slug)}>
        <Icon name="ext" size={13} />
        {t('meet.window.switch')}
      </Button>
    </div>
  );
}

/**
 * The meeting tab's own top strip: always a way home, also after leaving when the browser keeps
 * the tab open (it was not opened by the app, so it cannot close itself).
 */
export function MeetingWindowBar() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // In the desktop app the meeting window's title bar (lib/desktop-titlebar).
  const bar = useRef<HTMLDivElement>(null);
  const titleBar = useDesktopTitleBar(bar);
  return (
    <div
      ref={bar}
      data-titlebar={titleBar ? '' : undefined}
      className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-2"
    >
      <Button
        size="sm"
        variant="gh"
        onClick={() => {
          if (leaveMeetingWindow()) void navigate({ to: '/' });
        }}
      >
        <Icon name="arrowL" size={15} />
        {t('meet.window.home')}
      </Button>
    </div>
  );
}
