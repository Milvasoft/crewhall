import {
  cn,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusDot,
  type IconName,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { changesQuery, mediaQuery, postsQuery, versionsQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { siteHref } from '@/lib/portal/format';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

/**
 * Portal sub-navigation (design 10.1): site picker on top, the module's screens, "Siteyi aç"
 * and the queue status at the bottom. Settings only for site managers.
 */
export function PortalSidebar() {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const slug = site.slug;
  const versions = useQuery(versionsQuery(site.id));
  const posts = useQuery(postsQuery(site.id, { locale: site.defaultLocale }));
  const media = useQuery(mediaQuery(site.id));
  const changes = useQuery(changesQuery(site.id));
  const current = versions.data?.items.find((v) => v.status === 'current');
  const docCount = current?.docCounts[site.defaultLocale];
  const pending = changes.data?.items.length ?? site.pendingCount;
  const href = siteHref(site);
  const n = (v: number | undefined) => (v === undefined ? undefined : formatNumber(v, locale));

  return (
    <ModuleSidebar label={t('portal.nav.label')} className="gap-px overflow-hidden px-2.5 py-3">
      <SitePicker />
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        <Item
          to="/portal/$siteSlug"
          slug={slug}
          icon="grid"
          label={t('portal.nav.overview')}
          exact
        />
        <Item
          to="/portal/$siteSlug/docs"
          slug={slug}
          icon="page"
          label={t('portal.nav.docs')}
          count={n(docCount)}
        />
        <Item
          to="/portal/$siteSlug/blog"
          slug={slug}
          icon="edit"
          label={t('portal.nav.blog')}
          count={n(posts.data?.items.length)}
        />
        <Item to="/portal/$siteSlug/home" slug={slug} icon="home" label={t('portal.nav.home')} />
        <Item
          to="/portal/$siteSlug/navigation"
          slug={slug}
          icon="menu"
          label={t('portal.nav.navigation')}
        />
        <Item
          to="/portal/$siteSlug/media"
          slug={slug}
          icon="image"
          label={t('portal.nav.media')}
          count={n(media.data?.items.length)}
        />
        <Item to="/portal/$siteSlug/seo" slug={slug} icon="search" label={t('portal.nav.seo')} />
        <Item
          to="/portal/$siteSlug/publishes"
          slug={slug}
          icon="history"
          label={t('portal.nav.publishes')}
        />
        {site.capabilities.manage ? (
          <>
            <Item
              to="/portal/$siteSlug/import"
              slug={slug}
              icon="download"
              label={t('portal.nav.import')}
            />
            <Item
              to="/portal/$siteSlug/settings"
              slug={slug}
              icon="settings"
              label={t('portal.nav.settings')}
            />
          </>
        ) : null}
      </div>
      <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-line pt-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
          >
            <Icon name="ext" size={16} />
            {t('portal.nav.openSite')}
          </a>
        ) : null}
        <span className="flex items-center gap-2 px-2.5 py-1 text-xs text-fg2">
          <StatusDot status={pending ? 'warn' : 'up'} />
          {pending
            ? t('portal.status.queuePending', { count: pending })
            : t('portal.status.allPublished')}
        </span>
      </div>
    </ModuleSidebar>
  );
}

function Item({
  to,
  slug,
  icon,
  label,
  count,
  exact,
}: {
  to: string;
  slug: string;
  icon: IconName;
  label: ReactNode;
  count?: ReactNode;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      params={{ siteSlug: slug }}
      activeOptions={{ exact: exact ?? false, includeSearch: false }}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium whitespace-nowrap text-fg2 hover:bg-bg2 hover:text-fg',
        'data-[status=active]:bg-capsule data-[status=active]:font-semibold data-[status=active]:text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="text-xs font-medium text-fg3 tn">{count}</span>
      ) : null}
    </Link>
  );
}

function SitePicker() {
  const { t } = useI18n();
  const { site, sites } = usePortalSite();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const subtitle = [t('portal.picker.engine'), site.locales.join(', '), site.currentVersion ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t('portal.picker.label')}
        className="flex h-12 w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-bg2"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2 text-fg">
          <Icon name="globe" size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{site.domain ?? site.name}</span>
          <span className="truncate text-xs text-fg2">{subtitle}</span>
        </span>
        <Icon name="chevUD" size={14} className="text-fg3" />
      </PopoverTrigger>
      <PopoverContent className="flex w-[280px] flex-col gap-px p-1.5">
        {sites.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setOpen(false);
              void navigate({ to: '/portal/$siteSlug', params: { siteSlug: s.slug } });
            }}
            className={cn(
              'flex min-h-11 items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left hover:bg-capsule',
              s.id === site.id && 'bg-capsule',
            )}
          >
            <Icon name="globe" size={16} className="text-fg2" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] font-semibold">{s.domain ?? s.name}</span>
              <span className="truncate text-xs text-fg2">
                {s.status === 'live'
                  ? t('portal.picker.live', { count: s.publishedUrlCount })
                  : s.domain
                    ? t('portal.picker.setup')
                    : t('portal.picker.setupNoDomain')}
              </span>
            </span>
            {s.id === site.id ? <Icon name="check" size={14} /> : null}
          </button>
        ))}
        {site.capabilities.manage ? (
          <>
            <span className="mx-1.5 my-1 h-px bg-line" />
            <PickerLink
              to="/portal/new"
              icon="plus"
              label={t('portal.picker.newSite')}
              onGo={() => setOpen(false)}
            />
            <PickerLink
              to="/portal/$siteSlug/import"
              params={{ siteSlug: site.slug }}
              icon="download"
              label={t('portal.picker.import')}
              onGo={() => setOpen(false)}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PickerLink({
  to,
  params,
  icon,
  label,
  onGo,
}: {
  to: string;
  params?: Record<string, string>;
  icon: IconName;
  label: string;
  onGo: () => void;
}) {
  return (
    <Link
      to={to}
      params={params}
      onClick={onGo}
      className="flex min-h-[34px] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium hover:bg-capsule"
    >
      <Icon name={icon} size={16} className="text-fg2" />
      {label}
    </Link>
  );
}
