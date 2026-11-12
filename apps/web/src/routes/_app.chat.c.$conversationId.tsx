import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ConversationLayout } from '@/components/chat/ConversationLayout';
import { messagesQuery } from '@/lib/chat/queries';
import { warm } from '@/lib/prefetch';

export const Route = createFileRoute('/_app/chat/c/$conversationId')({
  validateSearch: z.object({
    /** Jump to and flash this message (links, search, pins, notifications). */
    seq: z.coerce.number().int().min(1).optional(),
    panel: z.enum(['webhooks']).optional(),
    hook: z.string().optional(),
  }),
  // Hover a chat in the list: its latest messages are ready before it opens.
  loader: ({ params, context: { queryClient } }) => {
    warm(queryClient, messagesQuery(params.conversationId));
  },
  component: function Conversation() {
    const { conversationId } = Route.useParams();
    const { panel, hook } = Route.useSearch();
    return (
      <ConversationLayout key={conversationId} id={conversationId} panel={panel} webhookId={hook} />
    );
  },
});
