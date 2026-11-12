import { emptyItem, encryptItem, newId, type ItemPayload } from '@crewhall/crypto';
import { toast, Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { lock, vaultKeyFor } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { mailMockState } from '@/mocks/mail';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Right-click menus of the vault item list and the mail message list. */

const PASSWORD = 'kayısı-pusula-fener-yelken-41';
const SECRET = 'R0uter-Gizli-Deger!9';

const names = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent?.trim() ?? '');

async function setUpVault() {
  signedInAs(USER.bugra);
  const view = renderApp('/vault');
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Kasa şifreni oluştur' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
  await user.type(screen.getByLabelText('Kasa şifresi tekrar'), PASSWORD);
  const continueButton = screen.getByRole('button', { name: /Devam et/ });
  await waitFor(() => expect(continueButton).toBeEnabled());
  await user.click(continueButton);
  await screen.findByRole('heading', { name: 'Kurtarma anahtarını sakla' }, { timeout: 15_000 });
  await user.click(screen.getByLabelText('Kurtarma anahtarımı güvenli bir yere kaydettim'));
  await user.click(screen.getByRole('button', { name: 'Kasayı aç' }));
  expect(await screen.findByText('Kasan hazır, henüz boş')).toBeInTheDocument();
  return { ...view, user };
}

function seed(items: ItemPayload[]) {
  const v = vaultState(db());
  const vault = v.vaults.find((x) => x.kind === 'personal' && x.ownerUserId === USER.bugra)!;
  const member = v.members.find((m) => m.vaultId === vault.id && m.userId === USER.bugra)!;
  const key = vaultKeyFor({ ...vault, myWrappedKey: member.wrappedKey });
  const at = new Date().toISOString();
  return items.map((payload) => {
    const id = newId();
    const ctx = { vaultId: vault.id, itemId: id, revision: 1, keyVersion: vault.keyVersion };
    v.items.push({
      id,
      vaultId: vault.id,
      type: payload.type,
      revision: 1,
      keyVersion: vault.keyVersion,
      ...encryptItem(key, { ...ctx, type: payload.type }, payload),
      createdBy: USER.bugra,
      updatedBy: USER.bugra,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedBy: null,
      attachments: [],
      revisions: [],
    });
    return { id, vaultId: vault.id };
  });
}

const vaultRow = async (name: string) => {
  const list = await screen.findByRole('region', { name: 'Öğeler' });
  return (await within(list).findByText(name)).closest<HTMLElement>('[role="button"]')!;
};

describe('vault item list › right-click menu', () => {
  afterEach(() => lock('manual'));

  it('copies, trashes and restores an item from its row', async () => {
    const { user, queryClient, router } = await setUpVault();
    const [router1] = seed([
      { ...emptyItem('login', 'Eski Router'), username: 'admin', password: SECRET },
      { ...emptyItem('login', 'Parolasız'), username: 'misafir' },
    ]);
    await act(() => queryClient.invalidateQueries());
    await act(() =>
      router.navigate({
        to: '/vault/$vaultId/$category',
        params: { vaultId: router1!.vaultId, category: 'all' },
      }),
    );

    fireEvent.contextMenu(await vaultRow('Eski Router'));
    let menu = await screen.findByRole('menu');
    await within(menu).findByRole('menuitem', { name: 'Şifreyi kopyala' });
    expect(names(menu)).toEqual([
      'Aç',
      'Kullanıcı adını kopyala',
      'Şifreyi kopyala',
      'Sürüm geçmişi',
      'Link ile paylaş',
      'Başka kasaya taşı',
      'Çöpe taşı',
    ]);
    // The password is decrypted only for the copy, and the clipboard holds exactly it.
    await user.click(within(menu).getByRole('menuitem', { name: 'Şifreyi kopyala' }));
    const copied = await navigator.clipboard.readText();
    expect(copied === SECRET).toBe(true);

    // A login without a password offers no password copy.
    fireEvent.contextMenu(await vaultRow('Parolasız'));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Kullanıcı adını kopyala' })).toBeVisible();
    expect(within(menu).queryByRole('menuitem', { name: 'Şifreyi kopyala' })).toBeNull();
    await user.keyboard('{Escape}');

    // Trash from the row: the server marks it deleted and the row leaves "Tümü".
    fireEvent.contextMenu(await vaultRow('Eski Router'));
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Çöpe taşı' }));
    await waitFor(() =>
      expect(vaultState(db()).items.find((i) => i.id === router1!.id)?.deletedAt).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Öğeler' })).queryByText('Eski Router'),
      ).toBeNull(),
    );

    // In the trash: restore and purge (the owner manages the personal vault).
    await act(() =>
      router.navigate({
        to: '/vault/$vaultId/$category',
        params: { vaultId: router1!.vaultId, category: 'trash' },
      }),
    );
    fireEvent.contextMenu(await vaultRow('Eski Router'));
    menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual(['Aç', 'Geri yükle', 'Kalıcı sil']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Geri yükle' }));
    await waitFor(() =>
      expect(vaultState(db()).items.find((i) => i.id === router1!.id)?.deletedAt).toBeNull(),
    );
  }, 90_000);
});

const inbox = () => mailMockState(db()).folders[USER.bugra]!.find((f) => f.path === 'INBOX')!;
const message = (uid: number) => inbox().messages.find((m) => m.uid === uid)!;

async function openInbox() {
  signedInAs(USER.bugra);
  render(<Toaster />);
  renderApp('/mail');
  const list = await screen.findByRole('region', { name: 'İletiler' });
  await within(list).findByText('Haftalık sunucu raporu');
  return list;
}

const mailRow = (list: HTMLElement, subject: string) =>
  within(list).getByText(subject).closest<HTMLElement>('.group')!;

describe('mail message list › right-click menu', () => {
  afterEach(() => toast.dismiss());

  it('offers the row actions, flags a message and replies from the list', async () => {
    const list = await openInbox();
    const user = userEvent.setup();

    fireEvent.contextMenu(mailRow(list, 'Haftalık sunucu raporu'));
    let menu = await screen.findByRole('menu');
    expect(names(menu)).toEqual([
      'Aç',
      'Yeni sekmede aç',
      'Yanıtla',
      'Tümünü yanıtla',
      'İlet',
      'Okunmadı olarak işaretle',
      'Bayrak koy',
      'Taşı',
      'Sil',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Bayrak koy' }));
    await waitFor(() => expect(message(1).flagged).toBe(true));

    // Flagged now: the same menu offers to take it off.
    fireEvent.contextMenu(mailRow(list, 'Haftalık sunucu raporu'));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Bayrağı kaldır' })).toBeVisible();

    await user.click(within(menu).getByRole('menuitem', { name: 'Yanıtla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yanıtla' });
    expect(within(dialog).getByLabelText('Konu')).toHaveValue('YNT: Haftalık sunucu raporu');
  });

  it('moves one row through the folder submenu', async () => {
    const list = await openInbox();
    const user = userEvent.setup();
    fireEvent.contextMenu(mailRow(list, 'Haftalık sunucu raporu'));
    const menu = await screen.findByRole('menu');
    // Open the submenu from the keyboard, then pick the folder (a moving pointer would leave
    // the trigger and close the submenu in jsdom).
    within(menu).getByRole('menuitem', { name: 'Taşı' }).focus();
    await user.keyboard('{ArrowRight}');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Arşiv' }));
    await waitFor(() =>
      expect(
        mailMockState(db())
          .folders[USER.bugra]!.find((f) => f.path === 'Archive')!
          .messages.map((m) => m.subject),
      ).toEqual(['Haftalık sunucu raporu']),
    );
    await waitFor(() => expect(within(list).queryByText('Haftalık sunucu raporu')).toBeNull());
  });

  it('acts on the selection when the right-clicked row is in it', async () => {
    const list = await openInbox();
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole('checkbox', { name: 'Bülten: Ekim sayısı iletisini seç' }),
    );
    await user.click(
      within(list).getByRole('checkbox', { name: 'Teklif ve sözleşme taslağı iletisini seç' }),
    );

    fireEvent.contextMenu(mailRow(list, 'Teklif ve sözleşme taslağı'));
    const menu = await screen.findByRole('menu');
    // Bulk: no open or reply; the shortcut works on the selection, so it is shown.
    expect(names(menu)).toEqual(['Okundu olarak işaretleShift I', 'Bayrak koy', 'Taşı', 'Sil']);
    await user.click(within(menu).getByRole('menuitem', { name: /Okundu olarak işaretle/ }));
    await waitFor(() => expect([message(2).seen, message(3).seen]).toEqual([true, true]));

    // A row outside the selection gets its own menu.
    fireEvent.contextMenu(mailRow(list, 'Haftalık sunucu raporu'));
    expect(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Aç' }),
    ).toBeVisible();
  });
});
