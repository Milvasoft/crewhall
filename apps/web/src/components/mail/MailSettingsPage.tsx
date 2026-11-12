import { type MailAccountState } from '@crewhall/shared';
import { emptyDoc } from '@crewhall/editor';
import { RichEditor, type RichEditorHandle } from '@crewhall/editor/react';
import { Badge, Button, Field, Input, Switch, toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { ConfirmDialog } from '@/components/identity/parts';
import { editorLabels } from '@/components/portal/PortalEditor';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { whenEditorReady } from '@/lib/mail/editor';
import { mailKeys, oauthStartUrl } from '@/lib/mail/queries';
import { mailError } from './errors';
import { MailSidebar } from './MailSidebar';

/** Posta › Ayarlar: display name, signature, notifications, password and disconnecting. */
export function MailSettingsPage({ state }: { state: MailAccountState }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const account = state.account!;
  const labels = useMemo(() => editorLabels(t), [t]);
  const signature = useRef<RichEditorHandle>(null);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [notify, setNotify] = useState(account.notify);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(
    () =>
      whenEditorReady(signature, (ed) => {
        if (account.signatureHtml) ed.commands.setContent(account.signatureHtml);
      }),
    [account.signatureHtml],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: mailKeys.account });
  const save = useMutation({
    mutationFn: () => {
      const editor = signature.current?.getEditor();
      const html = editor && !editor.isEmpty ? editor.getHTML() : '';
      return api.call('mailUpdateAccount', {
        body: { displayName: displayName.trim(), notify, signatureHtml: html },
      });
    },
    onSuccess: async () => {
      toast(t('mail.settings.saved'));
      await refresh();
    },
    onError: (e) => toast(mailError(t, e)),
  });
  const changePassword = useMutation({
    mutationFn: () => api.call('mailUpdateAccount', { body: { password } }),
    onSuccess: async () => {
      setPassword('');
      toast(t('mail.settings.passwordSaved'));
      await qc.invalidateQueries({ queryKey: mailKeys.all });
    },
    onError: (e) => setPasswordError(mailError(t, e)),
  });
  const disconnect = useMutation({
    mutationFn: () => api.call('mailDisconnectAccount'),
    onSuccess: async () => {
      toast(t('mail.settings.disconnected'));
      await qc.invalidateQueries({ queryKey: mailKeys.all });
      void navigate({ to: '/mail' });
    },
    onError: (e) => toast(mailError(t, e)),
  });

  return (
    <Workspace
      sidebar={
        <MailSidebar
          email={account.email}
          folder={null}
          onCompose={() => void navigate({ to: '/mail', search: { new: 1 } })}
        />
      }
      crumbs={[{ label: t('mail.title') }, { label: t('mail.settings.title') }]}
    >
      <div className="flex w-full max-w-[720px] flex-col gap-5">
        <PageHeader title={t('mail.settings.title')} subtitle={t('mail.settings.subtitle')} />
        <SettingsCard title={t('mail.settings.account')}>
          <SettingsRow label={t('mail.settings.address')}>
            <span className="text-sm font-semibold">{account.email}</span>
          </SettingsRow>
          <SettingsRow label={t('mail.settings.method')}>
            <span className="text-sm">{t(`mail.settings.methods.${account.authMode}`)}</span>
          </SettingsRow>
          <SettingsRow
            label={t('mail.settings.status.label')}
            description={
              account.lastCheckedAt
                ? t('mail.settings.lastChecked', {
                    time: formatRelative(account.lastCheckedAt, locale),
                  })
                : t('mail.settings.neverChecked')
            }
          >
            <Badge tone={account.status === 'ok' ? 'ok' : 'danger'}>
              {t(`mail.settings.status.${account.status}`)}
            </Badge>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title={t('mail.settings.signature')}>
          <SettingsRow
            label={t('mail.settings.displayName')}
            description={t('mail.settings.displayNameHint')}
            htmlFor="mail-display-name"
          >
            <Input
              id="mail-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-64"
            />
          </SettingsRow>
          <div className="flex flex-col gap-2 border-t border-line py-3">
            <span className="text-cap font-semibold">{t('mail.settings.signature')}</span>
            <span className="text-xs text-fg2">{t('mail.settings.signatureHint')}</span>
            <div className="min-h-[96px] rounded-lg px-3 py-2 shadow-line2">
              <RichEditor
                variant="light"
                value={emptyDoc()}
                labels={labels}
                editorRef={signature}
              />
            </div>
          </div>
          <SettingsRow
            label={t('mail.settings.notify')}
            description={t('mail.settings.notifyHint')}
          >
            <Switch
              checked={notify}
              onCheckedChange={setNotify}
              aria-label={t('mail.settings.notify')}
            />
          </SettingsRow>
          <div className="flex justify-end border-t border-line py-3">
            <Button variant="pri" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              {t('mail.settings.save')}
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard
          title={
            account.authMode === 'password'
              ? t('mail.settings.password')
              : t('mail.connect.reconnect')
          }
        >
          {account.authMode === 'password' ? (
            <form
              className="flex flex-wrap items-end gap-3 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                setPasswordError(null);
                changePassword.mutate();
              }}
            >
              <Field
                label={t('mail.settings.newPassword')}
                error={passwordError ?? undefined}
                className="min-w-[240px] flex-1"
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" size="sm" loading={changePassword.isPending}>
                {t('mail.settings.save')}
              </Button>
            </form>
          ) : (
            <div className="py-3">
              <Button asChild size="sm">
                <a href={oauthStartUrl()}>{t('mail.connect.reconnect')}</a>
              </Button>
            </div>
          )}
        </SettingsCard>

        <div>
          <Button variant="dng" size="sm" onClick={() => setConfirm(true)}>
            {t('mail.settings.disconnect')}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('mail.settings.disconnectTitle')}
        body={t('mail.settings.disconnectBody')}
        confirm={t('mail.settings.disconnect')}
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </Workspace>
  );
}
