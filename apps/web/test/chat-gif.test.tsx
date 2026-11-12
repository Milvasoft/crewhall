import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** GIFs through GIPHY: picker, /gif, the message and the admin card. */

const gifsOn = () => {
  chatState(db()).gif = { enabled: true, apiKey: 'giphy-key-1234567890', rating: 'g', lang: 'tr' };
};
const lastMessage = () =>
  chatState(db())
    .messages.filter((m) => m.conversationId === CONV.milvaion)
    .sort((a, b) => a.seq - b.seq)
    .at(-1)!;

async function openChat() {
  signedInAs(USER.bugra);
  renderApp(`/chat/c/${CONV.milvaion}`);
  const user = userEvent.setup();
  const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
  await user.clear(box);
  return { user, box };
}

afterEach(() => {
  delete document.documentElement.dataset.motion;
});

describe('GIFs in chat', () => {
  it('shows no GIF button or command while the org has GIFs off', async () => {
    const { user, box } = await openChat();
    expect(screen.queryByRole('button', { name: 'GIF gönder' })).toBeNull();
    await user.type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Komutlar' });
    expect(within(list).queryByText('/gif', { exact: false })).toBeNull();
  });

  it('picks a GIF from trending and search, with the GIPHY attribution, and sends it', async () => {
    gifsOn();
    const { user } = await openChat();
    await user.click(await screen.findByRole('button', { name: 'GIF gönder' }));
    const picker = await screen.findByRole('dialog', { name: 'GIF seç' });
    expect(within(picker).getByText('Powered by GIPHY')).toBeInTheDocument();
    expect(await within(picker).findByRole('option', { name: 'trend 1' })).toBeInTheDocument();
    await user.type(within(picker).getByRole('textbox', { name: "GIPHY'de ara" }), 'kedi');
    await user.click(await within(picker).findByRole('option', { name: 'kedi 1' }));
    await waitFor(() => expect(lastMessage().gif?.id).toBe('kedi-0'));
    expect(lastMessage().gif?.url).toBe('https://media.giphy.com/media/kedi-0/giphy.gif');
    expect(await screen.findByRole('img', { name: 'kedi 1' })).toBeInTheDocument();
  });

  it('searches only from two letters on and keeps trending until then', async () => {
    gifsOn();
    const { user } = await openChat();
    await user.click(await screen.findByRole('button', { name: 'GIF gönder' }));
    const picker = await screen.findByRole('dialog', { name: 'GIF seç' });
    await within(picker).findByRole('option', { name: 'trend 1' });
    await user.type(within(picker).getByRole('textbox', { name: "GIPHY'de ara" }), 'k');
    expect(await within(picker).findByText(/en az 2 harf/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(within(picker).getByRole('option', { name: 'trend 1' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: 'k 1' })).toBeNull();
  });

  it('opens the picker with /gif and the word as the search', async () => {
    gifsOn();
    const { user, box } = await openChat();
    await user.type(box, '/gif tebrikler{Enter}');
    const picker = await screen.findByRole('dialog', { name: 'GIF seç' });
    expect(within(picker).getByRole('textbox', { name: "GIPHY'de ara" })).toHaveValue('tebrikler');
    expect(await within(picker).findByRole('option', { name: 'tebrikler 1' })).toBeInTheDocument();
  });

  it('shows the still frame with reduced motion and plays on a click', async () => {
    gifsOn();
    const { user } = await openChat();
    // After the app applied the account's motion setting.
    document.documentElement.dataset.motion = 'reduced';
    await user.click(await screen.findByRole('button', { name: 'GIF gönder' }));
    await user.click(await screen.findByRole('option', { name: 'trend 1' }));
    const play = await screen.findByRole('button', { name: "trend 1 GIF'ini oynat" });
    expect(within(play).getByRole('img')).toHaveAttribute(
      'src',
      'https://media.giphy.com/media/trend-0/200w_s.gif',
    );
    await user.click(play);
    expect(
      await screen.findByRole('button', { name: "trend 1 GIF'ini büyüt" }),
    ).toBeInTheDocument();
  });

  it('lets an admin save the key and test it', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations');
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: 'GIF (GIPHY)' });
    await user.type(within(card).getByLabelText('GIPHY API anahtarı'), 'giphy-key-1234567890');
    await user.click(within(card).getByRole('button', { name: 'Anahtarı kaydet' }));
    await waitFor(() => expect(chatState(db()).gif?.apiKey).toBe('giphy-key-1234567890'));
    await user.click(within(card).getByRole('switch', { name: "Sohbette GIF'leri aç" }));
    await waitFor(() => expect(chatState(db()).gif?.enabled).toBe(true));
    await user.click(within(card).getByRole('button', { name: 'Test et' }));
    expect(await within(card).findByText(/Bağlantı çalışıyor: 5/)).toBeInTheDocument();
    // Beta key: the hourly budget and what is left of it.
    expect(within(card).getByText(/0 \/ 90 GIPHY isteği kullanıldı, 90 kaldı/)).toBeInTheDocument();
  });
});
