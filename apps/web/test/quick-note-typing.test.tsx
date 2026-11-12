import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** The editor of every note card on the surface. */
const editors = () =>
  screen
    .getAllByRole('group', { name: 'Not metni' })
    .map((g) => g.querySelector<HTMLElement>('.ProseMirror'));

describe('quick access › sticky note', () => {
  it('a note added from "Kart ekle" can be typed into at once', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('article', { name: 'Dokploy' }, { timeout: 5000 });
    const before = screen.getAllByRole('group', { name: 'Not metni' }).length;
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    await user.click(await screen.findByRole('button', { name: /^Yapışkan not/ }));
    await waitFor(() =>
      expect(screen.getAllByRole('group', { name: 'Not metni' }).length).toBe(before + 1),
    );
    await waitFor(() => expect(editors().at(-1)).toBeTruthy());
    expect(editors().every((e) => e?.getAttribute('contenteditable') === 'true')).toBe(true);
  });

  it('Düzenle arranges the surface; Kart ekle opens the card gallery', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('article', { name: 'Dokploy' }, { timeout: 5000 });
    const gallery = () => screen.queryByRole('button', { name: /^Yapışkan not/ });

    await user.click(screen.getByRole('button', { name: 'Düzenle' }));
    expect(await screen.findByRole('button', { name: 'Bitti' })).toBeInTheDocument();
    expect(gallery()).toBeNull();
    // In edit mode "Kart ekle" opens and closes the gallery.
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    expect(gallery()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    expect(gallery()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Bitti' }));

    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    expect(gallery()).not.toBeNull();
  });
});
