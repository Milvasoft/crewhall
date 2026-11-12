import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { lock } from '@/lib/vault/session';
import { normalizeTags } from '@/lib/vault/items';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Item tags: edited in the form, stored encrypted, listed and filtered in the sidebar. */

const PASSWORD = 'kayısı-pusula-fener-yelken-41';

async function setUpVault() {
  signedInAs(USER.bugra);
  renderApp('/vault');
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Kasa şifreni oluştur' });
  await user.type(screen.getByLabelText('Kasa şifresi'), PASSWORD);
  await user.type(screen.getByLabelText('Kasa şifresi tekrar'), PASSWORD);
  const continueButton = screen.getByRole('button', { name: /Devam et/ });
  await waitFor(() => expect(continueButton).toBeEnabled());
  await user.click(continueButton);
  await screen.findByRole('heading', { name: 'Kurtarma anahtarını sakla' }, { timeout: 15_000 });
  await user.click(screen.getByLabelText('Kurtarma anahtarımı güvenli bir yere kaydettim'));
  await user.click(screen.getByRole('button', { name: 'Kasayı aç' }));
  await screen.findByText('Kasan hazır, henüz boş');
  return user;
}

async function createNote(user: ReturnType<typeof userEvent.setup>, name: string, tags: string) {
  await user.click(screen.getAllByRole('button', { name: /Yeni öğe/ })[0]!);
  await user.click(await screen.findByRole('button', { name: /^Güvenli not/ }));
  await user.type(await screen.findByLabelText('Ad'), name);
  if (tags) await user.type(screen.getByRole('combobox', { name: 'Etiketler' }), tags);
  await user.click(screen.getByRole('button', { name: /Kaydet/ }));
  return screen.findByRole('article', { name });
}

afterEach(() => lock('manual'));

describe('normalizeTags', () => {
  it('trims, drops empties and case-insensitive duplicates', () => {
    expect(normalizeTags([' Agro ', '', 'agro', 'AWS', 'İzmir', 'izmir'])).toEqual([
      'Agro',
      'AWS',
      'İzmir',
    ]);
  });
});

describe('vault tags', () => {
  it('saves tags encrypted, lists them in the sidebar and filters by one', async () => {
    const user = await setUpVault();
    const first = await createNote(user, 'Agro Jenkins', 'Agro,Sunucu{Enter}');
    expect(within(first).getByRole('button', { name: '#Agro' })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: '#Sunucu' })).toBeInTheDocument();
    await createNote(user, 'Opsiyon S3', 'Opsiyon{Enter}');

    // The server only sees ciphertext.
    expect(JSON.stringify(vaultState(db()).items)).not.toContain('Sunucu');

    const sidebar = screen.getByRole('complementary', { name: 'Kasa menüsü' });
    expect(await within(sidebar).findByText('Etiketler')).toBeInTheDocument();
    await user.click(within(sidebar).getByRole('link', { name: /Agro/ }));
    const list = screen.getByRole('region', { name: 'Öğeler' });
    await waitFor(() => expect(within(list).queryByText('Opsiyon S3')).toBeNull());
    expect(within(list).getByText('Agro Jenkins')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Etiket süzmesini kaldır' }));
    expect(await within(list).findByText('Opsiyon S3')).toBeInTheDocument();
  }, 60_000);
});
