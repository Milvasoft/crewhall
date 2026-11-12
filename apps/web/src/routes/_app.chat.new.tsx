import { createFileRoute } from '@tanstack/react-router';
import { NewChat } from '@/components/chat/NewChat';

export const Route = createFileRoute('/_app/chat/new')({
  component: NewChat,
});
