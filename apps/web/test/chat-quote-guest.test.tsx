import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** A meeting guest has no account: a reply to them still names them, before and after sending. */

function guestMessage(text: string) {
  const c = chatState(db());
  const conv = c.conversations.find((x) => x.id === CONV.milvaion)!;
  const last = c.messages
    .filter((m) => m.conversationId === conv.id)
    .sort((a, b) => b.seq - a.seq)[0]!;
  const seq = last.seq + 1;
  c.messages.push({
    ...last,
    id: crypto.randomUUID(),
    seq,
    kind: 'user',
    text,
    authorId: null,
    webhookId: null,
    system: null,
    card: null,
    guestAuthor: { name: 'Deniz Kaya' },
  });
  conv.lastSeq = seq;
  return seq;
}

describe('replying to a meeting guest', () => {
  it('names the guest in the composer and in the quote of the sent reply', async () => {
    const seq = guestMessage('misafirin sorusu');
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
      if (!el) throw new Error('not rendered yet');
      return el;
    });
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: 'Yanıtla' }));
    expect(await screen.findByText('Deniz Kaya kişisine yanıt')).toBeInTheDocument();

    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.type(box, 'misafire cevap{Enter}');
    const sent = (await screen.findByText('misafire cevap')).closest('[data-seq]') as HTMLElement;
    await waitFor(() => {
      const quote = within(sent).getByRole('button', { name: /misafirin sorusu/ });
      expect(quote).toHaveTextContent('Deniz Kaya');
    });
  });
});
