import {
  type CompliancePolicy,
  type ComplianceOverview,
  type DlpRule,
  type EdiscoveryContent,
  type EdiscoveryExport,
  type LegalHold,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  CheckboxRow,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  IconButton,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader, SaveBar, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { endOfDay } from '@/components/identity/GuestBadge';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { complianceQuery, identityKeys } from '@/lib/identity/queries';
import { useUnsavedGuard } from './UnsavedGuard';
import { membersQuery, orgSpacesQuery } from '@/lib/queries';

const CHAT_DAYS = [30, 90, 180, 365, 730, 1825, 3650];
const AUDIT_DAYS = [365, 730, 1095, 1825, 3650];
const CONTENT: EdiscoveryContent[] = ['chat', 'pages', 'cards', 'files', 'audit'];

/** Yönetim › Uyumluluk (roadmap 25): retention, legal hold, eDiscovery and DLP. */
export function CompliancePage() {
  const { t } = useI18n();
  const view = useQuery(complianceQuery);
  return (
    <Workspace
      crumbs={[{ label: t('admin.title') }, { label: t('identity.nav.compliance') }]}
      searchLabel={t('admin.searchSettings')}
    >
      <PageHeader
        title={t('identity.compliance.title')}
        subtitle={t('identity.compliance.subtitle')}
      />
      {view.data ? (
        <ComplianceView key={view.dataUpdatedAt} view={view.data} />
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

function errorText(t: ReturnType<typeof useI18n>['t'], e: unknown) {
  return isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal');
}

function ComplianceView({ view }: { view: ComplianceOverview }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CompliancePolicy>(view.policy);
  const changes = JSON.stringify(draft) === JSON.stringify(view.policy) ? 0 : 1;
  const [holdOpen, setHoldOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const guard = useUnsavedGuard(changes > 0);

  const save = useMutation({
    mutationFn: () => api.call('updateCompliancePolicy', { body: draft }),
    onSuccess: (next) => {
      qc.setQueryData(identityKeys.compliance, next);
      toast(t('ui.saved'));
    },
    onError: (e) => toast(errorText(t, e)),
  });

  const setRule = (id: string, patch: Partial<DlpRule>) =>
    setDraft((d) => ({
      ...d,
      dlp: { rules: d.dlp.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) },
    }));

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-5 pb-20 xl:grid-cols-2">
        <SettingsCard title={t('identity.compliance.retention')}>
          <SettingsRow
            label={t('identity.compliance.chatDays')}
            description={t('identity.compliance.chatDaysHint')}
          >
            <DaysSelect
              value={draft.retention.chatDays}
              options={CHAT_DAYS}
              label={t('identity.compliance.chatDays')}
              onChange={(v) =>
                setDraft((d) => ({ ...d, retention: { ...d.retention, chatDays: v } }))
              }
            />
          </SettingsRow>
          <SettingsRow
            label={t('identity.compliance.auditDays')}
            description={t('identity.compliance.auditDaysHint')}
          >
            <DaysSelect
              value={draft.retention.auditDays}
              options={AUDIT_DAYS}
              label={t('identity.compliance.auditDays')}
              onChange={(v) =>
                setDraft((d) => ({ ...d, retention: { ...d.retention, auditDays: v } }))
              }
            />
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title={t('identity.compliance.dlp')}>
          <p className="pb-2 text-cap text-fg2">{t('identity.compliance.dlpHint')}</p>
          {draft.dlp.rules.map((r) => (
            <SettingsRow
              key={r.id}
              label={
                r.detector === 'custom' ? r.name : t(`identity.compliance.detector.${r.detector}`)
              }
              description={r.detector === 'custom' ? r.pattern : undefined}
            >
              <div className="flex items-center gap-2">
                <Select
                  value={r.action}
                  onValueChange={(v) => setRule(r.id, { action: v as DlpRule['action'] })}
                >
                  <SelectTrigger
                    aria-label={t('identity.compliance.action')}
                    className="h-9 w-[120px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="warn">{t('identity.compliance.warn')}</SelectItem>
                    <SelectItem value="block">{t('identity.compliance.block')}</SelectItem>
                  </SelectContent>
                </Select>
                <Switch
                  aria-label={t('identity.compliance.ruleOn')}
                  checked={r.enabled}
                  onCheckedChange={(v) => setRule(r.id, { enabled: v })}
                />
                {r.detector === 'custom' ? (
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('common.actions.delete')}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        dlp: { rules: d.dlp.rules.filter((x) => x.id !== r.id) },
                      }))
                    }
                  >
                    <Icon name="trash" size={16} />
                  </IconButton>
                ) : null}
              </div>
            </SettingsRow>
          ))}
          <CustomRuleForm
            disabled={draft.dlp.rules.length >= 20}
            onAdd={(rule) => setDraft((d) => ({ ...d, dlp: { rules: [...d.dlp.rules, rule] } }))}
          />
        </SettingsCard>

        <SettingsCard
          title={t('identity.compliance.holds')}
          className="xl:col-span-2"
          aside={
            <Button size="sm" onClick={() => setHoldOpen(true)}>
              {t('identity.compliance.newHold')}
            </Button>
          }
        >
          <p className="pb-2 text-cap text-fg2">{t('identity.compliance.holdsHint')}</p>
          {view.holds.length === 0 ? (
            <p className="py-3 text-cap text-fg2">{t('identity.compliance.noHolds')}</p>
          ) : (
            view.holds.map((h) => <HoldRow key={h.id} hold={h} />)
          )}
        </SettingsCard>

        <SettingsCard
          title={t('identity.compliance.exports')}
          className="xl:col-span-2"
          aside={
            <Button size="sm" onClick={() => setExportOpen(true)}>
              {t('identity.compliance.newExport')}
            </Button>
          }
        >
          <p className="pb-2 text-cap text-fg2">{t('identity.compliance.exportsHint')}</p>
          {view.exports.length === 0 ? (
            <p className="py-3 text-cap text-fg2">{t('identity.compliance.noExports')}</p>
          ) : (
            view.exports.map((e) => <ExportRow key={e.id} item={e} />)
          )}
        </SettingsCard>
      </div>
      <SaveBar
        count={changes}
        saving={save.isPending}
        onCancel={() => setDraft(view.policy)}
        onSave={() => save.mutate()}
      />
      <Dialog open={holdOpen} onOpenChange={setHoldOpen}>
        {holdOpen ? <HoldForm onClose={() => setHoldOpen(false)} /> : null}
      </Dialog>
      {guard}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        {exportOpen ? <ExportForm onClose={() => setExportOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function DaysSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: number | null;
  options: number[];
  label: string;
  onChange: (v: number | null) => void;
}) {
  const { t } = useI18n();
  const list =
    value && !options.includes(value) ? [...options, value].sort((a, b) => a - b) : options;
  return (
    <Select
      value={value ? String(value) : 'keep'}
      onValueChange={(v) => onChange(v === 'keep' ? null : Number(v))}
    >
      <SelectTrigger aria-label={label} className="h-9 w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="keep">{t('identity.compliance.keepAll')}</SelectItem>
        {list.map((d) => (
          <SelectItem key={d} value={String(d)}>
            {d % 365 === 0
              ? t('identity.compliance.years', { count: d / 365 })
              : t('identity.compliance.days', { count: d })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CustomRuleForm({ onAdd, disabled }: { onAdd: (r: DlpRule) => void; disabled: boolean }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  let valid = name.trim().length > 0 && pattern.length > 0;
  try {
    if (pattern) new RegExp(pattern, 'iu');
  } catch {
    valid = false;
  }
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line py-3">
      <Field label={t('identity.compliance.customName')} className="min-w-[140px] flex-1">
        <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('identity.compliance.customPattern')} className="min-w-[160px] flex-1">
        <Input
          value={pattern}
          maxLength={200}
          className="font-mono"
          onChange={(e) => setPattern(e.target.value)}
        />
      </Field>
      <Button
        size="sm"
        disabled={!valid || disabled}
        onClick={() => {
          onAdd({
            id: `custom-${Date.now().toString(36)}`,
            detector: 'custom',
            name: name.trim(),
            pattern,
            enabled: true,
            action: 'warn',
          });
          setName('');
          setPattern('');
        }}
      >
        {t('identity.compliance.addRule')}
      </Button>
    </div>
  );
}

function HoldRow({ hold }: { hold: LegalHold }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const release = useMutation({
    mutationFn: () => api.call('releaseLegalHold', { params: { holdId: hold.id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: identityKeys.compliance }),
    onError: (e) => toast(errorText(t, e)),
  });
  const scope = [...hold.users.map((u) => u.name), ...hold.spaces.map((s) => s.name)].join(', ');
  return (
    <div className="flex items-start justify-between gap-3 border-t border-line py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {hold.name}
          {hold.releasedAt ? (
            <Badge plain>{t('identity.compliance.released')}</Badge>
          ) : (
            <Badge tone="warn">{t('identity.compliance.active')}</Badge>
          )}
        </span>
        <span className="text-cap text-fg2">{scope}</span>
        {hold.reason ? <span className="text-xs text-fg3">{hold.reason}</span> : null}
        <span className="text-xs text-fg3">
          {t('identity.compliance.since', {
            date: formatDate(hold.createdAt, locale),
            name: hold.createdBy?.name ?? '—',
          })}
        </span>
      </div>
      {hold.releasedAt ? null : (
        <Button
          size="sm"
          variant="gh"
          loading={release.isPending}
          onClick={() =>
            window.confirm(t('identity.compliance.releaseConfirm')) && release.mutate()
          }
        >
          {t('identity.compliance.release')}
        </Button>
      )}
    </div>
  );
}

function ExportRow({ item }: { item: EdiscoveryExport }) {
  const { t, locale } = useI18n();
  const download = useMutation({
    mutationFn: () => api.call('getEdiscoveryDownload', { params: { exportId: item.id } }),
    onSuccess: (link) => {
      window.location.href = link.url;
    },
    onError: (e) => toast(errorText(t, e)),
  });
  const tone = item.status === 'ready' ? 'ok' : item.status === 'failed' ? 'danger' : 'info';
  const counts = item.counts
    ? Object.entries(item.counts)
        .filter(([k]) => ['chatMessages', 'pages', 'cards', 'files', 'auditEntries'].includes(k))
        .map(([k, n]) => `${t(`identity.compliance.count.${k as 'pages'}`)} ${n}`)
        .join(' · ')
    : '';
  return (
    <div className="flex items-start justify-between gap-3 border-t border-line py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {item.name}
          <Badge tone={tone}>{t(`identity.compliance.state.${item.status}`)}</Badge>
        </span>
        <span className="text-cap text-fg2">
          {formatDate(item.createdAt, locale)}
          {item.requestedBy ? ` · ${item.requestedBy.name}` : ''}
          {item.sizeBytes ? ` · ${formatBytes(item.sizeBytes, locale)}` : ''}
        </span>
        {counts ? <span className="text-xs text-fg3">{counts}</span> : null}
        {item.error ? <span className="text-xs text-danger">{item.error}</span> : null}
      </div>
      {item.status === 'ready' ? (
        <Button
          size="sm"
          variant="gh"
          loading={download.isPending}
          onClick={() => download.mutate()}
        >
          {t('identity.compliance.download')}
        </Button>
      ) : null}
    </div>
  );
}

/** People and spaces to cover: the org directory and every shared space. */
function ScopePicker({
  userIds,
  spaceIds,
  onUsers,
  onSpaces,
}: {
  userIds: string[];
  spaceIds: string[];
  onUsers: (ids: string[]) => void;
  onSpaces: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const people = useQuery(membersQuery({ q: q || undefined, limit: 50 }));
  const spaces = useQuery(orgSpacesQuery());
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={t('identity.compliance.people')}>
        <div className="flex flex-col gap-2 rounded-xl p-2 shadow-line">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('identity.compliance.searchPeople')}
            containerClassName="h-8"
          />
          <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto px-1">
            {(people.data?.items ?? []).map((m) => (
              <CheckboxRow
                key={m.user.id}
                checked={userIds.includes(m.user.id)}
                onCheckedChange={(v) => onUsers(toggle(userIds, m.user.id, v === true))}
              >
                {m.user.name} <span className="text-fg3">{m.user.email}</span>
              </CheckboxRow>
            ))}
          </div>
        </div>
      </Field>
      <Field label={t('identity.compliance.spaces')}>
        <div className="flex max-h-[232px] flex-col gap-1.5 overflow-y-auto rounded-xl p-3 shadow-line">
          {(spaces.data?.items ?? []).map((s) => (
            <CheckboxRow
              key={s.id}
              checked={spaceIds.includes(s.id)}
              onCheckedChange={(v) => onSpaces(toggle(spaceIds, s.id, v === true))}
            >
              {s.name}
            </CheckboxRow>
          ))}
        </div>
      </Field>
    </div>
  );
}

function HoldForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api.call('createLegalHold', {
        body: { name: name.trim(), reason: reason.trim() || undefined, userIds, spaceIds },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: identityKeys.compliance });
      toast(t('identity.compliance.holdCreated'));
      onClose();
    },
    onError: (e) => toast(errorText(t, e)),
  });
  const valid = name.trim().length > 0 && userIds.length + spaceIds.length > 0;
  return (
    <DialogContent width={640}>
      <DialogHeader
        icon="lock"
        title={t('identity.compliance.newHold')}
        description={t('identity.compliance.holdsHint')}
      />
      <Field label={t('identity.compliance.holdName')}>
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('identity.compliance.reason')}>
        <Textarea
          value={reason}
          maxLength={2000}
          rows={2}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ScopePicker
        userIds={userIds}
        spaceIds={spaceIds}
        onUsers={setUserIds}
        onSpaces={setSpaceIds}
      />
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!valid}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          {t('identity.compliance.startHold')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ExportForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [include, setInclude] = useState<EdiscoveryContent[]>(['chat', 'pages', 'cards']);
  const create = useMutation({
    mutationFn: () =>
      api.call('createEdiscoveryExport', {
        body: {
          name: name.trim(),
          scope: {
            userIds,
            spaceIds,
            from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
            to: to ? endOfDay(to) : null,
            include,
          },
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: identityKeys.compliance });
      toast(t('identity.compliance.exportStarted'));
      onClose();
    },
    onError: (e) => toast(errorText(t, e)),
  });
  const valid =
    name.trim().length > 0 && userIds.length + spaceIds.length > 0 && include.length > 0;
  return (
    <DialogContent width={640}>
      <DialogHeader
        icon="download"
        title={t('identity.compliance.newExport')}
        description={t('identity.compliance.exportsHint')}
      />
      <Field label={t('identity.compliance.exportName')}>
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ScopePicker
        userIds={userIds}
        spaceIds={spaceIds}
        onUsers={setUserIds}
        onSpaces={setSpaceIds}
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('identity.compliance.from')}>
          <DatePicker
            value={from}
            onChange={setFrom}
            max={to}
            aria-label={t('identity.compliance.from')}
          />
        </Field>
        <Field label={t('identity.compliance.to')}>
          <DatePicker
            value={to}
            onChange={setTo}
            min={from}
            aria-label={t('identity.compliance.to')}
          />
        </Field>
      </div>
      <Field label={t('identity.compliance.include')}>
        <div className="flex flex-wrap gap-4">
          {CONTENT.map((c) => (
            <CheckboxRow
              key={c}
              checked={include.includes(c)}
              onCheckedChange={(v) =>
                setInclude((list) => (v === true ? [...list, c] : list.filter((x) => x !== c)))
              }
            >
              {t(`identity.compliance.content.${c}`)}
            </CheckboxRow>
          ))}
        </div>
      </Field>
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!valid}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          {t('identity.compliance.startExport')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
