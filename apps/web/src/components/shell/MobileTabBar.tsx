import { Avatar, Button, cn, Count, Drawer, DrawerContent, Icon } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { openStatusDialog } from '@/components/chat/dialogs';
import { useI18n } from '@/lib/i18n/I18nContext';
import { signOutWithSso } from '@/lib/identity/signOut';
import { usePermissions } from '@/lib/session';
import { setMoreOpen, useMoreOpen } from '@/lib/shell';
import { useTheme } from '@/lib/theme/ThemeContext';
import { type RailEntry, useRailEntries } from './Rail';
import { RailIcon } from './RailIcon';

/** Tabs before "More": home and the first three modules. */
const TAB_COUNT = 4;

/**
 * Phone replacement for the rail (H10): bottom tabs for home and the first modules, "More" opens a
 * sheet with the rest, portal/admin and the account menu. Hidden while the soft keyboard is open;
 * respects the bottom safe area.
 */
export function MobileTabBar() {
  const { t } = useI18n();
  const { modules, extra } = useRailEntries();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const more = useMoreOpen();
  // Following a link in the sheet (or any navigation) closes it; coming back never reopens it.
  useEffect(() => setMoreOpen(false), [path]);

  const tabs = modules.slice(0, TAB_COUNT);
  const rest = [...modules.slice(TAB_COUNT), ...extra];
  const moreActive = rest.some((m) => m.active) || path.startsWith('/account');

  return (
    <nav
      aria-label={t('shell.rail')}
      className="flex shrink-0 items-stretch border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] keyboard:hidden"
    >
      {tabs.map((m) => (
        <Tab key={m.to} entry={m} />
      ))}
      <Drawer open={more} onOpenChange={setMoreOpen}>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={more}
          onClick={() => setMoreOpen(true)}
          className={cn(tabClass, moreActive && 'text-fg')}
        >
          <TabIcon entry={{ icon: 'dots' }} active={moreActive} />
          <span>{t('shell.more')}</span>
        </button>
        <DrawerContent side="bottom" title={t('shell.more')}>
          <MoreSheet entries={rest} />
        </DrawerContent>
      </Drawer>
    </nav>
  );
}

const tabClass =
  'press relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] leading-[14px] font-semibold text-fg2';

function TabIcon({
  entry,
  active,
  badge,
}: {
  entry: Pick<RailEntry, 'icon' | 'iconUrl'>;
  active: boolean;
  badge?: number;
}) {
  return (
    <span
      className={cn(
        'relative flex h-7 w-12 items-center justify-center rounded-full',
        active && 'bg-capsule',
      )}
    >
      <RailIcon entry={entry} size={entry.iconUrl ? 24 : 20} />
      {badge ? (
        <Count className="absolute -top-1 right-1 h-4 min-w-4 px-1 text-[9.5px] leading-4 shadow-[0_0_0_2px_var(--bg)]">
          {badge > 99 ? '99+' : badge}
        </Count>
      ) : null}
    </span>
  );
}

function Tab({ entry }: { entry: RailEntry }) {
  return (
    <Link
      to={entry.to}
      aria-current={entry.active ? 'page' : undefined}
      className={cn(tabClass, entry.active && 'text-fg')}
    >
      <TabIcon entry={entry} active={entry.active} badge={entry.badge} />
      <span className="max-w-full truncate px-1">{entry.label}</span>
    </Link>
  );
}

function MoreSheet({ entries }: { entries: RailEntry[] }) {
  const { t } = useI18n();
  const { me } = usePermissions();
  const { scheme, setAppearance } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const row =
    'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-medium text-fg hover:bg-bg2';
  return (
    <div className="flex flex-col gap-1">
      {entries.length ? (
        <div className="grid grid-cols-4 gap-1 pb-2">
          {entries.map((m) => (
            <Link
              key={m.to}
              to={m.to}
              aria-current={m.active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg py-2.5 text-xs font-semibold text-fg2',
                m.active && 'bg-capsule text-fg',
              )}
            >
              <RailIcon entry={m} size={22} />
              <span className="max-w-full px-0.5 text-center leading-tight break-words hyphens-auto">
                {m.label}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
      {me ? (
        <>
          <div className="flex items-center gap-3 border-t border-line px-3 pt-3 pb-1">
            <Avatar name={me.user.name} src={me.user.imageUrl} size="md" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">{me.user.name}</span>
              <span className="truncate text-xs text-fg2">{me.user.email}</span>
            </div>
          </div>
          <button type="button" className={row} onClick={() => openStatusDialog(true)}>
            <Icon name="smile" size={18} className="text-fg2" />
            {t('chat.status.title')}
          </button>
          <Link to="/account/profile" className={row}>
            <Icon name="user" size={18} className="text-fg2" />
            {t('account.nav.profile')}
          </Link>
          <Link to="/account/security" className={row}>
            <Icon name="shield" size={18} className="text-fg2" />
            {t('account.nav.security')}
          </Link>
          <button
            type="button"
            className={row}
            onClick={() => setAppearance(scheme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={scheme === 'dark' ? 'sun' : 'moon'} size={18} className="text-fg2" />
            {t(scheme === 'dark' ? 'shell.lightMode' : 'shell.darkMode')}
          </button>
          {confirmSignOut ? (
            // A stray tap must not end the session (W5): ask in place.
            <div
              role="group"
              aria-label={t('shell.signOutConfirm')}
              className="flex flex-col gap-2 rounded-lg bg-bg2 p-3"
            >
              <span className="text-sm font-semibold">{t('shell.signOutConfirm')}</span>
              <div className="flex gap-2">
                <Button
                  variant="out"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmSignOut(false)}
                >
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  variant="dng"
                  size="sm"
                  className="flex-1"
                  onClick={async () => {
                    if (!(await signOutWithSso(qc))) await navigate({ to: '/login' });
                  }}
                >
                  {t('shell.signOut')}
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" className={row} onClick={() => setConfirmSignOut(true)}>
              <Icon name="logout" size={18} className="text-fg2" />
              {t('shell.signOut')}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
