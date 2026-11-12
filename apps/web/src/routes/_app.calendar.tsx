import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { CalendarPage } from '@/components/calendar/CalendarPage';
import { OauthReturn } from '@/components/calendar/OauthReturn';

/**
 * Calendar (roadmap 14): `?view=day|week|month|agenda&date=YYYY-MM-DD&event=<id>&space=<id>`.
 * `?connected=google|microsoft` / `?error=<code>`: back from connecting an account.
 */
export const Route = createFileRoute('/_app/calendar')({
  validateSearch: z.object({
    view: z.enum(['day', 'week', 'month', 'agenda']).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    event: z.uuid().optional(),
    space: z.uuid().optional(),
    connected: z.enum(['google', 'microsoft']).optional().catch(undefined),
    error: z.string().max(100).optional(),
  }),
  component: function CalendarRoute() {
    const { view, date, event, space, connected, error } = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const seen = useCallback(
      () =>
        void navigate({
          search: (prev) => ({ ...prev, connected: undefined, error: undefined }),
          replace: true,
        }),
      [navigate],
    );
    return (
      <>
        <OauthReturn connected={connected} error={error} onSeen={seen} />
        <CalendarPage view={view} date={date} eventId={event} spaceId={space} />
      </>
    );
  },
});
