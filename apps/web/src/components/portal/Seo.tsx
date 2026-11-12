import { type PortalDoc, type PortalSeo } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  docQuery,
  invalidatePortal,
  overviewQuery,
  redirectsQuery,
  siteQuery,
  treeQuery,
} from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { docPath, siteBaseUrl } from '@/lib/portal/format';
import { Card, Counter, FieldRow, SaveStatus, smallInput, useWhen } from './common';
import { useDocAutosave } from './docs/DocEditor';
import { ImageField, MediaThumb } from './MediaPicker';
import { PortalPage } from './PortalPage';

type Tab = 'page' | 'defaults' | 'sitemap' | 'redirects';

/** 10.10 SEO: per-page settings with previews, site defaults, sitemap/robots and redirects. */
export function SeoScreen() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/seo' });
  const tab: Tab = search.tab ?? 'page';
  const redirects = useQuery(redirectsQuery(site.id));
  const tree = useQuery(treeQuery(site.id, site.currentVersion ?? 'next', site.defaultLocale));
  const docs = (tree.data?.items ?? []).filter((i) => i.kind === 'doc' && i.id);
  const pageId = search.page ?? docs[0]?.id ?? '';
  const doc = useQuery({ ...docQuery(pageId), enabled: Boolean(pageId) });
  const set = (patch: { tab?: Tab; page?: string }) =>
    void navigate({
      to: '/portal/$siteSlug/seo',
      params: { siteSlug: site.slug },
      search: { ...search, ...patch },
      replace: true,
    });

  return (
    <PortalPage
      crumbs={[{ label: t('portal.nav.seo') }]}
      previewPath={tab === 'page' && doc.data ? docPath(site, doc.data) : null}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => set({ tab: v as Tab })}
        className="flex flex-col gap-5"
      >
        <TabsList>
          <TabsTrigger value="page">{t('portal.seo.tabs.page')}</TabsTrigger>
          <TabsTrigger value="defaults">{t('portal.seo.tabs.defaults')}</TabsTrigger>
          <TabsTrigger value="sitemap">{t('portal.seo.tabs.sitemap')}</TabsTrigger>
          <TabsTrigger value="redirects">
            {t('portal.seo.tabs.redirects')}
            <span className="text-xs text-fg3">{redirects.data?.items.length ?? ''}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="page" className="flex flex-col gap-4">
          <Select value={pageId} onValueChange={(page) => set({ page })}>
            <SelectTrigger size="sm" className="w-[420px]" aria-label={t('portal.seo.page')}>
              <SelectValue placeholder={t('portal.seo.page')} />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {docs.map((d) => (
                <SelectItem key={d.id} value={d.id ?? ''}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {doc.data ? (
            <PageSeo key={doc.data.id} doc={doc.data} />
          ) : (
            <Skeleton className="h-64 rounded-2xl" />
          )}
        </TabsContent>
        <TabsContent value="defaults">
          <SiteDefaults />
        </TabsContent>
        <TabsContent value="sitemap">
          <SitemapInfo />
        </TabsContent>
        <TabsContent value="redirects">
          <Redirects />
        </TabsContent>
      </Tabs>
    </PortalPage>
  );
}

function PageSeo({ doc }: { doc: PortalDoc }) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const autosave = useDocAutosave(doc);
  const [seo, setSeo] = useState<PortalSeo>(doc.seo);
  const canEdit = site.capabilities.edit;
  const base = siteBaseUrl(site) ?? '';
  const path = docPath(site, doc);
  const canonical = seo.canonical || `${base}${path}`;
  const template = site.settings.titleTemplate || '{page} | {site}';
  const title =
    seo.title || template.replace('{page}', doc.title).replace('{site}', site.settings.title);
  const description = seo.description || doc.description || '';
  const update = (patch: Partial<PortalSeo>) => {
    const next = { ...seo, ...patch };
    setSeo(next);
    autosave.queue({ seo: next });
  };
  const hasTwin = doc.translations.filter((x) => x.locale !== doc.locale && x.docId);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Card
        title={doc.title}
        aside={
          <>
            <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
            <span className="text-xs text-fg2">{`${doc.version} · ${doc.locale}`}</span>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FieldRow
            label={t('portal.seo.title')}
            htmlFor="seo-title"
            aside={<Counter value={seo.title || title} max={60} />}
          >
            <input
              id="seo-title"
              className={smallInput}
              value={seo.title ?? ''}
              placeholder={title}
              disabled={!canEdit}
              onChange={(e) => update({ title: e.target.value || null })}
            />
            <span className="text-xs text-fg2">
              {t('portal.seo.titleHint', { text: template })}
            </span>
          </FieldRow>
          <FieldRow
            label={t('portal.seo.description')}
            htmlFor="seo-desc"
            aside={<Counter value={seo.description || description} max={160} min={70} />}
          >
            <textarea
              id="seo-desc"
              className={cn(smallInput, 'h-auto min-h-20 py-2')}
              value={seo.description ?? ''}
              placeholder={doc.description ?? ''}
              disabled={!canEdit}
              onChange={(e) => update({ description: e.target.value || null })}
            />
            <span
              className={cn(
                'text-xs text-fg2',
                description.length > 0 && description.length < 70 && 'text-warning',
              )}
            >
              {t('portal.seo.descriptionHint')}
            </span>
          </FieldRow>
          <FieldRow
            label={t('portal.seo.canonical')}
            aside={!seo.canonical ? <Badge plain>{t('portal.seo.auto')}</Badge> : null}
          >
            <input
              aria-label={t('portal.seo.canonical')}
              className={cn(smallInput, 'font-mono text-xs')}
              value={seo.canonical ?? ''}
              placeholder={canonical}
              disabled={!canEdit}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (!v || /^https?:\/\/\S+$/.test(v)) update({ canonical: v || null });
              }}
            />
          </FieldRow>
          <FieldRow
            label={t('portal.seo.image')}
            aside={!seo.image ? <Badge plain>{t('portal.seo.auto')}</Badge> : null}
          >
            <ImageField
              label={t('portal.seo.image')}
              value={seo.image}
              disabled={!canEdit}
              onChange={(image) => update({ image })}
            />
          </FieldRow>
          <label className="flex items-center justify-between gap-3 text-[13.5px]">
            {t('portal.seo.index')}
            <Switch
              checked={!seo.noindex}
              disabled={!canEdit}
              onCheckedChange={(c) => update({ noindex: !c })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-[13.5px]">
            {t('portal.seo.sitemap')}
            <Switch
              checked={!seo.excludeFromSitemap}
              disabled={!canEdit}
              onCheckedChange={(c) => update({ excludeFromSitemap: !c })}
            />
          </label>
          <p className="rounded-lg bg-bg2 px-3.5 py-2.5 text-xs text-fg2">
            {hasTwin.length
              ? t('portal.seo.hreflangOk', { count: hasTwin.length + 1 })
              : t('portal.seo.hreflangMissing')}
          </p>
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        <Card title={t('portal.seo.google')}>
          <div className="flex flex-col gap-1 rounded-xl bg-white p-4 text-[#202124] shadow-line">
            <span className="truncate text-xs">
              {site.settings.title} ·{' '}
              <span className="text-[#4d5156]">
                {`${base}${path}`.replace(/\//g, ' › ').replace('https: ›  › ', '')}
              </span>
            </span>
            <span className="truncate text-lg text-[#1a0dab]">{title}</span>
            <span className="line-clamp-2 text-[13px] text-[#4d5156]">{description}</span>
          </div>
        </Card>
        <Card title={t('portal.seo.social')}>
          <div className="overflow-hidden rounded-xl bg-bg2 shadow-line">
            <div className="aspect-[1200/630] w-full">
              {seo.image || site.settings.socialImage ? (
                <MediaThumb
                  path={seo.image || site.settings.socialImage}
                  className="object-cover"
                />
              ) : (
                <div className="flex size-full flex-col justify-end gap-1 bg-graphite p-5 text-white">
                  <span className="text-xs opacity-70">{`${site.settings.title} · Docs ${doc.version}`}</span>
                  <span className="text-xl font-bold">{doc.title}</span>
                  <span className="text-xs opacity-70">
                    {doc.path.map((p) => p.title).join(' › ')}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="text-xs text-fg2">{site.domain}</span>
              <span className="truncate text-[13.5px] font-semibold">{title}</span>
              <span className="truncate text-xs text-fg2">{description}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SiteDefaults() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const [template, setTemplate] = useState(site.settings.titleTemplate);
  const save = useMutation({
    mutationFn: (settings: { titleTemplate?: string; socialImage?: string | null }) =>
      api.call('updatePortalSite', { params: { siteId: site.id }, body: { settings } }),
    onSuccess: (s) => {
      qc.setQueryData(siteQuery(site.id).queryKey, s);
      toast(t('portal.common.savedToast'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const canManage = site.capabilities.manage;
  return (
    <Card className="max-w-[640px]">
      <div className="flex flex-col gap-4">
        <FieldRow label={t('portal.seo.template')} htmlFor="seo-template">
          <div className="flex gap-2">
            <input
              id="seo-template"
              className={cn(smallInput, 'font-mono')}
              value={template}
              disabled={!canManage}
              onChange={(e) => setTemplate(e.target.value)}
            />
            {canManage ? (
              <Button
                size="sm"
                variant="inv"
                disabled={template === site.settings.titleTemplate}
                loading={save.isPending}
                onClick={() => save.mutate({ titleTemplate: template })}
              >
                {t('portal.common.save')}
              </Button>
            ) : null}
          </div>
          <span className="text-xs text-fg2">{t('portal.seo.templateHint')}</span>
        </FieldRow>
        <FieldRow label={t('portal.seo.socialDefault')}>
          <ImageField
            label={t('portal.seo.socialDefault')}
            value={site.settings.socialImage}
            disabled={!canManage}
            onChange={(socialImage) => save.mutate({ socialImage })}
          />
        </FieldRow>
        {!canManage ? <p className="text-xs text-fg2">{t('portal.seo.managersOnly')}</p> : null}
      </div>
    </Card>
  );
}

function SitemapInfo() {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const overview = useQuery(overviewQuery(site.id));
  const base = siteBaseUrl(site) ?? '';
  const last = overview.data?.lastPublish;
  return (
    <div className="grid max-w-[880px] gap-3 md:grid-cols-2">
      <Card title="sitemap.xml">
        <p className="text-sm">
          {t('portal.seo.sitemapInfo', {
            count: overview.data?.publishedUrlCount ?? 0,
            time: last ? formatTime(last.createdAt, locale) : '-',
          })}
        </p>
        {base ? (
          <a
            className="mt-2 font-mono text-xs text-fg2 hover:underline"
            href={`${base}/sitemap.xml`}
            target="_blank"
            rel="noreferrer"
          >{`${base}/sitemap.xml`}</a>
        ) : null}
      </Card>
      <Card title="robots.txt">
        <p className="text-sm">
          {site.settings.nextPublic ? t('portal.seo.robotsOpen') : t('portal.seo.robotsNext')}
        </p>
        <p className="mt-2 text-xs text-fg2">{t('portal.seo.robotsHint')}</p>
      </Card>
    </div>
  );
}

function Redirects() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const when = useWhen();
  const redirects = useQuery(redirectsQuery(site.id));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [code, setCode] = useState<'301' | '308'>('301');
  const create = useMutation({
    mutationFn: () =>
      api.call('createPortalRedirect', {
        params: { siteId: site.id },
        body: { fromPath: from.trim(), toPath: to.trim(), code: code === '308' ? 308 : 301 },
      }),
    onSuccess: () => {
      setFrom('');
      setTo('');
      invalidatePortal(qc);
    },
  });
  const remove = useMutation({
    mutationFn: (redirectId: string) =>
      api.call('deletePortalRedirect', { params: { redirectId } }),
    onSuccess: () => invalidatePortal(qc),
    onError: (e) => toast(t(errorKey(e))),
  });
  const canEdit = site.capabilities.edit;
  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-2xl bg-surface p-4 shadow-line"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <FieldRow className="min-w-[220px] flex-1" label={t('portal.seo.from')} htmlFor="r-from">
            <input
              id="r-from"
              className={cn(smallInput, 'font-mono')}
              placeholder={t('portal.seo.fromExample')}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </FieldRow>
          <FieldRow className="min-w-[220px] flex-1" label={t('portal.seo.to')} htmlFor="r-to">
            <input
              id="r-to"
              className={cn(smallInput, 'font-mono')}
              placeholder={t('portal.seo.toExample')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </FieldRow>
          <Select value={code} onValueChange={(v) => setCode(v as '301' | '308')}>
            <SelectTrigger size="sm" className="w-24" aria-label={t('portal.seo.code')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="301">301</SelectItem>
              <SelectItem value="308">308</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="submit"
            size="sm"
            variant="inv"
            disabled={!from.trim() || !to.trim()}
            loading={create.isPending}
          >
            {t('portal.seo.addRedirect')}
          </Button>
          {create.error ? (
            <span role="alert" className="w-full text-xs text-danger">
              {t(errorKey(create.error))}
            </span>
          ) : null}
        </form>
      ) : null}
      <div className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table aria-label={t('portal.seo.tabs.redirects')}>
          <thead>
            <tr>
              <Th>{t('portal.seo.from')}</Th>
              <Th>{t('portal.seo.to')}</Th>
              <Th>{t('portal.seo.code')}</Th>
              <Th>{t('portal.seo.source')}</Th>
              <Th>{t('portal.seo.created')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {!redirects.data?.items.length ? (
              <tr>
                <Td colSpan={6}>
                  {redirects.isPending ? (
                    <Skeleton className="h-5" />
                  ) : (
                    <EmptyState icon="arrowR" title={t('portal.seo.noRedirects')} />
                  )}
                </Td>
              </tr>
            ) : (
              redirects.data.items.map((r) => (
                <tr key={r.id}>
                  <Td className="max-w-[320px] truncate font-mono text-xs">{r.fromPath}</Td>
                  <Td className="max-w-[320px] truncate font-mono text-xs">{r.toPath}</Td>
                  <Td className="tn">{r.code}</Td>
                  <Td>
                    {r.auto ? (
                      <Badge tone="info">{t('portal.seo.autoRedirect')}</Badge>
                    ) : (
                      <Badge plain>{t('portal.seo.manual')}</Badge>
                    )}
                  </Td>
                  <Td className="text-fg2">{when(r.createdAt, true)}</Td>
                  <Td className="text-right">
                    {canEdit ? (
                      <IconButton
                        aria-label={t('portal.seo.removeRedirect', { path: r.fromPath })}
                        size="xs"
                        tone="plain"
                        onClick={() => remove.mutate(r.id)}
                      >
                        <Icon name="trash" size={14} />
                      </IconButton>
                    ) : null}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
