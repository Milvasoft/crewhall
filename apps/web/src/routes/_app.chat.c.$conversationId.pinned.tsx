import { createFileRoute } from '@tanstack/react-router';
import { useConversation } from '@/components/chat/ConversationLayout';
import { PinnedTab } from '@/components/chat/ConversationTabs';

export const Route = createFileRoute('/_app/chat/c/$conversationId/pinned')({
  component: function ConversationPinned() {
    const { conv } = useConversation(Route.useParams().conversationId);
    return conv ? <PinnedTab conv={conv} /> : null;
  },
});
