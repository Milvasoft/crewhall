import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** The shortcuts the Drive item menu shows work on the selection without opening it. */

const SUNUMLAR = `/drive/milvasoft/folder/${NODE.sunumlar}`;

describe('Drive menu shortcuts', () => {
  it('M opens the move dialog for the selected items', async () => {
    signedInAs(USER.bugra);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('row', { name: /ekran-kaydi\.mp4/ }));
    await user.keyboard('m');
    expect(await screen.findByRole('dialog', { name: 'Öğeyi taşı' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('M');
    expect(await screen.findByRole('dialog', { name: /öğeyi taşı/ })).toBeInTheDocument();
  });

  it('Ctrl+Shift+C copies the link of the selected item', async () => {
    signedInAs(USER.bugra);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('row', { name: /ekran-kaydi\.mp4/ }));
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}');
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toMatch(/^https?:\/\/.+\/drive\//),
    );
  });

  it('works on the recent page too', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/recent');
    const user = userEvent.setup();
    await screen.findAllByRole('checkbox', { name: /seç/ });
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('m');
    expect(await screen.findByRole('dialog', { name: /taşı/i })).toBeInTheDocument();
  });
});
