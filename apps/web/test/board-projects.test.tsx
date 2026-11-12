import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { boardsMockState } from '@/mocks/boards';
import { newId } from '@/mocks/db';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const section = (name: string) => screen.getByRole('region', { name });

describe('board sprints (kararlar 2026-10-29)', () => {
  it('shows the running sprint on the board and plans the rest in the backlog', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.sprint42}`);
    // The kanban shows the running sprint only; backlog cards wait in the backlog view.
    expect(await screen.findByText('Scheduler retry politikası')).toBeInTheDocument();
    expect(screen.queryByText('Dump arama geçmişi')).toBeNull();
    expect(screen.getByText('Sprint 42')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Backlog' }));
    await waitFor(() => expect(section('Backlog')).toBeInTheDocument());
    expect(within(section('Sprint 42')).getByText('Devam ediyor')).toBeInTheDocument();
    expect(
      within(section('Sprint 43')).getByText('Android bildirim kanalları'),
    ).toBeInTheDocument();
    expect(within(section('Backlog')).getByText('Dump arama geçmişi')).toBeInTheDocument();
    // The running sprint carries its burndown.
    expect(within(section('Sprint 42')).getByRole('img', { name: /Burndown/ })).toBeInTheDocument();

    // Row menu: the backlog card goes into Sprint 43.
    await user.click(
      within(section('Backlog')).getByRole('button', { name: 'DMP-331 kartını taşı' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Sprint 43' }));
    await waitFor(() =>
      expect(within(section('Sprint 43')).getByText('Dump arama geçmişi')).toBeInTheDocument(),
    );
    const card = boardsMockState().cards.find((c) => c.title === 'Dump arama geçmişi')!;
    const planned = boardsMockState().sprints.find((s) => s.name === 'Sprint 43')!;
    expect(card.sprintId).toBe(planned.id);
  }, 30_000);

  it('creates a sprint, closes the running one and starts the next', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.sprint42}?view=backlog`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Yeni sprint' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Ad');
    expect(name).toHaveValue('Sprint 3');
    await user.clear(name);
    await user.type(name, 'Sprint 44');
    await user.type(within(dialog).getByLabelText('Hedef'), 'Ödeme akışı');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(section('Sprint 44')).toBeInTheDocument());
    expect(within(section('Sprint 44')).getByText('Ödeme akışı')).toBeInTheDocument();

    // Another sprint runs, so the planned ones cannot start yet.
    expect(
      within(section('Sprint 43')).getByRole('button', { name: 'Sprinti başlat' }),
    ).toBeDisabled();

    // Closing: unfinished cards go to the chosen planned sprint.
    await user.click(within(section('Sprint 42')).getByRole('button', { name: 'Sprinti kapat' }));
    const close = await screen.findByRole('dialog');
    expect(within(close).getByText(/Bitmemiş 5 kart/)).toBeInTheDocument();
    await user.click(within(close).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sprint 42' })).toBeNull());
    expect(
      within(section('Sprint 43')).getByText('Scheduler retry politikası'),
    ).toBeInTheDocument();
    const closed = boardsMockState().sprints.find((s) => s.name === 'Sprint 42')!;
    expect(closed).toMatchObject({ status: 'closed', result: { unit: 'points', done: 8 } });

    await user.click(within(section('Sprint 43')).getByRole('button', { name: 'Sprinti başlat' }));
    await waitFor(() =>
      expect(within(section('Sprint 43')).getByText('Devam ediyor')).toBeInTheDocument(),
    );
  }, 30_000);

  it('moves a card between sprints from its detail', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.sprint42}/DMP-318`);
    const dialog = await screen.findByRole('dialog');
    const user = userEvent.setup();
    const picker = await within(dialog).findByRole('combobox', { name: 'Sprint' });
    expect(picker).toHaveTextContent('Sprint 42');
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Backlog' }));
    await waitFor(() => {
      const card = boardsMockState().cards.find((c) => c.number === 318)!;
      expect(card.sprintId).toBeNull();
    });
  });
});

describe('card dependencies (kararlar 2026-10-29)', () => {
  it('flags blocked cards and links, opens and unlinks cards from the detail', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.sprint42}`);
    const tile = (await screen.findByText('Scheduler retry politikası')).closest('[data-card-id]');
    expect(within(tile as HTMLElement).getByText('Engelli')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText('Scheduler retry politikası'));
    const links = await screen.findByRole('region', { name: 'Bağlantılar' });
    expect(within(links).getByText('Engelleyenler')).toBeInTheDocument();
    expect(within(links).getByText("Hub API'ye toplu silme ucu")).toBeInTheDocument();

    // Relate it to another card found by its key.
    await user.click(within(links).getByRole('button', { name: 'Bağlantı ekle' }));
    await user.click(await screen.findByRole('combobox', { name: 'Bağlantı türü' }));
    await user.click(await screen.findByRole('option', { name: 'İlgili kart' }));
    await user.type(screen.getByRole('textbox', { name: /Kart ara/ }), 'DMP-324');
    await user.click(await screen.findByRole('button', { name: /Test ortamı SSL yenileme/ }));
    await waitFor(() => expect(within(links).getByText('İlgili')).toBeInTheDocument());
    const card = boardsMockState().cards.find((c) => c.number === 318)!;
    const other = boardsMockState().cards.find((c) => c.number === 324)!;
    expect(boardsMockState().links).toContainEqual(
      expect.objectContaining({ fromCardId: card.id, toCardId: other.id, kind: 'relates' }),
    );

    await user.click(within(links).getByRole('button', { name: 'DMP-324 bağlantısını kaldır' }));
    await waitFor(() => expect(within(links).queryByText('İlgili')).toBeNull());
  });

  it('refuses a link that would loop', async () => {
    signedInAs(USER.bugra);
    // 311 blocks 318 (seed) and 318 blocks 324: 324 blocking 311 would loop.
    const st = boardsMockState();
    const id = (n: number) => st.cards.find((c) => c.number === n)!.id;
    st.links.push({
      id: newId(),
      fromCardId: id(318),
      toCardId: id(324),
      kind: 'blocks',
      createdAt: new Date().toISOString(),
    });
    renderApp(`/b/${NODE.sprint42}/DMP-324`);
    const links = await screen.findByRole('region', { name: 'Bağlantılar' });
    const user = userEvent.setup();
    await user.click(within(links).getByRole('button', { name: 'Bağlantı ekle' }));
    await user.click(await screen.findByRole('combobox', { name: 'Bağlantı türü' }));
    await user.click(await screen.findByRole('option', { name: 'Bu kartın engellediği' }));
    await user.type(screen.getByRole('textbox', { name: /Kart ara/ }), 'DMP-311');
    const pick = await screen.findByRole('button', { name: /Hub API'ye toplu silme ucu/ });
    const before = st.links.length;
    await user.click(pick);
    // Refused (board_link_cycle, shown as a toast in the app): nothing stored, picker stays.
    const search = screen.getByRole('textbox', { name: /Kart ara/ });
    await expect(
      waitFor(() => expect(search).not.toBeInTheDocument(), { timeout: 1500 }),
    ).rejects.toThrow();
    expect(st.links).toHaveLength(before);
  });
});

describe('board timeline (kararlar 2026-10-29)', () => {
  const card = (n: number) =>
    boardsMockState().cards.find((c) => c.boardId === NODE.yolHaritasi && c.number === n)!;
  const day = (iso: string) => new Date(iso).getDate();

  it('draws dated cards as bars, moves them with the keyboard and plans undated ones', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}?view=timeline`);
    const bar = await screen.findByRole('button', { name: /^MLV-142 SSO ile giriş \(OIDC\):/ });
    // SSO starts before its blocker (MLV-144) ends: warning.
    expect(bar).toHaveAttribute('title', 'Engelleyen kart bitmeden başlıyor');

    const before = { start: card(142).startAt!, due: card(142).dueAt! };
    const user = userEvent.setup();
    bar.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(card(142).startAt).not.toBe(before.start));
    expect(Date.parse(card(142).startAt!) - Date.parse(before.start)).toBe(86_400_000);
    expect(Date.parse(card(142).dueAt!) - Date.parse(before.due)).toBe(86_400_000);
    // Shift moves the end only.
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await waitFor(() => expect(day(card(142).dueAt!)).toBe(day(before.due)));
    expect(Date.parse(card(142).startAt!) - Date.parse(before.start)).toBe(86_400_000);

    // Undated cards wait below; planning gives them this week.
    const undated = screen.getByRole('region', { name: 'Tarihsiz' });
    const row = within(undated).getByText('Webhook ile iş tetikleme').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Bu haftaya planla' }));
    await waitFor(() => expect(card(149).startAt).toBeTruthy());
    expect(card(149).dueAt).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /^MLV-149 Webhook ile iş tetikleme:/ }),
    ).toBeInTheDocument();
  });

  it('edits the start date in the card detail', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}/MLV-144`);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Başlangıç')).toBeInTheDocument();
    expect(within(dialog).queryByText('Başlangıç yok')).toBeNull();
  });
});

describe('time tracking (kararlar 2026-10-29)', () => {
  const sso = () =>
    boardsMockState().cards.find((c) => c.boardId === NODE.yolHaritasi && c.number === 142)!;
  const mine = () => boardsMockState().time.filter((e) => e.userId === USER.bugra);

  it('shows time against the estimate, runs a timer and logs time by hand', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}/MLV-142`);
    const time = await screen.findByRole('region', { name: 'Zaman' });
    expect(within(time).getByText('6 sa 15 dk / 16 sa')).toBeInTheDocument();
    const user = userEvent.setup();
    const seeded = mine().length;

    // The timer runs on the card and shows in the toolbar pill.
    await user.click(within(time).getByRole('button', { name: 'Zamanlayıcıyı başlat' }));
    await waitFor(() => expect(mine().some((e) => e.minutes === null)).toBe(true));
    expect(
      // The toolbar is behind the modal card, out of the accessibility tree meanwhile.
      await screen.findByRole('button', { name: 'MLV-142 zamanlayıcısını durdur', hidden: true }),
    ).toBeInTheDocument();
    await user.click(await within(time).findByRole('button', { name: /Durdur/ }));
    await waitFor(() => expect(mine().every((e) => e.minutes !== null)).toBe(true));
    expect(mine()).toHaveLength(seeded + 1);

    // By hand: 1 hour 30 minutes with a note.
    await user.click(within(time).getByRole('button', { name: 'Süre ekle' }));
    const minutes = within(time).getByRole('spinbutton', { name: 'Dakika' });
    await user.clear(minutes);
    await user.type(minutes, '30');
    await user.type(within(time).getByRole('textbox', { name: 'Not' }), 'Rol eşleme testleri');
    await user.click(within(time).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(mine()).toHaveLength(seeded + 2));
    expect(mine().find((e) => e.source === 'manual')).toMatchObject({
      minutes: 90,
      note: 'Rol eşleme testleri',
    });
    expect(await within(time).findByText('Rol eşleme testleri')).toBeInTheDocument();
  }, 30_000);

  it('sets the estimate in hours and lets people edit only their own entries', async () => {
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.yolHaritasi}/MLV-142`);
    const time = await screen.findByRole('region', { name: 'Zaman' });
    const user = userEvent.setup();
    const estimate = within(time).getByRole('spinbutton', { name: 'Tahmin (saat)' });
    await user.clear(estimate);
    await user.type(estimate, '20');
    await user.tab();
    await waitFor(() => expect(sso().estimateMinutes).toBe(1200));
    // Bugra administers the space, so both seeded entries can be edited.
    expect(await within(time).findAllByRole('button', { name: 'Kaydı sil' })).toHaveLength(2);
  });
});

describe('workload (kararlar 2026-10-29)', () => {
  it('shows hours per person and week against the capacity, and opens a cell', async () => {
    const board = boardsMockState().boards.find((b) => b.id === NODE.sprint42)!;
    board.settings.capacityHours = 8;
    signedInAs(USER.bugra);
    renderApp(`/b/${NODE.sprint42}?view=workload`);
    expect(await screen.findByText('Kapasite: kişi başı haftada 8 saat')).toBeInTheDocument();
    // Selin has the iOS push work (16 h) in the running sprint: over capacity this week.
    const cell = (await screen.findAllByRole('button', { name: /^Selin Öztürk, .* haftası/ }))[0]!;
    expect(cell.getAttribute('aria-label')).toMatch(/\/ 8 saat/);
    const user = userEvent.setup();
    await user.click(cell);
    expect(
      await screen.findByRole('button', { name: /Push bildirim izni akışı/ }),
    ).toBeInTheDocument();
  });

  it('sums every board of the space from the sidebar view', async () => {
    signedInAs(USER.bugra);
    renderApp('/boards/dumpapp');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'İş yükü' }));
    expect(await screen.findByRole('heading', { name: 'İş yükü' })).toBeInTheDocument();
    expect(await screen.findByText('Kapasite: kişi başı haftada 40 saat')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Selin Öztürk/ })).toBeInTheDocument();
  });
});
