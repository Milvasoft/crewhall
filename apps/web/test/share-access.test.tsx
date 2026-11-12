import { pagePath } from '@crewhall/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { SPACE, USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Paylaş shows who reaches a page, and by which road. */

async function openShare(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const sidebar = await screen.findByRole('complementary', { name: /Space/i });
  await user.click((await within(sidebar).findAllByRole('link', { name }))[0]!);
  await user.click(await screen.findByRole('button', { name: 'Paylaş' }));
  return screen.findByRole('dialog');
}

describe('who can reach a page', () => {
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('lists the space members by role and says what sharing cannot do', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const dialog = await openShare(user, /Onboarding/);
    expect(await within(dialog).findByText(/^Senin yetkin: /)).toBeInTheDocument();

    const row = await within(dialog).findByRole('button', { name: /Milvasoft üyeleri/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).queryByText(/ayrı bir space kullan/)).toBeNull();
    await user.click(row);

    const { items } = await api.call('listSpaceMembers', {
      params: {
        spaceId: (await api.call('listSpaces')).items.find((s) => s.slug === 'milvasoft')!.id,
      },
    });
    expect(items.length).toBeGreaterThan(1);
    for (const m of items) {
      expect(await within(dialog).findByText(m.user.name)).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/ayrı bir space kullan/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('Düzenleyen').length).toBeGreaterThan(0);

    await user.click(row);
    expect(within(dialog).queryByText(/ayrı bir space kullan/)).toBeNull();
  });

  it('names the page a sub-page inherits a share from, and does not let it be changed here', async () => {
    signedInAs(USER.bugra);
    const { items: tree } = await api.call('listPageTree', {
      params: { spaceId: SPACE.milvasoft },
    });
    const parent = tree.find((p) => p.name === 'Onboarding')!;
    const child = tree.find((p) => p.parentId === parent.id)!;
    const share = await api.call('createShare', {
      params: { nodeId: parent.id },
      body: { kind: 'user', role: 'viewer', userId: USER.burak },
    });
    const guest = share.grantee!;

    renderApp(pagePath(child));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Paylaş' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Üstteki öğeden: Onboarding')).toBeInTheDocument();
    expect(within(dialog).getByText(guest.name)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: `${guest.name} erişimini kaldır` }),
    ).toBeNull();
  });
});
