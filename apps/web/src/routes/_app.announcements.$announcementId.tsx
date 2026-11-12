import { createFileRoute } from '@tanstack/react-router';
import { AnnouncementView } from '@/components/announcements/AnnouncementView';

/** One announcement (roadmap 19); notifications and e-mails link here. */
export const Route = createFileRoute('/_app/announcements/$announcementId')({
  component: function Announcement() {
    const { announcementId } = Route.useParams();
    return <AnnouncementView key={announcementId} id={announcementId} />;
  },
});
