import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Takip et" in the page header: a person's choice, kept by the server. */

describe('following a page', () => {
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('follows and stops following from the header', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    const link = (await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!;
    const pageId = /([0-9a-f-]{36})$/.exec(link.getAttribute('href')!)![1]!;
    await user.click(link);

    const follow = await screen.findByRole('button', { name: /^Takip et/ });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    await user.click(follow);
    expect(await screen.findByRole('button', { name: 'Takibi bırak' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(async () =>
      expect((await api.call('getPage', { params: { nodeId: pageId } })).following).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Takibi bırak' }));
    expect(await screen.findByRole('button', { name: /^Takip et/ })).toBeInTheDocument();
    await waitFor(async () =>
      expect((await api.call('getPage', { params: { nodeId: pageId } })).following).toBe(false),
    );
  });

  it('follows a page with its sub-pages from the page menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    const link = (await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!;
    const pageId = /([0-9a-f-]{36})$/.exec(link.getAttribute('href')!)![1]!;
    await user.click(link);

    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: /Alt sayfaları da takip et/ }));
    expect(await screen.findByRole('button', { name: 'Takibi bırak' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(async () =>
      expect(await api.call('getPage', { params: { nodeId: pageId } })).toMatchObject({
        following: true,
        followingDescendants: true,
      }),
    );

    // Again: back to the page alone, still following.
    await user.click(screen.getByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: /Alt sayfaları da takip et/ }));
    await waitFor(async () =>
      expect(await api.call('getPage', { params: { nodeId: pageId } })).toMatchObject({
        following: true,
        followingDescendants: false,
      }),
    );

    // Stopping clears the sub-pages too.
    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: /Alt sayfaları da takip et/ }));
    await user.click(await screen.findByRole('button', { name: 'Takibi bırak' }));
    await waitFor(async () =>
      expect(await api.call('getPage', { params: { nodeId: pageId } })).toMatchObject({
        following: false,
        followingDescendants: false,
      }),
    );
  });
});
