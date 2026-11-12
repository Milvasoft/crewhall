import { queryKeys } from '@crewhall/api-client';
import { TRASH_RETENTION_DAYS, type OrgSettings } from '@crewhall/shared';
import { Icon, Input, Segmented, Skeleton, Switch, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useBlocker } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader, SaveBar, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { ModulesCard } from '@/components/identity/ModulesCard';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { countModuleChanges } from '@/lib/identity/modules';
import { orgQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { DesktopReleaseCard } from '@/components/account/DesktopDownload';

export const Route = createFileRoute('/_app/admin/general')({
  component: GeneralPage,
});

/** Days 1-3650; the field keeps what is typed and reports only valid numbers. */
function TrashDaysInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  // Follow outside changes (cancel, save) without an effect.
  if (value !== seen) {
    setSeen(value);
    setText(String(value));
  }
  const n = Number(text);
  const invalid = !Number.isInteger(n) || n < 1 || n > 3650;
  return (
    <div className="flex items-center gap-2">
      <Input
        id="trash-days"
        type="number"
        inputMode="numeric"
        min={1}
        max={3650}
        value={text}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (Number.isInteger(next) && next >= 1 && next <= 3650) {
            setSeen(next);
            onChange(next);
          }
        }}
        disabled={disabled}
        containerClassName="h-9 w-[96px] rounded-md"
      />
      <span className="text-cap text-fg2">{t('admin.general.trashDaysUnit')}</span>
    </div>
  );
}

interface Draft {
  name: string;
  settings: OrgSettings;
}

/** Org identity, regional defaults and policies (doc 09 · 9.1); saved together via the bar. */
function GeneralPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { canOrg } = usePermissions();
  const org = useQuery(orgQuery);
  const [draft, setDraft] = useState<Draft | null>(null);

  // Seed the draft once the data arrives (state adjusted during render, no effect).
  if (org.data && !draft) setDraft({ name: org.data.name, settings: org.data.settings });

  const base = org.data ? { name: org.data.name, settings: org.data.settings } : null;
  const changes =
    base && draft
      ? Number(base.name !== draft.name) +
        (Object.keys(draft.settings) as (keyof OrgSettings)[]).filter(
          (k) => k !== 'modules' && draft.settings[k] !== base.settings[k],
        ).length +
        countModuleChanges(base.settings, draft.settings)
      : 0;

  useBlocker({
    shouldBlockFn: () => changes > 0 && !window.confirm(t('admin.leaveUnsaved')),
    enableBeforeUnload: () => changes > 0,
  });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.call('updateOrg', { body: { name: d.name.trim(), settings: d.settings } }),
    onSuccess: async (next) => {
      qc.setQueryData(queryKeys.org, next);
      setDraft({ name: next.name, settings: next.settings });
      await qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      toast(t('ui.saved'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) =>
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, [k]: v } } : d));
  const editable = canOrg('org.update_settings');

  return (
    <Workspace
      crumbs={[{ label: t('admin.title') }, { label: t('admin.nav.general') }]}
      searchLabel={t('admin.searchSettings')}
    >
      <PageHeader title={t('admin.general.title')} subtitle={t('admin.general.subtitle')} />
      {!draft || !org.data ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 pb-20 xl:grid-cols-2">
          {/* Two balanced columns: the short cards together on the left, policies (long) on
              the right, so neither column leaves an empty area above the modules. */}
          <div className="flex flex-col gap-5">
            <SettingsCard title={t('admin.general.org')}>
              <SettingsRow
                label={t('admin.general.name')}
                description={t('admin.general.nameHint')}
                htmlFor="org-name"
              >
                <Input
                  id="org-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  disabled={!editable}
                  maxLength={80}
                  containerClassName="h-9 w-[220px] rounded-md"
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.general.slug')}
                description={t('admin.general.slugHint')}
              >
                <span className="font-mono text-cap">{org.data.slug}</span>
                <Icon name="lock" size={14} className="text-fg3" />
              </SettingsRow>
            </SettingsCard>
            <SettingsCard title={t('admin.general.region')}>
              <SettingsRow
                label={t('admin.general.locale')}
                description={t('admin.general.localeHint')}
              >
                <Segmented
                  aria-label={t('admin.general.locale')}
                  value={draft.settings.defaultLocale}
                  onValueChange={(v) => set('defaultLocale', v)}
                  options={[
                    { value: 'tr', label: t('prefs.languages.tr'), disabled: !editable },
                    { value: 'en', label: t('prefs.languages.en'), disabled: !editable },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
            <DesktopReleaseCard />
          </div>
          <div className="flex flex-col gap-5">
            <SettingsCard title={t('admin.general.policies')}>
              <SettingsRow
                label={t('admin.general.require2fa')}
                description={t('admin.general.require2faHint')}
              >
                <Switch
                  aria-label={t('admin.general.require2fa')}
                  checked={draft.settings.requireTwoFactor}
                  onCheckedChange={(v) => set('requireTwoFactor', v)}
                  disabled={!editable}
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.general.membersCreate')}
                description={t('admin.general.membersCreateHint')}
              >
                <Switch
                  aria-label={t('admin.general.membersCreate')}
                  checked={draft.settings.membersCanCreateSpaces}
                  onCheckedChange={(v) => set('membersCanCreateSpaces', v)}
                  disabled={!editable}
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.general.publicLinks')}
                description={t('admin.general.publicLinksHint')}
              >
                <Switch
                  aria-label={t('admin.general.publicLinks')}
                  checked={draft.settings.publicLinksEnabled}
                  onCheckedChange={(v) => set('publicLinksEnabled', v)}
                  disabled={!editable}
                />
              </SettingsRow>
              <SettingsRow
                label={t('chat.admin.deleteForEveryone')}
                description={t('chat.admin.deleteForEveryoneHint')}
              >
                <Switch
                  aria-label={t('chat.admin.deleteForEveryone')}
                  checked={draft.settings.chatDeleteForEveryone !== false}
                  onCheckedChange={(v) => set('chatDeleteForEveryone', v)}
                  disabled={!editable}
                />
              </SettingsRow>
              <SettingsRow
                label={t('meet.admin.remoteControl')}
                description={t('meet.admin.remoteControlHint')}
              >
                <Switch
                  aria-label={t('meet.admin.remoteControl')}
                  checked={draft.settings.meetRemoteControl !== false}
                  onCheckedChange={(v) => set('meetRemoteControl', v)}
                  disabled={!editable}
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.general.trashDays')}
                description={t('admin.general.trashDaysHint')}
                htmlFor="trash-days"
              >
                <TrashDaysInput
                  value={draft.settings.trashRetentionDays ?? TRASH_RETENTION_DAYS}
                  onChange={(v) => set('trashRetentionDays', v)}
                  disabled={!editable}
                />
              </SettingsRow>
            </SettingsCard>
          </div>
          <ModulesCard
            settings={draft.settings}
            onChange={(settings) => setDraft({ ...draft, settings })}
            disabled={!editable}
          />
        </div>
      )}
      <SaveBar
        count={changes}
        saving={save.isPending}
        onCancel={() => base && setDraft(base)}
        onSave={() => draft && save.mutate(draft)}
      />
    </Workspace>
  );
}
