import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Pages › Son açılanlar and Favoriler: Drive's recent and favorite nodes, pages only. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

const sidebar = () => screen.findByRole('complementary', { name: /Space/i });

describe('pages recent and favorites', () => {
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = noRects;
    Element.prototype.getClientRects = noRects;
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = layout.rangeRect;
    Range.prototype.getClientRects = layout.rangeRects;
    Element.prototype.getClientRects = layout.elRects;
  });
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('stars from the header and the tree, and lists favorites and recent pages', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    await user.click(
      (await within(await sidebar()).findAllByRole('link', { name: /Milvaion/ }))[0]!,
    );

    // ☆ in the page header.
    const star = await screen.findByRole('button', { name: 'Favorilere ekle' });
    await user.click(star);
    expect(await screen.findByRole('button', { name: 'Favorilerden çıkar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Right click in the tree.
    const row = (
      await within(await sidebar()).findAllByRole('link', { name: /Toplantı notları/ })
    )[0]!;
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(await screen.findByRole('menuitem', { name: 'Favorilere ekle' }));

    await user.click(within(await sidebar()).getByRole('link', { name: 'Favoriler' }));
    const favorites = await screen.findByRole('list', { name: 'Favoriler' });
    await waitFor(() =>
      expect(
        within(favorites)
          .getAllByRole('link')
          .map((a) => a.textContent),
      ).toEqual(expect.arrayContaining(['Milvaion', 'Toplantı notları'])),
    );
    // Unstarring leaves the list.
    const fav = within(favorites)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Toplantı notları'))!;
    await user.click(within(fav).getByRole('button', { name: 'Favorilerden çıkar' }));
    await waitFor(() => expect(favorites).not.toHaveTextContent('Toplantı notları'));

    // The opened page is under "Bugün" in the recent list.
    await user.click(within(await sidebar()).getByRole('link', { name: 'Son açılanlar' }));
    const today = await screen.findByRole('region', { name: 'Bugün' });
    expect(await within(today).findByRole('link', { name: /Milvaion/ })).toBeInTheDocument();
  });
});
