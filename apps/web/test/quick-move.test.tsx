import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@crewhall/ui';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { handleEvent } from '@/lib/chat/runtime';
import { db, newId } from '@/mocks/db';
import { quickState } from '@/mocks/quick';
import { SURFACE } from '@/mocks/quickSeed';
import { SPACE, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const MOVE = "Başka space'e taşı";
const card = (name: string) => screen.findByRole('article', { name });
const row = (cardId: string) => quickState().cards.find((c) => c.id === cardId)!;
const seeded = (title: string) =>
  quickState().cards.find((c) => c.config.title === title && !c.deletedAt)!;

async function openMoveDialog(name: string) {
  fireEvent.contextMenu(await card(name));
  fireEvent.click(await screen.findByRole('menuitem', { name: MOVE }));
  return screen.findByRole('dialog', { name: MOVE });
}

describe('moving a home card to another space (request of 2026-11-05)', () => {
  it('picks a target from a searchable list, moves the card and undoes it', async () => {
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp('/');
    const moved = seeded('Bu hafta');
    const place = { ...moved.layout };
    const user = userEvent.setup();
    const dialog = await openMoveDialog('Bu hafta');

    await within(dialog).findByRole('button', { name: /Milvasoft/ });
    // Not the home the card is on, and nothing to confirm until one is chosen.
    expect(within(dialog).queryByRole('button', { name: /Benim/ })).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Taşı' });
    expect(confirm).toBeDisabled();

    const search = within(dialog).getByRole('textbox');
    await user.type(search, 'hiçbiri');
    expect(within(dialog).getByText('Eşleşen space yok.')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'milva');
    await user.click(within(dialog).getByRole('button', { name: /Milvasoft/ }));
    await user.click(confirm);

    await waitFor(() => expect(row(moved.id).surfaceId).toBe(SURFACE.milvasoft));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Bu hafta' })).toBeNull());

    const toast = (await screen.findByText(/Milvasoft yüzeyine taşındı/)).closest(
      '[data-sonner-toast]',
    );
    if (!(toast instanceof HTMLElement)) throw new Error('toast not found');
    // A plain click: sonner's swipe handler wants setPointerCapture, which jsdom lacks.
    fireEvent.click(within(toast).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => expect(row(moved.id).surfaceId).toBe(SURFACE.bugra));
    expect(row(moved.id).layout).toEqual(place);
    expect(await card('Bu hafta')).toBeInTheDocument();
  });

  it('follows a move made elsewhere on both homes', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    await card('Bu hafta');
    // Someone else's session moved it: the event says both homes changed.
    seeded('Bu hafta').surfaceId = SURFACE.milvasoft;
    handleEvent({ type: 'surface.changed', surfaceId: SURFACE.bugra });
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Bu hafta' })).toBeNull());
  });

  it('warns when people there cannot open what the card points to', async () => {
    signedInAs(USER.bugra);
    // The seed's Sunumlar folder sits in Milvasoft; Dumpapp gets someone who is not a member there.
    const inMilvasoft = db()
      .spaceMembers.filter((m) => m.spaceId === SPACE.milvasoft)
      .map((m) => m.userId);
    const stranger = db().users.find((u) => !inMilvasoft.includes(u.id));
    if (stranger) {
      db().spaceMembers.push({
        ...db().spaceMembers.find((m) => m.spaceId === SPACE.dumpapp)!,
        userId: stranger.id,
        role: 'viewer',
      });
    } else {
      db().spaceMembers = db().spaceMembers.filter(
        (m) => m.spaceId !== SPACE.milvasoft || m.userId === USER.bugra,
      );
    }
    const pointing = quickState().cards.find(
      (c) => c.surfaceId === SURFACE.bugra && c.type === 'node' && !c.deletedAt,
    )!;
    const { items } = await listTargets(pointing.id);
    const target = items.find((t) => t.surface.owner.type === 'space' && t.cannotOpen > 0)!;
    expect(target).toBeTruthy();

    renderApp('/');
    const frame = await waitFor(() => {
      const el = document.querySelector(`[data-card-id="${pointing.id}"]`);
      if (!el) throw new Error('card not on screen');
      return el;
    });
    fireEvent.contextMenu(frame);
    fireEvent.click(await screen.findByRole('menuitem', { name: MOVE }));
    const dialog = await screen.findByRole('dialog', { name: MOVE });
    const name = target.surface.owner.type === 'space' ? target.surface.owner.spaceName : '';
    fireEvent.click(await within(dialog).findByRole('button', { name: new RegExp(name) }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(/açamayabilir/);
  });

  it('does not offer a vault card on a personal home the move, and refuses it', async () => {
    signedInAs(USER.bugra);
    const vault = {
      ...seeded('Bu hafta'),
      id: newId(),
      type: 'vault_item' as const,
      config: { vaultId: newId(), itemId: newId() },
    };
    quickState().cards.push(vault);
    renderApp('/');
    const frame = await waitFor(() => {
      const el = document.querySelector(`[data-card-id="${vault.id}"]`);
      if (!el) throw new Error('card not on screen');
      return el;
    });
    fireEvent.contextMenu(frame);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: MOVE })).toBeNull();
    const { items } = await listTargets(vault.id);
    expect(items).toEqual([]);
    await expect(
      api.call('moveCard', {
        params: { cardId: vault.id },
        body: { surfaceId: SURFACE.milvasoft },
      }),
    ).rejects.toMatchObject({ code: 'quick_card_not_movable' });
  });
});

function listTargets(cardId: string) {
  return api.call('listCardMoveTargets', { params: { cardId } });
}
