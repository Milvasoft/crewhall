import { queryKeys } from '@crewhall/api-client';
import { type BrandAssetSlot, type Branding, type Organization } from '@crewhall/shared';
import { Button, CrewhallMark, Icon, Input, Skeleton, Switch, Tag, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useBlocker } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { IMAGE_ACCEPT, readImage } from '@/components/account/ImageCropDialog';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgQuery } from '@/lib/queries';

export const Route = createFileRoute('/_app/admin/brand')({
  component: BrandPage,
});

type Draft = Pick<Branding, 'orgName' | 'appName' | 'showPoweredBy'>;

/** Tenant identity: names, logos, product signature, live preview (doc 09 · 9.2). */
function BrandPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const org = useQuery(orgQuery);
  const branding = org.data?.branding;
  const [draft, setDraft] = useState<Draft | null>(null);

  // Seed the draft once the data arrives (state adjusted during render, no effect).
  if (branding && !draft) {
    setDraft({
      orgName: branding.orgName,
      appName: branding.appName,
      showPoweredBy: branding.showPoweredBy,
    });
  }

  const dirty =
    Boolean(branding && draft) &&
    (draft?.orgName !== branding?.orgName ||
      draft?.appName !== branding?.appName ||
      draft?.showPoweredBy !== branding?.showPoweredBy);

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(t('admin.leaveUnsaved')),
    enableBeforeUnload: () => dirty,
  });

  const publish = useMutation({
    mutationFn: (d: Draft) =>
      api.call('updateBranding', {
        body: {
          orgName: d.orgName.trim(),
          appName: d.appName.trim(),
          showPoweredBy: d.showPoweredBy,
        },
      }),
    onSuccess: async (next) => {
      setDraft({ orgName: next.orgName, appName: next.appName, showPoweredBy: next.showPoweredBy });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.org }),
        qc.invalidateQueries({ queryKey: queryKeys.bootstrap }),
      ]);
      toast(t('admin.brand.published'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  return (
    <Workspace
      crumbs={[
        { label: t('admin.title') },
        { label: t('admin.groups.brand') },
        { label: t('admin.nav.brand') },
      ]}
    >
      <PageHeader
        title={t('admin.brand.title')}
        subtitle={t('admin.brand.subtitle')}
        actions={
          <>
            <Button
              variant="gh"
              size="sm"
              disabled={!dirty}
              onClick={() =>
                branding &&
                setDraft({
                  orgName: branding.orgName,
                  appName: branding.appName,
                  showPoweredBy: branding.showPoweredBy,
                })
              }
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={!dirty || !draft?.orgName.trim() || !draft.appName.trim()}
              loading={publish.isPending}
              onClick={() => draft && publish.mutate(draft)}
            >
              {t('admin.publish')}
            </Button>
          </>
        }
      />
      {!draft || !branding ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : (
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <SettingsCard title={t('admin.brand.identity')}>
              <SettingsRow
                label={t('admin.brand.orgName')}
                description={t('admin.brand.orgNameHint')}
                htmlFor="b-org"
              >
                <Input
                  id="b-org"
                  value={draft.orgName}
                  onChange={(e) => setDraft({ ...draft, orgName: e.target.value })}
                  maxLength={80}
                  containerClassName="h-9 w-[220px] rounded-md"
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.brand.appName')}
                description={t('admin.brand.appNameHint', { org: draft.orgName })}
                htmlFor="b-app"
              >
                <Input
                  id="b-app"
                  value={draft.appName}
                  onChange={(e) => setDraft({ ...draft, appName: e.target.value })}
                  maxLength={40}
                  containerClassName="h-9 w-[220px] rounded-md"
                />
              </SettingsRow>
            </SettingsCard>
            <SettingsCard
              title={t('admin.brand.logos')}
              aside={<span className="text-xs text-fg2">{t('admin.brand.logosHint')}</span>}
            >
              <LogoRow
                label={t('admin.brand.logoLight')}
                url={branding.logoLightUrl}
                slot="logoLight"
              />
              <LogoRow
                label={t('admin.brand.logoDark')}
                url={branding.logoDarkUrl}
                slot="logoDark"
                dark
              />
              <LogoRow label={t('admin.brand.mark')} url={branding.markUrl} slot="mark" square />
              <LogoRow
                label={t('admin.brand.favicon')}
                url={branding.faviconUrl}
                slot="favicon"
                square
              />
            </SettingsCard>
            <SettingsCard title={t('admin.brand.signature')}>
              <SettingsRow
                label={t('admin.brand.poweredBy')}
                description={t('admin.brand.poweredByHint')}
              >
                <Switch
                  aria-label={t('admin.brand.poweredBy')}
                  checked={draft.showPoweredBy}
                  onCheckedChange={(v) => setDraft({ ...draft, showPoweredBy: v })}
                />
              </SettingsRow>
            </SettingsCard>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[340px]">
            <SettingsCard
              title={t('admin.brand.preview')}
              aside={<span className="text-xs text-fg3">{t('admin.brand.previewHint')}</span>}
            >
              <div className="mb-3 flex flex-col gap-3">
                <div className="flex h-9 items-center gap-2 rounded-t-lg bg-bg2 px-3">
                  <span className="flex size-4 items-center justify-center">
                    {branding.faviconUrl ? (
                      <img src={branding.faviconUrl} alt="" className="size-4" />
                    ) : (
                      <CrewhallMark size={14} />
                    )}
                  </span>
                  <span className="truncate text-xs font-medium">
                    {draft.orgName && draft.orgName !== draft.appName
                      ? `${draft.orgName} · ${draft.appName}`
                      : draft.appName}
                  </span>
                </div>
                <div
                  data-theme="dark"
                  className="flex flex-col gap-3 rounded-lg bg-graphite p-4 text-fg"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-bold">
                      {branding.markUrl ? (
                        <img src={branding.markUrl} alt="" className="size-6 rounded-xs" />
                      ) : (
                        <CrewhallMark size={20} className="text-white" />
                      )}
                      {draft.orgName}
                    </span>
                    {draft.showPoweredBy ? (
                      <span className="inline-flex h-5 items-center gap-1 rounded-full bg-white/[.07] px-1.5 text-[10px] font-semibold text-white/70">
                        <CrewhallMark size={12} className="text-white" />
                        {t('auth.brand.poweredBy')}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-base leading-5 font-bold">
                    {t('auth.brand.titleLead', { org: draft.orgName })}{' '}
                    <em className="text-[#FBC419] not-italic">{t('auth.brand.titleAccent')}</em>
                  </span>
                </div>
              </div>
            </SettingsCard>
          </div>
        </div>
      )}
    </Workspace>
  );
}

function LogoRow({
  label,
  url,
  slot,
  dark,
  square,
}: {
  label: string;
  url: string | null;
  slot: BrandAssetSlot;
  dark?: boolean;
  square?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SettingsRow label={label} description={url ? url.split('/').pop() : t('admin.brand.noFile')}>
      <span
        data-theme={dark ? 'dark' : undefined}
        className={`flex h-10 items-center justify-center rounded-md shadow-line2 ${square ? 'w-10' : 'w-[120px]'} ${dark ? 'bg-graphite' : 'bg-bg2'}`}
      >
        {url ? (
          <img src={url} alt="" className="max-h-8 max-w-[104px] object-contain" />
        ) : (
          <Icon name="image" size={18} className="text-fg3" />
        )}
      </span>
      <BrandImageButtons slot={slot} hasImage={Boolean(url)} />
      {url ? null : <Tag tone="out">{t('admin.brand.fallback')}</Tag>}
    </SettingsRow>
  );
}

/**
 * Logo, mark and favicon upload (H5). Stored and applied at once (not part of the draft):
 * the server fits logos into 1024×256 and makes the mark 512 px, the favicon 64 px square.
 */
function BrandImageButtons({ slot, hasImage }: { slot: BrandAssetSlot; hasImage: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const apply = (branding: Branding) => {
    qc.setQueryData(queryKeys.org, (o: Organization | undefined) => (o ? { ...o, branding } : o));
    void qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
  };
  const upload = useMutation({
    mutationFn: (data: string) => api.call('uploadBrandAsset', { body: { slot, data } }),
    onSuccess: apply,
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteBrandAsset', { params: { slot } }),
    onSuccess: apply,
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const r = await readImage(file);
          if ('error' in r) toast(t(r.error));
          else upload.mutate(r.image.dataUrl);
        }}
      />
      <Button size="xs" loading={upload.isPending} onClick={() => input.current?.click()}>
        {t('admin.brand.change')}
      </Button>
      {hasImage ? (
        <Button size="xs" loading={remove.isPending} onClick={() => remove.mutate()}>
          {t('admin.brand.remove')}
        </Button>
      ) : null}
    </>
  );
}
