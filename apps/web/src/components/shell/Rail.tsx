import {
  Avatar,
  cn,
  Count,
  CrewhallMark,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  type IconName,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { announcementCountsQuery } from '@/lib/announcements/queries';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { presenceDot } from '@/components/chat/common';
import { openStatusDialog } from '@/components/chat/dialogs';
import { unreadConversations } from '@/lib/chat/cache';
import { useChatEnabled } from '@/lib/chat/enabled';
import { conversationsQuery } from '@/lib/chat/queries';
import { usePresence } from '@/lib/chat/stores';
import { useBadgeMotion } from '@/lib/motion';
import { middleClickOpens, newTabLabel, openInNewTab } from '@/lib/newTab';
import { useNow } from '@/lib/useNow';
import { useI18n } from '@/lib/i18n/I18nContext';
import { enabledModules, RAIL_MODULE_KEY } from '@/lib/identity/modules';
import { signOutWithSso } from '@/lib/identity/signOut';
import { MODULES } from '@/lib/modules';
import { usePermissions } from '@/lib/session';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useBootstrap } from '@/lib/useBranding';
import { applyNavOrder, fitRail, uiPrefsQuery } from '@/lib/shell/navOrder';
import { setKeyboardHelpOpen } from '@/lib/shell/shortcuts';
import { useRailPrefs } from '@/lib/shell/useRailPrefs';
import { localize } from '@crewhall/plugin-sdk';
import { pluginIcon, usePluginSurfaces } from '@/components/plugins/surfaces';
import { RailIcon } from './RailIcon';

export interface RailEntry {
  /** Module id ("chat", "announcements"...): the key of the person's menu order. */
  id: string;
  to: string;
  icon: IconName;
  /** A plugin's own picture; shown instead of `icon`. */
  iconUrl?: string | null;
  label: string;
  active: boolean;
  badge?: number;
}

/** Addresses outside a module's own path that still belong to it (`/b/<id>` is a board). */
const SECTION_OF: Record<string, string> = {
  '/b': '/boards',
  '/d': '/drawings',
  '/p': '/pages',
  '/office': '/drive',
  '/people': '/contacts',
  '/bookings': '/calendar',
};

/**
 * What the rail (and the phone tab bar) shows: home, the enabled modules, then portal and admin
 * when allowed.
 */
export function useRailEntries({ includeHidden = false }: { includeHidden?: boolean } = {}): {
  modules: RailEntry[];
  extra: RailEntry[];
} {
  const { t, locale } = useI18n();
  const { me, canOrg, role } = usePermissions();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // A board, drawing, page, office document or person opens on a short address of its own; the
  // rail still marks the module it belongs to.
  const segment = `/${path.split('/')[1] ?? ''}`;
  const first = SECTION_OF[segment] ?? segment;
  const isAdmin = canOrg('org.manage_members') || canOrg('org.update_branding');
  const enabled = enabledModules(me);
  // Chat badge: chats with unread messages (muted ones only count mentions).
  const chatOn = useChatEnabled();
  const { data: chats } = useQuery({ ...conversationsQuery, enabled: Boolean(me) && chatOn });
  const now = useNow(60_000);
  const unreadChats = unreadConversations(chats, now);
  const { data: prefs } = useQuery({ ...uiPrefsQuery, enabled: Boolean(me) });
  const pluginSurfaces = usePluginSurfaces();
  const ordered: RailEntry[] = [
    ...MODULES.filter((m) => {
      const key = RAIL_MODULE_KEY[m.id];
      return key === null || enabled.has(key);
    }).map((m) => ({
      id: m.id,
      to: m.path,
      icon: m.icon,
      label: t(`shell.modules.${m.id}`),
      active: first === m.path,
      badge: m.id === 'chat' ? unreadChats : undefined,
    })),
  ];
  // Plugin tabs placed in the rail, or pinned there by this person (docs/contracts/eklentiler.md);
  // guests get none.
  for (const s of pluginSurfaces) {
    for (const tab of s.tabs.filter(
      (x) => x.placement === 'rail' || s.pinnedTabs?.includes(x.id),
    )) {
      const to = `/plugins/${s.installationId}/${tab.id}`;
      ordered.push({
        id: `plugin:${s.pluginId}:${tab.id}`,
        to,
        icon: pluginIcon(tab.icon),
        iconUrl: s.icon,
        label: localize(tab.title, locale),
        active: path.startsWith(to),
      });
    }
  }
  // Announcements (roadmap 19): everyone but guests; the badge counts unread ones.
  const announcementsOn = Boolean(me) && role !== 'guest';
  const { data: announcementCounts } = useQuery({
    ...announcementCountsQuery,
    enabled: announcementsOn,
  });
  if (announcementsOn) {
    ordered.push({
      id: 'announcements',
      to: '/announcements',
      icon: 'flag',
      label: t('announcements.title'),
      active: first === '/announcements',
      badge: announcementCounts?.unread || undefined,
    });
  }
  // Home stays first; the rest follow the person's order (Hesabım › Görünüm › Menü sırası).
  const modules: RailEntry[] = [
    { id: 'home', to: '/', icon: 'home', label: t('shell.modules.home'), active: first === '/' },
    ...applyNavOrder(ordered, prefs?.railOrder ?? prefs?.navOrder ?? []),
  ];
  const extra: RailEntry[] = [];
  if (canOrg('portal.edit') && enabled.has('portal')) {
    extra.push({
      id: 'portal',
      to: '/portal',
      icon: 'portal',
      label: t('shell.modules.portal'),
      active: first === '/portal',
    });
  }
  if (isAdmin) {
    extra.push({
      id: 'admin',
      to: '/admin',
      icon: 'admin',
      label: t('shell.modules.admin'),
      active: first === '/admin',
    });
  }
  if (includeHidden || !prefs?.railHidden?.length) return { modules, extra };
  // Home stays: it is the one entry the rail cannot do without.
  const hidden = new Set(prefs.railHidden);
  const shows = (e: RailEntry) => e.id === 'home' || !hidden.has(e.id);
  return { modules: modules.filter(shows), extra: extra.filter(shows) };
}

/** The element's height, kept up to date; 0 until measured (and in tests, where nothing lays out). */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

/** 64px app rail: org mark, global modules, portal/admin when allowed, avatar (doc 16 §8.1). */
export function Rail() {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const { me } = usePermissions();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const first = `/${path.split('/')[1] ?? ''}`;
  const all = useRailEntries();
  const navRef = useRef<HTMLElement>(null);
  const height = useHeight(navRef);
  // A laptop screen does not fit them all: the rest go under "Diğer".
  const { modules, extra, more } = fitRail(all.modules, all.extra, height);
  const indicator = useRailIndicator(
    navRef,
    `${first}|${modules.map((m) => m.id).join()}|${extra.length}`,
  );

  return (
    <nav
      ref={navRef}
      // macOS desktop app: the traffic lights sit above the rail (lib/desktop-titlebar).
      data-titlebar-rail=""
      aria-label={t('shell.rail')}
      className="relative flex w-16 shrink-0 flex-col items-center gap-1 border-r border-line bg-bg pt-3.5 pb-3"
    >
      {indicator ? (
        // One accent bar for the whole rail: it slides from the old item to the new one.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-[3px]"
          style={{
            height: indicator.height,
            transform: `translateY(${indicator.top}px)`,
            transition: indicator.slide
              ? 'transform var(--t-panel) var(--ease-out-std), height var(--t-panel) var(--ease-out-std)'
              : 'none',
          }}
        >
          <span
            key={indicator.appearKey}
            className="block size-full origin-left animate-[ch-indicator-in_var(--t-panel)_var(--ease-out-std)_both] rounded-r-[3px] bg-accent"
          />
        </span>
      ) : null}
      <Link
        to="/"
        aria-label={branding.orgName}
        className="mb-2.5 flex size-[34px] items-center justify-center rounded-md"
      >
        {branding.markUrl ? (
          <img src={branding.markUrl} alt="" className="size-[34px] rounded-md object-contain" />
        ) : (
          <CrewhallMark size={30} />
        )}
      </Link>
      {modules.map((m) => (
        <RailItem key={m.to} {...m} />
      ))}
      {more.length ? <RailMore entries={more} /> : null}
      {extra.length ? <span className="mx-0 my-1.5 h-px w-7 shrink-0 bg-line" /> : null}
      {extra.map((m) => (
        <RailItem key={m.to} {...m} />
      ))}
      <div className="mt-auto">{me ? <AvatarMenu active={first === '/account'} /> : null}</div>
    </nav>
  );
}

/**
 * Where the active item's accent bar sits. It slides when the active item changes; it pops in
 * (scale) when there was none before (an account page, the first render).
 */
function useRailIndicator(
  navRef: RefObject<HTMLElement | null>,
  dep: string,
): { top: number; height: number; slide: boolean; appearKey: number } | null {
  const [state, setState] = useState<{
    top: number;
    height: number;
    slide: boolean;
    appearKey: number;
  } | null>(null);
  const appear = useRef(0);
  useLayoutEffect(() => {
    const item = navRef.current?.querySelector<HTMLElement>(
      '[data-rail-item][aria-current="page"]',
    );
    if (!item) {
      setState(null);
      return;
    }
    const top = item.offsetTop + 12;
    const height = item.offsetHeight - 24;
    setState((prev) => {
      if (prev && prev.top === top && prev.height === height) return prev;
      if (!prev) appear.current++;
      return { top, height, slide: prev !== null, appearKey: appear.current };
    });
  }, [navRef, dep]);
  return state;
}

function useHideRailEntry() {
  const { data: prefs } = useQuery(uiPrefsQuery);
  const save = useRailPrefs();
  return (id: string) =>
    save.mutate({ railHidden: [...new Set([...(prefs?.railHidden ?? []), id])] });
}

/** "Diğer": the entries a short screen has no room for, and their unread counts. */
function RailMore({ entries }: { entries: RailEntry[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const badge = entries.reduce((n, e) => n + (e.badge ?? 0), 0);
  return (
    <Menu>
      <Tooltip content={t('shell.more')} side="right">
        <MenuTrigger
          aria-label={t('shell.more')}
          data-rail-more=""
          className="press relative flex size-11 shrink-0 items-center justify-center rounded-lg text-fg2 transition-colors duration-(--t-base) hover:bg-bg2 hover:text-fg"
        >
          <Icon name="dots" size={20} />
          {badge ? (
            <Count className="absolute top-[3px] right-0.5 h-4 min-w-4 px-1 text-[9.5px] leading-4 shadow-[0_0_0_2px_var(--bg)]">
              {badge > 99 ? '99+' : badge}
            </Count>
          ) : null}
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="right" align="end" className="w-56">
        {entries.map((e) => (
          <MenuItem
            key={e.id}
            icon={e.iconUrl ? undefined : e.icon}
            shortcut={e.badge ? (e.badge > 99 ? '99+' : e.badge) : undefined}
            onSelect={() => void navigate({ to: e.to })}
            // The middle button opens a new tab, as on the rail's own links.
            {...middleClickOpens(e.to)}
          >
            {e.iconUrl ? (
              <span className="flex items-center gap-2.5">
                <RailIcon entry={e} size={16} className="shrink-0 text-fg2" />
                <span className="truncate">{e.label}</span>
              </span>
            ) : (
              e.label
            )}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function RailItem({
  id,
  to,
  icon,
  iconUrl,
  label,
  active,
  badge,
}: {
  id: string;
  to: string;
  icon: IconName;
  iconUrl?: string | null;
  label: string;
  active: boolean;
  badge?: number;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pulse = useBadgeMotion(badge ?? 0);
  const hide = useHideRailEntry();
  // Right click: open here or in a new tab, hide it, and the place to change the rail.
  const entries: ActionEntry[] = [
    {
      kind: 'item',
      key: 'open',
      icon: 'arrowUR',
      label: t('shell.railMenu.open'),
      onSelect: () => void navigate({ to }),
    },
    {
      kind: 'item',
      key: 'tab',
      icon: 'ext',
      label: t(newTabLabel()),
      onSelect: () => openInNewTab(to),
    },
    { kind: 'sep', key: 'sep' },
    ...(id === 'home'
      ? []
      : ([
          {
            kind: 'item',
            key: 'hide',
            icon: 'eyeOff',
            label: t('shell.railMenu.hide'),
            onSelect: () => hide(id),
          },
        ] as ActionEntry[])),
    {
      kind: 'item',
      key: 'order',
      icon: 'sliders',
      label: t('shell.railMenu.order'),
      onSelect: () => void navigate({ to: '/account/appearance' }),
    },
  ];
  return (
    <ActionContextMenu
      entries={entries}
      wrapTrigger={(trigger) => (
        <Tooltip content={label} side="right">
          {trigger}
        </Tooltip>
      )}
    >
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        data-rail-item=""
        className={cn(
          'press relative flex size-11 shrink-0 items-center justify-center rounded-lg text-fg2 transition-colors duration-(--t-base) hover:bg-bg2 hover:text-fg',
          active && 'bg-capsule text-fg hover:bg-capsule',
        )}
      >
        <RailIcon entry={{ icon, iconUrl }} size={iconUrl ? 24 : 20} />
        {badge ? (
          <Count
            key={pulse.key}
            className={cn(
              'absolute top-[3px] right-0.5 h-4 min-w-4 px-1 text-[9.5px] leading-4 shadow-[0_0_0_2px_var(--bg)]',
              pulse.className,
            )}
          >
            {badge > 99 ? '99+' : badge}
          </Count>
        ) : null}
      </Link>
    </ActionContextMenu>
  );
}

function AvatarMenu({ active }: { active: boolean }) {
  const { t } = useI18n();
  const { me } = usePermissions();
  const { scheme, setAppearance } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const presence = usePresence(me?.user.id);
  if (!me) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={t('shell.account')}
        className={cn(
          'rounded-full',
          active && 'shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--accent)]',
        )}
      >
        <Avatar
          name={me.user.name}
          src={me.user.imageUrl}
          size="md"
          presence={presenceDot(presence) ?? 'online'}
        />
      </MenuTrigger>
      <MenuContent side="right" align="end" className="w-60">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <Avatar name={me.user.name} src={me.user.imageUrl} size="md" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{me.user.name}</span>
            <span className="truncate text-xs text-fg2">{me.user.email}</span>
          </div>
        </div>
        {presence?.message ? (
          <div className="px-2.5 pb-1.5 text-xs text-fg2">
            {presence.message.emoji ? `${presence.message.emoji} ` : ''}
            {presence.message.text}
          </div>
        ) : null}
        <MenuSeparator />
        <MenuItem icon="smile" shortcut="Alt S" onSelect={() => openStatusDialog(true)}>
          {t('chat.status.title')}
        </MenuItem>
        <MenuItem icon="user" onSelect={() => void navigate({ to: '/account/profile' })}>
          {t('account.nav.profile')}
        </MenuItem>
        <MenuItem icon="shield" onSelect={() => void navigate({ to: '/account/security' })}>
          {t('account.nav.security')}
        </MenuItem>
        <MenuItem icon="key" shortcut="?" onSelect={() => setKeyboardHelpOpen(true)}>
          {t('shell.keys.title')}
        </MenuItem>
        <MenuItem
          icon={scheme === 'dark' ? 'sun' : 'moon'}
          onSelect={() => setAppearance(scheme === 'dark' ? 'light' : 'dark')}
        >
          {t(scheme === 'dark' ? 'shell.lightMode' : 'shell.darkMode')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="logout"
          onSelect={async () => {
            if (!(await signOutWithSso(qc))) await navigate({ to: '/login' });
          }}
        >
          {t('shell.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
