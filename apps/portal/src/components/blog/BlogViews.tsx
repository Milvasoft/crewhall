import type { PortalPublicPostSummary } from '@crewhall/shared';
import type { ReactNode } from 'react';
import { Shell } from '@/components/layout/Shell';
import { BlogLayout, BlogSidebarList, ListPaginator, PostListItem } from '@/components/blog/parts';
import { strings } from '@/i18n';
import type { PageContext } from '@/lib/page';
import { sitePath } from '@/lib/site';
import type { TocItem } from '@/render/Markdown';

export const POSTS_PER_PAGE = 10;
export const SIDEBAR_COUNT = 5;

export async function recentPosts(ctx: PageContext): Promise<PortalPublicPostSummary[]> {
  const res = await ctx.client.posts({ locale: ctx.locale, page: 1, pageSize: SIDEBAR_COUNT });
  return res.items;
}

/** Blog chrome: shell, recent posts column (and drawer), optional TOC. */
export async function BlogFrame({
  ctx,
  path,
  activeSlug = null,
  toc = null,
  children,
}: {
  ctx: PageContext;
  path: string;
  activeSlug?: string | null;
  toc?: TocItem[] | null;
  children: ReactNode;
}) {
  const { site, locale } = ctx;
  const s = strings(locale);
  const recent = await recentPosts(ctx);
  return (
    <Shell
      site={site}
      locale={locale}
      path={path}
      section="blog"
      secondary={
        <BlogSidebarList
          site={site}
          locale={locale}
          posts={recent}
          activeSlug={activeSlug}
          s={s}
          mobile
        />
      }
    >
      <BlogLayout
        sidebar={
          <BlogSidebarList
            site={site}
            locale={locale}
            posts={recent}
            activeSlug={activeSlug}
            s={s}
          />
        }
        toc={toc}
      >
        {children}
      </BlogLayout>
    </Shell>
  );
}

/** Paged post list (/blog, /blog/page/n, tag and author pages). */
export function PostList({
  ctx,
  posts,
  page,
  pages,
  basePath,
}: {
  ctx: PageContext;
  posts: PortalPublicPostSummary[];
  page: number;
  pages: number;
  /** Locale-less path of page 1, e.g. /blog or /blog/tags/dotnet. */
  basePath: string;
}) {
  const { site, locale } = ctx;
  const s = strings(locale);
  const pageHref = (n: number) =>
    sitePath(site, locale, n <= 1 ? basePath : `${basePath}/page/${n}`);
  return (
    <>
      {posts.map((post) => (
        <PostListItem key={post.slug} site={site} locale={locale} post={post} s={s} />
      ))}
      <ListPaginator
        newer={page > 1 ? pageHref(page - 1) : null}
        older={page < pages ? pageHref(page + 1) : null}
        s={s}
      />
    </>
  );
}
