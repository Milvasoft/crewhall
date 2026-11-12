import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MeetHome } from '@/components/meet/MeetHome';

/** Design 7.1: meetings home; `?view=scheduled|recordings|history` opens the full lists. */
export const Route = createFileRoute('/_app/meetings/')({
  validateSearch: z.object({
    view: z.enum(['scheduled', 'recordings', 'history']).optional(),
    /** Ctrl K "Yeni toplantı" opens the dialog. */
    new: z.enum(['now', 'schedule', 'room']).optional(),
  }),
  component: function MeetHomeRoute() {
    const { view, new: open } = Route.useSearch();
    return (
      <MeetHome
        view={view === 'scheduled' ? 'upcoming' : (view ?? 'home')}
        open={
          open === 'now'
            ? 'instant'
            : open === 'schedule'
              ? 'scheduled'
              : open === 'room'
                ? 'room'
                : undefined
        }
      />
    );
  },
});
