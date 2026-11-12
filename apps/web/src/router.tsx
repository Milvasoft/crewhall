import { type QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { NotFoundPage } from '@/components/common/NotFoundPage';
import { PendingPage } from '@/components/common/PendingPage';
import { routeTree } from '@/routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFoundPage,
    defaultPendingComponent: PendingPage,
    // Keep the current screen up while the next one loads (app-like); a spinner only after
    // a real wait. Hover preloading usually has the code and data ready before the click.
    defaultPendingMs: 800,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
