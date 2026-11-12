import { createFileRoute } from '@tanstack/react-router';
import { PublicFormPage } from '@/components/forms/FillPages';

/** Public form link: no app shell and no session (roadmap 16). */
export const Route = createFileRoute('/f/$token')({
  component: function PublicFormRoute() {
    const { token } = Route.useParams();
    return <PublicFormPage token={token} />;
  },
});
