import { createFileRoute, notFound } from '@tanstack/react-router';
import { NewRulePage } from '@/components/automations/AutomationPages';
import { spacesQuery } from '@/lib/queries';
import { useSpaces } from '@/lib/useSpaces';

/** New automation rule. */
export const Route = createFileRoute('/_app/automations/$spaceSlug/new')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: function NewRuleRoute() {
    const { spaceSlug } = Route.useParams();
    const space = useSpaces().bySlug(spaceSlug);
    return space ? <NewRulePage space={space} /> : null;
  },
});
