import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/mocks/db';
import { quickState } from '@/mocks/quick';
import { LINK } from '@/mocks/quickSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const card = (name: string) => screen.findByRole('article', { name });
const cardConfig = (pred: (c: { type: string; config: Record<string, unknown> }) => boolean) =>
  db().quick!.cards.find((c) => !c.deletedAt && pred(c))!.config;

async function openHome() {
  signedInAs(USER.bugra);
  renderApp('/');
  const user = userEvent.setup();
  await card('Dokploy');
  return user;
}

/** Right click a card and read its menu. */
async function menuOf(name: string) {
  fireEvent.contextMenu(await card(name));
  return screen.findByRole('menu');
}

describe('quick access › Düzenle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('edits a single link card from its menu: name, description and health check', async () => {
    const user = await openHome();
    const menu = await menuOf('Dokploy');
    const items = within(menu).getAllByRole('menuitem');
    // First in the menu, with its shortcut.
    expect(items[0]).toHaveTextContent(/Düzenle\s*E/);
    await user.click(items[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'Linki düzenle' });
    await user.clear(within(dialog).getByLabelText('Görünen ad'));
    await user.type(within(dialog).getByLabelText('Görünen ad'), 'Dokploy paneli');
    await user.clear(within(dialog).getByLabelText(/Açıklama/));
    await user.type(within(dialog).getByLabelText(/Açıklama/), 'Prod ve test');
    const health = within(dialog).getByRole('switch', { name: 'Sağlık kontrolü' });
    const was = health.getAttribute('aria-checked') === 'true';
    await user.click(health);
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    // The card changes at once and the server has it.
    expect(await card('Dokploy paneli')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        cardConfig(
          (c) =>
            c.type === 'link' && (c.config.item as { title: string }).title === 'Dokploy paneli',
        ).item,
      ).toMatchObject({ description: 'Prod ve test' }),
    );
    const item = cardConfig(
      (c) => c.type === 'link' && (c.config.item as { title: string }).title === 'Dokploy paneli',
    ).item as { linkId: string };
    await waitFor(() =>
      expect(db().quick!.links.find((l) => l.id === item.linkId)?.checkEnabled).toBe(!was),
    );
  });

  it('moves a link card to a new address in place and gives it its own icon', async () => {
    const user = await openHome();
    const before = db().quick!.cards.find(
      (c) => c.type === 'link' && (c.config.item as { title: string }).title === 'PairDrop',
    )!;
    await user.click(within(await menuOf('PairDrop')).getByRole('menuitem', { name: /Düzenle/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Linki düzenle' });
    const address = within(dialog).getByLabelText('Adres');
    await user.clear(address);
    await user.type(address, 'drop.ornek.com');
    expect(within(dialog).getByText(/kart yeni adrese geçer/)).toBeInTheDocument();

    // A custom icon must be https.
    await user.click(within(dialog).getByRole('radio', { name: 'Özel' }));
    await user.type(within(dialog).getByLabelText('Simge adresi'), 'http://ornek.com/i.png');
    expect(within(dialog).getByText('Simge adresi https ile başlamalı.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Simge adresi'));
    await user.type(within(dialog).getByLabelText('Simge adresi'), 'https://ornek.com/i.png');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    // Same card (pins keep working), pointing at the new address's Link, with the icon.
    await waitFor(() => {
      const after = db().quick!.cards.find((c) => c.id === before.id)!;
      const item = after.config.item as { linkId: string; iconUrl?: string | null };
      expect(db().quick!.links.find((l) => l.id === item.linkId)?.url).toBe(
        'https://drop.ornek.com/',
      );
      expect(item.iconUrl).toBe('https://ornek.com/i.png');
    });
    // The card shows the new link at once, with the card's own icon.
    const shown = await card('PairDrop');
    await waitFor(() =>
      expect(shown.querySelector('img')?.getAttribute('src')).toBe('https://ornek.com/i.png'),
    );
    expect(shown.querySelector('a')?.getAttribute('href')).toBe('https://drop.ornek.com/');
  });

  it('shows an internal-network address as not checked, not as an error', async () => {
    signedInAs(USER.bugra);
    const redis = quickState().links.find((l) => l.id === LINK.redisTest)!;
    redis.checkEnabled = true;
    redis.siteTitle = null;
    redis.faviconUrl = null;
    redis.health = {
      ...redis.health,
      status: 'unknown',
      reason: 'internal',
      httpStatus: null,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
    };
    renderApp('/');
    const user = userEvent.setup();
    const tools = await card('Tools');
    const dot = within(tools).getByRole('img', {
      name: 'RedisInsight: Kontrol edilemiyor (iç ağ)',
    });
    await user.hover(dot);
    expect(await screen.findByText(/iç ağ adreslerine istek atmaz/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Şimdi dene' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Yine de aç' })).toBeInTheDocument();
  });

  it('keyboard: E edits, Enter still opens the link, Ctrl D duplicates, Del removes', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = await openHome();
    const github = await card('GitHub');
    github.focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('github'),
      '_blank',
      expect.anything(),
    );

    await user.keyboard('e');
    expect(await screen.findByRole('dialog', { name: 'Linki düzenle' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const count = () =>
      db().quick!.cards.filter(
        (c) =>
          !c.deletedAt &&
          c.type === 'link' &&
          (c.config.item as { title: string }).title === 'GitHub',
      ).length;
    (await card('GitHub')).focus();
    await user.keyboard('{Control>}d{/Control}');
    await waitFor(() => expect(count()).toBe(2));
    (await screen.findAllByRole('article', { name: 'GitHub' }))[0]!.focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(count()).toBe(1));
  });

  it('renames a to-do card and sets how many items a folder card shows', async () => {
    const user = await openHome();
    await user.click(within(await menuOf('Bu hafta')).getByRole('menuitem', { name: /Düzenle/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Kartı düzenle' });
    await user.clear(within(dialog).getByLabelText('Başlık'));
    await user.type(within(dialog).getByLabelText('Başlık'), 'Bu sprint');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    expect(await card('Bu sprint')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        db().quick!.cards.some((c) => c.type === 'todo' && c.config.title === 'Bu sprint'),
      ).toBe(true),
    );

    // A folder card: how many of its items it lists.
    await user.click(
      within(await menuOf('Logo ve sunumlar')).getByRole('menuitem', { name: /Düzenle/ }),
    );
    const folder = await screen.findByRole('dialog', { name: 'Kartı düzenle' });
    await user.click(within(folder).getByRole('combobox', { name: 'Gösterilecek öğe sayısı' }));
    await user.click(await screen.findByRole('option', { name: '5' }));
    await user.click(within(folder).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(
        db().quick!.cards.find(
          (c) => c.type === 'node' && (c.config as { maxItems?: number }).maxItems === 5,
        ),
      ).toBeTruthy(),
    );
  });

  it('shows Düzenle only where something can change; module cards open and copy', async () => {
    await openHome();
    // A single file only points at the file: open, copy, size, move, remove, no edit.
    const file = await menuOf('Q3-rapor.xlsx');
    expect(within(file).queryByRole('menuitem', { name: /Düzenle/ })).toBeNull();
    expect(within(file).getByRole('menuitem', { name: /Dosyayı aç/ })).toBeInTheDocument();
    expect(within(file).getByRole('menuitem', { name: /Linki kopyala/ })).toBeInTheDocument();
    expect(within(file).getByRole('menuitem', { name: /Kaldır/ })).toBeInTheDocument();
  });
});
