import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { openDriveDialog } from '@/features/drive/actions';
import { chatState } from '@/mocks/chat';
import { db } from '@/mocks/db';
import { federationState } from '@/mocks/federation';
import { SPACE, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Federation screens (roadmap 26): admin pairing, remote chats, sending a share. */

const turnOn = () => {
  federationState(db()).enabled = true;
};

describe('Yönetim › Federasyon', () => {
  it('turns federation on, shows the fingerprint and adds a peer', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/federation');
    const user = userEvent.setup();
    expect(await screen.findByText(/Federasyon kapalı/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Federasyonu aç' }));
    expect(await screen.findByText('3F2A 9C1D 77B0 E4A5 0C6D 18F3 A2B9 5E70')).toBeInTheDocument();
    expect(screen.getAllByText('hub.acme.com').length).toBeGreaterThan(0);

    await user.type(screen.getByRole('textbox', { name: 'Alan' }), 'hub.ornek.com');
    await user.click(screen.getByRole('button', { name: /Eş ekle/ }));
    expect((await screen.findAllByText('hub.ornek.com')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Karşı tarafın seni eklemesi bekleniyor/)).toBeInTheDocument();
    expect(federationState(db()).allowedDomains).toContain('hub.ornek.com');
  });
});

describe('chat with remote people', () => {
  it('opens a direct chat from a handle@domain address', async () => {
    turnOn();
    signedInAs(USER.bugra);
    renderApp('/chat/new');
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: /Kime/ }), 'ayse@hub.acme.com');
    await user.click(
      await screen.findByRole('button', { name: /ayse@hub\.acme\.com ile sohbet aç/ }),
    );
    expect(await screen.findByText('Federasyonlu · hub.acme.com')).toBeInTheDocument();
    const conv = chatState(db()).conversations.find(
      (c) => c.federation?.remoteMembers[0]?.address === 'ayse@hub.acme.com',
    )!;
    expect(conv.type).toBe('direct');
    expect(conv.name).toBe('Ayşe Demir');
  });

  it('shows a remote author with their domain', async () => {
    turnOn();
    signedInAs(USER.bugra);
    const conv = await api.call('createRemoteConversation', {
      body: { address: 'kerem@hub.acme.com' },
    });
    const c = chatState(db());
    const mine = c.messages.filter((m) => m.conversationId === conv.id);
    expect(mine).toHaveLength(0);
    await api.call('sendMessage', {
      params: { conversationId: conv.id },
      body: { clientMsgId: crypto.randomUUID(), text: 'Merhaba Kerem', attachmentNodeIds: [] },
    });
    // As the server stores a message from the other installation: no local author.
    const sent = c.messages.find((m) => m.conversationId === conv.id)!;
    Object.assign(sent, {
      authorId: null,
      text: 'Selam, gördüm',
      clientMsgId: null,
      remoteAuthor: { address: 'kerem@hub.acme.com', name: 'Kerem Aydın', domain: 'hub.acme.com' },
    });
    renderApp(`/chat/c/${conv.id}`);
    expect((await screen.findAllByText('Selam, gördüm')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Kerem Aydın').length).toBeGreaterThan(0);
    expect(await screen.findByTitle('kerem@hub.acme.com')).toHaveTextContent('hub.acme.com');
  });

  it('adds a remote person to a group from the menu', async () => {
    turnOn();
    signedInAs(USER.bugra);
    const group = await api.call('createConversation', {
      body: { type: 'group', userIds: [USER.elif, USER.can], name: 'Ortak iş' },
    });
    renderApp(`/chat/c/${group.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sohbet menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Başka kurumdan kişi ekle' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'ayse@hub.acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    await waitFor(() =>
      expect(
        chatState(db()).conversations.find((c) => c.id === group.id)?.federation?.remoteMembers,
      ).toEqual([{ address: 'ayse@hub.acme.com', name: 'Ayşe Demir', domain: 'hub.acme.com' }]),
    );
  });
});

describe('sharing with a remote person', () => {
  it('sends a page or file as a link in the direct chat', async () => {
    turnOn();
    signedInAs(USER.bugra);
    const { items } = await api.call('listNodes', {
      params: { spaceId: SPACE.milvasoft },
      query: {},
    });
    const node = items.find((n) => n.type === 'file') ?? items[0]!;
    renderApp('/');
    const user = userEvent.setup();
    await screen.findAllByRole('navigation');
    act(() => openDriveDialog({ kind: 'share', node }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByRole('textbox', { name: 'Adres' }),
      'ayse@hub.acme.com',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Not (isteğe bağlı)' }),
      'Bakar mısın?',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    await waitFor(() => {
      const conv = chatState(db()).conversations.find(
        (c) => c.federation?.remoteMembers[0]?.address === 'ayse@hub.acme.com',
      )!;
      const last = chatState(db())
        .messages.filter((m) => m.conversationId === conv.id)
        .at(-1);
      expect(last?.text).toMatch(new RegExp(`^Bakar mısın\\?\\n\\n${node.name}: .+/s/`));
    });
  });
});
