import {
  MCP_SCOPES,
  type ConsentDuration,
  type ConsentInfo,
  type ConsentRequest,
  type McpScope,
} from '@crewhall/shared';
import { Button, CrewhallMark, Icon, Segmented, Skeleton } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { AuthLayout, Notice, WhoRow } from '@/components/auth/AuthLayout';
import { ScopeChecklist, SpaceChips } from '@/components/mcp/parts';
import { useReauth } from '@/components/mcp/ReauthDialog';
import { api, isApiError } from '@/lib/api';
import { signOut } from '@/lib/auth/auth';
import { useI18n } from '@/lib/i18n/I18nContext';
import { consentQuery } from '@/lib/mcp/queries';
import { meQuery } from '@/lib/queries';
import { useBootstrap } from '@/lib/useBranding';

const Search = z.object({
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().optional(),
});

export const Route = createFileRoute('/oauth/consent')({
  validateSearch: Search,
  // Signed out: the normal sign-in (password + 2FA or passkey) first, then back here.
  beforeLoad: async ({ context: { queryClient }, location }) => {
    try {
      await queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw e;
    }
  },
  component: ConsentPage,
});

const isLoopback = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
};

/**
 * OAuth consent (design 18.2): the client name comes from dynamic registration and is not
 * verified, so the redirect address is shown next to it. Scopes are prefilled with the
 * request, the person narrows them; the vault is never a scope.
 */
function ConsentPage() {
  const { t } = useI18n();
  const search = Route.useSearch();
  const parsed = z
    .object({
      client_id: z.string().min(1),
      redirect_uri: z.string().min(1),
      response_type: z.literal('code'),
      code_challenge: z.string().min(43),
      code_challenge_method: z.literal('S256'),
      scope: z.string().optional(),
      state: z.string().optional(),
      resource: z.string().optional(),
    })
    .safeParse(search);
  if (!parsed.success) {
    return <Problem title={t('mcp.consent.invalidTitle')} body={t('mcp.consent.invalidBody')} />;
  }
  return <Consent request={parsed.data} />;
}

function Problem({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <AuthLayout>
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger">
        <Icon name="alert" size={24} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">{title}</h1>
        <p className="m-0 text-sm text-fg2">{body}</p>
      </div>
      {children}
    </AuthLayout>
  );
}

function Consent({ request }: { request: ConsentRequest }) {
  const { t } = useI18n();
  const consent = useQuery(consentQuery(request));

  if (consent.isError) {
    const e = consent.error;
    if (isApiError(e, 'mcp_disabled')) {
      return (
        <Problem title={t('mcp.consent.disabledTitle')} body={t('mcp.overview.disabledBody')} />
      );
    }
    if (isApiError(e, 'mcp_guests_not_allowed')) {
      return <Problem title={t('mcp.overview.guestsTitle')} body={t('mcp.overview.guestsBody')} />;
    }
    if (isApiError(e, 'two_factor_required')) {
      return (
        <Problem title={t('errors.two_factor_required')} body={t('mcp.consent.invalidBody')} />
      );
    }
    return <Problem title={t('mcp.consent.invalidTitle')} body={t('mcp.consent.invalidBody')} />;
  }
  if (!consent.data) {
    return (
      <AuthLayout wide>
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-12" />
        <Skeleton className="h-64" />
      </AuthLayout>
    );
  }
  return <ConsentForm request={request} info={consent.data} />;
}

function ConsentForm({ request, info }: { request: ConsentRequest; info: ConsentInfo }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const reauth = useReauth();
  const [scopes, setScopes] = useState<McpScope[]>(
    info.scopes.filter((s) => s.requested && s.allowed).map((s) => s.scope),
  );
  const [spaceIds, setSpaceIds] = useState<string[] | null>(null);
  const [duration, setDuration] = useState<ConsentDuration>(info.defaultDuration);
  const [leaving, setLeaving] = useState(false);
  const client = info.client.name;
  const blocked = info.client.status !== 'allowed';

  async function finish(redirectTo: string, grantId: string | null) {
    setLeaving(true);
    if (grantId && isLoopback(redirectTo)) {
      // Native clients (Claude Code) listen on a loopback port: hand over the code without
      // leaving the page, then show the summary (18.3). Fall back to a normal redirect.
      try {
        await fetch(redirectTo, { mode: 'no-cors', credentials: 'omit' });
        await navigate({ to: '/oauth/done', search: { grant: grantId, client } });
        return;
      } catch {
        // blocked by the browser: go there directly
      }
    }
    window.location.assign(redirectTo);
  }

  const approve = useMutation({
    mutationFn: (token: string) =>
      api.call('approveMcpConsent', {
        body: { ...request, consentToken: token, scopes, spaceIds, duration },
      }),
    onSuccess: (res) => void finish(res.redirectTo, res.grantId),
    onError: (e) => {
      reauth.handle(e, () => void approveFresh());
    },
  });
  const deny = useMutation({
    mutationFn: () =>
      api.call('denyMcpConsent', { body: { ...request, consentToken: info.consentToken } }),
    onSuccess: (res) => window.location.assign(res.redirectTo),
  });

  /** A passkey check starts a new session, which needs a new consent token. */
  async function approveFresh() {
    const fresh = await qc.fetchQuery({ ...consentQuery(request), staleTime: 0 });
    approve.mutate(fresh.consentToken);
  }

  async function otherAccount() {
    await signOut();
    qc.clear();
    window.location.reload();
  }

  const options = MCP_SCOPES.map((scope) => {
    const o = info.scopes.find((s) => s.scope === scope)!;
    return { scope, allowed: o.allowed, required: o.required, approval: o.approval };
  });
  const error =
    approve.error && !isApiError(approve.error, 'mcp_reauth_required')
      ? isApiError(approve.error)
        ? t(`errors.${approve.error.code}`)
        : t('errors.internal')
      : null;

  if (leaving) {
    return (
      <AuthLayout>
        <div className="flex items-center gap-3 text-sm text-fg2">
          <Icon name="refresh" size={18} className="animate-spin" />
          {t('mcp.done.returning', { client })}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide footer={t('mcp.consent.footer')}>
      <div className="flex items-center gap-2">
        <span className="flex size-10 items-center justify-center rounded-[11px] bg-bg2 text-fg">
          <Icon name="code" size={20} />
        </span>
        <span className="w-8 border-t-2 border-dotted border-line2" />
        <span className="flex size-10 items-center justify-center rounded-[11px] bg-bg2 text-fg">
          {branding.markUrl ? (
            <img src={branding.markUrl} alt="" className="size-7 rounded-sm" />
          ) : (
            <CrewhallMark size={24} />
          )}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[24px] leading-[30px] font-bold tracking-[-.02em]">
          {t('mcp.consent.title', { client })}
        </h1>
        <p className="m-0 text-cap text-fg2">
          <b className="font-semibold text-fg">{client}</b> ·{' '}
          {t(`mcp.consent.registration.${info.client.registration}`)} · {t('mcp.consent.redirect')}{' '}
          <code className="font-mono text-xs break-all text-fg">{info.client.redirectUri}</code>
        </p>
        {info.client.registration === 'dcr' ? (
          <p className="m-0 text-xs text-fg3">{t('mcp.consent.unverifiedName')}</p>
        ) : null}
      </div>
      <WhoRow
        name={info.user.name}
        email={`${info.user.email} · ${info.user.orgName}`}
        action={
          <Button size="xs" variant="gh" onClick={() => void otherAccount()}>
            {t('mcp.consent.change')}
          </Button>
        }
      />
      {blocked ? (
        <Notice tone="warn" icon="lock">
          <b className="font-semibold">
            {info.client.status === 'pending'
              ? t('mcp.consent.pendingTitle')
              : t('mcp.consent.blockedTitle')}
          </b>
          <br />
          {info.client.status === 'pending'
            ? t('mcp.consent.pendingBody', { client })
            : t('mcp.consent.blockedBody', { client })}
        </Notice>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-cap font-semibold">{t('mcp.consent.what', { client })}</span>
              <span className="text-xs text-fg3">{t('mcp.consent.whatAside')}</span>
            </div>
            <ScopeChecklist
              options={options}
              value={scopes}
              onChange={setScopes}
              footer={
                <div className="flex min-h-10 items-center gap-2.5 px-3 py-2 sm:col-span-2">
                  <Icon name="lock" size={16} className="text-fg3" />
                  <span className="flex-1 text-cap text-fg2">{t('mcp.consent.deleteRow')}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-bg2 px-2 py-0.5 text-tag text-fg2">
                    {t('mcp.consent.approval')}
                  </span>
                </div>
              }
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-cap font-semibold">{t('mcp.consent.spaces')}</span>
              <SpaceChips spaces={info.spaces} value={spaceIds} onChange={setSpaceIds} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-cap font-semibold">{t('mcp.consent.duration')}</span>
              <Segmented
                value={duration}
                onValueChange={setDuration}
                aria-label={t('mcp.consent.duration')}
                options={info.durations.map((d) => ({
                  value: d,
                  label: t(`mcp.consent.durations.${d}`),
                }))}
              />
            </div>
          </div>
          <Notice tone="info" icon="lock">
            {t('mcp.consent.vault', { client })}
          </Notice>
        </>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {spaceIds !== null && spaceIds.length === 0 ? (
        <Notice tone="warn">{t('mcp.consent.spaceRequired')}</Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="out" loading={deny.isPending} onClick={() => deny.mutate()}>
          {t('mcp.consent.deny')}
        </Button>
        <Button
          variant="pri"
          loading={approve.isPending}
          disabled={blocked || (spaceIds !== null && spaceIds.length === 0)}
          onClick={() =>
            info.needsReauth
              ? reauth.ask(() => void approveFresh())
              : approve.mutate(info.consentToken)
          }
        >
          {t('mcp.consent.allow')}
        </Button>
      </div>
      {reauth.dialog}
    </AuthLayout>
  );
}
