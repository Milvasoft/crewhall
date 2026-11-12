import { cn, CrewhallMark, Icon, IconButton, Kbd } from '@crewhall/ui';
import { Link, useCanGoBack, useRouter, useRouterState } from '@tanstack/react-router';
import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AskButton } from '@/components/ai/AskPanel';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { useDesktopTitleBar } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { setPaletteOpen } from '@/lib/palette';
import { useShellLayout } from '@/lib/shell';
import { useBootstrap } from '@/lib/useBranding';
import { HistoryBack, SidebarToggle } from './ModuleSidebar';

export interface Crumb {
  label: ReactNode;
}

/**
 * The area right of the rail: optional 248px sidebar, then the main column with the
 * 56px top bar (crumb, Ctrl K search, tools) and the scrolling body.
 */
export function Workspace({
  sidebar,
  crumbs,
  topLeft,
  searchLabel,
  tools,
  children,
  bodyClassName,
  panel,
  scrollKey,
}: {
  sidebar?: ReactNode;
  crumbs?: Crumb[];
  /** Replaces the crumb (home tabs). */
  topLeft?: ReactNode;
  searchLabel?: string;
  tools?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  /** Right detail panel (340px). */
  panel?: ReactNode;
  /** A screen that stays mounted across items (Drive folders): the body scrolls back up when it changes. */
  scrollKey?: string;
}) {
  const body = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [scrollKey]);
  return (
    <>
      {sidebar}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar crumbs={crumbs} topLeft={topLeft} searchLabel={searchLabel} tools={tools} />
        <div className="relative flex min-h-0 flex-1">
          <main
            ref={body}
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 md:px-7 md:py-6',
              bodyClassName,
            )}
          >
            {children}
          </main>
          {panel ? (
            // Phone: the detail panel covers the body at full width instead of squeezing it.
            <div className="flex min-h-0 shrink-0 empty:hidden max-md:absolute max-md:inset-0 max-md:z-30 max-md:bg-bg max-md:*:w-full max-md:*:border-l-0">
              {panel}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function TopBar({
  crumbs,
  topLeft,
  searchLabel,
  tools,
}: {
  crumbs?: Crumb[];
  topLeft?: ReactNode;
  searchLabel?: string;
  tools?: ReactNode;
}) {
  const { t } = useI18n();
  const phone = useShellLayout() === 'phone';
  // In the desktop app this bar is the window's title bar (lib/desktop-titlebar).
  const bar = useRef<HTMLElement>(null);
  const titleBar = useDesktopTitleBar(bar);
  const strip = topLeft ? (
    <div className="flex min-w-0 shrink items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {topLeft}
    </div>
  ) : null;
  return (
    <>
      <header
        ref={bar}
        data-titlebar={titleBar ? '' : undefined}
        className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-4 md:pr-4 md:pl-6"
      >
        {titleBar && !phone ? <WindowHistory /> : <HistoryBack />}
        <SidebarToggle />
        {topLeft ? (
          // Phone: the tabs get their own row below; the org mark keeps this one from looking empty.
          phone ? (
            <OrgHome />
          ) : (
            strip
          )
        ) : (
          <nav
            aria-label={t('shell.breadcrumb')}
            className="flex min-w-0 items-center gap-1.5 text-cap font-medium whitespace-nowrap text-fg2"
          >
            {(phone ? crumbs?.slice(-1) : crumbs)?.map((c, i, shown) => (
              <Fragment key={i}>
                {i > 0 ? <Icon name="chevR" size={14} className="text-fg3" /> : null}
                {i === shown.length - 1 ? (
                  <b className="truncate font-semibold text-fg" aria-current="page">
                    {c.label}
                  </b>
                ) : (
                  <span className="truncate">{c.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        {phone ? (
          <IconButton
            size="sm"
            tone="plain"
            className="ml-auto"
            aria-label={searchLabel ?? t('shell.search')}
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="search" size={18} />
          </IconButton>
        ) : (
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            // Gives up its width before the crumb does, so a narrow window keeps the page's name.
            className="press ml-auto flex h-9 w-[300px] min-w-[72px] shrink-[4] items-center gap-2 rounded-md bg-bg2 pr-2 pl-3 text-[13.5px] leading-[18px] text-fg3 hover:bg-capsule"
          >
            <Icon name="search" size={16} className="text-fg2" />
            <span className="truncate">{searchLabel ?? t('shell.search')}</span>
            <Kbd className="ml-auto">Ctrl K</Kbd>
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Phone (W6): page tools move to the row below so the title keeps its room. */}
          {phone ? null : tools}
          <AskButton />
          <NotificationBell />
        </div>
      </header>
      {phone && (strip || tools) ? (
        <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {strip}
          {tools ? (
            <div className={cn('flex shrink-0 items-center gap-1.5', strip && 'ml-auto')}>
              {tools}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Phone top bar of a page without crumbs (home): the org mark and name, linking home. */
function OrgHome() {
  const { branding } = useBootstrap();
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2">
      {branding.markUrl ? (
        <img src={branding.markUrl} alt="" className="size-7 rounded-sm object-contain" />
      ) : (
        <CrewhallMark size={26} />
      )}
      <span className="truncate text-sm font-semibold">{branding.orgName}</span>
    </Link>
  );
}

/** Back and forward, as in a browser: the desktop app has no browser buttons (like Teams). */
function WindowHistory() {
  const { t } = useI18n();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  // The Navigation API knows the forward list; read again on every route change.
  const canGoForward = useRouterState({
    select: () =>
      (window as { navigation?: { canGoForward?: boolean } }).navigation?.canGoForward === true,
  });
  return (
    <div className="-ml-1 flex shrink-0 items-center">
      <IconButton
        size="sm"
        tone="plain"
        shape="sq"
        aria-label={t('desktop.titleBar.back')}
        disabled={!canGoBack}
        onClick={() => router.history.back()}
      >
        <Icon name="arrowL" size={18} />
      </IconButton>
      <IconButton
        size="sm"
        tone="plain"
        shape="sq"
        aria-label={t('desktop.titleBar.forward')}
        disabled={!canGoForward}
        onClick={() => router.history.forward()}
      >
        <Icon name="arrowR" size={18} />
      </IconButton>
    </div>
  );
}
