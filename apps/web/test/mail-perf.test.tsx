import { type MailMessage } from '@crewhall/shared';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { handleMailEvent } from '@/lib/mail/realtime';
import { mailKeys } from '@/lib/mail/queries';
import { db } from '@/mocks/db';
import { mailMockState } from '@/mocks/mail';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const inbox = () => mailMockState(db()).folders[USER.bugra]!.find((f) => f.path === 'INBOX')!;

function fillInbox(n: number) {
  const box = inbox();
  for (let i = 0; i < n; i++) {
    const uid = box.nextUid++;
    box.messages.push({
      ...box.messages[0]!,
      uid,
      messageId: `<p-${uid}@example.com>`,
      threadId: `<p-${uid}@example.com>`,
      subject: `İleti ${uid}`,
      seen: false,
      attachments: [],
      hasAttachments: false,
    } satisfies MailMessage);
  }
}

describe('mail speed features', () => {
  it('refetches a folder when the server pushes mail.changed', () => {
    const qc = new QueryClient();
    const inboxKey = mailKeys.messages({ folder: 'INBOX', filter: 'all' });
    const otherKey = mailKeys.messages({ folder: 'Arsiv', filter: 'all' });
    qc.setQueryData(inboxKey, { pages: [], pageParams: [] });
    qc.setQueryData(otherKey, { pages: [], pageParams: [] });
    qc.setQueryData(mailKeys.folders, { items: [] });
    handleMailEvent(qc, { type: 'mail.changed', folder: 'INBOX' });
    expect(qc.getQueryState(inboxKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(mailKeys.folders)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it('prefetches on hover without marking read, and marks read when opened', async () => {
    signedInAs(USER.bugra);
    const view = renderApp('/mail');
    const list = await screen.findByRole('region', { name: 'İletiler' });
    const row = await within(list).findByText('Teklif ve sözleşme taslağı');
    fireEvent.mouseEnter(row.closest('[data-mail-row]')!.parentElement!);
    await waitFor(() =>
      expect(view.queryClient.getQueryData(['mail', 'thread', 'INBOX', 2, false])).toBeDefined(),
    );
    expect(inbox().messages.find((m) => m.uid === 2)?.seen).toBe(false);
    await userEvent.setup().click(row);
    await screen.findByTitle('Teklif ve sözleşme taslağı iletisinin içeriği');
    await waitFor(() => expect(inbox().messages.find((m) => m.uid === 2)?.seen).toBe(true));
  });

  it('moves through the list with j and k', async () => {
    signedInAs(USER.bugra);
    renderApp('/mail?uid=3');
    await screen.findByTitle('Bülten: Ekim sayısı iletisinin içeriği');
    const user = userEvent.setup();
    const list = screen.getByRole('region', { name: 'İletiler' });
    within(list).getAllByRole('checkbox')[0]!.focus();
    await user.keyboard('j');
    expect(
      await screen.findByTitle('Teklif ve sözleşme taslağı iletisinin içeriği'),
    ).toBeInTheDocument();
    await user.keyboard('j');
    expect(
      await screen.findByTitle('Haftalık sunucu raporu iletisinin içeriği'),
    ).toBeInTheDocument();
    await user.keyboard('k');
    expect(
      await screen.findByTitle('Teklif ve sözleşme taslağı iletisinin içeriği'),
    ).toBeInTheDocument();
  });

  it('renders only the rows in view', async () => {
    fillInbox(200);
    signedInAs(USER.bugra);
    renderApp('/mail');
    const list = await screen.findByRole('region', { name: 'İletiler' });
    await within(list).findByText('İleti 203');
    const rendered = list.querySelectorAll('[data-mail-row]').length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(50);
  });
});
