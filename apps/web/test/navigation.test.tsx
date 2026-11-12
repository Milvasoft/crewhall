import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { nodesQuery } from '@/features/drive/api';
import { messagesQuery } from '@/lib/chat/queries';
import { cachedSpaceId } from '@/lib/prefetch';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Page changes draw from the cache: hovering a link warms the next screen's data. */
describe('navigation warm-up', () => {
  it('preloading a Drive folder route fetches its listing before the click', async () => {
    signedInAs(USER.bugra);
    const { router, queryClient } = renderApp('/drive/recent');
    await screen.findByRole('heading', { name: 'Son açılanlar' });
    const spaceId = cachedSpaceId(queryClient, 'milvasoft')!;
    expect(spaceId).toBeTruthy();
    const key = nodesQuery(spaceId, null, { sort: 'name', order: 'asc' }).queryKey;
    expect(queryClient.getQueryData(key)).toBeUndefined();
    await router.preloadRoute({ to: '/drive/$spaceSlug', params: { spaceSlug: 'milvasoft' } });
    await waitFor(() => expect(queryClient.getQueryData(key)).toBeDefined());
  });

  it('preloading a chat loads its latest messages', async () => {
    signedInAs(USER.bugra);
    const { router, queryClient } = renderApp('/drive/recent');
    await screen.findByRole('heading', { name: 'Son açılanlar' });
    const key = messagesQuery(CONV.elif).queryKey;
    await router.preloadRoute({
      to: '/chat/c/$conversationId',
      params: { conversationId: CONV.elif },
    });
    await waitFor(() => expect(queryClient.getQueryData(key)).toBeDefined());
  });
});
