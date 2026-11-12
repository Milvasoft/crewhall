import { MAIL_CONVERSATION_STATUSES } from '@crewhall/shared';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { InboxPage } from '@/components/mail/inbox/InboxPage';
import { OauthReturn } from '@/components/mail/OauthReturn';

/**
 * A shared inbox (sonraki-isler.md "Ortak gelen kutusu"); `?conversation=` opens one. The
 * inbox's OAuth sign-in returns here with `?connected=1` or `?error=<code>`.
 */
export const Route = createFileRoute('/_app/mail/inbox/$inboxId')({
  validateSearch: z.object({
    conversation: z.uuid().optional().catch(undefined),
    status: z
      .enum([...MAIL_CONVERSATION_STATUSES, 'all'])
      .optional()
      .catch(undefined),
    assignee: z.enum(['me', 'none']).optional().catch(undefined),
    tag: z.string().max(40).optional(),
    q: z.string().max(200).optional(),
    connected: z.literal(1).optional().catch(undefined),
    error: z.string().max(100).optional(),
  }),
  component: function InboxRoute() {
    const { inboxId } = Route.useParams();
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const seen = useCallback(
      () =>
        void navigate({
          search: (prev) => ({ ...prev, connected: undefined, error: undefined }),
          replace: true,
        }),
      [navigate],
    );
    return (
      <>
        <OauthReturn connected={search.connected === 1} error={search.error} onSeen={seen} />
        <InboxPage inboxId={inboxId} search={search} />
      </>
    );
  },
});
