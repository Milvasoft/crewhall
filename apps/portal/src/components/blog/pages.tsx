import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteLink } from '@/components/SiteLink';
import { BlogFrame, POSTS_PER_PAGE, PostList } from '@/components/blog/BlogViews';
import { AuthorCard, tagHref } from '@/components/blog/parts';
import { fill, strings } from '@/i18n';
import { metaContext, missing, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';
import { sitePath } from '@/lib/site';

/**
 * Blog route implementations shared by the route files (page 1 and /page/n variants).
 */

const pagePath = (base: string, page: number) => (page <= 1 ? base : `${base}/page/${page}`);

// ----- /blog, /blog/page/n

export async function blogListMetadata(locale: string, page: number): Promise<Metadata> {
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const s = strings(locale);
  return buildMetadata({
    site: ctx.site,
    locale,
    title: s.blogTitle,
    description: s.blogDescription,
    path: pagePath('/blog', page),
  });
}

export async function BlogListPage({ locale, page }: { locale: string; page: number }) {
  const ctx = await pageContext(locale);
  const data = await ctx.client.posts({ locale, page, pageSize: POSTS_PER_PAGE });
  if (page > 1 && page > data.pages) return missing(ctx, pagePath('/blog', page));
  return (
    <BlogFrame ctx={ctx} path={pagePath('/blog', page)}>
      <PostList ctx={ctx} posts={data.items} page={page} pages={data.pages} basePath="/blog" />
    </BlogFrame>
  );
}

// ----- /blog/tags/<tag>

export async function tagMetadata(locale: string, tag: string, page: number): Promise<Metadata> {
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const s = strings(locale);
  const data = await ctx.client.posts({ locale, tag, page: 1, pageSize: 1 }).catch(() => null);
  const count = data?.total ?? 0;
  const title = count === 1 ? fill(s.tagPostsOne, { tag }) : fill(s.tagPosts, { tag, count });
  return buildMetadata({
    site: ctx.site,
    locale,
    title,
    path: pagePath(`/blog/tags/${encodeURIComponent(tag)}`, page),
  });
}

export async function TagPage({
  locale,
  tag,
  page,
}: {
  locale: string;
  tag: string;
  page: number;
}) {
  const ctx = await pageContext(locale);
  const base = `/blog/tags/${encodeURIComponent(tag)}`;
  const data = await ctx.client.posts({ locale, tag, page, pageSize: POSTS_PER_PAGE });
  if (!data.total || (page > 1 && page > data.pages)) return missing(ctx, pagePath(base, page));
  const s = strings(locale);
  const title =
    data.total === 1 ? fill(s.tagPostsOne, { tag }) : fill(s.tagPosts, { tag, count: data.total });
  return (
    <BlogFrame ctx={ctx} path={pagePath(base, page)}>
      <header className="margin-bottom--xl">
        <h1>{title}</h1>
        <SiteLink href={sitePath(ctx.site, locale, '/blog/tags')}>{s.viewAllTags}</SiteLink>
      </header>
      <PostList ctx={ctx} posts={data.items} page={page} pages={data.pages} basePath={base} />
    </BlogFrame>
  );
}

// ----- /blog/authors/<key>

export async function authorMetadata(locale: string, key: string, page: number): Promise<Metadata> {
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const authors = await ctx.client.authors().catch(() => null);
  const author = authors?.items.find((a) => a.key === key);
  return buildMetadata({
    site: ctx.site,
    locale,
    title: author?.name ?? key,
    path: pagePath(`/blog/authors/${encodeURIComponent(key)}`, page),
  });
}

export async function AuthorPage({
  locale,
  authorKey,
  page,
}: {
  locale: string;
  authorKey: string;
  page: number;
}) {
  const ctx = await pageContext(locale);
  const base = `/blog/authors/${encodeURIComponent(authorKey)}`;
  const authors = await ctx.client.authors();
  const author = authors.items.find((a) => a.key === authorKey);
  if (!author) return missing(ctx, pagePath(base, page));
  const data = await ctx.client.posts({
    locale,
    author: authorKey,
    page,
    pageSize: POSTS_PER_PAGE,
  });
  if (page > 1 && page > data.pages) notFound();
  const s = strings(locale);
  return (
    <BlogFrame ctx={ctx} path={pagePath(base, page)}>
      <header className="margin-bottom--xl">
        <AuthorCard author={author} as="h1" count={data.total} />
        <SiteLink href={sitePath(ctx.site, locale, '/blog/authors')}>{s.viewAllAuthors}</SiteLink>
      </header>
      <PostList ctx={ctx} posts={data.items} page={page} pages={data.pages} basePath={base} />
    </BlogFrame>
  );
}

// ----- tags list helper (used by /blog/tags)

export function groupTags(
  items: { tag: string; count: number }[],
): { letter: string; tags: { tag: string; count: number }[] }[] {
  const groups = new Map<string, { tag: string; count: number }[]>();
  for (const item of [...items].sort((a, b) => a.tag.localeCompare(b.tag))) {
    const letter = item.tag.charAt(0).toLocaleUpperCase();
    const list = groups.get(letter) ?? [];
    list.push(item);
    groups.set(letter, list);
  }
  return [...groups.entries()].map(([letter, tags]) => ({ letter, tags }));
}

export { tagHref };
