import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { boardsMockState } from '@/mocks/boards';
import { db } from '@/mocks/db';
import { driveState } from '@/mocks/drive';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const state = () => boardsMockState(db());
const cardBy = (title: string) => state().cards.find((c) => c.title === title)!;
const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent);

async function openBoard() {
  signedInAs(USER.bugra);
  renderApp(`/b/${NODE.yolHaritasi}`);
  const user = userEvent.setup();
  await screen.findByText('Cron ifadesi doğrulayıcı');
  return user;
}

const tile = (title: string) => screen.getByText(title).closest<HTMLElement>('[data-card-id]')!;

describe('boards › right-click menus', () => {
  it('a kanban card offers the card actions; "Bana ata" assigns me', async () => {
    const user = await openBoard();
    fireEvent.contextMenu(tile('Cron ifadesi doğrulayıcı'));
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual([
      'Aç↵',
      'Yeni sekmede aç',
      'Bağlantıyı kopyala',
      'Sohbete gönder',
      'Sütuna taşı',
      'Bana ata',
      'Etiket ekle',
      'Arşivle',
      'Kartı sil',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Bana ata' }));
    await waitFor(() =>
      expect(cardBy('Cron ifadesi doğrulayıcı').assigneeIds).toContain(USER.bugra),
    );
  });

  it('moves a card to another column from the "Sütuna taşı" submenu', async () => {
    const user = await openBoard();
    fireEvent.contextMenu(tile('Cron ifadesi doğrulayıcı'));
    const menu = await screen.findByRole('menu');
    // Open the submenu from the keyboard (a moving pointer leaves the trigger in jsdom).
    within(menu).getByRole('menuitem', { name: 'Sütuna taşı' }).focus();
    await user.keyboard('{ArrowRight}');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Yapılıyor' }));
    const doing = state().columns.find(
      (c) => c.boardId === NODE.yolHaritasi && c.name === 'Yapılıyor',
    )!;
    await waitFor(() => expect(cardBy('Cron ifadesi doğrulayıcı').columnId).toBe(doing.id));
  });

  it('a column header shows the column menu; the empty lane area adds a card', async () => {
    const user = await openBoard();
    const queue = screen.getByRole('region', { name: 'Sırada' });
    fireEvent.contextMenu(within(queue).getByRole('heading', { name: 'Sırada' }));
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual([
      'Yeniden adlandır',
      'WIP sınırı',
      'Tamamlandı sütunu yap',
      'Sütunu sil',
    ]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    fireEvent.contextMenu(queue.querySelector<HTMLElement>('[data-lane]')!);
    const lane = await screen.findByRole('menu');
    expect(items(lane)[0]).toBe('Kart ekle');
    await user.click(within(lane).getByRole('menuitem', { name: 'Kart ekle' }));
    expect(await within(queue).findByRole('textbox', { name: 'Kart ekle' })).toBeInTheDocument();
  });

  it('a list view row has the same menu; archive takes the card off the board', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}?view=list`);
    const user = userEvent.setup();
    const row = (await screen.findByText('SSO ile giriş (OIDC)')).closest('tr')!;
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    // Enter does not open a row, so no shortcut is shown here.
    expect(items(menu)[0]).toBe('Aç');
    await user.click(within(menu).getByRole('menuitem', { name: 'Arşivle' }));
    await waitFor(() => expect(cardBy('SSO ile giriş (OIDC)').archivedAt).not.toBeNull());
  });
});

describe('boards and drawings lists › right-click menus', () => {
  it('a board tile offers the Drive actions and goes to the trash from its menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/boards/milvasoft');
    const user = userEvent.setup();
    // The tile in the page (the sidebar lists the board too).
    const link = await screen.findByRole('link', { name: /Milvaion Yol Haritası.*kart/ });
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole('menu');
    const labels = items(menu);
    expect(labels.slice(0, 3)).toEqual(['Aç↵', 'Yeni sekmede aç', 'Paylaş…']);
    for (const label of ['Linki kopyalaCtrl Shift C', 'Yeniden adlandırF2', 'Taşı…M']) {
      expect(labels).toContain(label);
    }
    await user.click(within(menu).getByRole('menuitem', { name: /Çöp kutusuna taşı/ }));
    await waitFor(() =>
      expect(driveState().nodes.find((n) => n.id === NODE.yolHaritasi)?.deletedAt).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: /Milvaion Yol Haritası.*kart/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it('a drawing tile renames from its menu, and with F2', async () => {
    signedInAs(USER.bugra);
    renderApp('/drawings/milvasoft');
    const user = userEvent.setup();
    // The drawings sidebar lists the same names; the tile is in the main area.
    const main = await screen.findByRole('main');
    const title = await within(main).findByText('Hub mimarisi');
    const link = title.closest('a')!;
    fireEvent.contextMenu(link);
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual(
      expect.arrayContaining([
        'Aç↵',
        'Yeni sekmede aç',
        'Kopyasını oluştur…',
        'Çöp kutusuna taşıDel',
      ]),
    );
    await user.click(within(menu).getByRole('menuitem', { name: /Yeniden adlandır/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Yeniden adlandır' });
    const input = within(dialog).getByLabelText('Ad');
    await user.clear(input);
    await user.type(input, 'Hub mimarisi v2{Enter}');
    expect(await within(main).findByText('Hub mimarisi v2')).toBeInTheDocument();
    expect(driveState().nodes.find((n) => n.id === NODE.hubMimarisi)?.name).toBe('Hub mimarisi v2');

    link.focus();
    fireEvent.keyDown(link, { key: 'F2' });
    dialog = await screen.findByRole('dialog', { name: 'Yeniden adlandır' });
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
