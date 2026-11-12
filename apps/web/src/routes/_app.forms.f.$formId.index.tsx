import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { FormEditorPage } from '@/components/forms/FormEditorPage';

/** Form builder (roadmap 16): `?tab=fields|sharing|preview`. */
export const Route = createFileRoute('/_app/forms/f/$formId/')({
  validateSearch: z.object({
    tab: z.enum(['fields', 'sharing', 'preview']).optional().catch(undefined),
  }),
  component: function FormEditorRoute() {
    const { formId } = Route.useParams();
    const { tab } = Route.useSearch();
    return <FormEditorPage formId={formId} tab={tab ?? 'fields'} />;
  },
});
