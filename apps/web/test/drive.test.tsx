import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@crewhall/ui';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { clearPaneWidths } from '@/components/shell/ResizablePane';
import { db } from '@/mocks/db';
import { NODE, PUBLIC_TOKEN } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const SUNUMLAR = `/drive/milvasoft/folder/${NODE.sunumlar}`;

/** jsdom has no DataTransfer; the drag only needs types and setData. */
function dataTransfer() {
  const types: string[] = [];
  return {
    types,
    files: [] as File[],
    items: [] as unknown[],
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: (type: string) => void (types.includes(type) || types.push(type)),
    getData: () => '',
  };
}

/** One drag from a row onto a drop target, as the browser fires it. */
function dragOnto(from: Element, to: Element) {
  const dt = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragEnter(to, { dataTransfer: dt });
  fireEvent.dragOver(to, { dataTransfer: dt });
  fireEvent.drop(to, { dataTransfer: dt });
  fireEvent.dragEnd(from, { dataTransfer: dt });
}

/** The Drive sidebar's folder tree (the list has links with the same names). */
function sidebarTree(): HTMLElement {
  const tree = screen.getByRole('link', { name: 'Tüm içerik' }).closest('.overflow-y-auto');
  if (!(tree instanceof HTMLElement)) throw new Error('sidebar tree not found');
  return tree;
}

const parentOf = (name: string) => db().drive!.nodes.find((n) => n.name === name)?.parentId;

describe('Drive (design 03)', () => {
  it('lists folders first and opens a folder', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Klasör içeriği' });
    await within(table).findByText('Q3-rapor.xlsx');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Finans')).toBeInTheDocument();
    await user.dblClick(within(table).getByText('Sunumlar'));
    await waitFor(() => expect(router.state.location.pathname).toBe(SUNUMLAR));
    expect(await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ })).toBeInTheDocument();
  });

  it('uploads a file in parts and asks on a name clash, then adds a version', async () => {
    signedInAs(USER.bugra);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ });
    const input = screen.getByTestId('drive-file-input');
    await user.upload(input, new File(['yeni içerik'], 'notlar.txt', { type: 'text/plain' }));
    const panel = await screen.findByRole('region', { name: 'Yüklemeler' });
    await waitFor(() => expect(within(panel).getByText(/Sunumlar/)).toBeInTheDocument());
    expect(await screen.findByRole('row', { name: /notlar\.txt/ })).toBeInTheDocument();

    await user.upload(
      input,
      new File(['%PDF-1.4'], 'milva-sunum-2026.pdf', { type: 'application/pdf' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Bu adla bir dosya zaten var' });
    expect(within(dialog).getByRole('radio', { name: /Yeni sürüm olarak ekle/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Devam' }));
    await waitFor(() => {
      const versions = db().drive!.versions.filter((v) => v.nodeId === NODE.sunum2026);
      expect(versions).toHaveLength(4);
    });
  });

  it('turns on a public link from the share dialog and shows its address once', async () => {
    signedInAs(USER.bugra);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    const row = await screen.findByRole('row', { name: /milva-sunum-2025\.pdf/ });
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(await screen.findByRole('menuitem', { name: 'Paylaş…' }));
    const dialog = await screen.findByRole('dialog', { name: /paylaş/ });
    await user.click(await within(dialog).findByRole('switch', { name: 'Herkese açık link' }));
    expect(await within(dialog).findByText(/\/s\/[\w-]+/)).toBeInTheDocument();
    expect(db().drive!.shares.some((s) => s.kind === 'link' && s.allowDownload)).toBe(true);
  });

  it('adds a person from the share dialog suggestions, drawn outside the dialog', async () => {
    signedInAs(USER.bugra);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    const row = await screen.findByRole('row', { name: /milva-sunum-2025.pdf/ });
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(await screen.findByRole('menuitem', { name: 'Paylaş…' }));
    const dialog = await screen.findByRole('dialog', { name: /paylaş/ });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Kişi ya da e-posta ekle' }),
      'Can',
    );
    // The list is in a portal, so the dialog's own scrolling cannot clip it.
    const option = await screen.findByRole('button', { name: /Can Demir/ });
    expect(dialog.contains(option)).toBe(false);
    await user.click(option);
    const fileId = db().drive!.nodes.find((n) => n.name === 'milva-sunum-2025.pdf')?.id;
    await waitFor(() =>
      expect(
        db().drive!.shares.some(
          (s) => s.kind === 'user' && s.granteeId === USER.can && s.nodeId === fileId,
        ),
      ).toBe(true),
    );
  });

  it('moves a file to the trash with Delete and restores it from the trash', async () => {
    signedInAs(USER.bugra);
    const folder = renderApp(SUNUMLAR);
    const user = userEvent.setup();
    const row = await screen.findByRole('row', { name: /ekran-kaydi\.mp4/ });
    await user.click(row);
    await user.keyboard('{Delete}');
    await waitFor(() => expect(screen.queryByRole('row', { name: /ekran-kaydi\.mp4/ })).toBeNull());
    folder.unmount();

    renderApp('/drive/milvasoft/trash');
    const trashRow = await screen.findByRole('row', { name: /ekran-kaydi\.mp4/ });
    await user.click(within(trashRow).getByRole('button', { name: 'Geri yükle' }));
    await waitFor(() =>
      expect(db().drive!.nodes.find((n) => n.name === 'ekran-kaydi.mp4')?.deletedAt).toBeNull(),
    );
  });

  it('drags a file onto a folder row to move it and undoes the move', async () => {
    signedInAs(USER.bugra);
    // renderApp mounts no Toaster; the move toast and its "Geri al" need one.
    render(<Toaster />);
    renderApp('/drive/milvasoft');
    const file = await screen.findByRole('row', { name: /Q3-rapor\.xlsx/ });
    dragOnto(file, screen.getByRole('row', { name: /Finans/ }));
    await waitFor(() => expect(parentOf('Q3-rapor.xlsx')).toBe(NODE.finans));
    await waitFor(() => expect(screen.queryByRole('row', { name: /Q3-rapor\.xlsx/ })).toBeNull());
    const moved = await screen.findByText('Öğe Finans klasörüne taşındı');
    const note = moved.closest('[data-sonner-toast]');
    if (!(note instanceof HTMLElement)) throw new Error('toast not found');
    // A plain click: sonner's swipe handler wants setPointerCapture, which jsdom lacks.
    fireEvent.click(within(note).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => expect(parentOf('Q3-rapor.xlsx')).toBeNull());
    expect(await screen.findByRole('row', { name: /Q3-rapor\.xlsx/ })).toBeInTheDocument();
  });

  it('moves the whole selection onto a folder in the sidebar tree', async () => {
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp(SUNUMLAR);
    const user = userEvent.setup();
    const pdf = await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ });
    const video = screen.getByRole('row', { name: /ekran-kaydi\.mp4/ });
    await user.click(pdf);
    await user.keyboard('{Control>}');
    await user.click(video);
    await user.keyboard('{/Control}');
    dragOnto(video, await screen.findByRole('link', { name: 'Finans' }));
    await waitFor(() => expect(parentOf('milva-sunum-2026.pdf')).toBe(NODE.finans));
    expect(parentOf('ekran-kaydi.mp4')).toBe(NODE.finans);
    expect(await screen.findByText('2 öğe Finans klasörüne taşındı')).toBeInTheDocument();
  });

  it('offers the Drive menu on a sidebar tree folder and moves it from there', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await screen.findByRole('row', { name: /Finans/ });
    const finans = within(sidebarTree()).getByRole('link', { name: 'Finans' });
    await user.pointer({ keys: '[MouseRight]', target: finans });
    expect(await screen.findByRole('menuitem', { name: 'Yeni klasör' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Çöp kutusuna taşı/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /^Taşı…/ }));
    expect(await screen.findByRole('dialog', { name: 'Öğeyi taşı' })).toBeInTheDocument();
  });

  it('trashes the open folder from the sidebar tree and goes to its parent', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ });
    await user.pointer({
      keys: '[MouseRight]',
      target: within(sidebarTree()).getByRole('link', { name: 'Sunumlar' }),
    });
    await user.click(await screen.findByRole('menuitem', { name: /^Çöp kutusuna taşı/ }));
    await waitFor(() =>
      expect(db().drive!.nodes.find((n) => n.id === NODE.sunumlar)?.deletedAt).not.toBeNull(),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/drive/milvasoft'));
  });

  it('lists a folder’s files in the sidebar tree and opens one in the viewer', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Tüm içerik' });
    const file = await within(sidebarTree()).findByRole('link', { name: 'milva-sunum-2026.pdf' });
    // A leaf: no chevron to open it.
    expect(
      within(sidebarTree()).queryByRole('button', { name: /milva-sunum-2026\.pdf/ }),
    ).toBeNull();
    await user.click(file);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ preview: NODE.sunum2026 }),
    );
  });

  it('opens a page from the sidebar tree as a page, its chevron still showing the sub-pages', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    await screen.findByRole('link', { name: 'Tüm içerik' });
    const page = await within(sidebarTree()).findByRole('link', { name: 'Onboarding' });
    expect(page.getAttribute('href')).toMatch(/^\/p\/onboarding-/);
    expect(
      within(sidebarTree()).getByRole('button', { name: 'Onboarding klasörünü aç' }),
    ).toBeInTheDocument();
  });

  it('keeps the sidebar mounted from folder to folder and starts the list over', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(SUNUMLAR);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Tüm içerik' });
    const tree = sidebarTree();
    const pdf = await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ });
    await user.click(pdf);
    expect(pdf).toHaveAttribute('aria-selected', 'true');
    await user.click(within(tree).getByRole('link', { name: 'Finans' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/drive/milvasoft/folder/${NODE.finans}`),
    );
    await screen.findByRole('row', { name: /butce-2026\.xlsx/ });
    // The same tree element: no remount, so nothing in it flashes or animates again.
    expect(tree.isConnected).toBe(true);
    expect(sidebarTree()).toBe(tree);
    // Tree rows open since the first paint do not grow in again.
    expect(tree.querySelector('.tree-reveal')).toHaveAttribute('data-state', 'static');
    // The folder's own state starts over: nothing is selected in the new list.
    expect(
      screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(0);
  });

  it('keeps tree folders open while moving between folders, until folded by hand', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(`/drive/milvasoft/folder/${NODE.ikonlar}`);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Tüm içerik' });
    await within(sidebarTree()).findByRole('link', { name: 'İkonlar' });
    await user.click(within(sidebarTree()).getByRole('link', { name: 'Sunumlar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(SUNUMLAR));
    await screen.findByRole('row', { name: /milva-sunum-2026\.pdf/ });
    expect(within(sidebarTree()).getByRole('link', { name: 'İkonlar' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tasarım klasörünü kapat' }));
    await waitFor(() =>
      expect(within(sidebarTree()).queryByRole('link', { name: 'İkonlar' })).toBeNull(),
    );
  });

  it('resizes the detail panel from its edge, keeps the width and resets on double click', async () => {
    localStorage.removeItem('crewhall.paneWidths');
    clearPaneWidths();
    signedInAs(USER.bugra);
    renderApp(`/drive/milvasoft?detail=${NODE.finans}`);
    const user = userEvent.setup();
    const edge = await screen.findByRole('separator', { name: 'Paneli boyutlandır' });
    const pane = edge.parentElement!;
    expect(pane.style.getPropertyValue('--pane-w')).toBe('340px');
    edge.focus();
    // A right panel grows leftwards: ← widens it.
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(pane.style.getPropertyValue('--pane-w')).toBe('356px'));
    expect(JSON.parse(localStorage.getItem('crewhall.paneWidths')!)).toEqual({
      'drive-detail': 356,
    });
    await user.dblClick(edge);
    await waitFor(() => expect(pane.style.getPropertyValue('--pane-w')).toBe('340px'));
  });

  it('does not drop a folder into itself', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const finans = await screen.findByRole('row', { name: /Finans/ });
    expect(finans).toHaveAttribute('draggable', 'true');
    dragOnto(finans, finans);
    expect(finans).not.toHaveAttribute('data-drop-target');
    expect(parentOf('Finans')).toBeNull();
  });

  it('does not let a viewer drag', async () => {
    signedInAs(USER.burak);
    renderApp('/drive/milvasoft');
    const row = await screen.findByRole('row', { name: /Q3-rapor\.xlsx/ });
    expect(row).not.toHaveAttribute('draggable');
  });

  it('finds files from Ctrl K', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('article', { name: 'Milvasoft' }, { timeout: 8000 });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByPlaceholderText('Ara ya da komut yaz'), 'docker-compose');
    await user.click(await screen.findByRole('option', { name: /docker-compose\.yml.*milva-01/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ preview: NODE.compose }),
    );
  }, 20_000);
});

describe('public links (19.1-19.5)', () => {
  it('shows a shared file with download to someone signed out', async () => {
    renderApp(`/s/${PUBLIC_TOKEN.file}`);
    expect(await screen.findByText('milva-sunum-2026.pdf')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'İndir' })).toBeInTheDocument();
    expect(screen.getByText('Linki bilen herkes')).toBeInTheDocument();
  });

  it('asks for the password and counts the attempts left', async () => {
    renderApp(`/s/${PUBLIC_TOKEN.password}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Şifre'), 'yanlis');
    await user.click(screen.getByRole('button', { name: 'Aç' }));
    expect(await screen.findByText('Şifre yanlış. 4 deneme hakkın kaldı.')).toBeInTheDocument();
    expect(screen.queryByText('sunucu-faturasi-eylul.pdf')).toBeNull();
  });

  it('tells expired links from unknown ones', async () => {
    const expired = renderApp(`/s/${PUBLIC_TOKEN.expired}`);
    expect(
      await screen.findByRole('heading', { name: 'Bu linkin süresi doldu' }),
    ).toBeInTheDocument();
    expired.unmount();
    renderApp('/s/uydurma-link');
    expect(
      await screen.findByRole('heading', { name: 'Bu link geçerli değil' }),
    ).toBeInTheDocument();
  });

  it('lists a shared folder without going above it', async () => {
    renderApp(`/s/${PUBLIC_TOKEN.folder}`);
    expect(await screen.findByRole('heading', { name: 'Logo ve sunumlar' })).toBeInTheDocument();
    expect(await screen.findByText('marka-kilavuzu.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Q3-rapor.xlsx')).toBeNull();
  });
});
