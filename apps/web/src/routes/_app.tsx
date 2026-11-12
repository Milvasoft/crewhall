import { cn } from '@crewhall/ui';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ChatRuntime } from '@/components/chat/ChatRuntime';
import { ViewerHost } from '@/components/viewer/ViewerHost';
import { IncomingCall } from '@/components/meet/IncomingCall';
import { MeetingElsewhereBar, MeetingWindowBar } from '@/components/meet/openMeeting';
import { isMeetingWindow } from '@/lib/meet/window';
import { AskPanel } from '@/components/ai/AskPanel';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { KeyboardShortcuts } from '@/components/shell/KeyboardShortcuts';
import { InShellNotFound } from '@/components/common/NotFoundPage';
import { ModuleGate } from '@/components/identity/ModuleDisabled';
import { MobileTabBar } from '@/components/shell/MobileTabBar';
import { Rail } from '@/components/shell/Rail';
import { SessionExpiredDialog } from '@/components/shell/SessionExpiredDialog';
import { DemoBanner } from '@/components/identity/Demo';
import { NewSpaceDialog } from '@/components/spaces/NewSpaceDialog';
import { DriveDialogs } from '@/features/drive/DriveDialogs';
import { UploadPanel } from '@/features/drive/UploadPanel';
import { isApiError } from '@/lib/api';
import { bootstrapQuery, meQuery, spacesQuery } from '@/lib/queries';
import { setSignedIn } from '@/lib/queryClient';
import { useTrackRecentRoute } from '@/lib/routes/recent';
import { useSidebarSizeSync } from '@/lib/shell/sidebarSize';
import { useShellLayout } from '@/lib/shell';

/**
 * Signed-in area. Guards, in order: first-run setup, session, then the 2FA policy
 * (the API answers two_factor_required on everything except /me).
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const boot = await queryClient.ensureQueryData(bootstrapQuery).catch(() => null);
    if (boot?.needsSetup) throw redirect({ to: '/setup' });
    let me;
    try {
      me = await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
    if (me.twoFactorRequired) {
      throw redirect({ to: '/security/2fa-setup', search: { from: 'policy' } });
    }
    try {
      await queryClient.ensureQueryData(spacesQuery());
    } catch (e) {
      if (isApiError(e, 'two_factor_required')) {
        throw redirect({ to: '/security/2fa-setup', search: { from: 'policy' } });
      }
      throw e;
    }
  },
  component: AppLayout,
  // notFoundComponent replaces the layout, so it brings the frame (rail) along.
  notFoundComponent: () => (
    <AppFrame>
      <InShellNotFound />
    </AppFrame>
  ),
});

function AppLayout() {
  useTrackRecentRoute();
  useSidebarSizeSync();
  return (
    <AppFrame>
      <div className="flex min-h-0 min-w-0 flex-1">
        <ModuleGate>
          <Outlet />
        </ModuleGate>
      </div>
    </AppFrame>
  );
}

function AppFrame({ children }: { children: ReactNode }) {
  useEffect(() => {
    setSignedIn(true);
    return () => setSignedIn(false);
  }, []);
  const phone = useShellLayout() === 'phone';
  // A meeting's own tab: only the meeting, no rail, menus or incoming-call ring (lib/meet/window).
  if (isMeetingWindow()) {
    return (
      <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-bg text-fg">
        <MeetingWindowBar />
        {children}
        <SessionExpiredDialog />
        <ChatRuntime />
      </div>
    );
  }
  // Phone (H10): content on top, tab bar below instead of the rail.
  return (
    <div
      className={cn(
        'flex h-[calc(100dvh-var(--kb,0px)-var(--desktop-strip,0px))] min-h-0 w-full overflow-hidden bg-bg pt-[env(safe-area-inset-top)] text-fg',
        phone && 'flex-col',
      )}
    >
      {phone ? null : <Rail />}
      {phone ? (
        <>
          <MeetingElsewhereBar />
          {children}
        </>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MeetingElsewhereBar />
          {children}
        </div>
      )}
      {phone ? <MobileTabBar /> : null}
      <CommandPalette />
      <KeyboardShortcuts />
      <AskPanel />
      <NewSpaceDialog />
      <SessionExpiredDialog />
      <DemoBanner />
      <UploadPanel />
      <DriveDialogs />
      <ChatRuntime />
      <ViewerHost />
      <IncomingCall />
    </div>
  );
}
