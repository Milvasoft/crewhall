import { emptyItem, toBitwardenJson, type ItemPayload } from '@crewhall/crypto';
import { screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { lock } from '@/lib/vault/session';
import { db } from '@/mocks/db';
import { vaultState } from '@/mocks/vault';
import { seedItems, setUpVault } from './support/vault';

/**
 * Bitwarden import at a real size (regression 2026-10-24: the page froze). Encryption runs in
 * chunks with a progress bar and can be cancelled before anything is written.
 */

const FOLDERS = ['Altyapı', 'Müşteriler', 'Kişisel', 'Sosyal', 'Bankacılık', 'Geliştirme'];

function exportOf(count: number) {
  return toBitwardenJson(
    Array.from({ length: count }, (_, i) => {
      const kind = i % 10;
      let payload: ItemPayload;
      if (kind === 8) {
        payload = { ...emptyItem('note', `Not ${i}`), notes: `Satır ${i}\n`.repeat(40) };
      } else if (kind === 9) {
        payload = {
          ...emptyItem('card', `Kart ${i}`),
          cardholder: 'Ahmet Buğra Kösen',
          number: `4111111111${String(100000 + i).slice(-6)}`,
          code: '123',
          expMonth: '12',
          expYear: '2029',
        };
      } else {
        payload = {
          ...emptyItem('login', `Servis ${i}`),
          username: `kisi${i}@example.com`,
          password: `Bw-${i}-Zq8!x${(i * 7919).toString(36)}`,
          uris: [`https://svc${i}.example.com/login`, `https://alt${i}.example.com`],
          totp: i % 7 === 0 ? 'JBSWY3DPEHPK3PXP' : '',
          notes: i % 3 === 0 ? `Açıklama ${i}` : '',
          fields: [{ id: `f${i}`, type: 'text', label: 'Ortam', value: 'prod' }],
        };
      }
      return { payload, folder: FOLDERS[i % FOLDERS.length]! };
    }),
  );
}

async function openWizard(count: number, before?: () => void, file = exportOf) {
  const view = await setUpVault();
  if (before) {
    before();
    await act(() => view.queryClient.invalidateQueries());
  }
  await act(() => view.router.navigate({ to: '/vault/import' }));
  const input = (await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(el).not.toBeNull();
    return el!;
  }))!;
  const json = file(count);
  await view.user.upload(
    input,
    new File([json], 'bitwarden_export.json', { type: 'application/json' }),
  );
  await view.user.click(await screen.findByRole('button', { name: 'Devam et' }));
  expect(
    await screen.findByText('Hangi öğe hangi kasaya?', {}, { timeout: 20_000 }),
  ).toBeInTheDocument();
  return view;
}

afterEach(() => lock('manual'));

describe('vault import (design 8.12-8.14)', () => {
  it('imports a 2000-item Bitwarden export in chunks with progress', async () => {
    const { user } = await openWizard(2000);
    const started = performance.now();
    await user.click(screen.getByRole('button', { name: /2\.000 öğeyi şifrele ve aktar/ }));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(
      await screen.findByText('2.000 öğe içe aktarıldı', {}, { timeout: 60_000 }),
    ).toBeInTheDocument();
    // Measured ~2 s in jsdom on a dev laptop (the page used to freeze for good).
    expect(performance.now() - started).toBeLessThan(30_000);
    const stored = vaultState(db()).items;
    expect(stored).toHaveLength(2000);
    expect(JSON.stringify(stored)).not.toContain('Servis 12');
  }, 120_000);

  it('says how many rows of the file could not be read', async () => {
    await openWizard(3, undefined, (count) => {
      const doc = JSON.parse(exportOf(count)) as { items: unknown[] };
      return JSON.stringify({ ...doc, items: [...doc.items, 'x', { type: 99, name: 'Yeni tür' }] });
    });
    expect(screen.getByText(/^Dosyadaki 2 satır okunamadı/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 öğeyi şifrele ve aktar/ })).toBeEnabled();
  }, 60_000);

  it('skips items already in the vault and can be cancelled before anything is written', async () => {
    // Same name, user name and site as the export's first logins.
    const { user } = await openWizard(1500, () =>
      seedItems(5, (i) => ({
        ...emptyItem('login', `Servis ${i}`),
        username: `kisi${i}@example.com`,
        uris: [`https://svc${i}.example.com/login`],
      })),
    );
    expect(await screen.findByText(/5 eşleşme/, {}, { timeout: 20_000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /1\.495 öğeyi şifrele ve aktar/ }));
    await user.click(await screen.findByRole('button', { name: 'İçe aktarmayı durdur' }));
    expect(
      await screen.findByText('İçe aktarma durduruldu; hiçbir öğe yazılmadı.'),
    ).toBeInTheDocument();
    expect(vaultState(db()).items).toHaveLength(5);
    // The plan is still there to run again.
    expect(screen.getByRole('button', { name: /1\.495 öğeyi şifrele ve aktar/ })).toBeEnabled();
  }, 120_000);
});
