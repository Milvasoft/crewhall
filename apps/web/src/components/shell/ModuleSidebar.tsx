import { cn, Drawer, DrawerContent, Icon, IconButton, Tooltip } from '@crewhall/ui';
import { Link, useCanGoBack, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useExit } from '@/lib/motion';
import {
  registerSidebar,
  setDrawerOpen,
  setTabletPinned,
  useDrawerOpen,
  useHasSidebar,
  useShellLayout,
  useTabletPinned,
} from '@/lib/shell';
import {
  clampWidth,
  COLLAPSE_BELOW,
  resetSidebar,
  setSidebarCollapsed,
  setSidebarWidth,
  SIDEBAR_STEP,
  sidebarMax,
  sidebarModuleOf,
  useSidebarSize,
} from '@/lib/shell/sidebarSize';

/**
 * Every module's left sidebar (Drive, pages, chat list, vault, admin…) renders through this, so
 * the narrow-screen behaviour lives in one place (H10): pinned on desktop, collapsible on tablets,
 * a drawer from the left on phones. `phone="full"` shows it as the whole screen instead (the chat
 * list on /chat).
 */
export function ModuleSidebar({
  label,
  className,
  children,
  phone = 'drawer',
  collapsible = true,
  defaultWidth = 248,
}: {
  label: string;
  className?: string;
  children: ReactNode;
  phone?: 'drawer' | 'full';
  /** Tablets may hide it (top-bar button); false keeps it (chat has no top bar for the button). */
  collapsible?: boolean;
  /** Width before the person drags the edge (and after a double-click on it). */
  defaultWidth?: number;
}) {
  const layout = useShellLayout();
  const pinned = useTabletPinned();
  const drawerOpen = useDrawerOpen();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Tablet: the pinned sidebar slides in and out, but only when the top-bar button toggles it,
  // not each time a module page mounts its own sidebar.
  const tabletToggle = layout === 'tablet' && collapsible;
  const pin = useExit(tabletToggle && pinned, 180);
  const [pinnedAtMount] = useState(pinned);
  const [toggled, setToggled] = useState(false);
  if (!toggled && pinned !== pinnedAtMount) setToggled(true);

  // Only a sidebar the top-bar button can act on shows that button.
  useEffect(
    () => (collapsible || layout === 'phone' ? registerSidebar() : undefined),
    [collapsible, layout],
  );
  // A link in the drawer navigates: close it.
  useEffect(() => setDrawerOpen(false), [path]);

  const moduleId = sidebarModuleOf(path);
  const size = useSidebarSize(moduleId);
  const frameRef = useRef<HTMLDivElement>(null);
  const width = size.width ?? defaultWidth;

  const base = 'flex w-[248px] shrink-0 flex-col border-r border-line bg-bg';
  // Desktop and a pinned tablet sidebar: width from the dragged edge, collapsed to 0 when
  // dragged under the minimum. The edge sits on a frame around the sidebar, so a sidebar that
  // scrolls itself neither clips nor scrolls the handle.
  const sized = (extra?: string, state?: string) => (
    <div
      ref={frameRef}
      data-state={state}
      data-sidebar-frame=""
      style={{ width: size.collapsed ? 0 : width }}
      className={cn('relative flex min-h-0 shrink-0', extra)}
    >
      <aside
        aria-label={label}
        inert={size.collapsed}
        className={cn(base, className, 'w-full', size.collapsed && 'invisible border-r-0')}
      >
        {children}
      </aside>
      <ResizeHandle
        moduleId={moduleId}
        width={width}
        collapsed={size.collapsed}
        frameRef={frameRef}
      />
    </div>
  );

  if (layout === 'phone' && phone === 'full') {
    return (
      <aside aria-label={label} className={cn(base, className, 'w-full border-r-0')}>
        {children}
      </aside>
    );
  }
  if (layout === 'desktop' || (layout === 'tablet' && !collapsible)) return sized();
  if (tabletToggle && pin.mounted) return sized(toggled ? 'sidebar-pin' : undefined, pin.state);
  return (
    <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
      <DrawerContent title={label}>
        <aside
          aria-label={label}
          className={cn(base, className, 'min-h-0 w-full flex-1 border-r-0')}
        >
          {children}
        </aside>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Top-bar button for the module sidebar: opens the drawer on phones, pins or hides the sidebar on
 * tablets, nothing on desktop or when the page has no sidebar.
 */
export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const layout = useShellLayout();
  const pinned = useTabletPinned();
  const has = useHasSidebar();
  const path = useRouterState({ select: (st) => st.location.pathname });
  const moduleId = sidebarModuleOf(path);
  const { collapsed } = useSidebarSize(moduleId);
  if (layout === 'desktop') {
    // Desktop: only a collapsed sidebar needs the button (its edge is thin to find).
    if (!collapsed) return null;
    return (
      <Tooltip content={t('shell.showSidebar')}>
        <IconButton
          size="sm"
          tone="plain"
          shape="sq"
          aria-label={t('shell.showSidebar')}
          className={cn('-ml-1 shrink-0', className)}
          onClick={() => setSidebarCollapsed(moduleId, false)}
        >
          <Icon name="sidebar" size={18} />
        </IconButton>
      </Tooltip>
    );
  }
  if (!has) return null;
  const label =
    layout === 'phone'
      ? t('shell.openMenu')
      : pinned
        ? t('shell.hideSidebar')
        : t('shell.showSidebar');
  return (
    <Tooltip content={label}>
      <IconButton
        size="sm"
        tone="plain"
        shape="sq"
        aria-label={label}
        aria-expanded={layout === 'tablet' ? pinned : undefined}
        className={cn('-ml-1 shrink-0', className)}
        onClick={() => {
          if (layout === 'phone') setDrawerOpen(true);
          else setTabletPinned(!pinned);
        }}
      >
        <Icon name={layout === 'phone' ? 'menu' : 'sidebar'} size={18} />
      </IconButton>
    </Tooltip>
  );
}

/** Phone only: back to a list screen (chat list from a chat, search or new chat). */
export function PhoneBack({ to }: { to: string }) {
  const { t } = useI18n();
  const layout = useShellLayout();
  if (layout !== 'phone') return null;
  return (
    <IconButton
      size="sm"
      tone="plain"
      shape="sq"
      aria-label={t('shell.back')}
      className="-ml-1 shrink-0"
      asChild
    >
      <Link to={to}>
        <Icon name="arrowL" size={18} />
      </Link>
    </IconButton>
  );
}

/**
 * Phone top bars: back to the previous screen of the app (H10). Hidden when the app was opened
 * on this page (nothing to go back to; home stays one tap away in the tab bar).
 */
export function HistoryBack() {
  const { t } = useI18n();
  const layout = useShellLayout();
  const canGoBack = useCanGoBack();
  const router = useRouter();
  const home = useRouterState({ select: (s) => s.location.pathname === '/' });
  // Home is the root: "back" from it would only lead to the sign-in screens.
  if (layout !== 'phone' || !canGoBack || home) return null;
  return (
    <IconButton
      size="sm"
      tone="plain"
      shape="sq"
      aria-label={t('shell.back')}
      className="-ml-1 shrink-0"
      onClick={() => router.history.back()}
    >
      <Icon name="arrowL" size={18} />
    </IconButton>
  );
}

/**
 * The sidebar's right edge: drag (mouse, pen or touch) to resize, under the minimum to collapse;
 * double-click for the default width; keyboard: ←/→ 16 px, Enter collapses or opens. During a
 * drag the width is written straight to the element (no re-render per move); the store and its
 * save follow on release.
 */
function ResizeHandle({
  moduleId,
  width,
  collapsed,
  frameRef,
}: {
  moduleId: string;
  width: number;
  collapsed: boolean;
  frameRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const drag = useRef<{ x: number; from: number; raw: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const max = sidebarMax();

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
    if (!d || !commit) {
      if (frameRef.current) frameRef.current.style.width = `${collapsed ? 0 : width}px`;
      return;
    }
    if (d.raw < COLLAPSE_BELOW) setSidebarCollapsed(moduleId, true);
    else setSidebarWidth(moduleId, d.raw);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('shell.resizeSidebar')}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={collapsed ? 0 : width}
      aria-valuetext={collapsed ? t('shell.sidebarCollapsed') : `${width} px`}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const from = collapsed ? 0 : width;
        drag.current = { x: e.clientX, from, raw: from };
        setDragging(true);
        document.documentElement.style.cursor = 'col-resize';
        document.documentElement.style.userSelect = 'none';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.raw = d.from + (e.clientX - d.x);
        // Live: the real width while above the collapse point, 0 below it (what a drop does).
        const live = d.raw < COLLAPSE_BELOW ? 0 : clampWidth(d.raw, max);
        if (frameRef.current) frameRef.current.style.width = `${live}px`;
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => drag.current && end(true)}
      onDoubleClick={() => resetSidebar(moduleId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setSidebarCollapsed(moduleId, !collapsed);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const by = e.key === 'ArrowRight' ? SIDEBAR_STEP : -SIDEBAR_STEP;
          if (collapsed) {
            if (by > 0) setSidebarCollapsed(moduleId, false);
          } else {
            setSidebarWidth(moduleId, clampWidth(width + by, max));
          }
        }
      }}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors duration-[var(--t-fast)] group-hover:bg-line2 group-focus-visible:bg-fg3 group-data-[dragging]:bg-accent"
      />
    </div>
  );
}
