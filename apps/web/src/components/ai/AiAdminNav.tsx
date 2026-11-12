import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';

/** Yönetim sidebar entry of the AI module; hidden while the module is switched off. */
export function AiAdminNav() {
  const { t } = useI18n();
  if (!useModuleEnabled('ai')) return null;
  return <NavItem icon="sparkle" to="/admin/ai" label={t('ai.admin.nav')} />;
}
