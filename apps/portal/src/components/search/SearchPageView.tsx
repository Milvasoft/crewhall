'use client';

import { useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { SiteLink } from '@/components/SiteLink';
import {
  highlightParts,
  markedParts,
  searchSite,
  type SearchHit,
} from '@/components/search/search-client';

interface Labels {
  pageTitle: string;
  resultsFor: string;
  documentsFound: string;
  documentFound: string;
  noDocuments: string;
  placeholder: string;
}

/** The search-local plugin's /search page; results from /api/search. */
export function SearchPageView({ locale, labels }: { locale: string; labels: Labels }) {
  const params = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    const q = query.trim();
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', url.toString());
    if (!q) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchSite({ q, locale, limit: 50 }, controller.signal)
        .then(setHits)
        .catch(() => undefined);
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, locale]);

  const title = query.trim()
    ? labels.resultsFor.replace('{query}', query.trim())
    : labels.pageTitle;
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className="container margin-vert--lg">
      <h1>{title}</h1>
      <div className="row">
        <div className="col col--12">
          <input
            type="search"
            name="q"
            className="searchQueryInput_CFBF"
            aria-label={labels.placeholder}
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {hits !== null && query.trim() !== '' && (
        <p>
          {hits.length === 0
            ? labels.noDocuments
            : hits.length === 1
              ? labels.documentFound
              : labels.documentsFound.replace('{count}', String(hits.length))}
        </p>
      )}
      <section>
        {query.trim() !== '' &&
          hits?.map((hit) => (
            <article key={hit.path} className="searchResultItem_U687">
              <h2>
                <SiteLink href={hit.path}>
                  {highlightParts(hit.title, query).map((p, i) =>
                    p.mark ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
                  )}
                </SiteLink>
              </h2>
              {hit.section && <p className="searchResultItemPath_uIbk">{hit.section}</p>}
              {hit.snippet && (
                <p className="searchResultItemSummary_oZHr">
                  {markedParts(hit.snippet).map((p, i) =>
                    p.mark ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
                  )}
                </p>
              )}
            </article>
          ))}
      </section>
    </div>
  );
}
