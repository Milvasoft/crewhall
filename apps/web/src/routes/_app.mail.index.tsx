import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { MailGate } from '@/components/mail/MailGate';
import { MailPage } from '@/components/mail/MailPage';
import { OauthReturn } from '@/components/mail/OauthReturn';

/** Roadmap 24: webmail. `?folder=&uid=` opens a conversation; `?new=1` the composer. */
export const Route = createFileRoute('/_app/mail/')({
  validateSearch: z.object({
    folder: z.string().min(1).max(1000).optional(),
    uid: z.coerce.number().int().min(1).optional(),
    q: z.string().max(200).optional(),
    filter: z.enum(['unread', 'flagged']).optional(),
    new: z.literal(1).optional().catch(undefined),
    connected: z.literal(1).optional().catch(undefined),
    error: z.string().max(100).optional(),
  }),
  component: function MailRoute() {
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
        <MailGate>{(state) => <MailPage state={state} search={search} />}</MailGate>
      </>
    );
  },
});
