import type { Metadata } from 'next';
import { Fragment } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { BlogFrame } from '@/components/blog/BlogViews';
import { groupTags, tagHref } from '@/components/blog/pages';
import { fill, strings } from '@/i18n';
import { metaContext, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  return buildMetadata({
    site: ctx.site,
    locale,
    title: strings(locale).tagsTitle,
    path: '/blog/tags',
  });
}

export default async function TagsPage({ params }: Props) {
  const { locale } = await params;
  const ctx = await pageContext(locale);
  const s = strings(locale);
  const tags = await ctx.client.tags(locale);
  return (
    <BlogFrame ctx={ctx} path="/blog/tags">
      <h1>{s.tagsTitle}</h1>
      <section className="margin-vert--lg">
        {groupTags(tags.items).map((group) => (
          <Fragment key={group.letter}>
            <article>
              <h2 className="anchor anchorTargetStickyNavbar_Vzrq" id={group.letter}>
                {group.letter}
                <a
                  href={`#${group.letter}`}
                  className="hash-link"
                  aria-label={fill(s.directLink, { heading: group.letter })}
                  title={fill(s.directLink, { heading: group.letter })}
                  translate="no"
                >
                  {'​'}
                </a>
              </h2>
              <ul className="padding--none">
                {group.tags.map((t) => (
                  <li key={t.tag} className="tag_Nnez">
                    <SiteLink
                      rel="tag"
                      className="tag_zVej tagWithCount_h2kH"
                      href={tagHref(ctx.site, locale, t.tag)}
                    >
                      {t.tag}
                      <span>{t.count}</span>
                    </SiteLink>
                  </li>
                ))}
              </ul>
              <hr />
            </article>
          </Fragment>
        ))}
      </section>
    </BlogFrame>
  );
}
