import { type PortalChange, type PortalChangeKind } from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useWhen } from './common';

/** Labels for queue entries (10.1, 10.11): the client builds them from the change fields. */

export const CHANGE_ICON: Record<PortalChangeKind, IconName> = {
  doc: 'page',
  post: 'edit',
  home: 'home',
  navigation: 'menu',
};

export function useChangeText() {
  const { t } = useI18n();
  const when = useWhen();
  return {
    title: (c: Pick<PortalChange, 'kind' | 'title'>) =>
      c.kind === 'home' || c.kind === 'navigation' ? t(`portal.kind.${c.kind}`) : c.title,
    detail: (c: Pick<PortalChange, 'kind' | 'version' | 'action' | 'scheduledAt'>) =>
      [
        t(`portal.kind.${c.kind}`),
        c.version,
        c.action === 'schedule' && c.scheduledAt
          ? t('portal.action.scheduleAt', { when: when(c.scheduledAt) })
          : t(`portal.action.${c.action}`),
      ]
        .filter(Boolean)
        .join(' · '),
  };
}
