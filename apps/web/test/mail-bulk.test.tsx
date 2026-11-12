import { type MailMessage } from '@crewhall/shared';
import { toast, Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { rowRange } from '@/components/mail/MessageList';
import { db } from '@/mocks/db';
import { mailMockState } from '@/mocks/mail';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const inbox = () => mailMockState(db()).folders[USER.bugra]!.find((f) => f.path === 'INBOX')!;

/** Adds `n` unread newsletters to the mock inbox (newest UIDs last). */
function fillInbox(n: number) {
  const box = inbox();
  for (let i = 0; i < n; i++) {
    const uid = box.nextUid++;
    const base = box.messages[0]!;
    box.messages.push({
      ...base,
      uid,
      messageId: `<bulk-${uid}@example.com>`,
      threadId: `<bulk-${uid}@example.com>`,
      subject: `Bülten ${uid}`,
      seen: false,
      date: new Date(Date.now() - (5000 - uid) * 1000).toISOString(),
      attachments: [],
      hasAttachments: false,
    } satisfies MailMessage);
  }
}

async function openInbox(first = 'Teklif ve sözleşme taslağı') {
  signedInAs(USER.bugra);
  render(<Toaster />);
  renderApp('/mail');
  const list = await screen.findByRole('region', { name: 'İletiler' });
  await within(list).findByText(first);
  return list;
}

const unreadBadge = async () =>
  (await screen.findByRole('navigation', { name: 'Klasörler' })).querySelector(
    '[aria-label$="okunmamış"]',
  )?.textContent ?? '0';

describe('mail selection and bulk actions', () => {
  afterEach(() => toast.dismiss());

  it('picks a range with Shift and marks it read at once', async () => {
    fillInbox(3);
    const list = await openInbox();
    const user = userEvent.setup();
    await waitFor(async () => expect(await unreadBadge()).toBe('5'));

    await user.click(within(list).getByRole('checkbox', { name: 'Bülten 6 iletisini seç' }));
    expect(await within(list).findByText('1 konuşma seçili')).toBeInTheDocument();
    await user.keyboard('{Shift>}');
    await user.click(within(list).getByRole('checkbox', { name: 'Bülten 4 iletisini seç' }));
    await user.keyboard('{/Shift}');
    expect(within(list).getByText('3 konuşma seçili')).toBeInTheDocument();
    expect(within(list).getByRole('checkbox', { name: 'Bülten 5 iletisini seç' })).toBeChecked();

    await user.click(within(list).getByRole('button', { name: /^Okundu işaretle/ }));
    // Optimistic: the counter drops before the server answers.
    await waitFor(async () => expect(await unreadBadge()).toBe('2'));
    await waitFor(() =>
      expect(
        inbox()
          .messages.filter((m) => m.uid >= 4)
          .every((m) => m.seen),
      ).toBe(true),
    );
    expect(inbox().messages.find((m) => m.uid === 2)?.seen).toBe(false);
  });

  it('selects the page with Ctrl+A, then every message in the folder, with progress', async () => {
    fillInbox(1203);
    const list = await openInbox('Bülten 1206');
    const user = userEvent.setup();
    within(list).getAllByRole('checkbox')[0]!.focus();
    await user.keyboard('{Control>}a{/Control}');
    expect(await within(list).findByText('50 konuşma seçili')).toBeInTheDocument();
    expect(within(list).getByText('Bu sayfadaki 50 konuşma seçili.')).toBeInTheDocument();
    await user.click(
      within(list).getByRole('button', { name: 'Bu klasördeki tüm 1.206 iletiyi seç' }),
    );
    expect(within(list).getByText('Bu klasördeki tüm 1.206 ileti seçili.')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: /^Okundu işaretle/ }));
    await waitFor(async () => expect(await unreadBadge()).toBe('0'));
    expect(
      await screen.findByText(/\/ 1\.205 ileti işlendi/, {}, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('1.205 ileti okundu olarak işaretlendi.', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(inbox().messages.every((m) => m.seen)).toBe(true);
  });

  it('marks a whole folder read from its menu and rolls back when the job fails', async () => {
    await openInbox();
    const user = userEvent.setup();
    await waitFor(async () => expect(await unreadBadge()).toBe('2'));
    mailMockState(db()).failNext = 'mail_server_unreachable';

    await user.click(screen.getByRole('button', { name: 'Gelen kutusu klasörü işlemleri' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Tümünü okundu işaretle' }));
    expect(
      await screen.findByText(
        'İşlem tamamlanamadı: Posta sunucusuna ulaşılamıyor. Biraz sonra yeniden dene.',
      ),
    ).toBeInTheDocument();
    await waitFor(async () => expect(await unreadBadge()).toBe('2'));
    expect(inbox().messages.some((m) => !m.seen)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Gelen kutusu klasörü işlemleri' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Tümünü okundu işaretle' }));
    expect(await screen.findByText('2 ileti okundu olarak işaretlendi.')).toBeInTheDocument();
    await waitFor(async () => expect(await unreadBadge()).toBe('0'));
  });

  it('puts a selection back when the server refuses it', async () => {
    const list = await openInbox();
    const user = userEvent.setup();
    mailMockState(db()).failNext = 'mail_auth_failed';
    await user.click(
      within(list).getByRole('checkbox', { name: 'Teklif ve sözleşme taslağı iletisini seç' }),
    );
    await user.click(within(list).getByRole('button', { name: /^Okundu işaretle/ }));
    expect(
      await screen.findByText('Posta sunucusu giriş bilgilerini kabul etmedi.'),
    ).toBeInTheDocument();
    await waitFor(async () => expect(await unreadBadge()).toBe('2'));
    expect(within(list).getAllByRole('img', { name: 'Okunmamış' })).toHaveLength(2);
  });

  it('marks with Shift+U and Shift+I (open conversation, then a selection)', async () => {
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp('/mail?uid=1');
    await screen.findByTitle('Haftalık sunucu raporu iletisinin içeriği');
    const user = userEvent.setup();
    await waitFor(() => expect(inbox().messages.find((m) => m.uid === 1)?.seen).toBe(true));
    document.body.focus();
    await user.keyboard('{Shift>}U{/Shift}');
    await waitFor(() => expect(inbox().messages.find((m) => m.uid === 1)?.seen).toBe(false));
    // Unread again: the conversation closes so opening it does not mark it read at once.
    await waitFor(() =>
      expect(screen.queryByTitle('Haftalık sunucu raporu iletisinin içeriği')).toBeNull(),
    );
    const list = screen.getByRole('region', { name: 'İletiler' });
    await user.click(
      within(list).getByRole('checkbox', { name: 'Haftalık sunucu raporu iletisini seç' }),
    );
    await user.keyboard('{Shift>}I{/Shift}');
    await waitFor(() => expect(inbox().messages.find((m) => m.uid === 1)?.seen).toBe(true));
  });

  it('moves a selection and closes the conversation that left', async () => {
    const list = await openInbox();
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole('checkbox', { name: 'Haftalık sunucu raporu iletisini seç' }),
    );
    await user.click(within(list).getByRole('button', { name: 'Taşı' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Projeler' }));
    await waitFor(() => expect(within(list).queryByText('Haftalık sunucu raporu')).toBeNull());
    const projeler = mailMockState(db()).folders[USER.bugra]!.find((f) => f.path === 'Projeler')!;
    await waitFor(() => expect(projeler.messages).toHaveLength(1));
  });
});

describe('rowRange', () => {
  it('covers both directions inclusively', () => {
    expect(rowRange([1, 2, 3, 4, 5], 1, 3)).toEqual([2, 3, 4]);
    expect(rowRange([1, 2, 3, 4, 5], 4, 2)).toEqual([3, 4, 5]);
    expect(rowRange([1, 2, 3], 1, 1)).toEqual([2]);
  });
});
