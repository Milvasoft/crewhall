import { formatBackupCode } from '@crewhall/shared';
import { queryKeys } from '@crewhall/api-client';
import { type SessionInfo } from '@crewhall/shared';
import {
  Badge,
  Button,
  CheckboxRow,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconBox,
  Input,
  Skeleton,
  Tag,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { DesktopDownloadCard } from '@/components/account/DesktopDownload';
import { MobileConnectDialog } from '@/components/account/MobileConnectDialog';
import { PageHeader, SettingsCard } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { MIN_PASSWORD, PasswordStrength } from '@/components/auth/PasswordStrength';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import {
  addPasskey,
  changePassword,
  deletePasskey,
  disableTwoFactor,
  listPasskeys,
  regenerateBackupCodes,
} from '@/lib/auth/auth';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgQuery, sessionsQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';

export const Route = createFileRoute('/_app/account/security')({
  component: SecurityPage,
});

type Ask = 'password' | 'disable2fa' | 'codes' | 'mobile' | null;

/** Sign-in methods and sessions (doc 09 · 9.19). Sensitive actions ask for the password again. */
function SecurityPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { me, role } = usePermissions();
  const org = useQuery(orgQuery);
  const sessions = useQuery(sessionsQuery);
  const passkeys = useQuery({ queryKey: ['me', 'passkeys'], queryFn: listPasskeys });
  const [ask, setAsk] = useState<Ask>(null);

  const required =
    Boolean(org.data?.settings.requireTwoFactor) || role === 'owner' || role === 'admin';
  const others = (sessions.data?.items ?? []).filter((s) => !s.current);

  const revoke = useMutation({
    mutationFn: (id: string) => api.call('revokeSession', { params: { sessionId: id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions }),
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      for (const s of others) await api.call('revokeSession', { params: { sessionId: s.id } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.sessions });
      toast(t('account.security.othersClosed'));
    },
  });
  const removeKey = useMutation({
    mutationFn: async (id: string) => {
      const res = await deletePasskey(id);
      if (!res.ok) throw new Error('delete failed');
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me', 'passkeys'] });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  async function onAddPasskey() {
    const res = await addPasskey(t('account.security.thisDevice'));
    if (res.ok) {
      await qc.invalidateQueries({ queryKey: ['me', 'passkeys'] });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      toast(t('account.security.passkeyAdded'));
    } else if (res.kind !== 'cancelled') toast(t('auth.passkey.failed'));
  }

  if (!me) return null;
  const keys = passkeys.data ?? [];
  // At least one method must remain while the policy applies.
  const canRemove2fa = !required || keys.length > 0;

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('account.nav.security') }]}>
      <PageHeader title={t('account.security.title')} subtitle={t('account.security.subtitle')} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <SettingsCard>
          <MethodRow
            icon="key"
            title={t('account.security.password')}
            body={t('account.security.passwordHint')}
            action={
              <Button size="sm" onClick={() => setAsk('password')}>
                {t('account.security.change')}
              </Button>
            }
          />
          <MethodRow
            icon="totp"
            title={
              <span className="flex items-center gap-2">
                {t('account.security.totp')}
                {me.user.twoFactorEnabled ? (
                  <Badge tone="ok">{t('account.security.on')}</Badge>
                ) : (
                  <Badge tone="warn">{t('account.security.off')}</Badge>
                )}
              </span>
            }
            body={required ? t('account.security.totpRequired') : t('account.security.totpHint')}
            action={
              me.user.twoFactorEnabled ? (
                <Tooltip
                  content={
                    canRemove2fa ? t('account.security.remove') : t('account.security.cannotRemove')
                  }
                >
                  <span>
                    <Button
                      size="sm"
                      variant="dng"
                      disabled={!canRemove2fa}
                      onClick={() => setAsk('disable2fa')}
                    >
                      {t('account.security.remove')}
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button size="sm" variant="inv" asChild>
                  <Link to="/security/2fa-setup" search={{ from: 'account' }}>
                    {t('account.security.setup')}
                  </Link>
                </Button>
              )
            }
          />
          {me.user.twoFactorEnabled ? (
            <MethodRow
              icon="note"
              title={t('account.security.backupCodes')}
              body={t('account.security.backupHint')}
              action={
                <Button size="sm" onClick={() => setAsk('codes')}>
                  {t('account.security.newCodes')}
                </Button>
              }
            />
          ) : null}
        </SettingsCard>

        <SettingsCard
          title={
            <span className="flex items-center gap-2">
              {t('account.security.passkeys')}
              <span className="text-xs font-medium text-fg3">{keys.length}</span>
            </span>
          }
          aside={
            <Button size="sm" onClick={() => void onAddPasskey()}>
              <Icon name="plus" size={16} />
              {t('account.security.addPasskey')}
            </Button>
          }
        >
          {passkeys.isLoading ? (
            <Skeleton className="my-3 h-10 w-full" />
          ) : keys.length === 0 ? (
            <p className="m-0 py-3 text-cap text-fg2">{t('account.security.noPasskeys')}</p>
          ) : (
            keys.map((k) => (
              <MethodRow
                key={k.id}
                icon="finger"
                title={k.name ?? t('account.security.passkey')}
                body={t('account.security.added', { date: formatDate(k.createdAt, locale) })}
                action={
                  <Button size="sm" variant="dng" onClick={() => removeKey.mutate(k.id)}>
                    {t('common.actions.delete')}
                  </Button>
                }
              />
            ))
          )}
        </SettingsCard>

        <SettingsCard
          title={
            <span className="flex items-center gap-2">
              {t('account.security.sessions')}
              <span className="text-xs font-medium text-fg3">
                {sessions.data?.items.length ?? ''}
              </span>
            </span>
          }
          aside={
            <Button size="sm" onClick={() => setAsk('mobile')}>
              <Icon name="qr" size={16} />
              {t('account.mobile.open')}
            </Button>
          }
        >
          {(sessions.data?.items ?? []).map((s) => (
            <SessionRow key={s.id} s={s} onRevoke={() => revoke.mutate(s.id)} />
          ))}
          {others.length ? (
            <div className="border-t border-line py-2.5">
              <Button
                size="sm"
                variant="dng"
                loading={revokeOthers.isPending}
                onClick={() => revokeOthers.mutate()}
              >
                {t('account.security.closeOthers')}
              </Button>
            </div>
          ) : null}
        </SettingsCard>

        <DesktopDownloadCard />

        <Notice tone="info" icon="vault">
          {t('account.security.vaultNote')}
        </Notice>
      </div>
      <PasswordDialog
        open={ask === 'password'}
        onClose={() => setAsk(null)}
        email={me.user.email}
        name={me.user.name}
      />
      <ConfirmPasswordDialog
        open={ask === 'disable2fa'}
        onClose={() => setAsk(null)}
        title={t('account.security.disableTitle')}
        body={t('account.security.disableBody')}
        action={t('account.security.remove')}
        run={async (pw) => {
          const res = await disableTwoFactor(pw);
          if (res.ok) await qc.invalidateQueries({ queryKey: queryKeys.me });
          return res.ok;
        }}
      />
      <BackupCodesDialog open={ask === 'codes'} onClose={() => setAsk(null)} />
      <MobileConnectDialog open={ask === 'mobile'} onClose={() => setAsk(null)} />
    </Workspace>
  );
}

function MethodRow({
  icon,
  title,
  body,
  action,
}: {
  icon: Parameters<typeof IconBox>[0]['icon'];
  title: ReactNode;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 border-t border-line py-2.5 first:border-t-0">
      <IconBox icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-cap font-semibold">{title}</span>
        <span className="text-xs text-fg2">{body}</span>
      </div>
      {action}
    </div>
  );
}

function SessionRow({ s, onRevoke }: { s: SessionInfo; onRevoke: () => void }) {
  const { t, locale } = useI18n();
  const mobile = /iphone|android|ios/i.test(s.userAgent ?? '');
  return (
    <MethodRow
      icon={mobile ? 'phone' : 'laptop'}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{s.userAgent ?? t('account.security.unknownDevice')}</span>
          {s.current ? <Tag tone="inv">{t('account.security.thisDevice')}</Tag> : null}
        </span>
      }
      body={`${s.ip ?? '—'} · ${s.current ? t('admin.members.online') : formatRelative(s.lastActiveAt, locale)}`}
      action={
        s.current ? null : (
          <Button size="sm" onClick={onRevoke}>
            {t('account.security.close')}
          </Button>
        )
      }
    />
  );
}

function PasswordDialog({
  open,
  onClose,
  email,
  name,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
  name: string;
}) {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setError(t('auth.password.tooShort', { min: MIN_PASSWORD, count: next.length }));
      return;
    }
    setBusy(true);
    const res = await changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: others,
    });
    setBusy(false);
    if (res.ok) {
      toast(t('account.security.passwordChanged'));
      setCurrent('');
      setNext('');
      onClose();
    } else setError(t('account.security.wrongPassword'));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader icon="key" title={t('account.security.changePassword')} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className="flex flex-col gap-3.5" onSubmit={onSubmit}>
          <Field label={t('account.security.currentPassword')}>
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t('auth.reset.newPassword')}>
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <PasswordStrength password={next} email={email} name={name} />
          <CheckboxRow checked={others} onCheckedChange={(v) => setOthers(v === true)}>
            {t('account.security.signOutOthers')}
          </CheckboxRow>
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={busy} disabled={!current || !next}>
              {t('common.actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmPasswordDialog({
  open,
  onClose,
  title,
  body,
  action,
  run,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  action: string;
  run: (password: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent>
        <DialogHeader icon="shield" title={title} description={body} />
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await run(pw);
            setBusy(false);
            if (ok) {
              setPw('');
              onClose();
            } else setError(true);
          }}
        >
          <Field
            label={t('account.security.currentPassword')}
            error={error ? t('account.security.wrongPassword') : undefined}
          >
            <Input
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="dngf" loading={busy} disabled={!pw}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BackupCodesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  function close() {
    setPw('');
    setCodes(null);
    setError(false);
    onClose();
  }
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : close())}>
      <DialogContent>
        <DialogHeader
          icon="note"
          title={t('account.security.newCodes')}
          description={t('setup2fa.codes.subtitle')}
        />
        {codes ? (
          <>
            <ol className="m-0 grid grid-flow-col grid-rows-5 list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-2xl bg-bg2 px-5 py-4 font-mono text-[15px] leading-[22px] font-medium tracking-[.04em]">
              {codes.map((c) => (
                <li key={c}>{formatBackupCode(c)}</li>
              ))}
            </ol>
            <DialogFooter>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(codes.map(formatBackupCode).join('\n'));
                  toast(t('setup2fa.codes.copied'));
                }}
              >
                <Icon name="copy" size={16} />
                {t('setup2fa.codes.copy')}
              </Button>
              <Button variant="pri" onClick={close}>
                {t('common.actions.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const res = await regenerateBackupCodes(pw);
              setBusy(false);
              if (res.ok) setCodes(res.data.backupCodes);
              else setError(true);
            }}
          >
            <Field
              label={t('account.security.currentPassword')}
              error={error ? t('account.security.wrongPassword') : undefined}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button variant="gh" onClick={close}>
                {t('common.actions.cancel')}
              </Button>
              <Button type="submit" variant="pri" loading={busy} disabled={!pw}>
                {t('account.security.generate')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
