import { createFileRoute } from '@tanstack/react-router';
import { FillPage } from '@/components/forms/FillPages';

/** Answering a form inside the app (org members). */
export const Route = createFileRoute('/_app/forms/edit/$formId')({
  component: function FillRoute() {
    const { formId } = Route.useParams();
    return <FillPage formId={formId} />;
  },
});
