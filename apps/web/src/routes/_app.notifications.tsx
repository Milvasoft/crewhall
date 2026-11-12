import { NotificationSource } from '@crewhall/shared';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { NotificationCenter } from '@/components/notifications/NotificationCenter';

/** Notification centre (19.17). */
export const Route = createFileRoute('/_app/notifications')({
  validateSearch: z.object({
    box: z.enum(['inbox', 'snoozed', 'dismissed']).optional(),
    kind: z.enum(['mentions', 'assigned', 'alerts']).optional(),
    source: NotificationSource.optional(),
    unread: z.boolean().optional(),
  }),
  component: function Notifications() {
    return <NotificationCenter params={Route.useSearch()} />;
  },
});
