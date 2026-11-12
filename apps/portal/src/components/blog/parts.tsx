import type { PortalPublicAuthor, PortalPublicPostSummary } from '@crewhall/shared';
import type { ReactNode } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { TocDesktop } from '@/components/docs/Toc';
import { fill, formatDate, type SiteStrings } from '@/i18n';
import type { PortalSiteData } from '@/lib/hub';
import { mediaSrc, sitePath } from '@/lib/site';
import { renderMarkdown, type TocItem } from '@/render/Markdown';

export const postHref = (site: PortalSiteData, locale: string, slug: string) =>
  sitePath(site, locale, `/blog/${encodeURIComponent(slug)}`);
export const tagHref = (site: PortalSiteData, locale: string, tag: string) =>
  sitePath(site, locale, `/blog/tags/${encodeURIComponent(tag)}`);

export function readingTime(s: SiteStrings, minutes: number): string {
  return minutes <= 1 ? s.readingTimeOne : fill(s.readingTime, { minutes });
}

/** "Recent posts", grouped by year (desktop column; the mobile drawer shows it too). */
export function BlogSidebarList({
  site,
  locale,
  posts,
  activeSlug,
  s,
  mobile = false,
}: {
  site: PortalSiteData;
  locale: string;
  posts: PortalPublicPostSummary[];
  activeSlug?: string | null;
  s: SiteStrings;
  mobile?: boolean;
}) {
  const years: { year: string; posts: PortalPublicPostSummary[] }[] = [];
  for (const post of posts) {
    const year = post.date.slice(0, 4);
    const group = years[years.length - 1];
    if (group?.year === year) group.posts.push(post);
    else years.push({ year, posts: [post] });
  }
  if (mobile) {
    return (
      <>
        {years.map((g) => (
          <div key={g.year} role="group">
            <h3 className="yearGroupHeading_QT03">{g.year}</h3>
            <ul className="menu__list">
              {g.posts.map((p) => (
                <li key={p.slug} className="menu__list-item">
                  <SiteLink
                    className={`menu__link${p.slug === activeSlug ? ' menu__link--active' : ''}`}
                    href={postHref(site, locale, p.slug)}
                  >
                    {p.title}
                  </SiteLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </>
    );
  }
  return (
    <nav className="sidebar_re4s thin-scrollbar" aria-label={s.recentPostsAria}>
      <div className="sidebarItemTitle_pO2u margin-bottom--md">{s.recentPosts}</div>
      {years.map((g) => (
        <div key={g.year} role="group">
          <h3 className="yearGroupHeading_rMGB">{g.year}</h3>
          <ul className="sidebarItemList_Yudw clean-list">
            {g.posts.map((p) => (
              <li key={p.slug} className="sidebarItem__DBe">
                <SiteLink
                  className={`sidebarItemLink_mo7H${p.slug === activeSlug ? ' sidebarItemLinkActive_I1ZP' : ''}`}
                  href={postHref(site, locale, p.slug)}
                >
                  {p.title}
                </SiteLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Docusaurus BlogLayout: sidebar column, main column, optional TOC column. */
export function BlogLayout({
  sidebar,
  toc,
  children,
}: {
  sidebar: ReactNode;
  toc?: TocItem[] | null;
  children: ReactNode;
}) {
  return (
    <div className="container margin-vert--lg">
      <div className="row">
        <aside className="col col--3">{sidebar}</aside>
        <main className="col col--7">{children}</main>
        {toc && toc.length > 0 && (
          <div className="col col--2">
            <TocDesktop items={toc} docs={false} />
          </div>
        )}
      </div>
    </div>
  );
}

export function AuthorCard({
  author,
  as = 'span',
  count,
}: {
  author: PortalPublicAuthor;
  as?: 'span' | 'h1' | 'h2';
  count?: number;
}) {
  const Name = as;
  const image = mediaSrc(author.imageUrl);
  const link = (children: ReactNode, className?: string) =>
    author.url ? (
      <SiteLink href={author.url} className={className}>
        {children}
      </SiteLink>
    ) : (
      children
    );
  return (
    <div
      className={`avatar margin-bottom--sm${as === 'h2' ? ' author-as-h2_gXvM' : as === 'h1' ? ' author-as-h1_n9oJ' : ''}`}
    >
      {image &&
        link(
          <img className="avatar__photo authorImage_XqGP" src={image} alt={author.name} />,
          'avatar__photo-link',
        )}
      <div className="avatar__intro authorDetails_lV9A">
        <div className="avatar__name">
          {link(
            <Name className="authorName_yefp" translate="no">
              {author.name}
            </Name>,
          )}
          {count !== undefined && <span className="authorBlogPostCount_iiJ5">{count}</span>}
        </div>
        {author.title && (
          <small className="authorTitle_nd0D" title={author.title}>
            {author.title}
          </small>
        )}
        <div className="authorSocials_rSDt" />
      </div>
    </div>
  );
}

export function TagsInline({
  site,
  locale,
  tags,
  s,
}: {
  site: PortalSiteData;
  locale: string;
  tags: string[];
  s: SiteStrings;
}) {
  return (
    <>
      <b>{s.tagsLabel}</b>
      <ul className="tags_jXut padding--none margin-left--sm">
        {tags.map((tag) => (
          <li key={tag} className="tag_QGVx">
            <SiteLink
              rel="tag"
              className="tag_zVej tagRegular_sFm0"
              href={tagHref(site, locale, tag)}
            >
              {tag}
            </SiteLink>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Post header: title, date · reading time, authors, optional cover image. */
export function PostHeader({
  site,
  locale,
  post,
  s,
  asPage,
}: {
  site: PortalSiteData;
  locale: string;
  post: PortalPublicPostSummary;
  s: SiteStrings;
  asPage: boolean;
}) {
  const cover = mediaSrc(post.cover);
  return (
    <header>
      {asPage ? (
        <h1 className="title_f1Hy">{post.title}</h1>
      ) : (
        <h2 className="title_f1Hy">
          <SiteLink href={postHref(site, locale, post.slug)}>{post.title}</SiteLink>
        </h2>
      )}
      <div className="container_mt6G margin-vert--md">
        <time dateTime={post.date}>{formatDate(locale, post.date)}</time> ·{' '}
        {readingTime(s, post.readingMinutes)}
      </div>
      {post.authors.length > 0 && (
        <div className="margin-top--md margin-bottom--sm row">
          {post.authors.map((a) => (
            <div
              key={a.key}
              className={`col ${post.authors.length > 1 ? 'col--6' : 'col--12'} authorCol_Hf19`}
            >
              <AuthorCard author={a} />
            </div>
          ))}
        </div>
      )}
      {asPage && cover && (
        <img
          className="img_ev3q margin-bottom--md"
          src={cover}
          alt={post.title}
          loading="lazy"
          decoding="async"
        />
      )}
    </header>
  );
}

/** A post in a list: excerpt up to the truncate marker, tags and "Read more". */
export function PostListItem({
  site,
  locale,
  post,
  s,
}: {
  site: PortalSiteData;
  locale: string;
  post: PortalPublicPostSummary;
  s: SiteStrings;
}) {
  const { content } = renderMarkdown(post.excerpt, s, true);
  const hasTags = post.tags.length > 0;
  return (
    <article className="margin-bottom--xl">
      <PostHeader site={site} locale={locale} post={post} s={s} asPage={false} />
      <div className="markdown">{content}</div>
      {(hasTags || post.truncated) && (
        <footer className="row docusaurus-mt-lg">
          {hasTags && (
            <div className={`col${post.truncated ? ' col--9' : ''}`}>
              <TagsInline site={site} locale={locale} tags={post.tags} s={s} />
            </div>
          )}
          {post.truncated && (
            <div className={`col text--right${hasTags ? ' col--3' : ''}`}>
              <SiteLink
                href={postHref(site, locale, post.slug)}
                aria-label={fill(s.readMoreAria, { title: post.title })}
              >
                <b>{s.readMore}</b>
              </SiteLink>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}

export function ListPaginator({
  newer,
  older,
  s,
}: {
  newer: string | null;
  older: string | null;
  s: SiteStrings;
}) {
  return (
    <nav className="pagination-nav" aria-label={s.listNavigation}>
      {newer && (
        <SiteLink className="pagination-nav__link pagination-nav__link--prev" href={newer}>
          <div className="pagination-nav__label">{s.newerEntries}</div>
        </SiteLink>
      )}
      {older && (
        <SiteLink className="pagination-nav__link pagination-nav__link--next" href={older}>
          <div className="pagination-nav__label">{s.olderEntries}</div>
        </SiteLink>
      )}
    </nav>
  );
}
