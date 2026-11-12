import { Button, CrewhallMark, Skeleton } from '@crewhall/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  finishSignIn,
  loadOffice,
  saveTokens,
  startSignIn,
  type OfficeHost,
} from '@/lib/microsoft/office';
import { loadTeams } from '@/lib/microsoft/teams';

/** The narrow frame of a task pane, dialog or Teams tab: mark, title, content. */
export function PaneFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col gap-3 bg-bg p-4 text-fg">
      <header className="flex items-center gap-2">
        <CrewhallMark size={22} />
        <h1 className="m-0 text-sub font-semibold">{title}</h1>
      </header>
      {children}
    </main>
  );
}

/** `/office/signin`: the dialog's first page; goes straight on to Crewhall's authorize. */
export function OfficeSignInPage({ clientId, host }: { clientId: string; host: OfficeHost }) {
  const { t } = useI18n();
  useEffect(() => {
    if (clientId) void startSignIn(clientId, host);
  }, [clientId, host]);
  return (
    <PaneFrame title={t('microsoft.pane.signIn')}>
      <Skeleton className="h-10 rounded-lg" />
    </PaneFrame>
  );
}

/** `/office/callback`: trades the code and hands the tokens to the pane that opened the dialog. */
export function OfficeCallbackPage() {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const { tokens, host, clientId } = await finishSignIn(
          new URLSearchParams(window.location.search),
        );
        const message = JSON.stringify(tokens);
        if (host === 'teams') {
          const teams = await loadTeams();
          if (teams) {
            teams.authentication.notifySuccess(message);
            return;
          }
        } else {
          const office = await loadOffice();
          if (office) {
            office.context.ui.messageParent(message);
            return;
          }
        }
        // A plain browser window (testing outside Office): keep the tokens here.
        saveTokens(clientId, tokens);
        window.close();
      } catch {
        setFailed(true);
      }
    })();
  }, []);
  return (
    <PaneFrame title={t('microsoft.pane.signIn')}>
      {failed ? (
        <Notice tone="error">{t('microsoft.pane.signInFailed')}</Notice>
      ) : (
        <Skeleton className="h-10 rounded-lg" />
      )}
    </PaneFrame>
  );
}

/** Shown in a pane while the person has no token yet. */
export function SignInPrompt({ onSignIn, failed }: { onSignIn: () => void; failed: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-cap text-fg2">{t('microsoft.pane.signInHint')}</p>
      {failed ? <Notice tone="error">{t('microsoft.pane.signInFailed')}</Notice> : null}
      <Button variant="inv" onClick={onSignIn}>
        {t('microsoft.pane.signIn')}
      </Button>
    </div>
  );
}
