import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type CardConfigOf } from '@/features/quick/context';
import { moveLink, moveSection } from '@/features/quick/GroupSections';
import { db } from '@/mocks/db';
import { quickState } from '@/mocks/quick';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const card = (name: string) => screen.findByRole('article', { name });

type Section = { id: string; title: string; items: { id: string; title: string }[] };
const groupConfig = (title: string) =>
  db().quick!.cards.find(
    (c) =>
      c.type === 'link_group' && !c.deletedAt && (c.config as { title: string }).title === title,
  )!.config as { sections: Section[]; showHealth: boolean };

async function openSettings(title: string) {
  const user = userEvent.setup();
  await card(title);
  // The card menu sits on the card in edit mode.
  await user.click(screen.getByRole('button', { name: 'Düzenle' }));
  const group = await card(title);
  await user.click(within(group).getByRole('button', { name: `${title} kartının menüsü` }));
  await user.click(await screen.findByRole('menuitem', { name: /Düzenle/ }));
  return { user, panel: await screen.findByRole('complementary', { name: 'Kart ayarları' }) };
}

describe('link group settings', () => {
  it('preselects the sub-section "Link ekle" was pressed under', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const { user, panel } = await openSettings('Tools');
    await user.click(within(panel).getByRole('button', { name: 'Prod bölümünü aç ya da kapat' }));
    const prod = within(panel).getAllByRole('button', { name: 'Link ekle' }).at(-1)!;
    await user.click(prod);
    const dialog = await screen.findByRole('dialog', { name: 'Link ekle' });
    expect(within(dialog).getByRole('radio', { name: 'Prod' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('edits a link: name and sub-section', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const { user, panel } = await openSettings('Tools');
    await user.click(within(panel).getByRole('button', { name: 'Seq linkini düzenle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Linki düzenle' });
    const name = within(dialog).getByLabelText('Görünen ad');
    await user.clear(name);
    await user.type(name, 'Seq (test)');
    await user.click(within(dialog).getByRole('combobox', { name: 'Alt bölüm' }));
    await user.click(await screen.findByRole('option', { name: 'Prod' }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      const [test, prod] = groupConfig('Tools').sections;
      expect(test!.items.some((i) => i.title === 'Seq (test)')).toBe(false);
      expect(prod!.items.at(-1)?.title).toBe('Seq (test)');
    });
  });

  it("gives a group's link its own https icon, and back to the site's", async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const { user, panel } = await openSettings('Tools');
    await user.click(within(panel).getByRole('button', { name: 'pgAdmin linkini düzenle' }));
    let dialog = await screen.findByRole('dialog', { name: 'Linki düzenle' });
    await user.click(within(dialog).getByRole('radio', { name: 'Özel' }));
    await user.type(within(dialog).getByLabelText('Simge adresi'), 'http://ornek.com/pg.png');
    expect(within(dialog).getByText('Simge adresi https ile başlamalı.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Simge adresi'));
    await user.type(within(dialog).getByLabelText('Simge adresi'), 'https://ornek.com/pg.png');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    const row = () =>
      groupConfig('Tools').sections[0]!.items.find((i) => i.title === 'pgAdmin') as
        { iconUrl?: string | null } | undefined;
    await waitFor(() => expect(row()?.iconUrl).toBe('https://ornek.com/pg.png'));

    // Back to the site's icon.
    await user.click(within(panel).getByRole('button', { name: 'pgAdmin linkini düzenle' }));
    dialog = await screen.findByRole('dialog', { name: 'Linki düzenle' });
    expect(within(dialog).getByLabelText('Simge adresi')).toHaveValue('https://ornek.com/pg.png');
    await user.click(within(dialog).getByRole('radio', { name: 'Sitenin simgesi' }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(row()?.iconUrl ?? null).toBeNull());
  });

  it("shows every link's health when the group asks for it, grey while unchecked", async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const group = await card('Milvasoft');
    // Green links get a dot too (before, only warn/down did and the setting looked dead).
    expect(
      within(group).getAllByRole('img', {
        name: /: (Erişilebilir|Kontrol edilmiyor|Henüz kontrol edilmedi|Erişilemiyor|Uyarı|Yavaş yanıt)/,
      }).length,
    ).toBe(7);
  });

  it("turning health on switches the group's unchecked links on", async () => {
    signedInAs(USER.bugra);
    for (const l of quickState().links) l.checkEnabled = false;
    renderApp('/');
    const { user, panel } = await openSettings('Milvasoft');
    const toggle = within(panel).getByRole('switch', { name: 'Sağlık durumunu göster' });
    await user.click(toggle); // off
    await user.click(toggle); // on again
    // Only this group's links: the Tools group (also *.milvasoft.com) stays as it was.
    const ids = new Set(
      groupConfig('Milvasoft').sections.flatMap((x) =>
        x.items.map((it) => (it as unknown as { linkId: string }).linkId),
      ),
    );
    await waitFor(() =>
      expect(
        quickState()
          .links.filter((l) => ids.has(l.id))
          .every((l) => l.checkEnabled),
      ).toBe(true),
    );
  });

  it('sets the card size: rows, icons and text follow it', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const { user, panel } = await openSettings('Milvasoft');
    await user.click(within(panel).getByRole('radio', { name: 'Büyük' }));
    await waitFor(() =>
      expect((groupConfig('Milvasoft') as { density?: string }).density).toBe('large'),
    );
    const row = within(await card('Milvasoft')).getByRole('link', { name: /Azure DevOps/ });
    expect(row).toHaveClass('h-12');
  });

  it('has a drag handle for each sub-section and link', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const { panel } = await openSettings('Tools');
    expect(
      within(panel).getByRole('button', { name: 'Test alt bölümünü taşı' }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Prod alt bölümünü taşı' }),
    ).toBeInTheDocument();
    expect(
      within(panel).getAllByRole('button', { name: 'Seq linkini taşı' }).length,
    ).toBeGreaterThan(0);
  });
});

describe('link group reorder', () => {
  const sections: CardConfigOf<'link_group'>['sections'] = [
    {
      id: 'a',
      title: 'Test',
      items: [
        { id: '1', linkId: 'l1', title: 'Seq', description: null },
        { id: '2', linkId: 'l2', title: 'pgAdmin', description: null },
      ],
    },
    {
      id: 'b',
      title: 'Prod',
      items: [{ id: '3', linkId: 'l3', title: 'Redis', description: null }],
    },
  ];
  const titles = (s: CardConfigOf<'link_group'>['sections']) =>
    s.map((x) => x.items.map((i) => i.title).join(','));

  it('reorders within a sub-section', () => {
    expect(titles(moveLink(sections, '2', 'a', 0))).toEqual(['pgAdmin,Seq', 'Redis']);
  });

  it('moves a link to another sub-section at a position or the end', () => {
    expect(titles(moveLink(sections, '1', 'b', 0))).toEqual(['pgAdmin', 'Seq,Redis']);
    expect(titles(moveLink(sections, '1', 'b', -1))).toEqual(['pgAdmin', 'Redis,Seq']);
  });

  it('reorders sub-sections', () => {
    expect(moveSection(sections, 'b', 0).map((s) => s.title)).toEqual(['Prod', 'Test']);
  });
});
