import { type MailAccountState } from '@crewhall/shared';
import { Button, EmptyState, Field, Icon, Input, Skeleton, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mailAccountQuery, mailKeys, oauthStartUrl } from '@/lib/mail/queries';
import { usePermissions } from '@/lib/session';
import { mailError } from './errors';
import { InboxSidebar } from './inbox/InboxSidebar';

/**
 * Everything under /mail needs a configured server and a connected account. Until then this
 * shows the notice for the admin, the connect form (app password) or the OAuth2 button.
 */
export function MailGate({ children }: { children: (state: MailAccountState) => ReactNode }) {
  const { t } = useI18n();
  const state = useQuery(mailAccountQuery);
  const { canOrg } = usePermissions();

  if (state.isPending) {
    return (
      <Workspace crumbs={[{ label: t('mail.title') }]}>
        <Skeleton className="h-40 w-full max-w-[560px]" />
      </Workspace>
    );
  }
  if (state.isError) {
    return (
      <Workspace crumbs={[{ label: t('mail.title') }]}>
        <EmptyState icon="alert" title={mailError(t, state.error)}>
          <Button size="sm" onClick={() => void state.refetch()}>
            {t('mail.connect.retry')}
          </Button>
        </EmptyState>
      </Workspace>
    );
  }
  const data = state.data;
  if (!data.server.configured) {
    return (
      <Workspace crumbs={[{ label: t('mail.title') }]}>
        <EmptyState
          icon="mail"
          title={t('mail.connect.notConfiguredTitle')}
          description={t('mail.connect.notConfiguredBody')}
        >
          {canOrg('org.update_settings') ? (
            <Button asChild variant="pri" size="sm">
              <Link to="/admin/mail">{t('mail.connect.notConfiguredAdmin')}</Link>
            </Button>
          ) : null}
        </EmptyState>
      </Workspace>
    );
  }
  if (!data.account || data.account.authMode !== data.server.authMode) {
    return (
      <Workspace crumbs={[{ label: t('mail.title') }]} sidebar={<InboxSidebar />}>
        <ConnectMailbox state={data} />
      </Workspace>
    );
  }
  return <>{children(data)}</>;
}

/** App password form or OAuth2 button, by the org's sign-in mode. */
export function ConnectMailbox({ state }: { state: MailAccountState }) {
  const { t } = useI18n();
  const mismatch = state.account !== null && state.account.authMode !== state.server.authMode;
  return (
    <section className="mx-auto flex w-full max-w-[480px] flex-col gap-4 rounded-2xl bg-surface p-6 shadow-line">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg2">
          <Icon name="mail" size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-h font-semibold">{t('mail.connect.title')}</h1>
          <p className="m-0 text-sm text-fg2">
            {mismatch ? t('mail.connect.mismatch') : t('mail.connect.body')}
          </p>
        </div>
      </div>
      {state.server.authMode === 'password' ? (
        <PasswordForm />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-fg2">{t('mail.connect.oauthBody')}</p>
          <Button asChild variant="pri">
            <a href={oauthStartUrl()}>
              {state.server.authMode === 'oauth_microsoft'
                ? t('mail.connect.oauthMicrosoft')
                : t('mail.connect.oauthGoogle')}
            </a>
          </Button>
        </div>
      )}
    </section>
  );
}

function PasswordForm() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () =>
      api.call('mailConnectAccount', {
        body: {
          email: email.trim(),
          password,
          ...(username.trim() ? { username: username.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      toast(t('mail.connect.connected'));
      await qc.invalidateQueries({ queryKey: mailKeys.all });
    },
    onError: (e) => setError(mailError(t, e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    connect.mutate();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label={t('mail.connect.email')}>
        <Input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label={t('mail.connect.username')} hint={t('mail.connect.usernameHint')}>
        <Input
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>
      <Field
        label={t('mail.connect.password')}
        hint={t('mail.connect.passwordHint')}
        error={error ?? undefined}
      >
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="pri" loading={connect.isPending}>
        {t('mail.connect.submit')}
      </Button>
    </form>
  );
}

/** True when an API error means the stored credentials stopped working. */
export const isAuthProblem = (e: unknown) =>
  isApiError(e, 'mail_auth_failed') || isApiError(e, 'mail_auth_mode_mismatch');
