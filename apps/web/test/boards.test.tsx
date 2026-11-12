import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { boardsMockState } from '@/mocks/boards';
import { db } from '@/mocks/db';
import { NODE } from '@/mocks/driveSeed';
import { quickState } from '@/mocks/quick';
import { SURFACE } from '@/mocks/quickSeed';
import { SPACE, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const state = () => boardsMockState(db());
const cardBy = (title: string) => state().cards.find((c) => c.title === title)!;
const column = (name: string) =>
  state().columns.find((c) => c.boardId === NODE.yolHaritasi && c.name === name)!;

describe('boards (design 06)', () => {
  it('shows columns with WIP counts and cards with their key, labels and meta', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    const doing = await screen.findByRole('region', { name: 'Yapılıyor' });
    expect(within(doing).getByText('3/3')).toBeInTheDocument();
    expect(within(doing).getByText('SSO ile giriş (OIDC)')).toBeInTheDocument();
    expect(within(doing).getByText('MLV-142')).toBeInTheDocument();
    expect(within(doing).getByText('2/5')).toBeInTheDocument();
    expect(within(doing).getAllByText('Güvenlik').length).toBeGreaterThan(0);
    // The done column with many cards starts collapsed (6.1).
    expect(screen.getByRole('button', { name: /Bitti · Sütunu aç/ })).toBeInTheDocument();
  });

  it('filters by person through the address and keeps empty columns', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(`/b/${NODE.yolHaritasi}`);
    const user = userEvent.setup();
    await screen.findByText('SSO ile giriş (OIDC)');
    await user.click(screen.getByRole('button', { name: 'Bana atananlar' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ person: ['me'] }));
    expect(screen.getByText('SSO ile giriş (OIDC)')).toBeInTheDocument();
    expect(screen.queryByText('Retry politikası arayüzü')).not.toBeInTheDocument();
    const idea = screen.getByRole('region', { name: 'Fikir' });
    expect(within(idea).getByText('Süzgece uyan kart yok')).toBeInTheDocument();
    expect(within(idea).getByText('0 / 4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Temizle' }));
    expect(await screen.findByText('Retry politikası arayüzü')).toBeInTheDocument();
  });

  it('adds a card inline with #label and @person; Enter keeps the box open', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    const user = userEvent.setup();
    const queue = await screen.findByRole('region', { name: 'Sırada' });
    await user.click(within(queue).getByRole('button', { name: 'Kart ekle' }));
    const box = within(queue).getByRole('textbox', { name: 'Kart ekle' });
    await user.type(box, 'Seq alarm webhook #backend @can{Enter}');
    await waitFor(() =>
      expect(state().cards.some((c) => c.title === 'Seq alarm webhook')).toBe(true),
    );
    const created = cardBy('Seq alarm webhook');
    expect(created.labels).toEqual(['l1']);
    expect(created.assigneeIds).toEqual([USER.can]);
    expect(created.columnId).toBe(column('Sırada').id);
    expect(await within(queue).findByText('Seq alarm webhook')).toBeInTheDocument();
    expect(within(queue).getByRole('textbox', { name: 'Kart ekle' })).toHaveValue('');
  });

  it('adds a card from the toolbar through a dialog, without the browser prompt', async () => {
    signedInAs(USER.bugra);
    const prompt = vi.spyOn(window, 'prompt');
    const { router } = renderApp(`/b/${NODE.yolHaritasi}`);
    const user = userEvent.setup();
    await screen.findByRole('region', { name: 'Sırada' });
    // The toolbar's button comes before the columns' own.
    await user.click(screen.getAllByRole('button', { name: 'Kart ekle' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Araç çubuğundan{Enter}');
    await waitFor(() =>
      expect(state().cards.some((c) => c.title === 'Araç çubuğundan')).toBe(true),
    );
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/b\/.+\/MLV-\d+$/));
  });

  it('moves a card with Ctrl → and warns past the WIP limit', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    const queue = await screen.findByRole('region', { name: 'Sırada' });
    const tile = within(queue).getByText('Cron ifadesi doğrulayıcı').closest('[data-card-id]')!;
    (tile as HTMLElement).focus();
    fireEvent.keyDown(tile, { key: 'ArrowRight', ctrlKey: true });
    await waitFor(() =>
      expect(cardBy('Cron ifadesi doğrulayıcı').columnId).toBe(column('Yapılıyor').id),
    );
    const doing = screen.getByRole('region', { name: 'Yapılıyor' });
    expect(await within(doing).findByText('4/3')).toBeInTheDocument();
    expect(within(doing).getByTitle('WIP sınırı aşıldı (4/3)')).toBeInTheDocument();
    const moved = state().activity.find(
      (a) => a.cardId === cardBy('Cron ifadesi doğrulayıcı').id && a.kind === 'moved',
    );
    expect(moved?.data).toMatchObject({ from: 'Sırada', to: 'Yapılıyor' });
  });

  it('reorders columns from the header grip with Ctrl ← → and keeps the focus there', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    const grip = await screen.findByRole('button', { name: 'Yapılıyor sütununu taşı' });
    const order = () =>
      [...document.querySelectorAll<HTMLElement>('[data-column-id]')].map(
        (el) => state().columns.find((c) => c.id === el.dataset.columnId)!.name,
      );
    const before = order();
    const i = before.indexOf('Yapılıyor');
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowLeft', ctrlKey: true });
    // The column jumps at once (optimistic), then the server order agrees.
    const expected = [...before];
    expected.splice(i, 1);
    expected.splice(i - 1, 0, 'Yapılıyor');
    await waitFor(() => expect(order()).toEqual(expected));
    const saved = state()
      .columns.filter((c) => c.boardId === NODE.yolHaritasi)
      .sort((a, b) => (a.position < b.position ? -1 : 1))
      .map((c) => c.name);
    expect(saved).toEqual(expected);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Yapılıyor sütununu taşı' }),
      ),
    );
    // Cards stay in their column after the move.
    const doing = screen.getByRole('region', { name: 'Yapılıyor' });
    expect(within(doing).getByText('SSO ile giriş (OIDC)')).toBeInTheDocument();
  });

  it('opens the board from the quick-access "Bana atananlar" card (H1)', async () => {
    signedInAs(USER.bugra);
    const q = quickState(db());
    q.cards.push({
      id: '0190f0a0-0000-7000-8000-00000000ab01',
      surfaceId: SURFACE.bugra,
      type: 'board_assigned',
      config: { scope: 'assigned', spaceId: null, limit: 6 },
      layout: { x: 0, y: 40, w: 4, h: 3 },
      mobileOrder: null,
      pinnedFrom: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    } as never);
    const { router } = renderApp('/');
    const user = userEvent.setup();
    const quickCard = await screen.findByRole('article', { name: 'Bana atananlar' });
    await user.click(await within(quickCard).findByText('SSO ile giriş (OIDC)'));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/b\//));
    // The board renders inside the app providers: the opened card, and the columns behind it
    // (hidden from the accessibility tree while the card dialog is open).
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/b/${NODE.yolHaritasi}/MLV-142`),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Authorization Code \+ PKCE/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Yapılıyor', hidden: true })).toBeInTheDocument();
  });

  it('opens a board directly at /b/<id>', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}`);
    expect(
      await screen.findByRole('heading', { name: 'Milvaion Yol Haritası' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fikir' })).toBeInTheDocument();
  });

  it('opens the card at its own address, edits subtasks and comments', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(`/b/${NODE.yolHaritasi}`);
    const user = userEvent.setup();
    await user.click(await screen.findByText('SSO ile giriş (OIDC)'));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/b/${NODE.yolHaritasi}/MLV-142`),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Authorization Code \+ PKCE/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Refresh token 30 gün olsun/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Rol eşleme tablosu ve testleri' }),
    );
    await waitFor(() =>
      expect(cardBy('SSO ile giriş (OIDC)').checklist.filter((i) => i.done)).toHaveLength(3),
    );
    const box = within(dialog).getByRole('textbox', { name: 'MLV-142 kartına yaz…' });
    await user.type(box, 'Testler yeşil{Enter}');
    expect(await within(dialog).findByText('Testler yeşil')).toBeInTheDocument();
    expect(cardBy('SSO ile giriş (OIDC)').commentCount).toBe(4);
    await user.click(within(dialog).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/b/${NODE.yolHaritasi}`));
  });

  it('list view groups by column and archives a selection', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}?view=list`);
    const user = userEvent.setup();
    expect(await screen.findByRole('columnheader', { name: /Son tarih/ })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'MLV-138 seç' }));
    expect(screen.getByText('1 kart seçili')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Arşivle' }));
    await waitFor(() => expect(cardBy('Retry politikası arayüzü').archivedAt).not.toBeNull());
  });

  it('viewers see the board without add or move controls', async () => {
    signedInAs(USER.burak);
    const s = db();
    s.spaceMembers = s.spaceMembers.filter(
      (m) => !(m.spaceId === SPACE.milvasoft && m.userId === USER.burak),
    );
    s.spaceMembers.push({
      spaceId: SPACE.milvasoft,
      userId: USER.burak,
      role: 'viewer',
      addedBy: USER.bugra,
      createdAt: new Date().toISOString(),
    } as never);
    renderApp(`/b/${NODE.yolHaritasi}`);
    await screen.findByText('SSO ile giriş (OIDC)');
    expect(screen.queryByRole('button', { name: 'Kart ekle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sütununu taşı$/ })).not.toBeInTheDocument();
  });

  it('assigned-to-me view lists open cards across boards', async () => {
    signedInAs(USER.bugra);
    renderApp('/boards/milvasoft?view=mine');
    expect(await screen.findByRole('heading', { name: 'Bana atananlar' })).toBeInTheDocument();
    expect(await screen.findByText('SSO ile giriş (OIDC)')).toBeInTheDocument();
    expect(screen.getByText(/Milvaion Yol Haritası · Yapılıyor/)).toBeInTheDocument();
  });

  it('creates a board from a template', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/boards/milvasoft');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /Yeni pano/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'Müşteri geri bildirimleri');
    await user.click(within(dialog).getByRole('radio', { name: /Hata takibi/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Panoyu oluştur' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/b\//));
    const board = state().boards.at(-1)!;
    expect(board.settings.template).toBe('bugs');
    expect(
      state()
        .columns.filter((c) => c.boardId === board.id)
        .map((c) => c.name),
    ).toEqual(['Yeni', 'Doğrulandı', 'Düzeltiliyor', 'Kapandı']);
    expect(await screen.findByText(/Pano hazır/)).toBeInTheDocument();
  });

  it('drawings home lists the space drawings', async () => {
    signedInAs(USER.bugra);
    renderApp('/drawings/milvasoft');
    // In the grid and in the drawings menu.
    expect((await screen.findAllByText('Hub mimarisi')).length).toBeGreaterThan(0);
    expect(screen.getByText(/8 öğe/)).toBeInTheDocument();
  });
});
