import { createFileRoute } from '@tanstack/react-router';
import { SessionSummary } from '@/components/meet/SessionSummary';

/** Design 7.17: after the meeting. */
export const Route = createFileRoute('/_app/meetings/summary/$sessionId')({
  component: function SessionSummaryRoute() {
    const { sessionId } = Route.useParams();
    return <SessionSummary sessionId={sessionId} />;
  },
});
