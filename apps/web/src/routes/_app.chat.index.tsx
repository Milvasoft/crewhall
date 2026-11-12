import { createFileRoute } from '@tanstack/react-router';
import { ChatHome } from '@/components/chat/ChatHome';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatHome,
});
