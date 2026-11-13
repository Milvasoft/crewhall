import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * A narrow chat header (below about 460 px, a container query) swaps the tabs for one menu. jsdom
 * applies no CSS, so both are in the document here; the menu must reach every tab.
 */
describe('chat header tabs in a narrow window', () => {
  it('offers the tabs as a menu that shows and switches the current one', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Sohbet sekmeleri' });
    expect(trigger).toHaveTextContent('Sohbet');
    expect(trigger.className).toContain('@[420px]/chathead:hidden');
    const nav = screen.getByRole('navigation', { name: 'Sohbet sekmeleri' });
    expect(nav.className).toContain('@[420px]/chathead:flex');

    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Sohbet' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Dosyalar' }));
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Dosyalar' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(screen.getByRole('button', { name: 'Sohbet sekmeleri' })).toHaveTextContent('Dosyalar');
  });
});
