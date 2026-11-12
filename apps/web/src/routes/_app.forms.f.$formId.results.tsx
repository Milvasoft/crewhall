import { createFileRoute } from '@tanstack/react-router';
import { FormResultsPage } from '@/components/forms/FormEditorPage';

/** Results of a form: summary charts, the answer table and CSV (roadmap 16). */
export const Route = createFileRoute('/_app/forms/f/$formId/results')({
  component: function FormResultsRoute() {
    const { formId } = Route.useParams();
    return <FormResultsPage formId={formId} />;
  },
});
