import { type BackupOverview, type BackupRun, type BackupSettings } from '@crewhall/shared';
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  Td,
  Th,
  TimePicker,
  Tr,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { PageHeader, SaveBar, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { backupsQuery, identityKeys } from '@/lib/identity/queries';
import { useUnsavedGuard } from './UnsavedGuard';

const KEEP = [3, 7, 14, 30, 60, 90];

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Browser zones for the picker; the saved zone stays listed even if the browser lacks it. */
function zones(current: string) {
  const list =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return list.includes(current) ? list : [current, ...list];
}

/** Yönetim › Yedekler (roadmap 3): nightly backup schedule, runs and snapshots. */
export function BackupsPage() {
  const { t } = useI18n();
  const view = useQuery(backupsQuery);
  return (
    <Workspace
      crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.backups') }]}
      searchLabel={t('admin.searchSettings')}
    >
      <PageHeader title={t('identity.backups.title')} subtitle={t('identity.backups.subtitle')} />
      {view.data ? (
        <BackupsView key={view.dataUpdatedAt} view={view.data} />
      ) : view.isError ? (
        <Notice tone="error">
          {isApiError(view.error) ? t(`errors.${view.error.code}`) : t('errors.internal')}
        </Notice>
      ) : (
        <Skeleton className="h-96 w-full rounded-2xl" />
      )}
    </Workspace>
  );
}

function BackupsView({ view }: { view: BackupOverview }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  // The form opens with what the server has. Before the first save the server only has
  // defaults; the admin's own time zone is then the starting value, not a pending change.
  const base = useMemo<BackupSettings>(
    () =>
      view.configured === false
        ? { ...view.settings, timezone: browserZone() ?? view.settings.timezone }
        : view.settings,
    [view.configured, view.settings],
  );
  const [draft, setDraft] = useState<BackupSettings>(base);
  const changes = (Object.keys(base) as (keyof BackupSettings)[]).filter(
    (k) => draft[k] !== base[k],
  ).length;
  const zoneList = useMemo(() => zones(draft.timezone), [draft.timezone]);

  const guard = useUnsavedGuard(changes > 0);

  const save = useMutation({
    mutationFn: () => api.call('updateBackupSettings', { body: draft }),
    onSuccess: (next) => {
      qc.setQueryData(identityKeys.backups, next);
      setDraft(next.settings);
      toast(t('ui.saved'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const start = useMutation({
    mutationFn: () => api.call('startBackup'),
    onSuccess: () => {
      toast(t('identity.backups.started'));
      void qc.invalidateQueries({ queryKey: identityKeys.backups });
    },
    onError: (e) =>
      toast(
        isApiError(e, 'conflict')
          ? t('identity.backups.busy')
          : isApiError(e)
            ? t(`errors.${e.code}`)
            : t('errors.internal'),
      ),
  });

  const set = <K extends keyof BackupSettings>(k: K, v: BackupSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const busy = view.runs.some((r) => r.status === 'queued' || r.status === 'running');
  const last = view.runs.find((r) => r.status === 'succeeded' || r.status === 'failed');
  const when = (iso: string) => `${formatDate(iso, locale)} ${formatTime(iso, locale)}`;

  return (
    <>
      {!view.available ? (
        <Notice tone="warn" className="mb-5">
          {t('identity.backups.unavailable')}
        </Notice>
      ) : null}
      {view.pgTools && !view.pgTools.compatible ? (
        <Notice tone="warn" className="mb-5">
          {view.pgTools.client === null
            ? t('identity.backups.toolsMissing', { server: view.pgTools.server ?? '?' })
            : t('identity.backups.toolsOutdated', {
                client: view.pgTools.client,
                server: view.pgTools.server ?? '?',
              })}
        </Notice>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 pb-20 xl:grid-cols-2">
        <SettingsCard title={t('identity.backups.schedule')}>
          <SettingsRow
            label={t('identity.backups.enabled')}
            description={t('identity.backups.enabledHint')}
          >
            <Switch
              aria-label={t('identity.backups.enabled')}
              checked={draft.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
          </SettingsRow>
          <SettingsRow label={t('identity.backups.time')} htmlFor="backup-time">
            <TimePicker
              id="backup-time"
              value={draft.time}
              onChange={(v) => v && set('time', v)}
              clearable={false}
              minuteStep={15}
              aria-label={t('identity.backups.time')}
            />
          </SettingsRow>
          <SettingsRow label={t('identity.backups.timezone')}>
            <Select value={draft.timezone} onValueChange={(v) => set('timezone', v)}>
              <SelectTrigger aria-label={t('identity.backups.timezone')} className="h-9 w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {zoneList.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            label={t('identity.backups.keep')}
            description={t('identity.backups.keepHint')}
          >
            <Select value={String(draft.keep)} onValueChange={(v) => set('keep', Number(v))}>
              <SelectTrigger aria-label={t('identity.backups.keep')} className="h-9 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...KEEP, draft.keep])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t('identity.backups.keepCount', { count: n })}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard
          title={t('identity.backups.status')}
          aside={
            <Button
              size="sm"
              onClick={() => start.mutate()}
              disabled={busy || start.isPending || !view.available}
            >
              {busy ? t('identity.backups.running') : t('identity.backups.runNow')}
            </Button>
          }
        >
          <SettingsRow label={t('identity.backups.next')}>
            <span className="text-cap text-fg2">
              {view.nextRunAt ? when(view.nextRunAt) : t('identity.backups.off')}
            </span>
          </SettingsRow>
          <SettingsRow label={t('identity.backups.last')}>
            {last ? <RunBadge run={last} /> : <span className="text-cap text-fg2">—</span>}
          </SettingsRow>
          <SettingsRow
            label={t('identity.backups.disk')}
            description={t('identity.backups.diskHint')}
          >
            <span className="text-cap text-fg2">
              {view.diskBytes === null ? '—' : formatBytes(view.diskBytes, locale)}
            </span>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title={t('identity.backups.snapshots')} className="xl:col-span-2">
          {view.snapshots.length === 0 ? (
            <p className="py-3 text-cap text-fg2">{t('identity.backups.noSnapshots')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>{t('identity.backups.col.date')}</Th>
                    <Th>{t('identity.backups.col.kind')}</Th>
                    <Th>{t('identity.backups.col.version')}</Th>
                    <Th>{t('identity.backups.col.size')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {view.snapshots.map((s) => (
                    <Tr key={s.id}>
                      <Td>
                        <div className="flex flex-col">
                          <span>{when(s.createdAt)}</span>
                          <span className="font-mono text-[11.5px] text-fg3">{s.id}</span>
                        </div>
                      </Td>
                      <Td>
                        <Badge plain>{t(`identity.backups.trigger.${s.trigger}`)}</Badge>
                        {s.config ? (
                          <Badge plain tone="info" className="ml-1">
                            {t('identity.backups.withConfig')}
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="font-mono text-[12px]">{s.version}</Td>
                      <Td>
                        {t('identity.backups.size', {
                          size: formatBytes(s.dbBytes, locale),
                          count: s.objectCount,
                          used: formatBytes(s.objectBytes, locale),
                        })}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <p className="border-t border-line py-3 text-cap text-fg2">
            {t('identity.backups.restoreHint')}{' '}
            <code className="font-mono text-[12px]">
              tools/crewhall/crewhall restore &lt;id&gt;
            </code>
          </p>
        </SettingsCard>

        <SettingsCard title={t('identity.backups.runs')} className="xl:col-span-2">
          {view.runs.length === 0 ? (
            <p className="py-3 text-cap text-fg2">{t('identity.backups.noRuns')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>{t('identity.backups.col.date')}</Th>
                    <Th>{t('identity.backups.col.kind')}</Th>
                    <Th>{t('identity.backups.col.status')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {view.runs.map((r) => (
                    <Tr key={r.id}>
                      <Td>{when(r.startedAt ?? r.createdAt)}</Td>
                      <Td>
                        {t(`identity.backups.trigger.${r.trigger}`)}
                        {r.requestedBy ? (
                          <span className="text-fg3"> · {r.requestedBy.name}</span>
                        ) : null}
                      </Td>
                      <Td>
                        <RunBadge run={r} />
                        {r.error ? (
                          <div className="mt-1 max-w-[320px] text-[12px] break-words text-danger">
                            {r.error}
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </SettingsCard>
      </div>
      <SaveBar
        count={changes}
        saving={save.isPending}
        onCancel={() => setDraft(base)}
        onSave={() => save.mutate()}
      />
      {guard}
    </>
  );
}

function RunBadge({ run }: { run: BackupRun }) {
  const { t } = useI18n();
  const tone =
    run.status === 'succeeded'
      ? 'ok'
      : run.status === 'failed'
        ? 'danger'
        : run.status === 'running'
          ? 'info'
          : 'default';
  return <Badge tone={tone}>{t(`identity.backups.state.${run.status}`)}</Badge>;
}
