import { createFileRoute } from '@tanstack/react-router';
import { AnnouncementFeed } from '@/components/announcements/AnnouncementFeed';

/** Duyurular (roadmap 19): the internal announcements feed. */
export const Route = createFileRoute('/_app/announcements/')({
  component: AnnouncementFeed,
});
