import { Toaster } from '@crewhall/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileKind, tooLarge, versionOf } from '@/features/desktopReleases/files';
import { canOpenRoute, ROUTE_BY_ID } from '@/lib/routes/catalog';
import {
  pendingDesktopUploads,
  resetDesktopReleasesMock,
  restoreDesktopUploads,
  storedPartCounts,
} from '@/mocks/desktopReleases';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const file = (name: string, size = 2048) => new File([new Uint8Array(size)], name);

async function openPage() {
  signedInAs(USER.bugra);
  // renderApp mounts no Toaster; the publish, delete and refusal messages are toasts.
  render(<Toaster />);
  const { router } = renderApp('/admin/desktop');
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Masaüstü sürümleri' });
  // The upload card comes with the list (it needs to know the storage and the feed source).
  await screen.findByLabelText('Dosyaları buraya bırak');
  return { user, router };
}

/** A toast's text (sonner's live region may repeat it). */
const toastText = async (text: string) =>
  expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);

const dropZone = () => screen.getByLabelText('Dosyaları buraya bırak');
/** The selected file's row (data-status: uploading, paused, done, failed, cancelled). */
const stagedRow = (name: string) =>
  screen
    .getAllByRole('listitem')
    .find((li) => li.dataset.status && li.textContent?.includes(name))!;
const rowOf = async (version: string) =>
  (await within(await screen.findByRole('table')).findByText(version)).closest('tr')!;

async function openMenu(user: ReturnType<typeof userEvent.setup>, version: string) {
  await user.click(
    within(await rowOf(version)).getByRole('button', { name: `${version} işlemleri` }),
  );
}

describe('desktop release files', () => {
  it('reads the kind and the version from the file name', () => {
    expect(fileKind('Crewhall-Setup-0.2.6.exe', 'win')).toBe('installer');
    expect(fileKind('Crewhall-Setup-0.2.6.exe.blockmap', 'win')).toBe('blockmap');
    expect(fileKind('Crewhall-0.2.6-mac.zip', 'win')).toBeNull();
    expect(fileKind('Crewhall-0.2.6-mac.zip', 'mac')).toBe('update_zip');
    expect(fileKind('Crewhall-0.2.6-mac.dmg', 'mac')).toBe('dmg');
    expect(fileKind('Crewhall-0.2.6-mac.zip.blockmap', 'mac')).toBe('blockmap');
    // Names the server refuses (DesktopFileName): spaces, a leading dot, other types.
    expect(fileKind('Crewhall Setup 0.2.6.exe', 'win')).toBeNull();
    expect(fileKind('.hidden-0.2.6.exe', 'win')).toBeNull();
    expect(fileKind('notes.txt', 'mac')).toBeNull();
    expect(versionOf('Crewhall-Setup-0.2.6.exe')).toBe('0.2.6');
    expect(versionOf('Crewhall-1.0.0-beta.2-mac.zip')).toBe('1.0.0-beta.2');
    expect(versionOf('Crewhall-Setup-0.3.0.exe.blockmap')).toBe('0.3.0');
    expect(versionOf('setup.exe')).toBeNull();
    expect(tooLarge(1024 ** 3)).toBe(false);
    expect(tooLarge(1024 ** 3 + 1)).toBe(true);
  });
});

describe('Yönetim › Masaüstü sürümleri', () => {
  beforeEach(() => {
    resetDesktopReleasesMock();
  });

  it('lists the versions with the live one marked', async () => {
    await openPage();
    expect(within(await rowOf('0.2.5')).getByText('Yayında')).toBeInTheDocument();
    expect(within(await rowOf('0.2.4')).queryByText('Yayında')).toBeNull();
    expect(screen.getByText('Crewhall-Setup-0.2.4.exe.blockmap')).toBeInTheDocument();
    expect(screen.getByText(/SmartScreen/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Masaüstü sürümleri' })).toBeInTheDocument();
  });

  it('uploads the dropped files, reads the version and publishes', async () => {
    const { user } = await openPage();
    await user.upload(dropZone(), [
      file('Crewhall-Setup-0.2.6.exe', 64 * 1024),
      file('Crewhall-Setup-0.2.6.exe.blockmap'),
    ]);
    const staged = () => screen.getAllByRole('listitem').filter((li) => li.dataset.status);
    expect(staged()).toHaveLength(2);
    await waitFor(() => expect(staged().every((li) => li.dataset.status === 'done')).toBe(true));
    expect(screen.getByLabelText('Sürüm')).toHaveValue('0.2.6');
    await user.click(screen.getByRole('button', { name: 'Yayınla' }));
    await toastText('0.2.6 yayında.');
    const row = await rowOf('0.2.6');
    expect(within(row).getByText('Yayında')).toBeInTheDocument();
    expect(within(row).getByText('Crewhall-Setup-0.2.6.exe.blockmap')).toBeInTheDocument();
    expect(within(await rowOf('0.2.5')).queryByText('Yayında')).toBeNull();
  });

  it('refuses files that do not fit the platform and needs the installer to publish', async () => {
    const { user } = await openPage();
    // The picker filters by type; a drop does not, so the page checks the name itself.
    fireEvent.drop(dropZone().closest('label')!, {
      dataTransfer: { files: [file('notes.txt')] },
    });
    await toastText('notes.txt bu platform için uygun bir dosya değil.');

    await user.click(screen.getByRole('radio', { name: 'macOS' }));
    expect(await screen.findByText('Bu platform için henüz sürüm yüklenmedi.')).toBeInTheDocument();
    await user.upload(dropZone(), file('Crewhall-0.3.0-mac.dmg'));
    expect(
      await screen.findByText('Yayınlamak için .zip güncelleme arşivi gerekli.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yayınla' })).toBeDisabled();

    await user.upload(dropZone(), file('Crewhall-0.3.0-mac.zip'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yayınla' })).toBeEnabled());
    expect(screen.getByLabelText('Sürüm')).toHaveValue('0.3.0');
    await user.clear(screen.getByLabelText('Sürüm'));
    await user.type(screen.getByLabelText('Sürüm'), 'yeni');
    await user.click(screen.getByRole('button', { name: 'Yayınla' }));
    expect(screen.getByText('Sürüm 1.2.3 biçiminde olmalı.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Sürüm'));
    await user.type(screen.getByLabelText('Sürüm'), '0.3.0');
    await user.click(screen.getByRole('button', { name: 'Yayınla' }));
    const row = await rowOf('0.3.0');
    expect(within(row).getByText('Crewhall-0.3.0-mac.dmg')).toBeInTheDocument();
    expect(within(row).getByText('Yayında')).toBeInTheDocument();
  });

  it('goes back to an older version after a confirmation', async () => {
    const { user } = await openPage();
    await openMenu(user, '0.2.4');
    await user.click(await screen.findByRole('menuitem', { name: 'Bu sürümü yayınla' }));
    const dialog = await screen.findByRole('dialog', { name: '0.2.4 yayınlansın mı?' });
    await user.click(within(dialog).getByRole('button', { name: 'Yayınla' }));
    await waitFor(async () =>
      expect(within(await rowOf('0.2.4')).getByText('Yayında')).toBeInTheDocument(),
    );
  });

  it('deletes an old version, keeping its blockmap unless asked, never the live one', async () => {
    const { user } = await openPage();
    await openMenu(user, '0.2.5');
    expect(
      await screen.findByRole('menuitem', { name: 'Yayındaki sürüm silinemez' }),
    ).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');

    await openMenu(user, '0.2.4');
    await user.click(await screen.findByRole('menuitem', { name: 'Sil' }));
    let dialog = await screen.findByRole('dialog', { name: '0.2.4 silinsin mi?' });
    const keepBlockmaps = within(dialog).getByRole('checkbox', {
      name: 'Blockmap dosyalarını da sil',
    });
    expect(keepBlockmaps).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Sil' }));
    await toastText('0.2.4 silindi.');
    // The installer is gone; the blockmap stays for differential updates.
    await waitFor(() => expect(screen.queryByText('Crewhall-Setup-0.2.4.exe')).toBeNull());
    expect(screen.getByText('Crewhall-Setup-0.2.4.exe.blockmap')).toBeInTheDocument();

    await openMenu(user, '0.2.4');
    await user.click(await screen.findByRole('menuitem', { name: 'Sil' }));
    dialog = await screen.findByRole('dialog', { name: '0.2.4 silinsin mi?' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Blockmap dosyalarını da sil' }));
    await user.click(within(dialog).getByRole('button', { name: 'Sil' }));
    await waitFor(() => expect(screen.queryByText('Crewhall-Setup-0.2.4.exe.blockmap')).toBeNull());
  });

  it('explains a 413 from a proxy in front of the store', async () => {
    resetDesktopReleasesMock({ proxyLimit: 32 * 1024 });
    const { user } = await openPage();
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe', 64 * 1024));
    await waitFor(() =>
      expect(screen.getAllByRole('listitem').some((li) => li.dataset.status === 'failed')).toBe(
        true,
      ),
    );
    expect(
      (await screen.findAllByText(/Crewhall-Setup-0\.2\.6\.exe yüklenemedi: .*Cloudflare.*\(413\)/))
        .length,
    ).toBeGreaterThan(0);
  });

  it('uploads in parts, each under the proxy limit', async () => {
    // 64 KB in 16 KB parts behind a 32 KB proxy: no part is refused.
    resetDesktopReleasesMock({ partSize: 16 * 1024, proxyLimit: 32 * 1024 });
    const { user } = await openPage();
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe', 64 * 1024));
    await waitFor(() => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('done'));
    expect(storedPartCounts()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
    expect(pendingDesktopUploads()).toBe(0);
  });

  it('pauses when the connection drops and continues with the missing parts only', async () => {
    resetDesktopReleasesMock({ partSize: 16 * 1024, dropParts: [3] });
    const { user } = await openPage();
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe', 64 * 1024));
    await waitFor(
      () => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('paused'),
      { timeout: 5000 },
    );
    const row = stagedRow('Crewhall-Setup-0.2.6.exe');
    expect(within(row).getByText(/Bağlantı koptu/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yayınla' })).toBeDisabled();

    restoreDesktopUploads();
    await user.click(
      within(row).getByRole('button', { name: 'Crewhall-Setup-0.2.6.exe yüklemesine devam et' }),
    );
    await waitFor(() => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('done'));
    // Parts 1 and 2 were not sent again.
    expect(storedPartCounts()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
    await user.click(screen.getByRole('button', { name: 'Yayınla' }));
    expect(within(await rowOf('0.2.6')).getByText('64 KB')).toBeInTheDocument();
  });

  it('continues after leaving the page: the same file again sends only the missing parts', async () => {
    resetDesktopReleasesMock({ partSize: 16 * 1024, dropParts: [3] });
    const { user, router } = await openPage();
    const installer = file('Crewhall-Setup-0.2.6.exe', 64 * 1024);
    await user.upload(dropZone(), installer);
    await waitFor(
      () => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('paused'),
      { timeout: 5000 },
    );
    // Leaving keeps the unfinished upload on the server (a cancel would drop it).
    await act(() => router.navigate({ to: '/' }));
    expect(pendingDesktopUploads()).toBe(1);

    restoreDesktopUploads();
    await act(() => router.navigate({ to: '/admin/desktop' }));
    await user.upload(await screen.findByLabelText('Dosyaları buraya bırak'), installer);
    await waitFor(() => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('done'));
    expect(storedPartCounts()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
    expect(pendingDesktopUploads()).toBe(0);
  });

  it('cancelling a paused upload drops it on the server', async () => {
    resetDesktopReleasesMock({ partSize: 16 * 1024, dropParts: [2] });
    const { user } = await openPage();
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe', 64 * 1024));
    await waitFor(
      () => expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('paused'),
      { timeout: 5000 },
    );
    expect(pendingDesktopUploads()).toBe(1);
    await user.click(
      screen.getByRole('button', { name: 'Crewhall-Setup-0.2.6.exe yüklemesini iptal et' }),
    );
    expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('cancelled');
    await waitFor(() => expect(pendingDesktopUploads()).toBe(0));
  });

  it('says so when the bucket CORS hides the ETag', async () => {
    resetDesktopReleasesMock({ hideEtag: true });
    const { user } = await openPage();
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe'));
    await waitFor(() =>
      expect(stagedRow('Crewhall-Setup-0.2.6.exe').dataset.status).toBe('failed'),
    );
    expect((await screen.findAllByText(/ExposeHeaders: ETag/)).length).toBeGreaterThan(0);
  });

  it('cannot publish a platform the server serves from its folder', async () => {
    resetDesktopReleasesMock({ folder: ['win'] });
    const { user } = await openPage();
    expect(await screen.findByText(/sunucudaki klasörden/)).toBeInTheDocument();
    await openMenu(user, '0.2.4');
    expect(await screen.findByRole('menuitem', { name: 'Bu sürümü yayınla' })).toHaveAttribute(
      'data-disabled',
    );
    await user.keyboard('{Escape}');
    await user.upload(dropZone(), file('Crewhall-Setup-0.2.6.exe'));
    await waitFor(() =>
      expect(screen.getAllByRole('listitem').some((li) => li.dataset.status === 'done')).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'Yayınla' })).toBeDisabled();
  });

  it('says so when the server has no S3 storage', async () => {
    resetDesktopReleasesMock({ storage: false, seed: false });
    await openPage();
    expect(
      await screen.findByText('Bu sunucuda S3 depolama ayarlı değil; masaüstü sürümü yüklenemez.'),
    ).toBeInTheDocument();
    expect(dropZone()).toBeDisabled();
  });

  it('is for the install admin only', async () => {
    signedInAs(USER.mert);
    const { router } = renderApp('/admin/desktop');
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/admin/desktop'));
    const page = ROUTE_BY_ID['admin.desktop'];
    const viewer = { role: 'owner' as const, modules: new Set<never>(), can: () => true };
    expect(canOpenRoute(page, viewer)).toBe(false);
    expect(canOpenRoute(page, { ...viewer, installAdmin: true })).toBe(true);
  });
});
