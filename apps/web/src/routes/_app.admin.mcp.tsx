import {
  LOCKED_APPROVAL_RULES,
  MCP_LIMITS,
  MCP_SCOPES,
  ApprovalRule,
  type McpOrgConnection,
  type McpPolicy,
  type UpdateMcpPolicy,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  IconBox,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  Tabs,
  TabsList,
  TabsTrigger,
  Tag,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { PageHeader } from '@/components/admin/Settings';
import { Card } from '@/components/mcp/Overview';
import { ConfirmDialog, CopyField, useConfirm } from '@/components/mcp/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesLabel } from '@/lib/mcp/format';
import {
  clientsQuery,
  mcpKeys,
  orgConnectionsQuery,
  overviewQuery,
  policyQuery,
  usageQuery,
} from '@/lib/mcp/queries';

const TABS = ['policy', 'connections', 'webhooks', 'usage'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/admin/mcp')({
  validateSearch: z.object({ tab: z.enum(TABS).optional() }),
  component: AdminMcpPage,
});

/** Yönetim › MCP ve API (design 18.10, 18.14): the policy is the ceiling of every connection. */
function AdminMcpPage() {
  const { t } = useI18n();
  const { tab: active = 'policy' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const connections = useQuery(orgConnectionsQuery);

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('mcp.admin.title') }]}>
      <PageHeader title={t('mcp.admin.title')} subtitle={t('mcp.admin.subtitle')} />
      <Tabs value={active} onValueChange={(v) => void navigate({ search: { tab: v as Tab } })}>
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`mcp.admin.tabs.${tab}`)}
              {tab === 'connections' && connections.data ? (
                <span className="ml-1 text-fg3">{connections.data.items.length}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {active === 'policy' ? (
        <>
          <PolicyTab />
          <ConnectionsTable />
        </>
      ) : active === 'connections' ? (
        <ConnectionsTable />
      ) : active === 'webhooks' ? (
        <WebhooksTab />
      ) : (
        <UsageTab />
      )}
    </Workspace>
  );
}

function usePolicyMutation() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMcpPolicy) => api.call('updateMcpPolicy', { body }),
    onSuccess: async (next) => {
      qc.setQueryData(mcpKeys.policy, next);
      toast(t('mcp.admin.saved'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
}

function PolicyTab() {
  const { t } = useI18n();
  const policy = useQuery(policyQuery);
  const overview = useQuery(overviewQuery);
  const save = usePolicyMutation();
  const p = policy.data;
  if (!p) return <Skeleton className="h-96 rounded-2xl" />;
  const set = (patch: UpdateMcpPolicy) => save.mutate(patch);

  return (
    <div className="grid items-start gap-4 xl:grid-cols-3">
      <div className="flex flex-col gap-4">
        <Card>
          <ToggleRow
            label={t('mcp.admin.server')}
            hint={overview.data?.serverUrl}
            checked={p.enabled}
            onChange={(v) => set({ enabled: v })}
          />
          <ToggleRow
            label={t('mcp.admin.pats')}
            hint={t('mcp.admin.patsHint')}
            checked={p.patsEnabled}
            onChange={(v) => set({ patsEnabled: v })}
          />
          <ToggleRow
            label={t('mcp.admin.guests')}
            checked={p.guestsAllowed}
            onChange={(v) => set({ guestsAllowed: v })}
          />
        </Card>
        <Card title={t('mcp.admin.limits')}>
          <LimitRow label={t('mcp.admin.requests')}>
            <NumberSelect
              value={p.requestsPerMinute}
              options={[30, 60, 120, 300]}
              format={(n) => t('mcp.admin.perMinPerson', { n })}
              onChange={(n) => set({ requestsPerMinute: n })}
            />
          </LimitRow>
          <LimitRow label={t('mcp.admin.writes')}>
            <NumberSelect
              value={p.writesPerMinute}
              options={[10, 20, 40, 100]}
              format={(n) => t('mcp.admin.perMin', { n })}
              onChange={(n) => set({ writesPerMinute: n })}
            />
          </LimitRow>
          <LimitRow label={t('mcp.admin.responseSize')}>
            <span className="text-cap font-semibold">
              {t('mcp.admin.kb', { n: MCP_LIMITS.responseBytes / 1024 })}
            </span>
          </LimitRow>
          <LimitRow label={t('mcp.admin.tokenLife')} hint={t('mcp.admin.tokenLifeHint')}>
            <Select
              value={p.maxTokenDays === null ? 'none' : String(p.maxTokenDays)}
              onValueChange={(v) => set({ maxTokenDays: v === 'none' ? null : Number(v) })}
            >
              <SelectTrigger
                className="h-9 w-auto min-w-[140px]"
                aria-label={t('mcp.admin.tokenLife')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[30, 90, 180, 365].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t('mcp.admin.maxDays', { count: d })}
                  </SelectItem>
                ))}
                <SelectItem value="none">{t('mcp.admin.unlimited')}</SelectItem>
              </SelectContent>
            </Select>
          </LimitRow>
        </Card>
      </div>
      <ClientsCard policy={p} onMode={(clientMode) => set({ clientMode })} />
      <div className="flex flex-col gap-4">
        <Card title={t('mcp.admin.widest')}>
          <div className="flex flex-col">
            {MCP_SCOPES.map((scope) => (
              <CheckRow
                key={scope}
                label={t(`mcp.scopes.${scope}`)}
                checked={scope === 'hub:read' || p.allowedScopes.includes(scope)}
                disabled={scope === 'hub:read'}
                onChange={(on) =>
                  set({
                    allowedScopes: on
                      ? [...p.allowedScopes, scope]
                      : p.allowedScopes.filter((s) => s !== scope),
                  })
                }
              />
            ))}
            <div className="flex items-center gap-2.5 py-1.5 text-cap text-fg3">
              <Icon name="lock" size={15} />
              <span className="flex-1">{t('mcp.admin.vault')}</span>
              <span className="text-xs">{t('mcp.admin.vaultUnsupported')}</span>
            </div>
          </div>
        </Card>
        <Card title={t('mcp.admin.humanApproval')}>
          <div className="flex flex-col">
            {ApprovalRule.options.map((rule) => {
              const locked = LOCKED_APPROVAL_RULES.includes(rule);
              return (
                <CheckRow
                  key={rule}
                  label={t(`mcp.admin.rules.${rule}`)}
                  checked={locked || p.approvalRules.includes(rule)}
                  disabled={locked}
                  aside={locked ? <Icon name="lock" size={13} className="text-fg3" /> : null}
                  onChange={(on) =>
                    set({
                      approvalRules: on
                        ? [...p.approvalRules, rule]
                        : p.approvalRules.filter((r) => r !== rule),
                    })
                  }
                />
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <label htmlFor={id} className="flex min-w-0 flex-col">
        <span className="text-cap font-semibold">{label}</span>
        {hint ? <span className="truncate text-xs text-fg2">{hint}</span> : null}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function LimitRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <span className="flex min-w-0 flex-col">
        <span className="text-cap font-semibold">{label}</span>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

function NumberSelect({
  value,
  options,
  format,
  onChange,
}: {
  value: number;
  options: number[];
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const all = [...new Set([...options, value])].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-9 w-auto min-w-[130px]" aria-label={format(value)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {format(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CheckRow({
  label,
  checked,
  disabled,
  aside,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  aside?: ReactNode;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <label
        htmlFor={id}
        className={cn('min-w-0 flex-1 text-cap', disabled ? 'text-fg2' : 'cursor-pointer')}
      >
        {label}
      </label>
      {aside}
    </div>
  );
}

function ClientsCard({
  policy,
  onMode,
}: {
  policy: McpPolicy;
  onMode: (m: McpPolicy['clientMode']) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const clients = useQuery(clientsQuery);
  const update = useMutation({
    mutationFn: (x: { id: string; status: 'allowed' | 'blocked' }) =>
      api.call('updateMcpClient', { params: { mcpClientId: x.id }, body: { status: x.status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.clients }),
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  return (
    <Card title={t('mcp.admin.clients')}>
      <Segmented
        value={policy.clientMode}
        onValueChange={onMode}
        aria-label={t('mcp.admin.clients')}
        options={[
          { value: 'listed', label: t('mcp.admin.listed') },
          { value: 'all', label: t('mcp.admin.all') },
        ]}
      />
      {clients.isPending ? <Skeleton className="h-24" /> : null}
      {clients.data?.items.length === 0 ? (
        <p className="m-0 text-xs text-fg2">{t('mcp.admin.noClients')}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {clients.data?.items.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2.5 border-t border-line py-2 first:border-t-0"
          >
            <IconBox icon="plug" size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-cap font-semibold">{c.name}</span>
              <span className="truncate font-mono text-[11px] text-fg3">
                {t('mcp.admin.registeredAt', {
                  kind: t(`mcp.consent.registration.${c.registration}`),
                  time: formatRelative(c.createdAt, locale),
                })}
              </span>
            </span>
            {c.status === 'pending' ? <Badge tone="warn">{t('mcp.admin.pending')}</Badge> : null}
            {c.status === 'blocked' ? <Badge tone="danger">{t('mcp.admin.blocked')}</Badge> : null}
            {c.status === 'allowed' ? (
              <Button
                size="xs"
                variant="gh"
                onClick={() => update.mutate({ id: c.id, status: 'blocked' })}
              >
                {t('mcp.admin.block')}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="out"
                onClick={() => update.mutate({ id: c.id, status: 'allowed' })}
              >
                {t('mcp.admin.allow')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ConnectionsTable() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const qc = useQueryClient();
  const list = useQuery(orgConnectionsQuery);
  const cut = useConfirm<McpOrgConnection>();
  const revoke = useMutation({
    mutationFn: (c: McpOrgConnection) =>
      c.kind === 'grant'
        ? api.call('revokeMcpOrgGrant', { params: { grantId: c.id } })
        : api.call('revokeMcpOrgToken', { params: { tokenId: c.id } }),
    onSuccess: async () => {
      cut.close();
      toast(t('mcp.overview.disconnected'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">{t('mcp.admin.orgConnections')}</span>
      <div className="overflow-x-auto rounded-2xl bg-surface shadow-line">
        <Table>
          <thead>
            <tr>
              <Th>{t('mcp.admin.cols.person')}</Th>
              <Th>{t('mcp.admin.cols.client')}</Th>
              <Th>{t('mcp.admin.cols.scopes')}</Th>
              <Th>{t('mcp.admin.cols.spaces')}</Th>
              <Th>{t('mcp.admin.cols.lastUsed')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {list.isPending ? (
              <tr>
                <Td colSpan={6}>
                  <Skeleton className="h-16" />
                </Td>
              </tr>
            ) : list.data?.items.length === 0 ? (
              <tr>
                <Td colSpan={6}>
                  <EmptyState icon="plug" title={t('mcp.admin.noConnections')} />
                </Td>
              </tr>
            ) : (
              list.data?.items.map((c) => (
                <tr key={`${c.kind}-${c.id}`}>
                  <Td>
                    <span className="flex items-center gap-2 text-cap font-semibold">
                      <Avatar name={c.user.name} src={c.user.imageUrl} size="sm" />
                      {c.user.name}
                    </span>
                  </Td>
                  <Td className="text-cap">
                    {c.kind === 'token'
                      ? t('mcp.admin.tokenLabel', { name: c.name })
                      : `${c.name} · ${t('mcp.admin.oauth')}`}
                  </Td>
                  <Td className="text-cap">{c.scopes.length}</Td>
                  <Td className="max-w-[240px] truncate text-cap">{spacesLabel(i18n, c.spaces)}</Td>
                  <Td className="text-cap whitespace-nowrap">
                    {c.lastUsedAt
                      ? formatRelative(c.lastUsedAt, locale)
                      : t('mcp.common.neverUsed')}
                  </Td>
                  <Td className="text-right">
                    <Button size="xs" variant="dng" onClick={() => cut.ask(c)}>
                      {t('mcp.admin.cut')}
                    </Button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
      <ConfirmDialog
        open={cut.target !== null}
        onOpenChange={(o) => !o && cut.close()}
        title={t('mcp.admin.cutTitle', {
          name: cut.target?.name ?? '',
          person: cut.target?.user.name ?? '',
        })}
        body={t('mcp.admin.cutBody')}
        confirm={t('mcp.admin.cut')}
        pending={revoke.isPending}
        onConfirm={() => cut.target && revoke.mutate(cut.target)}
      />
    </div>
  );
}

function WebhooksTab() {
  const { t } = useI18n();
  const overview = useQuery(overviewQuery);
  const api = (overview.data?.serverUrl ?? '').replace(/\/mcp$/, '');
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card title={t('mcp.admin.restTitle')} aside={<Tag>/api/v1</Tag>}>
        <p className="m-0 text-sm text-fg2">{t('mcp.admin.restBody')}</p>
        <CopyField prompt value={`curl -H "Authorization: Bearer mhp_…" ${api}/api/v1/spaces`} />
        <div className="flex flex-wrap gap-1.5">
          <Tag>{t('mcp.admin.restTags.bearer')}</Tag>
          <Tag>{t('mcp.admin.restTags.cursor')}</Tag>
          <Tag>{t('mcp.admin.restTags.idem')}</Tag>
        </div>
      </Card>
      <Card title={t('mcp.admin.webhooksTitle')}>
        <EmptyState
          icon="send"
          title={t('mcp.admin.webhooksTitle')}
          description={t('mcp.admin.webhooksBody')}
        />
      </Card>
    </div>
  );
}

function UsageTab() {
  const { t } = useI18n();
  const [days, setDays] = useState(14);
  const usage = useQuery(usageQuery(days));
  const u = usage.data;
  const max = Math.max(1, ...(u?.days.map((d) => d.calls) ?? [1]));
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card
        title={t('mcp.admin.usageTitle', { days })}
        aside={
          <Segmented
            size="sm"
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
            options={[
              { value: '7', label: '7' },
              { value: '14', label: '14' },
              { value: '30', label: '30' },
            ]}
          />
        }
      >
        {!u ? (
          <Skeleton className="h-40" />
        ) : u.days.length === 0 ? (
          <EmptyState icon="activity" title={t('mcp.admin.noUsage')} />
        ) : (
          <>
            <span className="text-xs text-fg2">{t('mcp.admin.people', { count: u.people })}</span>
            <div className="flex h-40 items-end gap-1" role="img" aria-label={t('mcp.admin.calls')}>
              {u.days.map((d) => (
                <div
                  key={d.date}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${d.date} · ${d.calls}`}
                >
                  <div
                    className="w-full rounded-t-[4px] bg-accent"
                    style={{ height: `${Math.max(4, (d.calls / max) * 140)}px` }}
                  />
                  <span className="text-[10px] text-fg3">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-xs text-fg2">
              <span>
                {t('mcp.admin.calls')}: {u.days.reduce((s, d) => s + d.calls, 0)}
              </span>
              <span>
                {t('mcp.admin.writes')}: {u.days.reduce((s, d) => s + d.writes, 0)}
              </span>
              <span>
                {t('mcp.admin.errors')}: {u.days.reduce((s, d) => s + d.errors, 0)}
              </span>
            </div>
          </>
        )}
      </Card>
      <Card title={t('mcp.admin.topTools')}>
        {u?.tools.length === 0 ? (
          <p className="m-0 text-xs text-fg2">{t('mcp.admin.noUsage')}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {u?.tools.map((x) => (
            <li key={x.tool} className="flex items-center justify-between text-cap">
              <span className="font-mono text-xs">{x.tool}</span>
              <span className="font-semibold">{x.calls}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
