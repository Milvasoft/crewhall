import { queryKeys } from '@crewhall/api-client';
import { type AppLocale } from '@crewhall/i18n';
import { Avatar, Badge, Button, Icon, Input, Segmented, toast } from '@crewhall/ui';
import { type Appearance } from '@crewhall/ui/theme';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import {
  IMAGE_ACCEPT,
  ImageCropDialog,
  readImage,
  type PickedImage,
} from '@/components/account/ImageCropDialog';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgQuery, spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { useTheme } from '@/lib/theme/ThemeContext';

export const Route = createFileRoute('/_app/account/profile')({
  component: ProfilePage,
});

/** Profile (doc 09 · 9.18). Fields save on blur; role and spaces are read-only here. */
function ProfilePage() {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const { me, role } = usePermissions();
  const { appearance, setAppearance } = useTheme();
  const org = useQuery(orgQuery);
  const spaces = useQuery(spacesQuery());
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: (body: { name?: string; locale?: AppLocale }) => api.call('updateMe', { body }),
    onSuccess: (next) => {
      qc.setQueryData(queryKeys.me, next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    },
  });

  if (!me) return null;
  const membership = me.memberships.find((m) => m.orgId === me.activeOrgId);

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('account.nav.profile') }]}>
      <PageHeader
        title={t('account.profile.title')}
        subtitle={t('account.profile.subtitle')}
        actions={
          saved ? (
            <span className="flex items-center gap-1.5 text-cap text-success" role="status">
              <Icon name="checkC" size={16} />
              {t('ui.saved')}
            </span>
          ) : null
        }
      />
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <SettingsCard>
            <div className="flex items-center gap-4 py-3">
              <Avatar name={me.user.name} src={me.user.imageUrl} size="lg" />
              <div className="flex flex-1 flex-col">
                <span className="text-cap font-semibold">{t('account.profile.photo')}</span>
                <span className="text-xs text-fg2">{t('account.profile.photoHint')}</span>
              </div>
              <AvatarUpload hasPhoto={Boolean(me.user.imageUrl)} />
            </div>
            <SettingsRow label={t('auth.fields.name')} htmlFor="p-name">
              <Input
                id="p-name"
                key={me.user.name}
                defaultValue={me.user.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== me.user.name) update.mutate({ name });
                }}
                maxLength={80}
                containerClassName="h-9 w-[260px] rounded-md"
              />
            </SettingsRow>
            <SettingsRow label={t('auth.fields.email')}>
              <span className="text-cap">{me.user.email}</span>
              <Badge tone="ok">{t('account.profile.verified')}</Badge>
            </SettingsRow>
          </SettingsCard>
          <SettingsCard title={t('account.profile.preferences')}>
            <SettingsRow
              label={t('prefs.language')}
              description={t('account.profile.orgDefault', {
                language: t(`prefs.languages.${org.data?.settings.defaultLocale ?? 'tr'}`),
              })}
            >
              <Segmented
                aria-label={t('prefs.language')}
                value={locale}
                onValueChange={(l: AppLocale) => {
                  setLocale(l);
                  update.mutate({ locale: l });
                }}
                options={[
                  { value: 'tr', label: t('prefs.languages.tr') },
                  { value: 'en', label: t('prefs.languages.en') },
                ]}
              />
            </SettingsRow>
            <SettingsRow label={t('prefs.theme')}>
              <Segmented
                aria-label={t('prefs.theme')}
                value={appearance}
                onValueChange={(a: Appearance) => setAppearance(a)}
                options={[
                  { value: 'system', label: t('prefs.appearance.system') },
                  { value: 'light', label: t('prefs.appearance.light') },
                  { value: 'dark', label: t('prefs.appearance.dark') },
                ]}
              />
            </SettingsRow>
          </SettingsCard>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[340px]">
          <SettingsCard title={t('account.profile.inOrg')}>
            <SettingsRow
              label={membership?.orgName ?? ''}
              description={
                org.data
                  ? t('account.profile.since', { date: formatDateLong(org.data.createdAt, locale) })
                  : undefined
              }
            >
              <span className="text-cap font-semibold">{t(`admin.members.role.${role}`)}</span>
            </SettingsRow>
          </SettingsCard>
          <SettingsCard title={t('admin.nav.spaces')}>
            {(spaces.data?.items ?? []).map((s) => (
              <div
                key={s.id}
                className="flex min-h-11 items-center gap-2.5 border-t border-line first:border-t-0"
              >
                <SpaceAvatar space={s} size="sm" />
                <span className="flex-1 text-cap font-medium">{spaceName(s, t)}</span>
                <span className="text-xs text-fg2">
                  {s.kind === 'personal'
                    ? t('spaces.onlyYou')
                    : t(`common.roles.space.${s.myRole}`)}
                </span>
              </div>
            ))}
            <p className="m-0 border-t border-line py-2.5 text-xs text-fg3">
              {t('account.profile.roleNote')}
            </p>
          </SettingsCard>
        </div>
      </div>
    </Workspace>
  );
}

/** Profile photo (H5): pick, crop to a square, upload; the server resizes to 512 px. */
function AvatarUpload({ hasPhoto }: { hasPhoto: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: queryKeys.me });
  const upload = useMutation({
    mutationFn: (crop: { x: number; y: number; size: number }) =>
      api.call('uploadAvatar', { body: { data: picked!.dataUrl, crop } }),
    onSuccess: () => {
      setPicked(null);
      done();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteAvatar'),
    onSuccess: done,
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <div className="flex items-center gap-2">
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
          else setPicked(r.image);
        }}
      />
      {hasPhoto ? (
        <Button size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
          {t('account.profile.removePhoto')}
        </Button>
      ) : null}
      <Button size="sm" onClick={() => input.current?.click()}>
        <Icon name="upload" size={16} />
        {t('account.profile.upload')}
      </Button>
      <ImageCropDialog
        image={picked}
        saving={upload.isPending}
        onCancel={() => setPicked(null)}
        onSave={(crop) => upload.mutate(crop)}
      />
    </div>
  );
}
