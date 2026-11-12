import { NavItem } from '@/components/spaces/SpaceSidebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';

/** Yönetim sidebar entry of the calendar module (hidden while the module is off). */
export function CalendarAdminNav() {
  const { t } = useI18n();
  const on = useModuleEnabled('calendar');
  if (!on) return null;
  return (
    <>
      <NavItem icon="calendar" to="/admin/calendar" label={t('calendar.admin.nav')} />
      <NavItem icon="users" to="/admin/bookings" label={t('calendar.booking.admin.nav')} />
    </>
  );
}
