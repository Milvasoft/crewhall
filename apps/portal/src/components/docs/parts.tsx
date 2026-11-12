import type { PortalSidebarItem } from '@crewhall/shared';
import { SiteLink } from '@/components/SiteLink';
import type { SidebarNode } from '@/components/docs/DocSidebarMenu';
import { fill, languageName, type SiteStrings } from '@/i18n';
import type { PortalSiteData } from '@/lib/hub';
import { currentVersion, docPath, sitePath } from '@/lib/site';

export function toSidebarNodes(
  items: PortalSidebarItem[],
  site: PortalSiteData,
  locale: string,
  version: string,
): SidebarNode[] {
  return items.map((item) => ({
    kind: item.kind,
    label: item.label,
    href: item.slug ? docPath(site, locale, version, item.slug) : null,
    collapsed: item.collapsed ?? true,
    items: toSidebarNodes(item.items ?? [], site, locale, version),
  }));
}

/** Number of direct children of the category whose index slug is given (for "N items"). */
export function categoryItemCount(items: PortalSidebarItem[], slug: string): number | null {
  for (const item of items) {
    if (item.kind === 'category' && item.slug === slug) return item.items?.length ?? 0;
    const inner = categoryItemCount(item.items ?? [], slug);
    if (inner !== null) return inner;
  }
  return null;
}

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" className="breadcrumbHomeIcon_YNFT">
    <path
      d="M10 19v-5h4v5c0 .55.45 1 1 1h3c.55 0 1-.45 1-1v-7h1.7c.46 0 .68-.57.33-.87L12.67 3.6c-.38-.34-.96-.34-1.34 0l-8.36 7.53c-.34.3-.13.87.33.87H5v7c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"
      fill="currentColor"
    />
  </svg>
);

export interface Crumb {
  label: string;
  href: string | null;
}

export function Breadcrumbs({
  crumbs,
  current,
  homeHref,
  s,
}: {
  crumbs: Crumb[];
  current: string;
  homeHref: string;
  s: SiteStrings;
}) {
  return (
    <nav className="theme-doc-breadcrumbs breadcrumbsContainer_Z_bl" aria-label={s.breadcrumbs}>
      <ul className="breadcrumbs">
        <li className="breadcrumbs__item">
          <SiteLink aria-label={s.homePage} className="breadcrumbs__link" href={homeHref}>
            <HomeIcon />
          </SiteLink>
        </li>
        {crumbs.map((c, i) => (
          <li key={i} className="breadcrumbs__item">
            {c.href ? (
              <SiteLink className="breadcrumbs__link" href={c.href}>
                <span>{c.label}</span>
              </SiteLink>
            ) : (
              <span className="breadcrumbs__link">{c.label}</span>
            )}
          </li>
        ))}
        <li className="breadcrumbs__item breadcrumbs__item--active">
          <span className="breadcrumbs__link">{current}</span>
        </li>
      </ul>
    </nav>
  );
}

export function VersionBadge({ label, s }: { label: string; s: SiteStrings }) {
  return (
    <span className="theme-doc-version-badge badge badge--secondary">
      {fill(s.versionBadge, { version: label })}
    </span>
  );
}

/** Old (archived) or unreleased (`next`) version banner linking to the same page in the current version. */
export function VersionBanner({
  site,
  version,
  latestHref,
  s,
}: {
  site: PortalSiteData;
  version: string;
  latestHref: string;
  s: SiteStrings;
}) {
  const v = site.versions.find((x) => x.name === version);
  const latest = currentVersion(site);
  if (!v || !latest || v.status === 'current') return null;
  const template = v.status === 'next' ? s.unreleasedVersion : s.archivedVersion;
  const [before, after] = template.split('{versionLabel}');
  const [suggestBefore, suggestAfter] = s.latestVersionSuggestion.split('{latestVersionLink}');
  return (
    <div className="theme-doc-version-banner alert alert--warning margin-bottom--md" role="alert">
      <div>
        {fill(before ?? '', { siteTitle: site.settings.title })}
        <b>{v.label}</b>
        {fill(after ?? '', { siteTitle: site.settings.title })}
      </div>
      <div className="margin-top--md">
        {suggestBefore}
        <b>
          <SiteLink href={latestHref}>{s.latestVersionLink}</SiteLink>
        </b>
        {fill(suggestAfter ?? '', { versionLabel: latest.label })}
      </div>
    </div>
  );
}

export function TranslationNotice({
  state,
  locale,
  contentLocale,
  s,
}: {
  state: string;
  locale: string;
  contentLocale: string;
  s: SiteStrings;
}) {
  if (state !== 'missing' && state !== 'outdated') return null;
  const language = languageName(locale, contentLocale);
  const message = state === 'missing' ? s.translationMissing : s.translationOutdated;
  return (
    <div className="alert alert--info margin-bottom--md portal-translation-notice" role="note">
      {fill(message, { language })}
    </div>
  );
}

export function DraftNotice({ s }: { s: SiteStrings }) {
  return (
    <div className="theme-admonition theme-admonition-caution admonition_xJq3 alert alert--warning margin-bottom--md">
      <div className="admonitionHeading_Gvgb">{s.draftTitle}</div>
      <div className="admonitionContent_BuS1">{s.draftMessage}</div>
    </div>
  );
}

export function DocPaginator({
  previous,
  next,
  hrefOf,
  s,
}: {
  previous: { title: string; slug: string } | null;
  next: { title: string; slug: string } | null;
  hrefOf: (slug: string) => string;
  s: SiteStrings;
}) {
  if (!previous && !next) return null;
  return (
    <nav className="docusaurus-mt-lg pagination-nav" aria-label={s.docsPages}>
      {previous && (
        <SiteLink
          className="pagination-nav__link pagination-nav__link--prev"
          href={hrefOf(previous.slug)}
        >
          <div className="pagination-nav__sublabel">{s.previous}</div>
          <div className="pagination-nav__label">{previous.title}</div>
        </SiteLink>
      )}
      {next && (
        <SiteLink
          className="pagination-nav__link pagination-nav__link--next"
          href={hrefOf(next.slug)}
        >
          <div className="pagination-nav__sublabel">{s.next}</div>
          <div className="pagination-nav__label">{next.title}</div>
        </SiteLink>
      )}
    </nav>
  );
}

export const homeHref = (site: PortalSiteData, locale: string) => sitePath(site, locale, '/');
