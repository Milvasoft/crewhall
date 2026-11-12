import { createFileRoute } from '@tanstack/react-router';
import { CalendarAdminPage } from '@/components/calendar/CalendarAdminPage';

/** Yönetim › Takvim: Google and Microsoft calendar connections. */
export const Route = createFileRoute('/_app/admin/calendar')({
  component: CalendarAdminPage,
});
