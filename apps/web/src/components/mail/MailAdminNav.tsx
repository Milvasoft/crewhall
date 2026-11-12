import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';

/** Yönetim sidebar entry of the mail module (hidden while the module is off). */
export function MailAdminNav() {
  const { t } = useI18n();
  const on = useModuleEnabled('mail');
  if (!on) return null;
  return <NavItem icon="mail" to="/admin/mail" label={t('mail.admin.nav')} />;
}
