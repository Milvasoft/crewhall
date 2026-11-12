import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AutomationsHome } from '@/components/automations/AutomationPages';
import { spacesQuery } from '@/lib/queries';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/** Automation rules of a space (roadmap 17). */
export const Route = createFileRoute('/_app/automations/$spaceSlug/')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: function AutomationsRoute() {
    const { spaceSlug } = Route.useParams();
    const space = useSpaces().bySlug(spaceSlug);
    useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
    return space ? <AutomationsHome space={space} /> : null;
  },
});
