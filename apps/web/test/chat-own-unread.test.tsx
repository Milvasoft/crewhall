import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV, type MockMessage } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * Own messages are never unread: the "Yeni mesajlar" divider sits above someone else's first
 * unread message, the summary counts only others' messages, and sending one ends the divider.
 */

/** Appends messages to the chat and puts my read position just before them. */
function seedUnread(lines: [author: string, text: string][]) {
  const c = chatState(db());
  const conv = c.conversations.find((x) => x.id === CONV.milvaion)!;
  const row = c.members.find((m) => m.conversationId === conv.id && m.userId === USER.bugra)!;
  row.lastReadSeq = conv.lastSeq;
  const base = Date.now() - lines.length * 60_000;
  lines.forEach(([authorId, text], i) => {
    conv.lastSeq += 1;
    const at = new Date(base + i * 60_000).toISOString();
    const m: MockMessage = {
      id: crypto.randomUUID(),
      conversationId: conv.id,
      seq: conv.lastSeq,
      kind: 'user',
      authorId,
      webhookId: null,
      text,
      card: null,
      system: null,
      attachments: [],
      replyToId: null,
      reactions: [],
      clientMsgId: null,
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    c.messages.push(m);
  });
}

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('own messages are never unread', () => {
  it('places the divider above the first message from someone else and counts only theirs', async () => {
    seedUnread([
      [USER.bugra, 'benim ilk notum'],
      [USER.zeynep, 'zeynep birinci'],
      [USER.bugra, 'benim ikinci notum'],
      [USER.zeynep, 'zeynep ikinci'],
      [USER.zeynep, 'zeynep üçüncü'],
    ]);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const divider = await screen.findByText('Yeni mesajlar');
    const mine = await screen.findByText('benim ilk notum');
    const theirs = screen.getByText('zeynep birinci');
    // Above Zeynep's first message, below my own one.
    expect(before(mine, divider)).toBe(true);
    expect(before(divider, theirs)).toBe(true);
    // Three unread from Zeynep; my two messages are not counted.
    expect(
      await screen.findByRole('button', { name: /3 okunmamış mesajı özetle/ }),
    ).toBeInTheDocument();
  });

  it('drops the divider and the summary once I send a message', async () => {
    seedUnread([
      [USER.zeynep, 'yarın görüşelim mi'],
      [USER.zeynep, 'saat 10 uygun mu'],
      [USER.zeynep, 'haber ver'],
    ]);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await screen.findByText('Yeni mesajlar');
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.clear(box);
    await user.type(box, 'Olur, 10 uygun{Enter}');
    await waitFor(() => expect(screen.queryByText('Yeni mesajlar')).toBeNull());
    expect(screen.queryByRole('button', { name: /okunmamış mesajı özetle/ })).toBeNull();
  });
});
