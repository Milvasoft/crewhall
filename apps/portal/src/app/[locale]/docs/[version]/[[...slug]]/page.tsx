import type {
  PortalPublicCategoryPage,
  PortalPublicDocPage,
  PortalSidebarItem,
} from '@crewhall/shared';
import { firstParagraphText } from '@crewhall/editor';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { draftMode } from 'next/headers';
import { permanentRedirect } from 'next/navigation';
import { SiteLink } from '@/components/SiteLink';
import { DocsChrome, MobileDocSidebar } from '@/components/docs/DocsChrome';
import { TocDesktop, TocMobile } from '@/components/docs/Toc';
import {
  Breadcrumbs,
  DocPaginator,
  DraftNotice,
  TranslationNotice,
  VersionBadge,
  VersionBanner,
  categoryItemCount,
  homeHref,
  toSidebarNodes,
  type Crumb,
} from '@/components/docs/parts';
import { Shell } from '@/components/layout/Shell';
import { fill, strings, type SiteStrings } from '@/i18n';
import { decodeSegment, metaContext, missing, pageContext, type PageContext } from '@/lib/page';
import { VERSION_PATTERN, localePath } from '@/lib/route';
import { buildMetadata, jsonLd } from '@/lib/seo';
import {
  absoluteUrl,
  currentVersion,
  docPath,
  firstSidebarSlug,
  isVisibleVersion,
  sitePath,
} from '@/lib/site';
import { parseMarkdown, renderDocument } from '@/render/Markdown';

type Params = { locale: string; version: string; slug?: string[] };

export async function generateStaticParams() {
  return [];
}

const slugOf = (slug: string[] | undefined) => (slug ?? []).map(decodeSegment).join('/');

async function load(ctx: PageContext, version: string, slug: string) {
  if (!VERSION_PATTERN.test(version) || !isVisibleVersion(ctx.site, version)) return null;
  const [page, sidebar] = await Promise.all([
    ctx.client.page(version, ctx.locale, slug),
    ctx.client.sidebar(version, ctx.locale),
  ]);
  return page ? { page, sidebar: sidebar?.items ?? [] } : null;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale, version, slug } = await params;
  const ctx = await metaContext(locale);
  const s = slugOf(slug);
  if (!ctx || !s) return {};
  const data = await load(ctx, version, s).catch(() => null);
  if (!data) {
    return { title: { absolute: `${strings(locale).notFoundTitle} | ${ctx.site.settings.title}` } };
  }
  const { page } = data;
  const { site } = ctx;
  const path = `/docs/${version}/${page.slug}`;
  const isDoc = page.kind === 'doc';
  const doc = isDoc ? (page as PortalPublicDocPage) : null;
  const description =
    doc?.seo.description ??
    page.description ??
    (doc ? firstParagraphText(parseMarkdown(doc.markdown), 300) : null);
  // Translations that exist; an untranslated page points to its source language as canonical.
  const languages: Record<string, string> = {};
  if (doc) {
    for (const a of doc.alternates) {
      languages[a.locale] = localePath(a.locale, site.defaultLocale, `/docs/${version}/${a.slug}`);
    }
    if (doc.translation !== 'missing') {
      languages[locale] = localePath(locale, site.defaultLocale, path);
    }
  }
  const untranslated = doc?.translation === 'missing';
  return buildMetadata({
    site,
    locale,
    title: doc?.seo.title ?? page.title,
    description,
    path,
    ...(doc ? { languages } : {}),
    canonical:
      doc?.seo.canonical ??
      (untranslated ? localePath(doc.contentLocale, site.defaultLocale, path) : null),
    noindex: version === 'next' || !!doc?.seo.noindex,
    image: doc?.seo.image ?? null,
  });
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const { locale, version, slug: rawSlug } = await params;
  const ctx = await pageContext(locale);
  const { site, client } = ctx;
  const slug = slugOf(rawSlug);
  const basePath = `/docs/${version}${slug ? `/${slug}` : ''}`;

  if (!slug) {
    if (!VERSION_PATTERN.test(version) || !isVisibleVersion(site, version)) {
      return missing(ctx, basePath);
    }
    const sidebar = await client.sidebar(version, locale);
    const first = sidebar ? firstSidebarSlug(sidebar.items) : null;
    if (!first) return missing(ctx, basePath);
    permanentRedirect(docPath(site, locale, version, first));
  }

  const data = await load(ctx, version, slug);
  if (!data) return missing(ctx, basePath);
  const { page, sidebar } = data;
  const s = strings(locale);
  const preview = (await draftMode()).isEnabled;
  const path = `/docs/${version}/${page.slug}`;
  const activePath = sitePath(site, locale, path);
  const nodes = toSidebarNodes(sidebar, site, locale, version);
  const hrefOf = (sl: string) => docPath(site, locale, version, sl);
  const crumbs: Crumb[] = page.breadcrumbs
    .filter((b, i, all) => !(i === all.length - 1 && b.slug === page.slug))
    .map((b) => ({ label: b.label, href: b.slug ? hrefOf(b.slug) : null }));

  const current = currentVersion(site);
  const sameInCurrent = current
    ? page.versions.find((v) => v.version === current.name)?.slug
    : undefined;
  let latestHref = sitePath(site, locale, '/docs');
  if (current) {
    if (sameInCurrent) latestHref = docPath(site, locale, current.name, sameInCurrent);
    else {
      const sb = await client.sidebar(current.name, locale).catch(() => null);
      const first = sb ? firstSidebarSlug(sb.items) : null;
      if (first) latestHref = docPath(site, locale, current.name, first);
    }
  }
  const versionLabel = site.versions.find((v) => v.name === version)?.label ?? version;
  const versionSlugs = Object.fromEntries(page.versions.map((v) => [v.version, v.slug]));

  const banners = (
    <>
      <VersionBanner site={site} version={version} latestHref={latestHref} s={s} />
      {preview && version !== 'next' && <DraftNotice s={s} />}
    </>
  );

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      ...crumbs
        .filter((c) => c.href)
        .map((c) => ({ name: c.label, item: absoluteUrl(site, c.href!) })),
      { name: page.title, item: absoluteUrl(site, activePath) },
    ].map((e, i) => ({ '@type': 'ListItem', position: i + 1, ...e })),
  };

  return (
    <Shell
      site={site}
      locale={locale}
      path={path}
      section="docs"
      version={version}
      versionSlugs={versionSlugs}
      secondary={<MobileDocSidebar nodes={nodes} activePath={activePath} s={s} />}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbLd) }}
      />
      <DocsChrome nodes={nodes} activePath={activePath} s={s}>
        {page.kind === 'doc' ? (
          <DocContent
            page={page as PortalPublicDocPage}
            ctx={ctx}
            s={s}
            crumbs={crumbs}
            banners={banners}
            versionLabel={versionLabel}
            hrefOf={hrefOf}
          />
        ) : (
          <CategoryContent
            page={page as PortalPublicCategoryPage}
            ctx={ctx}
            s={s}
            crumbs={crumbs}
            banners={banners}
            versionLabel={versionLabel}
            hrefOf={hrefOf}
            sidebar={sidebar}
          />
        )}
      </DocsChrome>
    </Shell>
  );
}

interface ContentProps {
  ctx: PageContext;
  s: SiteStrings;
  crumbs: Crumb[];
  banners: ReactNode;
  versionLabel: string;
  hrefOf: (slug: string) => string;
}

function DocContent({
  page,
  ctx,
  s,
  crumbs,
  banners,
  versionLabel,
  hrefOf,
}: ContentProps & { page: PortalPublicDocPage }) {
  const { site, locale } = ctx;
  const rendered = renderDocument(parseMarkdown(page.markdown), { strings: s, extractTitle: true });
  // Docusaurus: no page title header when the markdown has its own h1
  const hideTitle =
    page.frontMatter.hide_title === true || (rendered.title === null && rendered.hasH1);
  const title = rendered.title ?? page.title;
  const hasToc = rendered.toc.length > 0 && page.frontMatter.hide_table_of_contents !== true;
  return (
    <div className="container padding-top--md padding-bottom--lg">
      <div className="row">
        {/* Docusaurus narrows the column unless the front matter hides the TOC, even when empty. */}
        <div
          className={`col${page.frontMatter.hide_table_of_contents === true ? '' : ' docItemCol_VOVn'}`}
        >
          {banners}
          {site.settings.showUntranslatedNotice && (
            <TranslationNotice
              state={page.translation}
              locale={locale}
              contentLocale={page.contentLocale}
              s={s}
            />
          )}
          <div className="docItemContainer_Djhp">
            <article>
              <Breadcrumbs
                crumbs={crumbs}
                current={page.title}
                homeHref={homeHref(site, locale)}
                s={s}
              />
              <VersionBadge label={versionLabel} s={s} />
              {hasToc && <TocMobile items={rendered.toc} label={s.onThisPage} />}
              <div
                className="theme-doc-markdown markdown"
                lang={page.contentLocale !== locale ? page.contentLocale : undefined}
              >
                {!hideTitle && (
                  <header>
                    <h1>{title}</h1>
                  </header>
                )}
                {rendered.content}
              </div>
            </article>
            <DocPaginator previous={page.previous} next={page.next} hrefOf={hrefOf} s={s} />
          </div>
        </div>
        {hasToc && (
          <div className="col col--3">
            <TocDesktop items={rendered.toc} />
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryContent({
  page,
  ctx,
  s,
  crumbs,
  banners,
  versionLabel,
  hrefOf,
  sidebar,
}: ContentProps & { page: PortalPublicCategoryPage; sidebar: PortalSidebarItem[] }) {
  const { site, locale } = ctx;
  return (
    <div className="container padding-top--md padding-bottom--lg">
      <div className="generatedIndexPage_vN6x">
        {banners}
        <Breadcrumbs crumbs={crumbs} current={page.title} homeHref={homeHref(site, locale)} s={s} />
        <VersionBadge label={versionLabel} s={s} />
        <header>
          <h1 className="title_kItE">{page.title}</h1>
          {page.description && <p>{page.description}</p>}
        </header>
        <article className="margin-top--lg">
          <section className="row">
            {page.items.map((item, i) => {
              if (!item.slug) return null;
              const isCategory = item.kind === 'category';
              const count = isCategory ? categoryItemCount(sidebar, item.slug) : null;
              const description = isCategory
                ? count !== null
                  ? count === 1
                    ? s.categoryItemsOne
                    : fill(s.categoryItems, { count })
                  : item.description
                : item.description;
              const label = `${isCategory ? '🗃️' : '📄️'} ${item.title}`;
              return (
                <article key={i} className="docCardListItem_W1sv col col--6">
                  <SiteLink
                    className="card padding--lg cardContainer_fWXF"
                    href={hrefOf(item.slug)}
                  >
                    <h2 className="text--truncate cardTitle_rnsV" title={item.title}>
                      {label}
                    </h2>
                    {description && (
                      <p className="text--truncate cardDescription_PWke" title={description}>
                        {description}
                      </p>
                    )}
                  </SiteLink>
                </article>
              );
            })}
          </section>
        </article>
        <footer className="margin-top--md">
          <DocPaginator previous={page.previous} next={page.next} hrefOf={hrefOf} s={s} />
        </footer>
      </div>
    </div>
  );
}
