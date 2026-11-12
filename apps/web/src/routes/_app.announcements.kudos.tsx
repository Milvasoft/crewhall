import { createFileRoute } from '@tanstack/react-router';
import { KudosWall } from '@/components/announcements/KudosWall';

/** Duyurular › Teşekkür duvarı: thank-you cards, birthdays and work anniversaries. */
export const Route = createFileRoute('/_app/announcements/kudos')({
  component: KudosWall,
});
