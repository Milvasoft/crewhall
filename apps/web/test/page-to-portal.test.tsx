import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { db } from '@/mocks/db';
import { portalState } from '@/mocks/portal';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Portal'a gönder" in the page menu (design 05 5.12): a draft doc, for portal editors. */

async function openPage() {
  // renderApp mounts no Toaster; the result is a toast.
  render(<Toaster />);
  renderApp('/pages/milvasoft');
  const user = userEvent.setup();
  const sidebar = await screen.findByRole('complementary', { name: /Space/i });
  const link = (await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!;
  const pageId = /([0-9a-f-]{36})$/.exec(link.getAttribute('href')!)![1]!;
  await user.click(link);
  await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
  await screen.findByRole('menuitem', { name: /Dışa aktar/ });
  return { user, pageId };
}

describe('sending a page to the Portal', () => {
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('creates a draft doc, and the same page again updates it', async () => {
    signedInAs(USER.bugra);
    const { user, pageId } = await openPage();
    await user.click(screen.getByRole('menuitem', { name: "Portal'a gönder" }));
    const dialog = await screen.findByRole('dialog', { name: "Portal'a gönder" });
    const send = within(dialog).getByRole('button', { name: 'Taslak olarak gönder' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    expect((await screen.findAllByText(/portala taslak olarak gönderildi/)).length).toBeGreaterThan(
      0,
    );
    const linked = () =>
      portalState(db()).docs.filter((d) => d.sourceNodeId === pageId && !d.deletedAt);
    await waitFor(() => expect(linked()).toHaveLength(1));
    const first = linked()[0]!;
    expect(first.title).toMatch(/Milvaion/);

    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: "Portal'a gönder" }));
    const again = await screen.findByRole('dialog', { name: "Portal'a gönder" });
    await user.click(within(again).getByRole('button', { name: 'Taslak olarak gönder' }));
    expect((await screen.findAllByText(/portal taslağı güncellendi/)).length).toBeGreaterThan(0);
    expect(linked()).toHaveLength(1);
    expect(linked()[0]!.rev).toBeGreaterThan(1);
  });

  it('is not offered without portal rights', async () => {
    signedInAs(USER.mert);
    await openPage();
    expect(screen.queryByRole('menuitem', { name: "Portal'a gönder" })).toBeNull();
  });

  it('is not offered while the portal module is off', async () => {
    db().org!.settings.modules = { portal: false };
    signedInAs(USER.bugra);
    await openPage();
    expect(screen.queryByRole('menuitem', { name: "Portal'a gönder" })).toBeNull();
  });
});
