import { PortalSearchHit } from '@crewhall/shared';
import { z } from 'zod';

export type SearchHit = z.infer<typeof PortalSearchHit>;

const Response = z.object({ items: z.array(PortalSearchHit) });

/** Calls the site's own /api/search (the Hub token stays on the server). */
export async function searchSite(
  params: { q: string; locale: string; version?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ q: params.q, locale: params.locale });
  if (params.version) qs.set('version', params.version);
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await fetch(`/api/search?${qs.toString()}`, signal ? { signal } : {});
  if (!res.ok) return [];
  const parsed = Response.safeParse(await res.json());
  return parsed.success ? parsed.data.items : [];
}

/** A snippet's text split around <mark>…</mark> (the only tag the Hub puts in it). */
export function markedParts(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const clean = (s: string) =>
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: clean(snippet.slice(last, m.index)), mark: false });
    out.push({ text: clean(m[1] ?? ''), mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push({ text: clean(snippet.slice(last)), mark: false });
  return out.filter((p) => p.text);
}

/** Splits text around the query's words (case-insensitive) for highlighting titles. */
export function highlightParts(text: string, query: string): { text: string; mark: boolean }[] {
  const words = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return [{ text, mark: false }];
  // with one capture group, split() puts the matches at odd indexes
  const re = new RegExp(`(${words.join('|')})`, 'i');
  return text
    .split(re)
    .map((p, i) => ({ text: p, mark: i % 2 === 1 }))
    .filter((p) => p.text !== '');
}
