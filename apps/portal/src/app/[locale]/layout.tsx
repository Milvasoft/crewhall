import 'infima/dist/css/default/default.css';
import '@/styles/docusaurus-theme.css';
import '@/styles/custom.css';
import '@/styles/color-mode-toggle.css';
import '@/styles/portal.css';
import type { Viewport } from 'next';
import { draftMode } from 'next/headers';
import type { ReactNode } from 'react';
import { PreviewBar } from '@/components/layout/PreviewBar';
import { THEME_SCRIPT } from '@/components/layout/theme-script';
import { hub } from '@/lib/hub-server';
import { prismTheme, prismThemeCss } from '@/render/prism';

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Every page renders on its first request and stays cached until the Hub revalidates it.
export async function generateStaticParams() {
  return [];
}

async function prismCss(): Promise<string> {
  try {
    const site = await (await hub()).site();
    return prismThemeCss(
      prismTheme(site.settings.prism.light, 'github'),
      prismTheme(site.settings.prism.dark, 'dracula'),
    );
  } catch {
    return prismThemeCss(prismTheme('github', 'github'), prismTheme('dracula', 'dracula'));
  }
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const preview = (await draftMode()).isEnabled;
  return (
    <html lang={locale} dir="ltr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <style dangerouslySetInnerHTML={{ __html: await prismCss() }} />
      </head>
      <body className="navigation-with-keyboard">
        <svg style={{ display: 'none' }} aria-hidden="true">
          <defs>
            <symbol id="theme-svg-external-link" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M21 13v10h-21v-19h12v2h-10v15h17v-8h2zm3-12h-10.988l4.035 4-6.977 7.07 2.828 2.828 6.977-7.07 4.125 4.172v-11z"
              />
            </symbol>
          </defs>
        </svg>
        <div id="__docusaurus">{children}</div>
        {preview && <PreviewBar locale={locale} />}
      </body>
    </html>
  );
}
