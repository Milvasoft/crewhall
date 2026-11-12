import { Button, CrewhallMark, Icon, IconButton, toast } from '@crewhall/ui';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { isApiError } from '@/lib/api';
import { useI18nOrDefault } from '@/lib/i18n/I18nContext';
import { formatTime } from '@/lib/i18n/format';
import { cachedBranding } from '@/lib/useBranding';
import { newId } from '@/lib/ids';

/**
 * Unexpected error (doc 01 · 1.19, right side). Uses only the cached tenant name and mark
 * because the shell may not load, and works without the i18n provider. The error id is what
 * the admin looks up in the logs.
 */
export function ErrorPage({ error, reset }: Partial<ErrorComponentProps>) {
  // The root boundary can catch errors thrown above the i18n provider (e.g. during HMR).
  const { t, locale } = useI18nOrDefault();
  const router = useRouter();
  const branding = cachedBranding();
  const errorId = useMemo(() => newId().slice(0, 13), []);
  const at = useMemo(() => new Date(), []);
  const status = isApiError(error) ? error.status : 500;

  if (import.meta.env.DEV && error) console.error(error);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${errorId} · ${at.toISOString()}`);
      toast(t('pages.error.copied'));
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-7">
        {branding.markUrl ? (
          <img src={branding.markUrl} alt="" className="size-7 rounded-sm" />
        ) : (
          <CrewhallMark size={26} />
        )}
        <span className="text-sm font-semibold">{branding.orgName}</span>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <section className="flex min-h-[348px] w-[440px] max-w-full flex-col gap-4 rounded-4xl bg-surface p-7 shadow-line">
          <span className="flex size-11 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger">
            <Icon name="alert" size={22} />
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-h font-semibold">{t('pages.error.title')}</h1>
            <p className="m-0 text-sm text-fg2">{t('pages.error.subtitle', { status })}</p>
          </div>
          <p className="m-0 text-sm text-fg">{t('pages.error.body')}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-cap font-medium text-fg2">{t('pages.error.idLabel')}</span>
            <div className="flex h-10 items-center gap-2.5 rounded-md bg-bg2 pr-1.5 pl-3 font-mono text-sm font-medium">
              <span className="flex-1 truncate">
                {errorId} · {formatTime(at, locale)}
              </span>
              <IconButton
                aria-label={t('pages.error.copy')}
                size="xs"
                tone="plain"
                shape="sq"
                onClick={copy}
              >
                <Icon name="copy" size={16} />
              </IconButton>
            </div>
          </div>
          <div className="mt-auto flex gap-2">
            <Button
              variant="inv"
              onClick={() => {
                reset?.();
                void router.invalidate();
              }}
            >
              <Icon name="refresh" size={18} />
              {t('common.actions.retry')}
            </Button>
            <Button onClick={() => void router.navigate({ to: '/' })}>
              {t('pages.error.home')}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
