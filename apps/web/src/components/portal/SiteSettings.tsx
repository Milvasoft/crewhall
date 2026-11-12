import { type PortalSite, type UpdatePortalSite } from '@crewhall/shared';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { config } from '@/config';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, siteQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag, offsetLabel, timeZones } from '@/lib/portal/format';
import { Card, ConfirmDialog, FieldRow, PageHeader, smallInput } from './common';
import { ImageField } from './MediaPicker';
import { PortalPage } from './PortalPage';

type Settings = PortalSite['settings'];

/** 10.17 Site settings (site managers): site, languages, time zone, Next.js link, images. */
export function SiteSettings() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  return (
    <PortalPage crumbs={[{ label: t('portal.nav.settings') }]}>
      {site.capabilities.manage ? (
        <SettingsForm key={site.id} site={site} />
      ) : (
        <EmptyState
          className="m-auto"
          icon="lock"
          title={t('portal.settings.forbidden')}
          description={t('portal.settings.forbiddenHint')}
        />
      )}
    </PortalPage>
  );
}

function SettingsForm({ site }: { site: PortalSite }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(site.name);
  const [domain, setDomain] = useState(site.domain ?? '');
  const [locales, setLocales] = useState(site.locales);
  const [defaultLocale, setDefaultLocale] = useState(site.defaultLocale);
  const [newLocale, setNewLocale] = useState('');
  const [s, setS] = useState<Settings>(site.settings);
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const zones = useMemo(() => timeZones(), []);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));
  const urlOrNull = (v: string | null) => (v && v.trim() ? v.trim() : null);

  const body: UpdatePortalSite = {
    name: name.trim(),
    domain: domain.trim() || null,
    locales,
    defaultLocale,
    settings: {
      ...s,
      url: urlOrNull(s.url),
      revalidateUrl: urlOrNull(s.revalidateUrl),
      previewUrl: urlOrNull(s.previewUrl),
      tagline: s.tagline?.trim() || null,
    },
  };
  const dirty =
    JSON.stringify(body) !==
    JSON.stringify({
      name: site.name,
      domain: site.domain,
      locales: site.locales,
      defaultLocale: site.defaultLocale,
      settings: site.settings,
    });

  const save = useMutation({
    mutationFn: () => api.call('updatePortalSite', { params: { siteId: site.id }, body }),
    onSuccess: (x) => {
      qc.setQueryData(siteQuery(site.id).queryKey, x);
      invalidatePortal(qc);
      toast(t('portal.common.savedToast'));
    },
  });
  const test = useMutation({
    mutationFn: () => api.call('testPortalRevalidate', { params: { siteId: site.id } }),
    onError: (e) => toast(t(errorKey(e))),
  });
  const rotate = useMutation({
    mutationFn: () => api.call('rotatePortalToken', { params: { siteId: site.id } }),
    onSuccess: (r) => {
      setToken(r.token);
      void qc.invalidateQueries({ queryKey: siteQuery(site.id).queryKey });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const contentApi = `${config.apiUrl}/api/v1/public/portal`;

  return (
    <form
      className="flex max-w-[880px] flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <PageHeader
        title={t('portal.nav.settings')}
        subtitle={t('portal.settings.subtitle')}
        actions={
          <Button
            type="submit"
            variant="inv"
            size="sm"
            disabled={!dirty || !name.trim()}
            loading={save.isPending}
          >
            {t('portal.common.save')}
          </Button>
        }
      />
      {save.error ? (
        <p role="alert" className="text-sm text-danger">
          {t(errorKey(save.error))}
        </p>
      ) : null}
      <Card title={t('portal.settings.site')}>
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label={t('portal.settings.name')} htmlFor="st-name">
            <input
              id="st-name"
              className={smallInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.domain')} htmlFor="st-domain">
            <input
              id="st-domain"
              className={smallInput}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.title')} htmlFor="st-title">
            <input
              id="st-title"
              className={smallInput}
              value={s.title}
              onChange={(e) => set('title', e.target.value)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.tagline')} htmlFor="st-tagline">
            <input
              id="st-tagline"
              className={smallInput}
              value={s.tagline ?? ''}
              onChange={(e) => set('tagline', e.target.value)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.url')} htmlFor="st-url" className="col-span-2">
            <input
              id="st-url"
              className={`${smallInput} font-mono`}
              value={s.url ?? ''}
              onChange={(e) => set('url', e.target.value)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.languages')} className="col-span-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {locales.map((l) => (
                <span
                  key={l}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-bg2 pr-1 pl-3 text-[13px]"
                >
                  <b>{localeTag(l)}</b>
                  {localeName(l, locale)}
                  {l === defaultLocale ? (
                    <Badge plain tone="accent">
                      {t('portal.settings.default')}
                    </Badge>
                  ) : (
                    <>
                      <Button size="xs" variant="gh" onClick={() => setDefaultLocale(l)}>
                        {t('portal.settings.makeDefault')}
                      </Button>
                      <IconButton
                        aria-label={t('portal.settings.removeLanguage', {
                          language: localeName(l, locale),
                        })}
                        size="xs"
                        tone="plain"
                        onClick={() => setLocales(locales.filter((x) => x !== l))}
                      >
                        <Icon name="x" size={12} />
                      </IconButton>
                    </>
                  )}
                </span>
              ))}
              <input
                aria-label={t('portal.settings.addLanguage')}
                placeholder={t('portal.settings.addLanguage')}
                value={newLocale}
                onChange={(e) => setNewLocale(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const v = newLocale.trim();
                  if (/^[a-z]{2}(-[A-Z]{2})?$/.test(v) && !locales.includes(v)) {
                    setLocales([...locales, v]);
                  }
                  setNewLocale('');
                }}
                className={`${smallInput} h-8 w-40`}
              />
            </div>
          </FieldRow>
          <FieldRow label={t('portal.settings.timezone')} className="col-span-2">
            <Select value={s.timezone} onValueChange={(v) => set('timezone', v)}>
              <SelectTrigger size="sm" aria-label={t('portal.settings.timezone')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {`${z} (${offsetLabel(z)})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </Card>
      <Card title={t('portal.settings.nextjs')}>
        <div className="flex flex-col gap-4">
          <FieldRow label={t('portal.settings.contentApi')}>
            <code className="truncate rounded-md bg-bg2 px-3 py-2 font-mono text-xs">
              {contentApi}
            </code>
          </FieldRow>
          <FieldRow label={t('portal.settings.token')}>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-bg2 px-3 py-2 font-mono text-xs">
                {site.tokenHint ? `••••${site.tokenHint}` : t('portal.settings.noToken')}
              </code>
              <Button
                size="sm"
                variant="out"
                onClick={() => setConfirmRotate(true)}
                loading={rotate.isPending}
              >
                <Icon name="refresh" size={16} />
                {site.tokenHint ? t('portal.settings.rotate') : t('portal.settings.createToken')}
              </Button>
            </div>
          </FieldRow>
          <FieldRow label={t('portal.settings.revalidateUrl')} htmlFor="st-reval">
            <div className="flex items-center gap-2">
              <input
                id="st-reval"
                className={`${smallInput} font-mono`}
                value={s.revalidateUrl ?? ''}
                onChange={(e) => set('revalidateUrl', e.target.value)}
              />
              <Button
                size="sm"
                variant="out"
                loading={test.isPending}
                disabled={dirty}
                onClick={() => test.mutate()}
              >
                {t('portal.settings.test')}
              </Button>
            </div>
            {test.data ? (
              <span
                role="status"
                className={test.data.ok ? 'text-xs text-success' : 'text-xs text-danger'}
              >
                {test.data.ok
                  ? t('portal.settings.testOk', {
                      status: test.data.status ?? 0,
                      value: test.data.ms,
                      time: formatTime(new Date(), locale),
                    })
                  : t('portal.settings.testFailed', {
                      text: test.data.error ?? String(test.data.status ?? ''),
                    })}
              </span>
            ) : dirty ? (
              <span className="text-xs text-fg2">{t('portal.settings.saveBeforeTest')}</span>
            ) : null}
          </FieldRow>
          <FieldRow label={t('portal.settings.previewUrl')} htmlFor="st-preview">
            <input
              id="st-preview"
              className={`${smallInput} font-mono`}
              value={s.previewUrl ?? ''}
              onChange={(e) => set('previewUrl', e.target.value)}
            />
            <span className="text-xs text-fg2">{t('portal.settings.previewHint')}</span>
          </FieldRow>
        </div>
      </Card>
      <Card title={t('portal.settings.images')}>
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label={t('portal.settings.logo')}>
            <ImageField
              label={t('portal.settings.logo')}
              value={s.logo.src}
              onChange={(src) => set('logo', { ...s.logo, src })}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.logoDark')}>
            <ImageField
              label={t('portal.settings.logoDark')}
              value={s.logo.srcDark}
              onChange={(srcDark) => set('logo', { ...s.logo, srcDark })}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.favicon')}>
            <ImageField
              label={t('portal.settings.favicon')}
              value={s.favicon}
              onChange={(v) => set('favicon', v)}
            />
          </FieldRow>
          <FieldRow label={t('portal.settings.socialImage')}>
            <ImageField
              label={t('portal.settings.socialImage')}
              value={s.socialImage}
              onChange={(v) => set('socialImage', v)}
            />
          </FieldRow>
        </div>
      </Card>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={site.tokenHint ? t('portal.settings.rotateTitle') : t('portal.settings.createToken')}
        description={t('portal.settings.rotateBody')}
        confirm={site.tokenHint ? t('portal.settings.rotate') : t('portal.settings.createToken')}
        onConfirm={() => rotate.mutateAsync()}
      />
      <Dialog open={token !== null} onOpenChange={(v) => !v && setToken(null)}>
        <DialogContent width={520}>
          <DialogHeader
            icon="key"
            title={t('portal.settings.tokenTitle')}
            description={t('portal.settings.tokenOnce')}
          />
          <div className="flex items-center gap-2 rounded-lg bg-bg2 py-1.5 pr-1.5 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{token}</code>
            <Button
              size="xs"
              variant="inv"
              onClick={() =>
                void navigator.clipboard.writeText(token ?? '').then(
                  () => toast(t('portal.common.copied')),
                  () => undefined,
                )
              }
            >
              <Icon name="copy" size={14} />
              {t('portal.common.copy')}
            </Button>
          </div>
          <DialogFooter>
            <Button size="sm" variant="gh" onClick={() => setToken(null)}>
              {t('portal.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
