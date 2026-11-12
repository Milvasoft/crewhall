import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Channel emoji: set and removed in the chat settings, shown in the list and the header. */

const rocket = String.fromCodePoint(0x1f680);
const convOf = (id: string) => chatState(db()).conversations.find((c) => c.id === id)!;
const listRow = () =>
  within(screen.getByRole('complementary', { name: 'Sohbet' })).getAllByRole('link', {
    name: /Milvaion Ekibi/,
  })[0]!;
const header = () => screen.getByRole('button', { name: 'Sohbet menüsü' }).closest('header')!;

describe('channel emoji', () => {
  it('sets an emoji from the picker and shows it in the list and the header', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sohbet menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Yeniden adlandır' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sohbeti yeniden adlandır' });
    await user.click(within(dialog).getByRole('button', { name: 'Emoji seç' }));
    await user.click(await screen.findByRole('option', { name: rocket }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(convOf(CONV.milvaion).emoji).toBe(rocket));
    // The chat list row carries it in place of the letter placeholder.
    await waitFor(() => expect(within(listRow()).getByText(rocket)).toBeInTheDocument());
    // So does the conversation header.
    expect(within(header()).getByText(rocket)).toBeInTheDocument();
  });

  it('removes the emoji and the letter placeholder comes back', async () => {
    convOf(CONV.milvaion).emoji = rocket;
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await waitFor(() => expect(within(listRow()).getByText(rocket)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: 'Sohbet menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Yeniden adlandır' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sohbeti yeniden adlandır' });
    await user.click(within(dialog).getByRole('button', { name: 'Kaldır' }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(convOf(CONV.milvaion).emoji).toBeNull());
    await waitFor(() => expect(within(listRow()).queryByText(rocket)).toBeNull());
    expect(within(header()).queryByText(rocket)).toBeNull();
  });
});
