import { Button, EmptyState, Field, Input } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, sitesQuery } from '@/lib/portal/api';
import { slugify } from '@/lib/portal/format';

/** /portal with no site: managers create the first one, others see who can. */
export function NoSite() {
  const { t } = useI18n();
  const sites = useQuery(sitesQuery);
  if (sites.data?.capabilities.manage) return <CreateSitePage />;
  return (
    <Workspace crumbs={[{ label: t('shell.modules.portal') }]}>
      <EmptyState
        className="m-auto"
        icon="portal"
        title={t('portal.create.none')}
        description={t('portal.create.noneHint')}
      />
    </Workspace>
  );
}

export function CreateSitePage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sites = useQuery(sitesQuery);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [domain, setDomain] = useState('');
  const [locales, setLocales] = useState('en, tr');
  const [defaultLocale, setDefaultLocale] = useState('en');
  const [version, setVersion] = useState('1.0.0');
  const list = locales
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const create = useMutation({
    mutationFn: () =>
      api.call('createPortalSite', {
        body: {
          name: name.trim(),
          slug: slug || slugify(name),
          domain: domain.trim() || null,
          locales: list,
          defaultLocale,
          initialVersion: version.trim() || '1.0.0',
        },
      }),
    onSuccess: (s) => {
      invalidatePortal(qc);
      void navigate({ to: '/portal/$siteSlug', params: { siteSlug: s.slug } });
    },
  });

  if (sites.data && !sites.data.capabilities.manage) {
    return (
      <Workspace crumbs={[{ label: t('shell.modules.portal') }]}>
        <EmptyState className="m-auto" icon="lock" title={t('portal.settings.forbidden')} />
      </Workspace>
    );
  }

  return (
    <Workspace crumbs={[{ label: t('shell.modules.portal') }, { label: t('portal.create.title') }]}>
      <form
        className="mx-auto flex w-full max-w-[520px] flex-col gap-4 rounded-2xl bg-surface p-6 shadow-line"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-wtitle font-bold">{t('portal.create.title')}</h1>
          <p className="text-sm text-fg2">{t('portal.create.subtitle')}</p>
        </div>
        <Field label={t('portal.settings.name')}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label={t('portal.create.slug')} hint={t('portal.create.slugHint')}>
          <Input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
            }}
          />
        </Field>
        <Field label={t('portal.settings.domain')}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
        </Field>
        <div className="grid grid-cols-[1fr_120px_120px] gap-3">
          <Field label={t('portal.settings.languages')} hint={t('portal.create.languagesHint')}>
            <Input value={locales} onChange={(e) => setLocales(e.target.value)} />
          </Field>
          <Field label={t('portal.settings.default')}>
            <Input
              value={defaultLocale}
              onChange={(e) => setDefaultLocale(e.target.value.trim())}
            />
          </Field>
          <Field label={t('portal.create.version')}>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
        </div>
        {create.error ? (
          <p role="alert" className="text-sm text-danger">
            {t(errorKey(create.error))}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="pri"
          disabled={!name.trim() || !list.length || !list.includes(defaultLocale)}
          loading={create.isPending}
        >
          {t('portal.create.submit')}
        </Button>
      </form>
    </Workspace>
  );
}
