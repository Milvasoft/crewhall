import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ChatSearch } from '@/components/chat/ChatSearch';

export const Route = createFileRoute('/_app/chat/search')({
  validateSearch: z.object({
    q: z.string().optional(),
    from: z.string().optional(),
    conv: z.string().optional(),
    file: z.boolean().optional(),
    days: z.coerce.number().int().optional(),
  }),
  component: function ChatSearchRoute() {
    const params = Route.useSearch();
    return <ChatSearch key={params.q ?? ''} params={params} />;
  },
});
