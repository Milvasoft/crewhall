import { type AppLocale } from '@crewhall/i18n';
import { type PortalDoc, type PortalSite } from '@crewhall/shared';

/** Portal helpers: language names, site URLs, site time zone and version numbers. */

const BCP47: Record<AppLocale, string> = { tr: 'tr-TR', en: 'en-US' };

/** "English", "Türkçe" in the UI language; site languages are tenant data. */
export function localeName(code: string, ui: AppLocale): string {
  try {
    const name = new Intl.DisplayNames([BCP47[ui]], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(BCP47[ui]) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** Short tag shown next to titles: EN, TR. */
export const localeTag = (code: string) => code.toUpperCase();

export function localePrefix(site: Pick<PortalSite, 'defaultLocale'>, locale: string): string {
  return locale === site.defaultLocale ? '' : `/${locale}`;
}

/** Site-relative path of a doc, as Docusaurus builds it (`/tr/docs/1.0.1/welcome`). */
export function docPath(
  site: Pick<PortalSite, 'defaultLocale'>,
  doc: Pick<PortalDoc, 'locale' | 'version' | 'slug' | 'kind' | 'categorySlug'>,
): string {
  const slug = doc.kind === 'category' && doc.categorySlug ? doc.categorySlug : doc.slug;
  return `${localePrefix(site, doc.locale)}/docs/${doc.version}/${slug}`;
}

export function postPath(site: Pick<PortalSite, 'defaultLocale'>, locale: string, slug: string) {
  return `${localePrefix(site, locale)}/blog/${slug}`;
}

/** Public base URL of the site (settings.url, else the domain). */
export function siteBaseUrl(site: Pick<PortalSite, 'settings' | 'domain'>): string | null {
  if (site.settings.url) return site.settings.url.replace(/\/+$/, '');
  return site.domain ? `https://${site.domain}` : null;
}

export function siteHref(site: Pick<PortalSite, 'settings' | 'domain'>, path = ''): string | null {
  const base = siteBaseUrl(site);
  return base ? `${base}${path}` : null;
}

// ---- time zone (scheduled posts run in the site's zone) ----

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get('year'),
    mo: get('month'),
    d: get('day'),
    h: get('hour') % 24,
    mi: get('minute'),
    s: get('second'),
  };
}

/** Offset of `timeZone` at `date`, in minutes east of UTC. */
export function zoneOffset(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** ISO instant → wall clock in the zone: `{ date: '2026-10-22', time: '10:00' }`. */
export function toZoned(iso: string, timeZone: string): { date: string; time: string } {
  const p = partsIn(new Date(iso), timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.y}-${two(p.mo)}-${two(p.d)}`, time: `${two(p.h)}:${two(p.mi)}` };
}

/** Wall clock in the zone → ISO instant. */
export function fromZoned(date: string, time: string, timeZone: string): string | null {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  if (
    !y ||
    !mo ||
    !d ||
    h === undefined ||
    mi === undefined ||
    Number.isNaN(h) ||
    Number.isNaN(mi)
  ) {
    return null;
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - zoneOffset(new Date(guess), timeZone) * 60_000;
  ts = guess - zoneOffset(new Date(ts), timeZone) * 60_000;
  return new Date(ts).toISOString();
}

/** "UTC+3", "UTC−4:30". */
export function offsetLabel(timeZone: string, at = new Date()): string {
  const off = zoneOffset(at, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list?.length) return list;
  } catch {
    /* older engines */
  }
  return ['UTC', 'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'America/New_York'];
}

// ---- versions ----

/** Suggested next release for "Yeni versiyon dondur": 1.0.1 → 1.1.0. */
export function suggestVersion(names: string[]): string {
  const releases = names.filter((n) => n !== 'next').sort(compareVersions);
  const last = releases[releases.length - 1];
  if (!last) return '1.0.0';
  const [major = 1, minor = 0] = last.split('.').map((x) => Number(x) || 0);
  return `${major}.${minor + 1}.0`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** URL slug from a title (Turkish letters folded). */
export function slugify(text: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  return text
    .toLocaleLowerCase('tr')
    .replace(/[çğıİöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Plain text of an editor document (word counts, previews). */
export function plainText(node: { text?: string; content?: unknown[] }): string {
  const out: string[] = [];
  const walk = (n: { text?: string; content?: unknown[] }) => {
    if (n.text) out.push(n.text);
    for (const c of (n.content ?? []) as { text?: string; content?: unknown[] }[]) walk(c);
  };
  walk(node);
  return out.join(' ');
}
