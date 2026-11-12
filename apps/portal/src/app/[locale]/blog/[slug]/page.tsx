import type { PortalPublicPost } from '@crewhall/shared';
import { firstParagraphText } from '@crewhall/editor';
import type { Metadata } from 'next';
import { SiteLink } from '@/components/SiteLink';
import { BlogFrame } from '@/components/blog/BlogViews';
import { PostHeader, TagsInline, postHref } from '@/components/blog/parts';
import { strings } from '@/i18n';
import { decodeSegment, metaContext, missing, pageContext } from '@/lib/page';
import { localePath } from '@/lib/route';
import { buildMetadata, jsonLd } from '@/lib/seo';
import { absoluteUrl, mediaSrc } from '@/lib/site';
import { parseMarkdown, renderDocument } from '@/render/Markdown';

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateStaticParams() {
  return [];
}

function description(post: PortalPublicPost): string | null {
  return (
    post.seo.description ?? post.description ?? firstParagraphText(parseMarkdown(post.excerpt), 300)
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug: raw } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const slug = decodeSegment(raw);
  const post = await ctx.client.post(locale, slug).catch(() => null);
  if (!post) return {};
  const { site } = ctx;
  const languages: Record<string, string> = {};
  for (const a of post.alternates) {
    languages[a.locale] = localePath(a.locale, site.defaultLocale, `/blog/${a.slug}`);
  }
  if (post.contentLocale === locale) {
    languages[locale] = localePath(locale, site.defaultLocale, `/blog/${post.slug}`);
  }
  return buildMetadata({
    site,
    locale,
    title: post.seo.title ?? post.title,
    description: description(post),
    path: `/blog/${post.slug}`,
    languages,
    canonical:
      post.seo.canonical ??
      (post.contentLocale !== locale
        ? localePath(post.contentLocale, site.defaultLocale, `/blog/${post.slug}`)
        : null),
    noindex: !!post.seo.noindex,
    image: post.seo.image ?? post.cover,
    type: 'article',
    article: {
      publishedTime: post.date,
      authors: post.authors.map((a) => a.url ?? a.name),
      tags: post.tags,
    },
  });
}

export default async function PostPage({ params }: Props) {
  const { locale, slug: raw } = await params;
  const ctx = await pageContext(locale);
  const { site } = ctx;
  const slug = decodeSegment(raw);
  const post = await ctx.client.post(locale, slug);
  if (!post) return missing(ctx, `/blog/${slug}`);
  const s = strings(locale);
  const rendered = renderDocument(parseMarkdown(post.markdown), { strings: s, extractTitle: true });
  const url = absoluteUrl(site, postHref(site, locale, post.slug));
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': url,
    mainEntityOfPage: url,
    url,
    headline: post.title,
    name: post.title,
    description: description(post) ?? undefined,
    datePublished: post.date,
    author: post.authors.map((a) => ({
      '@type': 'Person',
      name: a.name,
      ...(a.title ? { description: a.title } : {}),
      ...(a.url ? { url: a.url } : {}),
      ...(a.imageUrl ? { image: absoluteUrl(site, mediaSrc(a.imageUrl) ?? a.imageUrl) } : {}),
    })),
    ...(post.cover ? { image: absoluteUrl(site, mediaSrc(post.cover) ?? post.cover) } : {}),
    keywords: post.tags,
    isPartOf: {
      '@type': 'Blog',
      '@id': absoluteUrl(site, localePath(locale, site.defaultLocale, '/blog')),
      name: s.blogTitle,
    },
  };

  return (
    <BlogFrame ctx={ctx} path={`/blog/${post.slug}`} activeSlug={post.slug} toc={rendered.toc}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ld) }} />
      <article>
        <PostHeader site={site} locale={locale} post={post} s={s} asPage />
        <div
          id="__blog-post-container"
          className="markdown"
          lang={post.contentLocale !== locale ? post.contentLocale : undefined}
        >
          {rendered.content}
        </div>
        {post.tags.length > 0 && (
          <footer className="docusaurus-mt-lg">
            <div className="row margin-top--sm theme-blog-footer-edit-meta-row">
              <div className="col">
                <TagsInline site={site} locale={locale} tags={post.tags} s={s} />
              </div>
            </div>
          </footer>
        )}
      </article>
      {(post.newer || post.older) && (
        <nav className="pagination-nav docusaurus-mt-lg" aria-label={s.postNavigation}>
          {post.newer && (
            <SiteLink
              className="pagination-nav__link pagination-nav__link--prev"
              href={postHref(site, locale, post.newer.slug)}
            >
              <div className="pagination-nav__sublabel">{s.newerPost}</div>
              <div className="pagination-nav__label">{post.newer.title}</div>
            </SiteLink>
          )}
          {post.older && (
            <SiteLink
              className="pagination-nav__link pagination-nav__link--next"
              href={postHref(site, locale, post.older.slug)}
            >
              <div className="pagination-nav__sublabel">{s.olderPost}</div>
              <div className="pagination-nav__label">{post.older.title}</div>
            </SiteLink>
          )}
        </nav>
      )}
    </BlogFrame>
  );
}
