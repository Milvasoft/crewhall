import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ContactsPage } from '@/components/contacts/ContactsPage';

/** Rehber (roadmap 15): directory. */
export const Route = createFileRoute('/_app/contacts/')({
  validateSearch: z.object({
    department: z.string().max(120).optional(),
    tag: z.string().max(40).optional(),
  }),
  component: function ContactsRoute() {
    const { department, tag } = Route.useSearch();
    return <ContactsPage key="directory" view="directory" department={department} tag={tag} />;
  },
});
