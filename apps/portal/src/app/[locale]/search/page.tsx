import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Shell } from '@/components/layout/Shell';
import { SearchPageView } from '@/components/search/SearchPageView';
import { strings } from '@/i18n';
import { metaContext, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const meta = buildMetadata({
    site: ctx.site,
    locale,
    title: null,
    path: '/search',
    noindex: true,
  });
  // the search-local plugin titles the page without the site name
  return { ...meta, title: { absolute: strings(locale).searchPageTitle } };
}

export default async function SearchPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { site } = await pageContext(locale);
  const s = strings(locale);
  return (
    <Shell site={site} locale={locale} path="/search">
      <Suspense fallback={null}>
        <SearchPageView
          locale={locale}
          labels={{
            pageTitle: s.searchPageTitle,
            resultsFor: s.searchResultsFor,
            documentsFound: s.searchDocumentsFound,
            documentFound: s.searchDocumentFound,
            noDocuments: s.searchNoDocuments,
            placeholder: s.searchPlaceholder,
          }}
        />
      </Suspense>
    </Shell>
  );
}
