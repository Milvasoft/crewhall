import type { Editor } from '@tiptap/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { api } from '@/lib/api';
import { db } from '@/mocks/db';
import { SURFACE } from '@/mocks/quickSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

const card = (name: string) => screen.findByRole('article', { name });

describe('quick access (design 02)', () => {
  it('shows the personal surface and saves a ticked to-do', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    const group = await card('Milvasoft');
    expect(within(group).getByText('Azure DevOps')).toBeInTheDocument();
    const todo = await card('Bu hafta');
    expect(within(todo).getByText('2 / 5')).toBeInTheDocument();
    await user.click(within(todo).getByRole('checkbox', { name: "Portal'ı Hub'a taşı" }));
    await waitFor(() => {
      const saved = db().quick!.cards.find((c) => c.config.title === 'Bu hafta')!;
      const items = saved.config.items as { text: string; done: boolean }[];
      expect(items.find((i) => i.text === "Portal'ı Hub'a taşı")?.done).toBe(true);
    });
  });

  it('edits a to-do item in place: Enter saves, Escape cancels, empty deletes', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    const todo = await card('Bu hafta');
    const texts = () =>
      (
        db().quick!.cards.find((c) => c.config.title === 'Bu hafta')!.config.items as {
          text: string;
        }[]
      ).map((i) => i.text);

    await user.click(
      within(todo).getByRole('button', { name: '"Dumpapp test ortamı SSL" maddesini düzenle' }),
    );
    const field = within(todo).getByRole('textbox', { name: /Madde metni/ });
    await user.clear(field);
    await user.type(field, 'Dumpapp SSL sertifikası{Enter}');
    await waitFor(() => expect(texts()).toContain('Dumpapp SSL sertifikası'));
    expect(texts()).not.toContain('Dumpapp test ortamı SSL');

    await user.click(
      within(todo).getByRole('button', { name: '"Dumpapp SSL sertifikası" maddesini düzenle' }),
    );
    await user.type(within(todo).getByRole('textbox', { name: /Madde metni/ }), 'xyz{Escape}');
    expect(within(todo).queryByRole('textbox', { name: /Madde metni/ })).toBeNull();
    expect(texts()).toContain('Dumpapp SSL sertifikası');

    await user.click(
      within(todo).getByRole('button', { name: `"Selin'in PR'ını incele" maddesini düzenle` }),
    );
    await user.clear(within(todo).getByRole('textbox', { name: /Madde metni/ }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(texts()).not.toContain("Selin'in PR'ını incele"));
  });

  it('adds a link card from the gallery with the fetched title', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await card('Milvasoft');
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    const gallery = await screen.findByRole('complementary', { name: 'Kart ekle' });
    await user.click(within(gallery).getByRole('button', { name: /^Link\s*Tek site/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Link ekle' });
    await user.type(within(dialog).getByLabelText('Adres'), 'grafana.com');
    await waitFor(() => expect(within(dialog).getByLabelText('Görünen ad')).toHaveValue('Grafana'));
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    expect(await card('Grafana')).toBeInTheDocument();
    const surface = db().quick!.cards.filter((c) => c.surfaceId === SURFACE.bugra && !c.deletedAt);
    expect(
      surface.some((c) => (c.config.item as { title?: string } | undefined)?.title === 'Grafana'),
    ).toBe(true);
  });

  it('lets a viewer pin a space card but not edit the space surface', async () => {
    signedInAs(USER.burak);
    renderApp('/?surface=milvasoft');
    const user = userEvent.setup();
    expect(await screen.findByText(/Yalnız görüntüleyebilirsin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Düzenle' })).toBeNull();
    const rules = await card('Ekip kuralları');
    await user.pointer({ keys: '[MouseRight]', target: rules });
    await user.click(await screen.findByRole('menuitem', { name: 'Benim yüzeyime sabitle' }));
    await waitFor(() =>
      expect(db().quick!.cards.some((c) => c.pinnedFrom && !c.deletedAt)).toBe(true),
    );
  });

  it('falls back to the welcome screen while the API does not serve surfaces', async () => {
    server.use(
      http.get('*/api/v1/surfaces', () =>
        HttpResponse.json({ code: 'not_implemented', message: 'later' }, { status: 501 }),
      ),
    );
    signedInAs(USER.bugra);
    renderApp('/');
    expect(await screen.findByText("Space'lerin")).toBeInTheDocument();
  });
});

describe('quick notes on the block editor', () => {
  const rects = {
    range: Range.prototype.getBoundingClientRect,
    rangeList: Range.prototype.getClientRects,
    el: Element.prototype.getClientRects,
  };
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  beforeAll(() => {
    // jsdom has no layout; the editor's menus ask for rectangles.
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = noRects;
    Element.prototype.getClientRects = noRects;
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = rects.range;
    Range.prototype.getClientRects = rects.rangeList;
    Element.prototype.getClientRects = rects.el;
  });

  it('shows the note as blocks and saves an edit as line-based text', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const note = await card('Not');
    const body = within(note).getByRole('group', { name: 'Not metni' });
    const dom = await waitFor(() => {
      const el = body.querySelector<HTMLElement & { editor?: Editor }>('.ProseMirror');
      expect(el?.editor).toBeTruthy();
      return el!;
    });
    expect(dom).toHaveTextContent("Prod deploy'dan önce Seq'te hata oranına bak.");
    expect(dom.getAttribute('contenteditable')).toBe('true');

    // Opening the note writes nothing; an edit saves the text with one block per line.
    const before = db().quick!.cards.find(
      (c) => c.type === 'note' && c.config.fontSize === 'large',
    )!;
    fireEvent.mouseDown(body);
    act(() => {
      dom
        .editor!.chain()
        .focus('end')
        .insertContentAt(dom.editor!.state.doc.content.size, {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seq panosu' }] }],
            },
          ],
        })
        .run();
    });
    await waitFor(
      () => {
        const saved = db().quick!.cards.find((c) => c.id === before.id)!;
        expect(saved.config.text).toBe(
          "Prod deploy'dan önce Seq'te hata oranına bak. Cuma 17:00'den sonra deploy yok.\n- [ ] Seq panosu",
        );
      },
      { timeout: 3000 },
    );
  });
});

describe('module cards (H4)', () => {
  /** Opens the gallery in edit mode and clicks a card type. */
  async function addFromGallery(user: ReturnType<typeof userEvent.setup>, kind: RegExp) {
    await card('Milvasoft');
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    const gallery = await screen.findByRole('complementary', { name: 'Kart ekle' });
    expect(within(gallery).queryByText('Yakında')).toBeNull();
    await user.click(within(gallery).getByRole('button', { name: kind }));
  }

  it('adds a page card from the picker and shows its preview', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await addFromGallery(user, /^Sayfa\s*Önizlemeli/);
    const dialog = await screen.findByRole('dialog', { name: 'Sayfa seç' });
    await user.type(within(dialog).getByLabelText('Ara'), 'Milvaion');
    await user.click(await within(dialog).findByRole('option', { name: /Milvaion/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    const page = await card('Milvaion');
    expect(await within(page).findByText('Dağıtık iş zamanlayıcısı.')).toBeInTheDocument();
    expect(db().quick!.cards.at(-1)).toMatchObject({ type: 'page' });
  });

  it('shows a page with to-dos as a checkable list on its card', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    const spaceId = (await api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    const page = await api.call('createPage', {
      params: { spaceId },
      body: { name: 'Alışveriş', markdown: 'Pazar için\n\n- [ ] Süt\n- [x] Ekmek\n' },
    });
    await addFromGallery(user, /^Sayfa\s*Önizlemeli/);
    const dialog = await screen.findByRole('dialog', { name: 'Sayfa seç' });
    await user.type(within(dialog).getByLabelText('Ara'), 'Alışveriş');
    await user.click(await within(dialog).findByRole('option', { name: /Alışveriş/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    await user.click(screen.getByRole('button', { name: 'Bitti' }));
    const shown = await card('Alışveriş');
    const milk = await within(shown).findByRole('checkbox', { name: 'Süt' });
    expect(milk).not.toBeChecked();
    expect(within(shown).getByRole('checkbox', { name: 'Ekmek' })).toBeChecked();
    expect(within(shown).getByText('1 / 2')).toBeInTheDocument();
    expect(within(shown).getByText('Pazar için')).toBeInTheDocument();

    await user.click(milk);
    await waitFor(() => expect(within(shown).getByText('2 / 2')).toBeInTheDocument());
    await waitFor(async () => {
      const { markdown } = await api.call('getPageContent', {
        params: { nodeId: page.id },
        query: { format: 'markdown' },
      });
      expect(markdown).toContain('- [x] Süt');
    });
  });

  it('adds a chat card and sends a quick reply from it', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await addFromGallery(user, /^Sohbet\s*Son mesajlar/);
    const dialog = await screen.findByRole('dialog', { name: 'Sohbet seç' });
    await user.dblClick(await within(dialog).findByRole('option', { name: /^Milvaion Ekibi/ }));
    await user.click(screen.getByRole('button', { name: 'Bitti' }));
    const chat = await card('Milvaion Ekibi');
    const reply = await within(chat).findByRole('textbox', {
      name: 'Milvaion Ekibi sohbetine yanıt yaz',
    });
    await user.type(reply, 'Karttan yanıt{Enter}');
    await waitFor(() =>
      expect(chatState(db()).messages.some((m) => m.text === 'Karttan yanıt')).toBe(true),
    );
  });

  it('shows the next meeting with a join button', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await addFromGallery(user, /^Toplantı\s*Sıradaki/);
    await user.click(screen.getByRole('button', { name: 'Bitti' }));
    const meeting = await card('Opsiyon · ürün demosu');
    expect(within(meeting).getByText('Sıradaki')).toBeInTheDocument();
    await user.click(within(meeting).getByRole('button', { name: 'Katıl' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/meetings/room/opsiyon-demo-7k2xq'),
    );
  });

  it('keeps a vault card closed while the vault is locked', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await addFromGallery(user, /^Kasa öğesi\s*Tek tıkla kopyala/);
    const dialog = await screen.findByRole('dialog', { name: 'Kasa öğesi seç' });
    expect(within(dialog).getByText(/Kasa öğesi eklemek için önce kasanı aç/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Kasayı aç' })).toHaveAttribute(
      'href',
      '/vault',
    );
  });

  it('hides a card and its gallery entry while its module is off', async () => {
    signedInAs(USER.bugra);
    const { items } = await api.call('listSurfaces');
    await api.call('createCard', {
      params: { surfaceId: items[0]!.id },
      body: { type: 'chat', config: { conversationId: CONV.milvaion } },
    });
    db().org!.settings.modules = { chat: false };
    renderApp('/');
    const user = userEvent.setup();
    await card('Milvasoft');
    expect(screen.queryByRole('article', { name: 'Milvaion Ekibi' })).toBeNull();
    expect(screen.queryByRole('article', { name: 'Bu sohbete erişimin yok' })).toBeNull();
    expect(screen.queryByRole('article', { name: 'Sohbet' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Kart ekle' }));
    const gallery = await screen.findByRole('complementary', { name: 'Kart ekle' });
    expect(within(gallery).queryByRole('button', { name: /^Sohbet/ })).toBeNull();
    expect(within(gallery).getByRole('button', { name: /^Sayfa/ })).toBeInTheDocument();
  });
});
