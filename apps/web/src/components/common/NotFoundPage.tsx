import { Button, CrewhallMark, Icon } from '@crewhall/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { setPaletteOpen } from '@/lib/palette';
import { useBootstrap } from '@/lib/useBranding';

function NotFoundBody({ inShell }: { inShell: boolean }) {
  const { t } = useI18n();
  return (
    <div className="m-auto flex max-w-[460px] flex-col items-center gap-3 py-10 text-center">
      <span className="font-mono text-[96px] leading-[96px] font-bold tracking-[-.04em] text-fg3 opacity-60">
        404
      </span>
      <h1 className="m-0 text-wtitle font-bold">{t('pages.notFound.title')}</h1>
      <p className="m-0 text-sm text-fg2">{t('pages.notFound.body')}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="inv" asChild>
          <Link to="/">
            <Icon name="home" size={18} />
            {t('pages.notFound.home')}
          </Link>
        </Button>
        {inShell ? (
          <Button onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={18} />
            {t('pages.notFound.search')}
          </Button>
        ) : null}
      </div>
      <p className="m-0 mt-3 text-cap text-fg3">{t('pages.notFound.hint')}</p>
    </div>
  );
}

/** Unknown route or hidden node inside the shell; no module is selected (doc 01 · 1.18). */
export function InShellNotFound() {
  const href = useRouterState({ select: (s) => s.location.href });
  return (
    <Workspace crumbs={[{ label: <span className="font-mono font-normal">{href}</span> }]}>
      <NotFoundBody inShell />
    </Workspace>
  );
}

/** Fallback outside the shell (signed out). */
export function NotFoundPage() {
  const { branding } = useBootstrap();
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-7">
        <CrewhallMark size={26} />
        <span className="text-sm font-semibold">{branding.orgName}</span>
      </header>
      <NotFoundBody inShell={false} />
    </div>
  );
}
