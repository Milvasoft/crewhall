import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from '@/components/identity/parts';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Asks before leaving a settings page with unsaved changes. An in-app dialog instead of
 * window.confirm: browsers and embedded views may suppress native dialogs, which then
 * blocked the navigation without a word. Reloading or closing the tab still gets the
 * browser's own prompt. `allow` lets some destinations through (e.g. after a save).
 */
export function useUnsavedGuard(dirty: boolean, allow?: (pathname: string) => boolean) {
  const { t } = useI18n();
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => dirty && !(allow?.(next.pathname) ?? false),
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
      title={t('identity.common.unsavedTitle')}
      body={t('admin.leaveUnsaved')}
      confirm={t('identity.common.leave')}
      onConfirm={() => blocker.proceed()}
    />
  );
}
