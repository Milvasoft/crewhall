import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Mesaj bilgisi": only on my own messages, with who saw them and who has not. */

describe('message info', () => {
  it('lists who saw my message and who has not yet', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.clear(box);
    await user.type(box, 'bilgi testi{Enter}');
    const text = await screen.findByText('bilgi testi');
    const c = chatState(db());
    const msg = c.messages.find((m) => m.text === 'bilgi testi')!;
    // Zeynep read it; everyone else has not.
    const zeynep = c.members.find(
      (m) => m.conversationId === CONV.milvaion && m.userId === USER.zeynep,
    )!;
    zeynep.lastReadSeq = msg.seq;
    zeynep.readAt = new Date().toISOString();
    const others = c.members.filter(
      (m) => m.conversationId === CONV.milvaion && m.userId !== USER.bugra,
    );
    for (const o of others) if (o.userId !== USER.zeynep) o.lastReadSeq = msg.seq - 1;

    const row = text.closest('[data-seq]') as HTMLElement;
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: 'Diğer eylemler' }));
    await user.click(await screen.findByRole('menuitem', { name: /Mesaj bilgisi/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Mesaj bilgisi' });
    expect(await within(dialog).findByText(`1 / ${others.length} kişi gördü`)).toBeInTheDocument();
    const seen = within(dialog).getByRole('region', { name: 'Gördü' });
    expect(within(seen).getByText('Zeynep Arslan')).toBeInTheDocument();
    const notSeen = within(dialog).getByRole('region', { name: 'Henüz görmedi' });
    expect(within(notSeen).queryByText('Zeynep Arslan')).toBeNull();
  });

  it('is not offered on other people’s messages', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const c = chatState(db());
    const theirs = c.messages
      .filter(
        (m) =>
          m.conversationId === CONV.milvaion &&
          m.kind === 'user' &&
          m.authorId !== USER.bugra &&
          !m.deletedAt,
      )
      .sort((a, b) => b.seq - a.seq)[0]!;
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-seq="${theirs.seq}"]`);
      if (!el) throw new Error('message not rendered yet');
      return el;
    });
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: 'Diğer eylemler' }));
    await screen.findByRole('menuitem', { name: /Okunmadı olarak işaretle/ });
    expect(screen.queryByRole('menuitem', { name: /Mesaj bilgisi/ })).toBeNull();
  });
});
