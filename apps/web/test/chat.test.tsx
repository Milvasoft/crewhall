import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ICON_PATHS } from '@crewhall/ui';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { chatEnabled } from '@/lib/chat/enabled';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

const messagesOf = (convId: string) =>
  chatState(db())
    .messages.filter((m) => m.conversationId === convId)
    .sort((a, b) => a.seq - b.seq);

describe('chat (design 04)', () => {
  it('lists pinned chats first with unread and mention counts', async () => {
    signedInAs(USER.bugra);
    renderApp('/chat');
    const pinned = await screen.findByRole('heading', { name: 'Sabitlenenler' });
    const section = pinned.closest('section')!;
    const rows = within(section).getAllByRole('link');
    expect(rows[0]).toHaveTextContent('Milvaion Ekibi');
    expect(rows[1]).toHaveTextContent('Prod Alarmları');
    expect(within(rows[0]!).getByLabelText('1 okunmamış bahsetme')).toBeInTheDocument();
    // Filters: Birebir keeps direct chats only.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Birebir' }));
    expect(screen.queryByText('Milvaion Ekibi')).toBeNull();
    expect(screen.getByText('Elif Yıldız')).toBeInTheDocument();
  });

  it('shows "Yeni sohbet" with the compose icon and a tooltip (H11)', async () => {
    signedInAs(USER.bugra);
    renderApp('/chat');
    const user = userEvent.setup();
    const list = await screen.findByRole('complementary', { name: 'Sohbet' });
    const button = within(list).getByRole('button', { name: 'Yeni sohbet' });
    expect(button.querySelector('svg')?.innerHTML).toBe(ICON_PATHS.compose);
    await user.hover(button);
    expect(await screen.findByRole('tooltip', { name: 'Yeni sohbet' })).toBeInTheDocument();
  });

  it('sends a message with an @mention picked from the suggestions', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.type(box, 'Bakar mısın @Zey');
    const option = await screen.findByRole('option', { name: /Zeynep Arslan/ });
    await user.click(option);
    await user.type(box, 'bugün{Enter}');
    await waitFor(() => {
      const last = messagesOf(CONV.milvaion).at(-1)!;
      expect(last.text).toBe(`Bakar mısın <@${USER.zeynep}> bugün`);
    });
    expect(await screen.findByText('@Zeynep Arslan')).toBeInTheDocument();
  });

  it('shows the @mention list above the composer in a portal and closes it with Escape', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.type(box, '@Zey');
    const list = await screen.findByRole('listbox', { name: 'Bu sohbetteki kişiler' });
    const panel = list.closest('[data-radix-popper-content-wrapper]');
    // doc 02 · 9.4: drawn on body, not inside the chat pane that scrolls and clips.
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.contains(box)).toBe(false);
    expect(list.closest('[data-side]')).toHaveAttribute('data-side', 'top');
    expect(box).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Bu sohbetteki kişiler' })).toBeNull(),
    );
    expect(box).toHaveFocus();
    expect(box).toHaveValue('@Zey');
  });

  it('replies with a quote and edits the last own message with the up arrow', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.elif}`);
    const user = userEvent.setup();
    const original = await screen.findByText('İyi hafta sonları 👋');
    const row = original.closest('[data-seq]') as HTMLElement;
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: 'Yanıtla' }));
    expect(screen.getByText('Elif Yıldız kişisine yanıt')).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Elif Yıldız sohbetine mesaj yaz' });
    await user.type(box, 'Geç cevap oldu{Enter}');
    await waitFor(() => {
      const last = messagesOf(CONV.elif).at(-1)!;
      expect(last.text).toBe('Geç cevap oldu');
      expect(last.replyToId).toBe(messagesOf(CONV.elif)[0]!.id);
    });
    await user.type(box, '{ArrowUp}');
    expect(await screen.findByText('Mesajı düzenliyorsun')).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'Geç cevap oldu, kusura bakma{Enter}');
    await waitFor(() => expect(messagesOf(CONV.elif).at(-1)!.editedAt).not.toBeNull());
    expect(await screen.findByText('(düzenlendi)')).toBeInTheDocument();
  });

  it('searches messages and jumps to the hit', async () => {
    signedInAs(USER.bugra);
    renderApp('/chat/search?q=redis');
    const user = userEvent.setup();
    const results = await screen.findByText(/için \d+ mesaj/);
    expect(results).toBeInTheDocument();
    const shows = await screen.findAllByRole('button', { name: 'Sohbette göster' });
    await user.click(shows[0]!);
    expect(
      await screen.findByRole('link', { name: 'Sohbet', current: 'page' }),
    ).toBeInTheDocument();
  });

  it('creates an incoming webhook and shows its URL once', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.prod}?panel=webhooks`);
    const user = userEvent.setup();
    const panel = await screen.findByRole('complementary', { name: "Uygulamalar ve webhook'lar" });
    expect(await within(panel).findByText('Sınırda')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Gelen webhook ekle' }));
    await user.type(within(panel).getByRole('textbox'), 'Grafana{Enter}');
    expect(await within(panel).findByText('Oluşturuldu')).toBeInTheDocument();
    expect(within(panel).getAllByText(/key=••••/).length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole('button', { name: 'Göster' }));
    expect(within(panel).getAllByText(/key=(?!••••)/).length).toBeGreaterThan(0);
  });
});

describe('deleting and archiving chats (H19)', () => {
  it('deletes a group for everyone after the name is typed', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.selinCan}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sohbet menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Herkes için sil' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Herkes için sil' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'Selin, Can');
    await user.click(submit);
    await waitFor(() =>
      expect(chatState(db()).conversations.some((c) => c.id === CONV.selinCan)).toBe(false),
    );
    expect(messagesOf(CONV.selinCan)).toHaveLength(0);
  });

  it('clears a direct chat for me and keeps archived chats under Arşiv', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.elif}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sohbet menüsü' }));
    expect(screen.queryByRole('menuitem', { name: 'Herkes için sil' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Benim için sil' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Benim için sil' }));
    const row = chatState(db()).members.find(
      (m) => m.conversationId === CONV.elif && m.userId === USER.bugra,
    )!;
    await waitFor(() => expect(row.clearedAtSeq).not.toBeNull());
    // Elif still has the whole history.
    expect(messagesOf(CONV.elif).length).toBeGreaterThan(0);

    const group = chatState(db()).members.find(
      (m) => m.conversationId === CONV.milvaion && m.userId === USER.bugra,
    )!;
    group.archivedAt = new Date().toISOString();
    await user.click(screen.getByRole('button', { name: 'Arşiv' }));
    expect(await screen.findByText('Milvaion Ekibi')).toBeInTheDocument();
    expect(screen.queryByText('Prod Alarmları')).toBeNull();
  });
});

describe('notification centre (19.17)', () => {
  it('renders the bell with unread count without a duplicate key warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    signedInAs(USER.bugra);
    renderApp('/');
    // The badge re-renders as counts arrive; seeing it with a count once is enough here.
    await screen.findByRole('button', { name: /Bildirimler, \d+ okunmamış/ });
    const keyWarnings = error.mock.calls.filter((c) => String(c[0]).includes('same key'));
    error.mockRestore();
    expect(keyWarnings).toEqual([]);
  });

  it('marks selected notifications as read in bulk', async () => {
    signedInAs(USER.bugra);
    renderApp('/notifications?kind=mentions');
    const user = userEvent.setup();
    // Row boxes (the list header has "Tümünü seç" too).
    const boxes = (await screen.findAllByRole('checkbox')).filter(
      (c) => c.getAttribute('aria-label') !== 'Tümünü seç',
    );
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    expect(screen.getByText('2 seçili')).toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: 'Toplu işlemler' });
    await user.click(within(bar).getByRole('button', { name: 'Okundu say' }));
    await waitFor(() => {
      const mentions = chatState(db()).notifications.filter((n) => n.category === 'mention');
      expect(mentions.every((n) => n.readAt)).toBe(true);
    });
  });
});

describe('chat turned off for the org', () => {
  it('shows the disabled state and hides chat entry points', async () => {
    signedInAs(USER.bugra);
    const s = db();
    const u = s.users.find((x) => x.id === USER.bugra)!;
    server.use(
      http.get('*/api/v1/me', () =>
        HttpResponse.json({
          user: {
            id: u.id,
            name: u.name,
            email: u.email,
            imageUrl: null,
            locale: 'tr',
            twoFactorEnabled: true,
            hasPasskey: true,
          },
          activeOrgId: s.org!.id,
          memberships: [
            {
              orgId: s.org!.id,
              orgName: s.org!.name,
              orgSlug: s.org!.slug,
              role: 'owner',
              permissions: [],
            },
          ],
          personalSpaceId: s.spaces.find((x) => x.kind === 'personal' && x.ownerUserId === u.id)!
            .id,
          modules: ['meet', 'wiki'],
        }),
      ),
    );
    renderApp('/chat');
    expect(await screen.findByText('Chat bu kurumda kapalı')).toBeInTheDocument();
    expect(chatEnabled({ modules: ['meet'] })).toBe(false);
    expect(chatEnabled({})).toBe(true);
  });
});
