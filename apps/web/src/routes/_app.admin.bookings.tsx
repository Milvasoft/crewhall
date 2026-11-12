import { createFileRoute } from '@tanstack/react-router';
import { BookingsAdminPage } from '@/components/calendar/BookingsAdminPage';

/** Yönetim › Oda ve masa: the rooms and desks people can book. */
export const Route = createFileRoute('/_app/admin/bookings')({
  component: BookingsAdminPage,
});
