import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type Notification } from '@crewhall/shared';
import { notificationTitle } from '@/components/notifications/text';
import { chatState } from '@/mocks/chat';
import { CONV, type MockReport } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Yöneticiye bildir" on messages and people, and Yönetim › Bildirilen içerik (API 54). */

function lastMessageOf(authorId: string) {
  return chatState(db())
    .messages.filter(
      (m) =>
        m.conversationId === CONV.milvaion &&
        m.kind === 'user' &&
        m.authorId === authorId &&
        !m.deletedAt,
    )
    .sort((a, b) => b.seq - a.seq)[0]!;
}

async function openMenu(seq: number) {
  const user = userEvent.setup();
  const row = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) throw new Error('message not rendered yet');
    return el;
  });
  await user.hover(row);
  await user.click(within(row).getByRole('button', { name: 'Diğer eylemler' }));
  await screen.findByRole('menuitem', { name: /Okunmadı olarak işaretle/ });
  return user;
}

function seedReport(over: Partial<MockReport> = {}, msg = lastMessageOf(USER.bugra)): MockReport {
  const c = chatState(db());
  const row: MockReport = {
    id: '0190f0a0-0000-7000-8000-00000000a001',
    kind: 'message',
    reporterId: USER.zeynep,
    reportedUserId: USER.bugra,
    messageId: msg.id,
    conversationId: CONV.milvaion,
    seq: msg.seq,
    excerpt: 'bildirilen kaba mesaj',
    reason: 'harassment',
    note: 'Sürekli böyle',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
  c.reports = [...(c.reports ?? []), row];
  return row;
}

describe('report to admins', () => {
  it('reports someone else’s message with a reason and a note', async () => {
    signedInAs(USER.zeynep);
    // renderApp mounts no Toaster; the confirmation toast needs one.
    render(<Toaster />);
    const theirs = lastMessageOf(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = await openMenu(theirs.seq);
    await user.click(screen.getByRole('menuitem', { name: /Yöneticiye bildir/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Mesajı yöneticiye bildir' });
    const submit = within(dialog).getByRole('button', { name: 'Bildir' });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'Spam ya da istenmeyen içerik' }));
    await user.type(within(dialog).getByRole('textbox'), 'Her gün aynı reklam');
    await user.click(submit);

    expect(await screen.findByText('Yöneticilere bildirildi')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const reports = chatState(db()).reports ?? [];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: 'message',
      messageId: theirs.id,
      reporterId: USER.zeynep,
      reason: 'spam',
      note: 'Her gün aynı reklam',
    });
  });

  it('is not offered on my own messages', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    await openMenu(lastMessageOf(USER.bugra).seq);
    expect(screen.queryByRole('menuitem', { name: /Yöneticiye bildir/ })).toBeNull();
  });

  it('is hidden on a server without chat reports', async () => {
    db().serverCapabilities = [];
    signedInAs(USER.zeynep);
    renderApp(`/chat/c/${CONV.milvaion}`);
    await openMenu(lastMessageOf(USER.bugra).seq);
    expect(screen.queryByRole('menuitem', { name: /Yöneticiye bildir/ })).toBeNull();
  });

  it('reports a person from their profile', async () => {
    signedInAs(USER.zeynep);
    render(<Toaster />);
    renderApp(`/people/${USER.can}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Yöneticiye bildir' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Can Demir kişisini yöneticiye bildir',
    });
    await user.click(within(dialog).getByRole('radio', { name: 'Taciz ya da zorbalık' }));
    await user.click(within(dialog).getByRole('button', { name: 'Bildir' }));
    // The toast store outlives a test: an earlier test's toast may still be there.
    expect((await screen.findAllByText('Yöneticilere bildirildi')).length).toBeGreaterThan(0);
    expect(chatState(db()).reports?.[0]).toMatchObject({
      kind: 'user',
      reportedUserId: USER.can,
      reason: 'harassment',
      note: null,
    });
  });

  it('does not offer to report myself', async () => {
    signedInAs(USER.zeynep);
    renderApp(`/people/${USER.zeynep}`);
    await screen.findByRole('link', { name: /E-posta/ });
    expect(screen.queryByRole('button', { name: 'Yöneticiye bildir' })).toBeNull();
  });
});

describe('Yönetim › Bildirilen içerik', () => {
  it('lists open reports with the words and resolves one', async () => {
    const report = seedReport();
    signedInAs(USER.bugra);
    renderApp('/admin/reports');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Bildirilen içerik' })).toBeInTheDocument();
    const item = (await screen.findByText('bildirilen kaba mesaj')).closest('li')!;
    expect(within(item).getByText('Taciz ya da zorbalık')).toBeInTheDocument();
    expect(within(item).getByText('“Sürekli böyle”')).toBeInTheDocument();
    expect(within(item).getByText(/Zeynep Arslan bildirdi/)).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'Mesaja git' })).toHaveAttribute(
      'href',
      `/chat/c/${CONV.milvaion}?seq=${report.seq}`,
    );

    await user.click(within(item).getByRole('button', { name: 'Çözüldü' }));
    expect(await screen.findByText('Açık bildirim yok.')).toBeInTheDocument();
    expect(chatState(db()).reports?.[0]).toMatchObject({
      status: 'resolved',
      resolvedBy: USER.bugra,
    });

    await user.click(screen.getByRole('radio', { name: 'Çözüldü' }));
    const closed = (await screen.findByText('bildirilen kaba mesaj')).closest('li')!;
    expect(within(closed).getByText(/Çözüldü · Ahmet Buğra Kösen/)).toBeInTheDocument();
    await user.click(within(closed).getByRole('button', { name: 'Yeniden aç' }));
    await waitFor(() => expect(chatState(db()).reports?.[0]?.status).toBe('open'));
  });

  it('shows a deleted message without a link', async () => {
    const msg = lastMessageOf(USER.bugra);
    msg.deletedAt = new Date().toISOString();
    seedReport({ excerpt: 'artık silinmiş' }, msg);
    signedInAs(USER.bugra);
    renderApp('/admin/reports');
    const item = (await screen.findByText('artık silinmiş')).closest('li')!;
    expect(within(item).getByText('Mesaj o zamandan beri silindi')).toBeInTheDocument();
    expect(within(item).queryByRole('link', { name: 'Mesaja git' })).toBeNull();
  });

  it('is not in the sidebar on a server without chat reports', async () => {
    db().serverCapabilities = ['desktop.releases'];
    signedInAs(USER.bugra);
    renderApp('/admin/general');
    await screen.findByRole('link', { name: 'Üyeler' });
    expect(screen.queryByRole('link', { name: 'Bildirilen içerik' })).toBeNull();
  });
});

describe('chat.report notification title', () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values)}`;
  const note = (data: Notification['data']) =>
    ({
      type: 'chat.report',
      actor: { id: USER.zeynep, name: 'Zeynep Arslan', email: 'z@x.com', imageUrl: null },
      count: 1,
      data,
    }) as unknown as Notification;

  it('names the reported person, but never a message’s words', () => {
    expect(notificationTitle(note({ kind: 'message', name: 'Can' }), t as never)).toMatch(
      /^chat\.notifications\.chat\.report:/,
    );
    expect(notificationTitle(note({ kind: 'user', name: 'Can Demir' }), t as never)).toMatch(
      /^chat\.notifications\.chat\.report_user:.*"name":"Can Demir"/,
    );
  });
});
