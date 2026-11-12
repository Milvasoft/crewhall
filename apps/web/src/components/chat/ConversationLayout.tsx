import { Button, EmptyState, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { isApiError } from '@/lib/api';
import { conversationQuery, conversationsQuery } from '@/lib/chat/queries';
import { type Conversation } from '@/lib/chat/types';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useExit } from '@/lib/motion';
import { MeetingChatStrip } from '@/components/meet/MeetingChat';
import { ConnectionBanner } from './ConnectionBanner';
import { ConversationHeader } from './ConversationHeader';
import { WebhooksPanel } from './WebhooksPanel';

/** The open chat: list entry when loaded, else a direct fetch (links, drafts, new chats). */
export function useConversation(id: string) {
  const { data: list } = useQuery(conversationsQuery);
  const fromList = list?.find((c) => c.id === id);
  const q = useQuery({ ...conversationQuery(id), enabled: !fromList });
  return { conv: fromList ?? q.data, error: q.error, isPending: !fromList && q.isPending };
}

export function ConversationLayout({
  id,
  panel,
  webhookId,
}: {
  id: string;
  panel?: 'webhooks';
  webhookId?: string;
}) {
  const { t } = useI18n();
  const { conv, error, isPending } = useConversation(id);
  const hooks = useExit(panel === 'webhooks' && Boolean(conv?.permissions.manageWebhooks), 200);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tab = path.endsWith('/files') ? 'files' : path.endsWith('/pinned') ? 'pinned' : 'chat';

  if (isPending) {
    return (
      <div className="flex flex-col gap-3 p-6" aria-busy="true">
        <Skeleton className="w-48" />
        <Skeleton className="w-72" />
      </div>
    );
  }
  if (!conv) {
    return (
      <EmptyState
        className="m-auto"
        icon="chat"
        title={t(isApiError(error, 'not_found') ? 'chat.notFound.title' : 'errors.internal')}
        description={t('chat.notFound.body')}
      >
        <Button variant="inv" asChild>
          <Link to="/chat">{t('chat.notFound.back')}</Link>
        </Button>
      </EmptyState>
    );
  }
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={conv.title}>
      <ConversationHeader conv={conv} tab={tab} />
      <MeetingChatStrip conv={conv} />
      <ConnectionBanner />
      {/* The panel stays under the header: in the desktop app that is the window buttons' row. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        {hooks.mounted ? (
          <div
            data-state={hooks.state}
            className="flex min-h-0 shrink-0 animate-slide-in-right data-[state=closed]:animate-slide-out-right"
          >
            <WebhooksPanel conv={conv} webhookId={webhookId} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export type { Conversation };
