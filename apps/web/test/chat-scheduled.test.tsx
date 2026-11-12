import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Scheduled messages: "Daha sonra gönder", /zamanla and the waiting list. */

const scheduled = () =>
  (chatState(db()).scheduled ?? []).filter((x) => x.conversationId === CONV.milvaion);
const tomorrow9 = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0).getTime();
};

async function openChat() {
  signedInAs(USER.bugra);
  renderApp(`/chat/c/${CONV.milvaion}`);
  const user = userEvent.setup();
  const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
  await user.clear(box);
  return { user, box };
}

describe('scheduled messages', () => {
  it('schedules the draft for tomorrow 09:00 from the send menu', async () => {
    const { user, box } = await openChat();
    await user.type(box, 'Sabah toplantısı');
    await user.click(screen.getByRole('button', { name: 'Daha sonra gönder' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Yarın 09:00' }));
    await waitFor(() => expect(scheduled().at(-1)?.text).toBe('Sabah toplantısı'));
    expect(Date.parse(scheduled().at(-1)!.sendAt)).toBe(tomorrow9());
    expect(box).toHaveValue('');
    expect(await screen.findByRole('button', { name: '1 zamanlanmış mesaj' })).toBeInTheDocument();
  });

  it('opens the menu with Ctrl+Shift+Enter', async () => {
    const { user, box } = await openChat();
    await user.type(box, 'Kısayol');
    await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
    expect(await screen.findByRole('menuitem', { name: 'Pazartesi 09:00' })).toBeInTheDocument();
  });

  it('schedules with /zamanla and a time in words', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/zamanla yarın 9:00 Toplantıyı unutmayın{Enter}');
    await waitFor(() => expect(scheduled().at(-1)?.text).toBe('Toplantıyı unutmayın'));
    expect(Date.parse(scheduled().at(-1)!.sendAt)).toBe(tomorrow9());
  });

  it('opens the picker when /zamanla has no readable time', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/zamanla bir ara bakalım{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Daha sonra gönder' });
    expect(within(dialog).getByLabelText('Mesaj')).toHaveValue('bir ara bakalım');
    await user.click(within(dialog).getByRole('button', { name: 'Zamanla' }));
    await waitFor(() => expect(scheduled().at(-1)?.text).toBe('bir ara bakalım'));
  });

  it('lists waiting messages, sends one now and deletes another', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/zamanla 30dk Birinci{Enter}');
    await waitFor(() => expect(scheduled().some((x) => x.text === 'Birinci')).toBe(true));
    await user.type(box, '/zamanla 2 saat sonra İkinci{Enter}');
    await waitFor(() => expect(scheduled().some((x) => x.text === 'İkinci')).toBe(true));
    const count = scheduled().filter((x) => x.status === 'scheduled').length;
    await user.click(await screen.findByRole('button', { name: `${count} zamanlanmış mesaj` }));
    const list = await screen.findByRole('list', { name: 'Zamanlanmış mesajlar' });
    const first = within(list).getByText('Birinci').closest('li')!;
    await user.click(within(first).getByRole('button', { name: 'Şimdi gönder' }));
    await waitFor(() => expect(scheduled().find((x) => x.text === 'Birinci')?.status).toBe('sent'));
    const second = (await within(list).findByText('İkinci')).closest('li')!;
    await user.click(within(second).getByRole('button', { name: 'Sil' }));
    await waitFor(() =>
      expect(scheduled().find((x) => x.text === 'İkinci')?.status).toBe('cancelled'),
    );
  });
});
