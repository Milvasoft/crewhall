import { TooltipProvider } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';
import { ThemeProvider } from '@/lib/theme/ThemeContext';
import { createAppRouter } from '@/router';

/** Renders the whole app (router, providers) at `path`, like a page load. */
export function renderApp(path: string, locale: 'tr' | 'en' = 'tr') {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient);
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: [path] }) });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale={locale}>
        <ThemeProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
