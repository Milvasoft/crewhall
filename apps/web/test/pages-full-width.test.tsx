import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Tam genişlik" is the person's choice for every page (UiPrefs.pagesFullWidth), not per page. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

const article = () => document.querySelector('article');

describe('pages full width', () => {
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

  it('turns on for every page and is saved as my preference', async () => {
    signedInAs(USER.bugra);
    renderApp('/sayfalar/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await waitFor(() => expect(article()).toHaveClass('max-w-[720px]'));

    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Tam genişlik' }));
    // Shown at once, before the server answers.
    expect(article()).toHaveClass('max-w-none');
    await waitFor(async () =>
      expect(await api.call('getUiPrefs')).toMatchObject({ pagesFullWidth: true }),
    );

    // Another page opens full width too.
    const tree = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(tree).findAllByRole('link', { name: /Onboarding/ }))[0]!);
    await waitFor(() => expect(screen.getByDisplayValue('Onboarding')).toBeInTheDocument());
    expect(article()).toHaveClass('max-w-none');

    // And off again, for every page.
    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Tam genişlik' }));
    expect(article()).toHaveClass('max-w-[720px]');
    await waitFor(async () =>
      expect(await api.call('getUiPrefs')).toMatchObject({ pagesFullWidth: false }),
    );
  });
});
