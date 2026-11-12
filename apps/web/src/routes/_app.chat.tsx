import { cn } from '@crewhall/ui';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ChatDialogs } from '@/components/chat/ChatDialogs';
import { ChatDisabled } from '@/components/chat/ChatHome';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { useChatEnabled } from '@/lib/chat/enabled';
import { useShellLayout, useShownPath } from '@/lib/shell';

/** Chat (design 04): the list on the left, the open chat, search or new chat on the right. */
export const Route = createFileRoute('/_app/chat')({
  component: function ChatLayout() {
    const enabled = useChatEnabled();
    // Phone (H10): /chat shows only the list, a chat only the conversation.
    const listOnly = useShownPath() === '/chat';
    const phone = useShellLayout() === 'phone';
    // The org turned chat off: links and old bookmarks land here instead of failing with 403s.
    if (!enabled) return <ChatDisabled />;
    return (
      <>
        <ChatSidebar />
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', phone && listOnly && 'hidden')}>
          <Outlet />
        </div>
        <ChatDialogs />
      </>
    );
  },
});
