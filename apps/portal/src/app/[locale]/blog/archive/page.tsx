import type { PortalPublicPostSummary } from '@crewhall/shared';
import type { Metadata } from 'next';
import { SiteLink } from '@/components/SiteLink';
import { postHref } from '@/components/blog/parts';
import { Shell } from '@/components/layout/Shell';
import { fill, formatMonthDay, strings } from '@/i18n';
import { metaContext, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const s = strings(locale);
  return buildMetadata({
    site: ctx.site,
    locale,
    title: s.archiveTitle,
    description: s.archiveTitle,
    path: '/blog/archive',
  });
}

/** Docusaurus blog archive: years newest first, posts oldest first within a year. */
function byYear(posts: PortalPublicPostSummary[]) {
  const years = new Map<string, PortalPublicPostSummary[]>();
  for (const p of [...posts].sort((a, b) => a.date.localeCompare(b.date))) {
    const y = p.date.slice(0, 4);
    years.set(y, [...(years.get(y) ?? []), p]);
  }
  return [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

export default async function ArchivePage({ params }: Props) {
  const { locale } = await params;
  const ctx = await pageContext(locale);
  const s = strings(locale);
  const all = await ctx.client.posts({ locale, page: 1, pageSize: 0 });
  return (
    <Shell site={ctx.site} locale={locale} path="/blog/archive" section="blog">
      <header className="hero hero--primary">
        <div className="container">
          <h1 className="hero__title">{s.archiveTitle}</h1>
          <p className="hero__subtitle">{s.archiveTitle}</p>
        </div>
      </header>
      <main>
        <section className="margin-vert--lg">
          <div className="container">
            <div className="row">
              {byYear(all.items).map(([year, posts]) => (
                <div key={year} className="col col--4 margin-vert--lg">
                  <h3 className="anchor anchorTargetStickyNavbar_Vzrq" id={year}>
                    {year}
                    <a
                      href={`#${year}`}
                      className="hash-link"
                      aria-label={fill(s.directLink, { heading: year })}
                      title={fill(s.directLink, { heading: year })}
                      translate="no"
                    >
                      {'​'}
                    </a>
                  </h3>
                  <ul>
                    {posts.map((p) => (
                      <li key={p.slug}>
                        <SiteLink href={postHref(ctx.site, locale, p.slug)}>
                          {formatMonthDay(locale, p.date)} - {p.title}
                        </SiteLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </Shell>
  );
}
