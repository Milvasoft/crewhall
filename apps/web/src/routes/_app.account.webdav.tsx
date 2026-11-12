import { Button, Icon, Segmented } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { CopyField } from '@/components/mcp/parts';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { overviewQuery } from '@/lib/mcp/queries';
import { usePermissions } from '@/lib/session';

export const Route = createFileRoute('/_app/account/webdav')({
  component: WebdavPage,
});

type ClientKind = 'mac' | 'windows' | 'linux' | 'rclone';

function guessClient(): ClientKind {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'rclone';
}

/**
 * Hesabım › Drive'ı bağla (roadmap 9): how to mount Drive over WebDAV (`/dav`) in Finder,
 * Windows Explorer, Linux file managers and rclone, signing in with a personal token.
 */
function WebdavPage() {
  const { t } = useI18n();
  const { me } = usePermissions();
  const mcpOn = useModuleEnabled('mcp');
  const overview = useQuery({ ...overviewQuery, enabled: mcpOn });
  const [kind, setKind] = useState<ClientKind>(guessClient);

  const url = `${window.location.origin}/dav/`;
  const host = window.location.host;
  const email = me?.user.email ?? '';
  const tokensOn =
    mcpOn && overview.data?.enabled !== false && overview.data?.patsEnabled !== false;
  const rcloneCreate = `rclone config create crewhall webdav url=${url} vendor=other user=${email} pass=<token>`;

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('webdav.nav') }]}>
      <PageHeader title={t('webdav.title')} subtitle={t('webdav.subtitle')} />
      <div className="flex max-w-[860px] flex-col gap-5">
        <SettingsCard title={t('webdav.address.title')}>
          <div className="flex flex-col gap-1.5 py-3">
            <span className="text-sm font-semibold">{t('webdav.address.server')}</span>
            <CopyField value={url} />
            <span className="text-cap text-fg2">{t('webdav.address.serverHint')}</span>
          </div>
          <SettingsRow label={t('webdav.address.user')} description={t('webdav.address.userHint')}>
            <span className="font-mono text-[13px]">{email}</span>
          </SettingsRow>
          <SettingsRow
            label={t('webdav.address.password')}
            description={
              tokensOn ? t('webdav.address.passwordHint') : t('webdav.address.tokensOff')
            }
          >
            {tokensOn ? (
              <Button size="sm" asChild>
                <Link to="/account/mcp">
                  <Icon name="plus" size={14} />
                  {t('webdav.address.createToken')}
                </Link>
              </Button>
            ) : (
              <span className="text-cap text-fg2">{t('webdav.address.passwordValue')}</span>
            )}
          </SettingsRow>
        </SettingsCard>

        <SettingsCard
          title={t('webdav.clients.title')}
          aside={
            <Segmented
              size="sm"
              aria-label={t('webdav.clients.label')}
              value={kind}
              onValueChange={setKind}
              options={(['mac', 'windows', 'linux', 'rclone'] as const).map((k) => ({
                value: k,
                label: t(`webdav.clients.${k}`),
              }))}
            />
          }
        >
          <div className="flex flex-col gap-3 py-3 text-sm">
            {kind === 'mac' ? (
              <Steps
                items={[t('webdav.mac.step1'), t('webdav.mac.step2'), t('webdav.mac.step3')]}
                notes={[t('webdav.mac.note')]}
              />
            ) : null}
            {kind === 'windows' ? (
              <Steps
                items={[
                  t('webdav.windows.step1'),
                  t('webdav.windows.step2'),
                  <>
                    {t('webdav.windows.step3')}
                    <CopyField
                      className="mt-2"
                      prompt
                      value={`net use * ${url} /user:${email} <token> /persistent:yes`}
                    />
                  </>,
                ]}
                notes={[t('webdav.windows.noteHttps'), t('webdav.windows.noteSize')]}
              />
            ) : null}
            {kind === 'linux' ? (
              <Steps
                items={[
                  <>
                    {t('webdav.linux.step1')}
                    <CopyField className="mt-2" value={`davs://${host}/dav/`} />
                  </>,
                  t('webdav.linux.step2'),
                ]}
              />
            ) : null}
            {kind === 'rclone' ? (
              <Steps
                items={[
                  <>
                    {t('webdav.rclone.step1')}
                    <CopyField className="mt-2" prompt value={rcloneCreate} />
                  </>,
                  <>
                    {t('webdav.rclone.step2')}
                    <CopyField className="mt-2" prompt value="rclone lsd crewhall:" />
                    <CopyField
                      className="mt-2"
                      prompt
                      value="rclone mount crewhall: ~/Crewhall --vfs-cache-mode writes"
                    />
                  </>,
                ]}
              />
            ) : null}
          </div>
        </SettingsCard>

        <SettingsCard title={t('webdav.notes.title')}>
          <ul className="m-0 flex list-disc flex-col gap-1.5 py-3 pl-5 text-sm text-fg2">
            {(['spaces', 'types', 'versions', 'trash', 'rights'] as const).map((k) => (
              <li key={k}>{t(`webdav.notes.${k}`)}</li>
            ))}
          </ul>
        </SettingsCard>
      </div>
    </Workspace>
  );
}

function Steps({ items, notes = [] }: { items: ReactNode[]; notes?: string[] }) {
  return (
    <>
      <ol className="m-0 flex list-decimal flex-col gap-2.5 pl-5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
      {notes.map((n) => (
        <p key={n} className="m-0 flex gap-2 text-cap text-fg2">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          {n}
        </p>
      ))}
    </>
  );
}
