import { toCurrentPath } from '@crewhall/shared';
import { createRootRouteWithContext, Outlet, redirect } from '@tanstack/react-router';
import { BrandingSync } from '@/components/common/BrandingSync';
import { ErrorPage } from '@/components/common/ErrorPage';
import { NewVersionBanner } from '@/components/common/NewVersionBanner';
import { OpenInAppBanner } from '@/components/common/OpenInAppBanner';
import { DesktopTitleBarSync } from '@/lib/desktop-titlebar';
import { type RouterContext } from '@/router';

export const Route = createRootRouteWithContext<RouterContext>()({
  // An old Turkish address (bookmark, notification, e-mail) goes to today's: path, query keys and
  // enum values (packages/shared paths.ts); the hash is kept. Replace, so Back skips it.
  beforeLoad: ({ location }) => {
    const href = `${location.pathname}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`;
    const current = toCurrentPath(href);
    if (current !== href) throw redirect({ href: current, replace: true });
  },
  component: Root,
  errorComponent: ErrorPage,
});

function Root() {
  return (
    <>
      <BrandingSync />
      <DesktopTitleBarSync />
      <NewVersionBanner />
      <Outlet />
      <OpenInAppBanner />
    </>
  );
}
