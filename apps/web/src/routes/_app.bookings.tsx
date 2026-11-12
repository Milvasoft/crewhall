import { createFileRoute } from '@tanstack/react-router';
import { BookingsPage } from '@/components/calendar/BookingsPage';

/** Room and desk booking (calendar module). */
export const Route = createFileRoute('/_app/bookings')({
  component: BookingsPage,
});
