/**
 * Search that does not care about Turkish letters or case: "yapay zeka" finds "Yapay zekâ",
 * "guvenlik" finds "Güvenlik", "ISTATISTIK" finds "İstatistikler". `fold` keeps the length, so a
 * match index in the folded text is the same index in the original (for highlighting).
 */
const FOLD: Record<string, string> = {
  ı: 'i',
  ş: 's',
  ğ: 'g',
  ç: 'c',
  ö: 'o',
  ü: 'u',
  â: 'a',
  î: 'i',
  û: 'u',
};

export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    // Per character so the length stays: "İ".toLocaleLowerCase('tr') is one letter, "i".
    const lower = ch.toLocaleLowerCase('tr');
    if (lower.length !== ch.length) {
      out += ch;
      continue;
    }
    out += FOLD[lower] ?? (ch.length === 1 ? (lower.normalize('NFD')[0] ?? lower) : lower);
  }
  return out;
}

export interface Searchable {
  label: string;
  /** Breadcrumb ("Yönetim"), matched like the label but weighs less. */
  crumb?: string;
  keywords?: readonly string[];
}

const BOUNDARY = /[\s›\-/(.,']/;

/** Where `needle` sits in `hay`: at the start, at a word start, inside a word, or nowhere. */
function place(hay: string, needle: string): 'start' | 'word' | 'inside' | null {
  let at = hay.indexOf(needle);
  if (at < 0) return null;
  if (at === 0) return 'start';
  // A later occurrence may start a word even when the first one does not.
  for (; at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (BOUNDARY.test(hay[at - 1] ?? '')) return 'word';
  }
  return 'inside';
}

function tokenScore(token: string, label: string, crumb: string, keywords: string[]): number {
  const inLabel = place(label, token);
  if (inLabel === 'start') return 100;
  if (inLabel === 'word') return 80;
  const inKeywords = keywords.map((k) => place(k, token));
  if (inKeywords.some((p) => p === 'start' || p === 'word')) return 60;
  // Inside a word only counts from three letters: "ai" should not find "mail".
  const loose = token.length >= 3;
  if (loose && inLabel === 'inside') return 40;
  const inCrumb = place(crumb, token);
  if (inCrumb === 'start' || inCrumb === 'word') return 30;
  if (loose && inKeywords.includes('inside')) return 20;
  return 0;
}

/** Letters of `needle` in order and close together in `hay`: "istatstk" still finds "istatistikler". */
function subsequence(needle: string, hay: string): boolean {
  let at = -1;
  let first = -1;
  for (const ch of needle) {
    at = hay.indexOf(ch, at + 1);
    if (at < 0) return false;
    if (first < 0) first = at;
  }
  return at - first < needle.length * 2;
}

/**
 * 0 for no match, higher for better: every word of the query has to be somewhere (label, then
 * keywords, then the breadcrumb); a single word of three letters or more may also match the label
 * loosely (letters in order) so small typos still find the page.
 */
export function matchScore(query: string, item: Searchable): number {
  const q = fold(query.trim());
  if (!q) return 0;
  const label = fold(item.label);
  const crumb = fold(item.crumb ?? '');
  const keywords = (item.keywords ?? []).map(fold);
  if (label === q) return 1000;
  const whole = tokenScore(q, label, crumb, keywords);
  if (whole) return whole * 2;
  const tokens = q.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(t, label, crumb, keywords);
    if (!s) {
      total = 0;
      break;
    }
    total += s;
  }
  if (total) return total / tokens.length;
  if (tokens.length === 1 && q.length >= 3 && subsequence(q, label)) return 10;
  return 0;
}
