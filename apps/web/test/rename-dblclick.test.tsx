import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * Double click: renames a named thing in a tree or a column head. In the Drive list and grid it
 * keeps opening, as in a file manager; F2 and the menu rename there.
 */
describe('double click to rename', () => {
  it('renames a folder in the Drive tree', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Klasör içeriği' });
    const inTree = async () =>
      (await screen.findAllByText('Sunumlar')).find((el) => !el.closest('table'))!;
    // As a browser does it: the first click opens the folder, the row may be a new one by the
    // second, which still counts as the second click.
    await user.click(await inTree());
    fireEvent.click(await inTree(), { detail: 2 });
    expect(await screen.findByRole('dialog')).toHaveTextContent('Yeniden adlandır');
    expect(screen.getByRole('textbox')).toHaveValue('Sunumlar');
  });

  it('renames a board column from its title', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    const user = userEvent.setup();
    await user.dblClick(await screen.findByRole('heading', { name: 'Sırada' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Sırada');
  });
});
