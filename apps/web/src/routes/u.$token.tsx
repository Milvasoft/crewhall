import { createFileRoute } from '@tanstack/react-router';
import { UploadRequestPage } from '@/components/microsoft/UploadRequestPage';

/** Public upload request link ("bana dosya yükle", Outlook add-in): no app shell, no session. */
export const Route = createFileRoute('/u/$token')({
  component: function UploadRequestRoute() {
    const { token } = Route.useParams();
    return <UploadRequestPage token={token} />;
  },
});
