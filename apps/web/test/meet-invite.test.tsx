import { type Call } from '@crewhall/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteSection } from '@/components/meet/room/InviteSection';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';

const state = {
  meeting: { id: 'm1', permissions: { inviteGuests: true } },
  callId: null,
  guest: false,
};
vi.mock('../src/components/meet/room/context', () => ({ useRoomState: () => state }));
vi.mock('../src/lib/session', () => ({ useMe: () => ({ user: { id: 'me' } }) }));

const user = (id: string, name: string) => ({
  id,
  name,
  email: `${id}@milvasoft.com`,
  imageUrl: null,
});
const elif = user('elif', 'Elif Yıldız');
const mert = user('mert', 'Mert Kaya');

function ringing(state: 'ringing' | 'declined'): Call {
  return {
    id: 'ring-1',
    meetingId: 'm1',
    slug: 'haftalik',
    conversationId: 'meeting-chat',
    conversationTitle: 'Haftalık',
    caller: user('me', 'Ben'),
    video: true,
    status: 'active',
    members: [{ user: elif, state, at: new Date().toISOString() }],
    upgraded: true,
    invite: true,
    startedAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    endedAt: null,
    durationSeconds: null,
  };
}

function renderSection(query: string, inMeeting = new Set<string>(['mert'])) {
  const client = createQueryClient();
  const view = render(
    <I18nProvider locale="tr">
      <QueryClientProvider client={client}>
        <InviteSection query={query} inMeeting={inMeeting} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { client, view };
}

afterEach(() => vi.restoreAllMocks());

describe('inviting from the people panel', () => {
  it('finds people in the organisation (not those inside) and rings them', async () => {
    const spy = vi.spyOn(api, 'call').mockImplementation(((name: string) =>
      Promise.resolve(
        name === 'listMembers'
          ? {
              items: [{ user: elif }, { user: mert }, { user: user('me', 'Ben') }],
              nextCursor: null,
            }
          : name === 'ringToMeeting'
            ? ringing('ringing')
            : ringing('ringing'),
      )) as never);
    renderSection('e');
    const row = await screen.findByText('Elif Yıldız');
    // The server searches: an organisation can be larger than a page of members.
    expect(spy).toHaveBeenCalledWith(
      'listMembers',
      expect.objectContaining({ query: expect.objectContaining({ q: 'e', status: 'active' }) }),
    );
    expect(screen.queryByText('Mert Kaya')).toBeNull();
    expect(screen.queryByText('Ben')).toBeNull();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Elif Yıldız kişisini toplantıya çağır' }));
    expect(spy).toHaveBeenCalledWith('ringToMeeting', {
      params: { meetingId: 'm1' },
      body: { userIds: ['elif'] },
    });
    expect(await screen.findByText('Çalıyor')).toBeInTheDocument();
    expect(row).toBeInTheDocument();
  });

  it('shows who turned it down and lets you call again', async () => {
    vi.spyOn(api, 'call').mockResolvedValue(ringing('declined') as never);
    // The room's call (or the first invite) tells the panel how the ring went.
    state.callId = 'ring-1' as never;
    renderSection('');
    expect(await screen.findByText('Reddetti')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Elif Yıldız kişisini toplantıya çağır' }),
    ).toHaveTextContent('Yeniden çağır');
    state.callId = null;
  });

  it('calls someone again who joined and left since', async () => {
    const left = ringing('ringing');
    left.members[0]!.state = 'accepted';
    left.members[0]!.at = new Date(Date.now() - 60_000).toISOString();
    vi.spyOn(api, 'call').mockResolvedValue(left as never);
    state.callId = 'ring-1' as never;
    renderSection('', new Set());
    const button = await screen.findByRole('button', {
      name: 'Elif Yıldız kişisini toplantıya çağır',
    });
    expect(button).toHaveTextContent('Yeniden çağır');
    expect(screen.queryByText('Katılıyor')).toBeNull();
    state.callId = null;
  });

  it('sends a guest the link by e-mail', async () => {
    const spy = vi.spyOn(api, 'call').mockResolvedValue({ items: [], nextCursor: null } as never);
    renderSection('deniz@opsiyon.com.tr');
    const u = userEvent.setup();
    const row = (await screen.findByText('deniz@opsiyon.com.tr')).closest('div')!;
    await u.click(within(row).getByRole('button', { name: 'E-postayla davet linki gönder' }));
    expect(spy).toHaveBeenCalledWith('inviteToMeeting', {
      params: { meetingId: 'm1' },
      body: { userIds: [], emails: ['deniz@opsiyon.com.tr'] },
    });
  });
});
