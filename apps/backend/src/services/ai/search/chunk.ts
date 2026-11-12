/**
 * Splitting long text into overlapping chunks for the search index (yol haritası #11). Chunks
 * end at paragraph or sentence boundaries where possible so a snippet reads as a whole.
 */

export const CHUNK_CHARS = 1_500;
const OVERLAP = 200;
/** Long documents keep their first chunks only (a page of ~60k characters). */
export const MAX_CHUNKS = 40;

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length && out.length < MAX_CHUNKS) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size / 2), end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
      const cut = para >= 0 ? para : sentence >= 0 ? sentence + 1 : -1;
      if (cut >= 0) end = start + Math.floor(size / 2) + cut;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out.filter(Boolean);
}

/**
 * Words of a question for `to_tsquery`: letters and digits only, OR-ed with prefix matching.
 * Turkish adds suffixes to a root ("taşınıyor", "taşıma"), so long words also match by their
 * first four letters; documents matching more terms still rank first. Postgres lower-cases the
 * terms itself (the same way as the index), so they are left as typed.
 */
export function tsQueryOf(q: string): string | null {
  const words = q
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 12);
  if (!words.length) return null;
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(`${w}:*`);
    if ([...w].length >= 6) terms.add(`${[...w].slice(0, 4).join('')}:*`);
  }
  return [...terms].join(' | ');
}

/** A short excerpt around the first matching word, for result lists and prompts. */
export function snippetOf(text: string, q: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLocaleLowerCase('tr');
  const words = q
    .toLocaleLowerCase('tr')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  const hit = words
    .map((w) => lower.indexOf(w.slice(0, Math.max(3, w.length - 2))))
    .filter((i) => i >= 0);
  const at = hit.length ? Math.min(...hit) : 0;
  const from = Math.max(0, at - Math.floor(max / 3));
  const piece = flat.slice(from, from + max);
  return `${from > 0 ? '…' : ''}${piece}${from + max < flat.length ? '…' : ''}`;
}

/** Cosine similarity for embeddings compared in memory (tests, small candidate sets). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
