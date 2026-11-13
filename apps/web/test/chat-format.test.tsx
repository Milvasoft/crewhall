import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Chat text formatting (kararlar.md 2026-11-13): markers, lists and composer shortcuts. */

function postText(text: string) {
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
    authorId: USER.elif,
    webhookId: null,
    system: null,
    card: null,
    attachments: [],
    reactions: [],
    replyToId: null,
  });
  conv.lastSeq = seq;
  return seq;
}

async function row(seq: number) {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) throw new Error('not rendered yet');
    return el;
  });
}

describe('chat text formatting', () => {
  it('shows bold, italic, strike and lists, never HTML, and leaves code alone', async () => {
    const seq = postText(
      '*kalın* _eğik_ ~çizik~ snake_case_ad <b>etiket</b> `*kod*`\n- bir\n- iki\n3. üç',
    );
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const el = await row(seq);
    expect(el.querySelector('strong')).toHaveTextContent('kalın');
    expect(el.querySelector('em')).toHaveTextContent('eğik');
    expect(el.querySelector('s')).toHaveTextContent('çizik');
    expect(el.querySelector('b')).toBeNull();
    expect(el).toHaveTextContent('snake_case_ad <b>etiket</b>');
    expect(el.querySelector('code')).toHaveTextContent('*kod*');
    expect([...el.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['bir', 'iki']);
    const ol = el.querySelector('ol');
    expect(ol).toHaveAttribute('start', '3');
    expect(ol).toHaveTextContent('üç');
  });

  it('wraps the selection with Ctrl+B, Ctrl+I and Ctrl+Shift+X and unwraps it again', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Milvaion Ekibi sohbetine mesaj yaz',
    });
    await user.click(box);
    await user.type(box, 'merhaba dünya');
    box.setSelectionRange(0, 7);
    await user.keyboard('{Control>}b{/Control}');
    expect(box).toHaveValue('*merhaba* dünya');
    await waitFor(() => expect([box.selectionStart, box.selectionEnd]).toEqual([1, 8]));
    await user.keyboard('{Control>}b{/Control}');
    expect(box).toHaveValue('merhaba dünya');

    box.setSelectionRange(8, 13);
    await user.keyboard('{Control>}i{/Control}');
    expect(box).toHaveValue('merhaba _dünya_');
    box.setSelectionRange(0, 7);
    await user.keyboard('{Control>}{Shift>}X{/Shift}{/Control}');
    expect(box).toHaveValue('~merhaba~ _dünya_');
  });
});
