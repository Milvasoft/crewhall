import type { Metadata } from 'next';
import { locale as rootLocale } from 'next/root-params';
import { NotFoundSuggestions } from '@/components/NotFoundSuggestions';
import { Shell } from '@/components/layout/Shell';
import { strings } from '@/i18n';
import { hub } from '@/lib/hub-server';

export const metadata: Metadata = { robots: { index: false, follow: true } };

async function currentLocale(): Promise<string> {
  try {
    const value: unknown = await rootLocale();
    return typeof value === 'string' ? value : 'en';
  } catch {
    return 'en';
  }
}

/** Docusaurus "Page Not Found" with a real 404 status, plus two search suggestions. */
export default async function NotFound() {
  const locale = await currentLocale();
  const s = strings(locale);
  const site = await (await hub()).site().catch(() => null);
  const body = (
    <main className="container margin-vert--xl">
      <title>{site ? `${s.notFoundTitle} | ${site.settings.title}` : s.notFoundTitle}</title>
      <div className="row">
        <div className="col col--6 col--offset-3">
          <h1 className="hero__title">{s.notFoundTitle}</h1>
          <p>{s.notFoundText}</p>
          <p>{s.notFoundHelp}</p>
          <NotFoundSuggestions locale={locale} label={s.notFoundSuggestions} />
        </div>
      </div>
    </main>
  );
  if (!site || !site.locales.includes(locale)) return body;
  return (
    <Shell site={site} locale={locale} path="/">
      {body}
    </Shell>
  );
}
