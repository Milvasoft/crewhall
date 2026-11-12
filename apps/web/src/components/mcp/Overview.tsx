import { MCP_SCOPES, type McpGrant, type McpScope, type McpSpaceRef } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  Icon,
  IconBox,
  Skeleton,
  Tag,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { formatDate, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { connectionLine, lastUsedLabel, sortScopes } from '@/lib/mcp/format';
import { grantQuery, grantsQuery, mcpKeys, overviewQuery, tokensQuery } from '@/lib/mcp/queries';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { CreateTokenDialog } from './CreateTokenDialog';
import { ResultBadge } from './ResultBadge';
import {
  ConfirmDialog,
  CopyButton,
  CopyField,
  ScopeChecklist,
  SpaceChips,
  useConfirm,
} from './parts';
import { useReauth } from './ReauthDialog';

const clientIcon = (g: Pick<McpGrant, 'client'>): IconName =>
  /desktop/i.test(g.client.name)
    ? 'laptop'
    : /claude\.ai|web/i.test(g.client.name)
      ? 'cloud'
      : 'code';

export function useMcpSpaces(): McpSpaceRef[] {
  const spaces = useQuery(spacesQuery());
  return (spaces.data?.items ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    color: s.color,
  }));
}

export function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line', className)}
    >
      {title ? (
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Hesabım › MCP ve API (design 18.1); with a grant id the right column shows 18.5. */
export function McpOverviewPage({ grantId }: { grantId?: string }) {
  const { t, rich } = useI18n();
  const { canOrg } = usePermissions();
  const overview = useQuery(overviewQuery);
  const spaces = useMcpSpaces();
  const [creating, setCreating] = useState(false);

  const data = overview.data;
  const serverUrl = data?.serverUrl ?? '';
  const apiUrl = serverUrl.replace(/\/mcp$/, '');
  const command = `claude mcp add --transport http crewhall ${serverUrl}`;

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('mcp.overview.title') }]}>
      <PageHeader
        title={t('mcp.overview.title')}
        subtitle={
          data
            ? `${t('mcp.overview.subtitle')} · ${t('mcp.overview.stats', {
                calls: data.todayCalls,
                pending: data.pendingApprovals,
              })}`
            : t('mcp.overview.subtitle')
        }
        actions={
          data?.enabled ? (
            <>
              <Button size="sm" variant="out" asChild>
                <Link to="/account/mcp/docs">
                  <Icon name="code" size={15} />
                  {t('mcp.overview.docs')}
                </Link>
              </Button>
              <Button
                size="sm"
                variant="pri"
                disabled={!data.patsEnabled}
                title={data.patsEnabled ? undefined : t('mcp.overview.tokensDisabled')}
                onClick={() => setCreating(true)}
              >
                <Icon name="plus" size={15} />
                {t('mcp.overview.createToken')}
              </Button>
            </>
          ) : null
        }
      />
      {!data ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : !data.enabled ? (
        <EmptyState
          icon="lock"
          title={
            data.disabledReason === 'guests_not_allowed'
              ? t('mcp.overview.guestsTitle')
              : t('mcp.overview.disabledTitle')
          }
          description={
            data.disabledReason === 'guests_not_allowed'
              ? t('mcp.overview.guestsBody')
              : t('mcp.overview.disabledBody')
          }
          className="mt-10"
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card
              title={
                <>
                  {t('mcp.overview.server')}
                  <Badge tone="ok">{t('mcp.overview.on')}</Badge>
                </>
              }
              aside={
                canOrg('org.update_settings') ? (
                  <Link to="/admin/mcp" className="text-xs text-fg3 hover:text-fg">
                    {t('mcp.overview.policyLink')}
                  </Link>
                ) : (
                  <span className="text-xs text-fg3">{t('mcp.overview.policyLink')}</span>
                )
              }
            >
              <CopyField
                value={serverUrl}
                display={<span className="font-semibold">{serverUrl}</span>}
              />
              <div className="flex flex-wrap gap-1.5">
                {(['http', 'oauth', 'dcr', 'pat'] as const).map((k) => (
                  <Tag key={k}>{t(`mcp.overview.features.${k}`)}</Tag>
                ))}
                <Tag>
                  <Icon name="lock" size={12} />
                  {t('mcp.overview.features.vault')}
                </Tag>
              </div>
            </Card>
            <Card
              title={
                <>
                  <IconBox icon="code" size="sm" />
                  {t('mcp.overview.claudeCode')}
                </>
              }
              aside={<span className="text-xs text-fg3">{t('mcp.overview.claudeCodeHint')}</span>}
            >
              <div className="flex items-start gap-2 rounded-lg bg-bg2 p-3 font-mono text-[13px] leading-5">
                <span className="text-fg3 select-none">$</span>
                <span className="min-w-0 flex-1 break-all">{command}</span>
                <CopyButton value={command} />
              </div>
              <p className="m-0 text-sm text-fg2">{rich('mcp.overview.claudeCodeAfter')}</p>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              <Steps
                icon="laptop"
                title={t('mcp.overview.desktop')}
                steps={['one', 'two', 'three'].map((s) =>
                  rich(`mcp.overview.desktopSteps.${s as 'one'}`),
                )}
              />
              <Steps
                icon="cloud"
                title={t('mcp.overview.web')}
                steps={['one', 'two', 'three'].map((s) =>
                  rich(`mcp.overview.webSteps.${s as 'one'}`),
                )}
              />
            </div>
            <p className="m-0 flex items-start gap-2 text-xs text-fg2">
              <Icon name="info" size={14} className="mt-px shrink-0" />
              <span>{rich('mcp.overview.others')}</span>
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {grantId ? <ClientPanel grantId={grantId} spaces={spaces} /> : <ConnectionLists />}
          </div>
        </div>
      )}
      {data ? (
        <CreateTokenDialog
          open={creating}
          onOpenChange={setCreating}
          spaces={spaces}
          maxTokenDays={data.maxTokenDays}
          allowedScopes={data.allowedScopes}
          serverUrl={serverUrl}
          apiUrl={apiUrl}
        />
      ) : null}
    </Workspace>
  );
}

function Steps({ icon, title, steps }: { icon: IconName; title: string; steps: ReactNode[] }) {
  return (
    <Card
      title={
        <>
          <IconBox icon={icon} size="sm" />
          {title}
        </>
      }
    >
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2.5 text-sm text-fg2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full shadow-line2 text-[11px] font-semibold text-fg">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function ConnectionLists() {
  const i18n = useI18n();
  const { t } = i18n;
  const qc = useQueryClient();
  const grants = useQuery(grantsQuery);
  const tokens = useQuery(tokensQuery);
  const cut = useConfirm<{ kind: 'grant' | 'token'; id: string; name: string }>();

  const revoke = useMutation({
    mutationFn: async (x: { kind: 'grant' | 'token'; id: string }) =>
      x.kind === 'grant'
        ? api.call('revokeMcpGrant', { params: { grantId: x.id } })
        : api.call('revokeMcpToken', { params: { tokenId: x.id } }),
    onSuccess: async (_d, x) => {
      cut.close();
      toast(x.kind === 'grant' ? t('mcp.overview.disconnected') : t('mcp.overview.revoked'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  return (
    <>
      <Card
        title={
          <>
            {t('mcp.overview.clients')}
            <span className="text-xs font-medium text-fg3">{grants.data?.items.length ?? ''}</span>
          </>
        }
      >
        {grants.isPending ? <Skeleton className="h-24" /> : null}
        {grants.data?.items.length === 0 ? (
          <p className="m-0 text-sm text-fg2">{t('mcp.overview.noClients')}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col p-0">
          {grants.data?.items.map((g) => (
            <li
              key={g.id}
              className="flex items-start gap-2.5 border-t border-line py-2.5 first:border-t-0"
            >
              <IconBox icon={clientIcon(g)} size="sm" />
              <Link
                to="/account/mcp/client/$grantId"
                params={{ grantId: g.id }}
                className="flex min-w-0 flex-1 flex-col hover:underline"
              >
                <span className="truncate text-cap font-semibold">
                  {g.label ? `${g.client.name} · ${g.label}` : g.client.name}
                </span>
                <span className="text-xs text-fg2">{connectionLine(i18n, g)}</span>
                <span className="text-xs text-fg3">{lastUsedLabel(i18n, g.lastUsedAt)}</span>
              </Link>
              <Button
                size="xs"
                variant="dng"
                onClick={() => cut.ask({ kind: 'grant', id: g.id, name: g.client.name })}
              >
                {t('mcp.overview.disconnect')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title={
          <>
            {t('mcp.overview.tokens')}
            <span className="text-xs font-medium text-fg3">{tokens.data?.items.length ?? ''}</span>
          </>
        }
      >
        {tokens.isPending ? <Skeleton className="h-20" /> : null}
        {tokens.data?.items.length === 0 ? (
          <p className="m-0 text-sm text-fg2">{t('mcp.overview.noTokens')}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col p-0">
          {tokens.data?.items.map((k) => (
            <li
              key={k.id}
              className="flex items-start gap-2.5 border-t border-line py-2.5 first:border-t-0"
            >
              <IconBox icon="key" size="sm" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-cap font-semibold">{k.name}</span>
                <span className="truncate font-mono text-xs text-fg2">
                  {`${k.prefix}… · ${
                    sortScopes(k.scopes)
                      .filter((s) => s !== 'hub:read')
                      .map((s) => t(`mcp.scopeShort.${s}`))
                      .join(', ') || t('mcp.common.readOnly')
                  }`}
                </span>
                <span className="text-xs text-fg3">
                  {connectionLine(i18n, { ...k, scopes: [] })
                    .split(' · ')
                    .slice(1)
                    .join(' · ')}{' '}
                  · {lastUsedLabel(i18n, k.lastUsedAt)}
                </span>
              </div>
              <Button
                size="xs"
                variant="dng"
                onClick={() => cut.ask({ kind: 'token', id: k.id, name: k.name })}
              >
                {t('mcp.overview.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <ConfirmDialog
        open={cut.target !== null}
        onOpenChange={(o) => !o && cut.close()}
        title={
          cut.target?.kind === 'token'
            ? t('mcp.overview.revokeTitle', { name: cut.target.name })
            : t('mcp.overview.disconnectTitle', { name: cut.target?.name ?? '' })
        }
        body={
          cut.target?.kind === 'token'
            ? t('mcp.overview.revokeBody')
            : t('mcp.overview.disconnectBody')
        }
        confirm={
          cut.target?.kind === 'token' ? t('mcp.overview.revoke') : t('mcp.overview.disconnect')
        }
        pending={revoke.isPending}
        onConfirm={() => cut.target && revoke.mutate(cut.target)}
      />
    </>
  );
}

/** Design 18.5: one connection, editable scopes and spaces, last 24 hours of calls. */
function ClientPanel({ grantId, spaces }: { grantId: string; spaces: McpSpaceRef[] }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const grant = useQuery(grantQuery(grantId));
  const overview = useQuery(overviewQuery);
  const reauth = useReauth();
  const [scopes, setScopes] = useState<McpScope[] | null>(null);
  const [spaceIds, setSpaceIds] = useState<string[] | null | undefined>(undefined);
  const [cutOpen, setCutOpen] = useState(false);

  const g = grant.data;
  const currentScopes = scopes ?? g?.scopes ?? [];
  const currentSpaces = spaceIds === undefined ? (g?.spaces?.map((s) => s.id) ?? null) : spaceIds;
  const dirty = scopes !== null || spaceIds !== undefined;

  const save = useMutation({
    mutationFn: (body: { scopes?: McpScope[]; spaceIds?: string[] | null; extendDays?: number }) =>
      api.call('updateMcpGrant', { params: { grantId }, body }),
    onSuccess: async (_d, body) => {
      setScopes(null);
      setSpaceIds(undefined);
      toast(body.extendDays ? t('mcp.client.extended') : t('mcp.client.saved'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
    onError: (e, body) => {
      if (reauth.handle(e, () => save.mutate(body))) return;
      toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
    },
  });
  const cut = useMutation({
    mutationFn: () => api.call('revokeMcpGrant', { params: { grantId } }),
    onSuccess: async () => {
      toast(t('mcp.overview.disconnected'));
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
      await navigate({ to: '/account/mcp' });
    },
  });

  if (grant.isError) {
    return (
      <Card>
        <EmptyState icon="plug" title={t('mcp.client.notFound')}>
          <Button size="sm" asChild>
            <Link to="/account/mcp">{t('mcp.client.close')}</Link>
          </Button>
        </EmptyState>
      </Card>
    );
  }
  if (!g) return <Skeleton className="h-96 rounded-2xl" />;

  const allowed = overview.data?.allowedScopes ?? MCP_SCOPES;
  const options = MCP_SCOPES.map((scope) => ({
    scope,
    allowed: scope === 'hub:read' || allowed.includes(scope),
    required: scope === 'hub:read',
    approval: scope === 'portal:publish',
  }));
  const fact = (label: string, value: ReactNode, aside?: ReactNode) => (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <span className="text-xs text-fg2">{label}</span>
      <span className="flex items-center gap-2 text-cap font-semibold">
        {value}
        {aside}
      </span>
    </div>
  );

  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          <IconBox icon={clientIcon(g)} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{g.client.name}</span>
            <span className="text-xs font-normal text-fg2">
              {[g.label, t(`mcp.client.kind.${g.client.registration}`)].filter(Boolean).join(' · ')}
            </span>
          </span>
        </span>
      }
      aside={
        <Button size="icon" variant="gh" aria-label={t('mcp.client.close')} asChild>
          <Link to="/account/mcp">
            <Icon name="x" size={16} />
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col">
        {fact(
          t('mcp.client.connected'),
          formatDate(g.createdAt, locale, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        )}
        {fact(
          t('mcp.client.lastUsed'),
          g.lastUsedAt ? formatRelative(g.lastUsedAt, locale) : t('mcp.common.neverUsed'),
          g.lastIp ? (
            <span className="font-mono text-xs font-normal text-fg3">{g.lastIp}</span>
          ) : null,
        )}
        {fact(
          t('mcp.client.expires'),
          g.expiresAt ? formatDate(g.expiresAt, locale) : t('mcp.common.noExpiry'),
          <Button
            size="xs"
            variant="out"
            loading={save.isPending && save.variables?.extendDays !== undefined}
            onClick={() =>
              save.mutate({ extendDays: Math.min(30, overview.data?.maxTokenDays ?? 30) })
            }
          >
            {t('mcp.client.extend')}
          </Button>,
        )}
        {fact(
          t('mcp.client.redirect'),
          <span className="max-w-[180px] truncate font-mono text-xs font-normal">
            {g.client.redirectUris[0]}
          </span>,
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-cap font-semibold">{t('mcp.client.scopes')}</span>
        <span className="text-xs text-fg3">{t('mcp.client.narrowNote')}</span>
      </div>
      <ScopeChecklist options={options} value={currentScopes} onChange={setScopes} columns={1} />
      <span className="text-cap font-semibold">{t('mcp.client.spaces')}</span>
      <SpaceChips spaces={spaces} value={currentSpaces} onChange={setSpaceIds} />
      {dirty ? (
        <Button
          variant="pri"
          size="sm"
          loading={save.isPending}
          disabled={currentSpaces !== null && currentSpaces.length === 0}
          onClick={() =>
            save.mutate({
              ...(scopes !== null ? { scopes } : {}),
              ...(spaceIds !== undefined ? { spaceIds } : {}),
            })
          }
        >
          {t('mcp.client.save')}
        </Button>
      ) : null}
      <div className="flex items-center justify-between pt-1">
        <span className="text-cap font-semibold">
          {t('mcp.client.recent', { count: g.calls24h })}
        </span>
        <Link
          to="/account/mcp/activity"
          search={{ grant: g.id }}
          className="text-xs text-fg3 hover:text-fg"
        >
          {t('mcp.overview.all')}
        </Link>
      </div>
      {g.recentCalls.length === 0 ? (
        <p className="m-0 text-xs text-fg2">{t('mcp.client.noCalls')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {g.recentCalls.slice(0, 8).map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 text-xs">
              <span className="w-10 shrink-0 font-mono text-fg3">{formatTime(c.at, locale)}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{c.tool}</span>
              <ResultBadge call={c} compact />
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 border-t border-line pt-3">
        <Button size="sm" variant="out" asChild className="flex-1">
          <Link to="/account/mcp/activity" search={{ grant: g.id }}>
            {t('mcp.client.activity')}
          </Link>
        </Button>
        <Button size="sm" variant="dngf" className="flex-1" onClick={() => setCutOpen(true)}>
          {t('mcp.overview.disconnect')}
        </Button>
      </div>
      <ConfirmDialog
        open={cutOpen}
        onOpenChange={setCutOpen}
        title={t('mcp.overview.disconnectTitle', { name: g.client.name })}
        body={t('mcp.overview.disconnectBody')}
        confirm={t('mcp.overview.disconnect')}
        pending={cut.isPending}
        onConfirm={() => cut.mutate()}
      />
      {reauth.dialog}
    </Card>
  );
}
