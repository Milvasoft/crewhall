import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@crewhall/ui';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Roadmap 23: the `/` menu and what each command sends. */

const messagesOf = (convId: string) =>
  chatState(db())
    .messages.filter((m) => m.conversationId === convId)
    .sort((a, b) => a.seq - b.seq);

async function openChat() {
  signedInAs(USER.bugra);
  // renderApp mounts no Toaster; reminder and error toasts need one.
  render(<Toaster />);
  renderApp(`/chat/c/${CONV.milvaion}`);
  const user = userEvent.setup();
  const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
  // Drafts outlive a render (memory per chat); start each test empty.
  await user.clear(box);
  return { user, box };
}

describe('chat slash commands', () => {
  it('opens the command menu on "/" and completes a command with Tab', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Komutlar' });
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent?.split(' ')[0]);
    expect(names).toEqual(['/meet', '/remind', '/poll', '/me', '/whisper', '/zamanla']);
    await user.type(box, 'po');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Tab}');
    expect(box).toHaveValue('/poll ');
    expect(screen.queryByRole('listbox', { name: 'Komutlar' })).toBeNull();
  });

  it('sends /me as an action line', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/me kahve almaya gitti{Enter}');
    await waitFor(
      () => {
        const sent = messagesOf(CONV.milvaion).find((m) => m.text.includes('kahve'));
        expect(sent).toMatchObject({ text: 'kahve almaya gitti', emote: true });
      },
      { timeout: 4000 },
    );
    expect(await screen.findByText('* Ahmet Buğra Kösen')).toBeInTheDocument();
  });

  it('whispers to the person picked after /whisper', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/whisper @Zey');
    await user.click(await screen.findByRole('option', { name: /Zeynep Arslan/ }));
    await user.type(box, 'yalnız sana{Enter}');
    await waitFor(() => {
      const last = messagesOf(CONV.milvaion).at(-1)!;
      expect(last).toMatchObject({ text: 'yalnız sana', whisperTo: USER.zeynep });
    });
    expect(await screen.findByText('Fısıltı · yalnız Zeynep Arslan görüyor')).toBeInTheDocument();
  });

  it('posts a poll from one line and votes on it', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/poll Öğle? | Pizza | Döner{Enter}');
    const pizza = await screen.findByRole('radio', { name: /Pizza/ });
    await user.click(pizza);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Pizza/ })).toBeChecked());
    const poll = messagesOf(CONV.milvaion).at(-1)!.poll!;
    expect(poll.votes).toEqual([{ userId: USER.bugra, option: 0 }]);
    expect(screen.getByText('1 kişi oy verdi')).toBeInTheDocument();
  });

  it('opens the poll dialog when the line has no options', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/poll Ne yiyelim?{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Anket aç' });
    expect(within(dialog).getByLabelText('Soru')).toHaveValue('Ne yiyelim?');
    await user.type(within(dialog).getByLabelText('Seçenek 1'), 'Pizza');
    await user.type(within(dialog).getByLabelText('Seçenek 2'), 'Döner');
    await user.click(within(dialog).getByRole('button', { name: 'Anketi gönder' }));
    await waitFor(() =>
      expect(messagesOf(CONV.milvaion).at(-1)?.poll?.options).toEqual(['Pizza', 'Döner']),
    );
  });

  it('sets a reminder and leaves the chat untouched', async () => {
    const { user, box } = await openChat();
    const before = messagesOf(CONV.milvaion).length;
    await user.type(box, '/remind 15dk toplantı{Enter}');
    expect(await screen.findByText(/Hatırlatma kuruldu/)).toBeInTheDocument();
    const r = chatState(db()).reminders?.at(-1);
    expect(r?.text).toBe('toplantı');
    expect(Date.parse(r!.remindAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(messagesOf(CONV.milvaion)).toHaveLength(before);
    expect(box).toHaveValue('');
  });

  it('keeps the draft when the reminder time cannot be read, and sends unknown commands as text', async () => {
    const { user, box } = await openChat();
    await user.type(box, '/remind bir ara{Enter}');
    expect(await screen.findByText(/Zamanı anlayamadım/)).toBeInTheDocument();
    expect(box).toHaveValue('/remind bir ara');
    await user.clear(box);
    await user.type(box, '/shrug olur{Enter}');
    await waitFor(() => expect(messagesOf(CONV.milvaion).at(-1)?.text).toBe('/shrug olur'));
  });
});
