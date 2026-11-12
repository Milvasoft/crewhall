import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { driveState } from '@/mocks/drive';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const rail = () => screen.getByRole('navigation', { name: 'Modüller' });

describe('drawings as their own module (2026-10-29)', () => {
  it('works with boards off: own rail entry, own menu, Drive creates drawings only', async () => {
    db().org!.settings.modules = { boards: false, drawings: true };
    signedInAs(USER.bugra);
    renderApp('/drawings/milvasoft');
    expect(await screen.findByText("Bu space'in çizimleri")).toBeInTheDocument();
    // Menu rows are named exactly after the drawing (grid tiles add meta): the space list,
    // and "Son açılanlar" / "Favoriler" when the drawing is in them; all open the editor.
    const rows = await screen.findAllByRole('link', { name: 'Hub mimarisi' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveAttribute('href', `/d/${NODE.hubMimarisi}`);
    expect(within(rail()).getByRole('link', { name: 'Çizimler' })).toBeInTheDocument();
    expect(within(rail()).queryByRole('link', { name: 'Panolar' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(rail()).getByRole('link', { name: 'Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Yeni' }));
    expect(await screen.findByRole('menuitem', { name: 'Çizim' })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Pano' })).toBeNull();
  });

  it('turned off on its own: the page says so and the boards menu no longer links it', async () => {
    db().org!.settings.modules = { boards: true, drawings: false };
    signedInAs(USER.bugra);
    renderApp('/drawings/milvasoft');
    expect(await screen.findByText('Bu modül kurumunda kapalı')).toBeInTheDocument();
    expect(within(rail()).queryByRole('link', { name: 'Çizimler' })).toBeNull();
    expect(within(rail()).getByRole('link', { name: 'Panolar' })).toBeInTheDocument();
  });

  it('boards no longer carry a drawings link in their menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/boards/milvasoft');
    await screen.findByText('Bana atananlar');
    const links = screen.queryAllByRole('link', { name: 'Çizimler' });
    // Only the rail entry is left; the boards menu itself has none.
    expect(links.filter((el) => !rail().contains(el))).toEqual([]);
  });

  it('Ctrl K lists drawings in their own group', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Modüller' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'Hub mimar');
    const group = await screen.findByRole('group', { name: 'Çizimler' });
    // Matches are highlighted, so the name is split across elements.
    expect(group.textContent).toContain('Hub mimarisi');
  });

  it('marks the module of a board, drawing or page opened on its own address', async () => {
    signedInAs(USER.bugra);
    renderApp(`/d/${NODE.hubMimarisi}`);
    await waitFor(() =>
      expect(within(rail()).getByRole('link', { name: 'Çizimler' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
  });

  it('opening a drawing puts it in "Son açılanlar"', async () => {
    signedInAs(USER.bugra);
    renderApp(`/d/${NODE.hubMimarisi}`);
    await waitFor(() => {
      const opened = driveState().userNodes.find(
        (x) => x.nodeId === NODE.hubMimarisi && x.userId === USER.bugra,
      );
      expect(opened?.lastOpenedAt).toBeTruthy();
    });
  });
});
