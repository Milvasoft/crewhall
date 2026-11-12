import { createFileRoute } from '@tanstack/react-router';
import { useConversation } from '@/components/chat/ConversationLayout';
import { ConversationPane } from '@/components/chat/ConversationPane';

export const Route = createFileRoute('/_app/chat/c/$conversationId/')({
  component: function ConversationChat() {
    const { conversationId } = Route.useParams();
    const { seq } = Route.useSearch();
    const { conv } = useConversation(conversationId);
    return conv ? <ConversationPane key={conv.id} conv={conv} seq={seq} /> : null;
  },
});
