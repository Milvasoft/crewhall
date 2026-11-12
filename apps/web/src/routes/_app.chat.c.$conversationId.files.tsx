import { createFileRoute } from '@tanstack/react-router';
import { useConversation } from '@/components/chat/ConversationLayout';
import { FilesTab } from '@/components/chat/ConversationTabs';

export const Route = createFileRoute('/_app/chat/c/$conversationId/files')({
  component: function ConversationFiles() {
    const { conv } = useConversation(Route.useParams().conversationId);
    return conv ? <FilesTab conv={conv} /> : null;
  },
});
