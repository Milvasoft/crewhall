import { TooltipProvider, Toaster, useVisualViewportVars } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';
import { ThemeProvider } from '@/lib/theme/ThemeContext';
import { createAppRouter } from '@/router';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createAppRouter(queryClient));
  // Soft keyboard insets for dialogs, sheets and the shell (doc 02 · "Klavye alanı örtmez").
  useVisualViewportVars();
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
