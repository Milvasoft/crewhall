'use client';

import { useEffect, useState } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { searchSite, type SearchHit } from '@/components/search/search-client';

const STOP = new Set(['docs', 'doc', 'blog', 'category', 'tags', 'page', 'next', 'en', 'tr']);

/** Words of the requested path, e.g. /docs/1.0.1/milvaion/quickstart → "milvaion quickstart". */
export function pathWords(pathname: string): string {
  return pathname
    .split('/')
    .filter(
      (p) => p && !STOP.has(p) && !/^\d+(\.\d+)*$/.test(p) && !/^[a-z]{2}(-[A-Z]{2})?$/.test(p),
    )
    .flatMap((p) => decodeURIComponent(p).split(/[-_.]+/))
    .filter((w) => w.length > 1)
    .join(' ');
}

/** "Maybe you were looking for:" — the two closest pages for the path's words (Hub search). */
export function NotFoundSuggestions({ locale, label }: { locale: string; label: string }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const q = pathWords(window.location.pathname);
    if (!q) return;
    const controller = new AbortController();
    searchSite({ q, locale, limit: 2 }, controller.signal)
      .then((items) => setHits(items.slice(0, 2)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [locale]);
  if (!hits.length) return null;
  return (
    <div className="portal-not-found-suggestions">
      <p>{label}</p>
      <ul>
        {hits.map((h) => (
          <li key={h.path}>
            <SiteLink href={h.path}>{h.title}</SiteLink>
            {h.section ? ` · ${h.section}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
