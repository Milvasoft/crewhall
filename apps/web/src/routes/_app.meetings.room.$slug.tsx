import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MeetingPage } from '@/components/meet/MeetingPage';

/** Design 7.3-7.16: waiting room and the room itself, inside the app shell. */
export const Route = createFileRoute('/_app/meetings/room/$slug')({
  // ?call=<call id>: a call (H7) joins at once, without the waiting room.
  // ?window=1: the meeting's own tab (lib/meet/window).
  validateSearch: z.object({
    call: z.string().optional(),
    window: z.union([z.string(), z.number()]).optional(),
    // ?device: "Şu an bu toplantıdasın" chose to move the meeting here or add this device.
    device: z.enum(['transfer', 'add']).optional(),
  }),
  component: function MeetingRoute() {
    const { slug } = Route.useParams();
    const { call, device } = Route.useSearch();
    return <MeetingPage key={slug} slug={slug} callId={call} device={device} />;
  },
});
