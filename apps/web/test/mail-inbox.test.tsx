import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { inboxMockState } from '@/mocks/mail-inbox';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const inbox = () => inboxMockState(db()).inboxes[0]!;
const conversation = (subject: string) =>
  inboxMockState(db()).conversations.find((c) => c.subject === subject)!;

async function openInbox(as: string = USER.can) {
  signedInAs(as);
  render(<Toaster />);
  renderApp(`/mail/inbox/${inbox().id}`);
  return screen.findByRole('region', { name: 'Konuşmalar' });
}

describe('shared inbox', () => {
  it('lists the space inboxes in the mail sidebar with their open conversations', async () => {
    signedInAs(USER.bugra);
    renderApp('/mail');
    const nav = await screen.findByRole('navigation', { name: 'Ortak kutular' });
    const link = await within(nav).findByRole('link', { name: /Destek/ });
    expect(within(link).getByLabelText('2 açık konuşma')).toBeInTheDocument();
  });

  it('works without a personal mailbox: open, assign, resolve', async () => {
    const list = await openInbox();
    const user = userEvent.setup();
    // Open conversations only by default.
    expect(within(list).queryByText('Teşekkürler')).not.toBeInTheDocument();
    await user.click(await within(list).findByText('Faturam gelmedi'));
    const view = await screen.findByRole('article', { name: 'Faturam gelmedi' });
    expect(within(view).getByText('#fatura')).toBeInTheDocument();
    expect(conversation('Faturam gelmedi').unread).toBe(false);

    await user.click(within(view).getByRole('combobox', { name: 'Atanan kişi' }));
    await user.click(await screen.findByRole('option', { name: 'Can Demir' }));
    await waitFor(() => expect(conversation('Faturam gelmedi').assignee?.id).toBe(USER.can));

    await user.click(within(view).getByRole('combobox', { name: 'Durum' }));
    await user.click(await screen.findByRole('option', { name: 'Çözüldü' }));
    await waitFor(() => expect(conversation('Faturam gelmedi').status).toBe('resolved'));
    await waitFor(() =>
      expect(within(list).queryByText('Faturam gelmedi')).not.toBeInTheDocument(),
    );
  });

  it('keeps internal notes apart from the mail', async () => {
    await openInbox();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Şifre sıfırlama'));
    const view = await screen.findByRole('article', { name: 'Şifre sıfırlama' });
    await user.type(within(view).getByRole('textbox', { name: 'İç not' }), 'Hesabı kontrol ettim.');
    await user.click(within(view).getByRole('button', { name: 'Not ekle' }));
    const note = await within(view).findByRole('region', { name: 'İç not' });
    expect(within(note).getByText('Hesabı kontrol ettim.')).toBeInTheDocument();
    expect(within(note).getByText('Müşteri görmez')).toBeInTheDocument();
    expect(conversation('Şifre sıfırlama').notes).toHaveLength(1);
  });

  it('warns when someone else is replying', async () => {
    const c = conversation('Şifre sıfırlama');
    inboxMockState(db()).replying[c.id] = [{ id: USER.mert, name: 'Mert Yıldız', imageUrl: null }];
    await openInbox();
    await userEvent.setup().click(await screen.findByText('Şifre sıfırlama'));
    expect(await screen.findByRole('status')).toHaveTextContent('Mert Yıldız şu an yanıt yazıyor');
  });

  it('marks a missed first response target', async () => {
    const list = await openInbox();
    const row = (await within(list).findByText('Şifre sıfırlama')).closest(
      '[data-conversation-row]',
    )!;
    expect(within(row as HTMLElement).getByText('Süre aşıldı')).toBeInTheDocument();
  });

  it('replies with a canned response and waits for the customer', async () => {
    await openInbox();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Faturam gelmedi'));
    const view = await screen.findByRole('article', { name: 'Faturam gelmedi' });
    await user.click(within(view).getByRole('button', { name: 'Yanıtla' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Hazır cevap ekle' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Fatura yeniden gönderildi' }));
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    await waitFor(() => expect(conversation('Faturam gelmedi').status).toBe('pending'));
    const sent = conversation('Faturam gelmedi').messages.at(-1)!;
    expect(sent.from?.address).toBe('destek@milvasoft.com');
    expect(sent.html).toContain('Faturanız e-postanıza yeniden gönderildi.');
  });

  it('asks an admin to sign an OAuth inbox in', async () => {
    inbox().password = null;
    signedInAs(USER.bugra);
    renderApp(`/mail/inbox/${inbox().id}`);
    const banner = await screen.findByText(/Bu kutu henüz bağlı değil\. Microsoft 365/);
    const link = within(banner.closest('[role="status"]') as HTMLElement).getByRole('link', {
      name: 'Microsoft 365 ile bağla',
    });
    expect(link.getAttribute('href')).toContain(
      `/api/mail/inbox-oauth/start?inboxId=${inbox().id}`,
    );
  });

  it('hides the inbox from people outside its space', async () => {
    signedInAs(USER.elif);
    renderApp(`/mail/inbox/${inbox().id}`);
    expect(await screen.findByText('Bu ortak kutu yok ya da erişimin yok.')).toBeInTheDocument();
  });
});
