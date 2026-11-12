import type * as EditorReact from '@crewhall/editor/react';
import { type PortalRichDoc } from '@crewhall/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/mocks/db';
import { portalState } from '@/mocks/portal';
import { PORTAL_SITE_SLUG } from '@/mocks/portalSeed';
import { USER } from '@/mocks/seed';
import { setPublishOpen } from '@/lib/portal/context';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

// The Tiptap editor is replaced by a textarea; its labels and key list stay real.
vi.mock('@crewhall/editor/react', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorReact>();
  const plain = (doc: PortalRichDoc): string =>
    (doc.content ?? []).map((b) => (b.content ?? []).map((i) => i.text ?? '').join('')).join('\n');
  function RichEditor({
    value,
    onChange,
    editable,
  }: {
    value: PortalRichDoc;
    onChange?: (d: PortalRichDoc) => void;
    editable?: boolean;
  }) {
    return (
      <textarea
        aria-label="editor"
        readOnly={editable === false}
        defaultValue={plain(value)}
        onChange={(e) =>
          onChange?.({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: e.target.value }] }],
          })
        }
      />
    );
  }
  return { ...actual, RichEditor };
});

const SITE = `/portal/${PORTAL_SITE_SLUG.milva}`;

function doc(version: string, locale: string, slugEnd: string) {
  const d = portalState(db()).docs.find(
    (x) => x.version === version && x.locale === locale && x.slug.endsWith(slugEnd),
  );
  if (!d) throw new Error(`no doc ${slugEnd}`);
  return d;
}

beforeEach(() => setPublishOpen(false));

describe('portal (design 10)', () => {
  it('opens the last or first site and shows the overview KPIs', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/portal');
    const kpis = await screen.findByRole('list', { name: 'Site durumu' });
    await waitFor(() => expect(router.state.location.pathname).toBe(SITE));
    expect(within(kpis).getByText('Yayındaki URL')).toBeInTheDocument();
    expect(within(kpis).getByText('Yayınlanmamış değişiklik')).toBeInTheDocument();
    expect(within(kpis).getByText('Türkçe çeviri')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Yayınlanmamış değişiklikler' }),
    ).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Portal menüsü' });
    expect(within(sidebar).getByRole('link', { name: /Ayarlar/ })).toBeInTheDocument();
  });

  it('opens a new site right after creating it (no stale 404)', async () => {
    signedInAs(USER.bugra);
    const user = userEvent.setup();
    const { router } = renderApp('/portal/new');
    await user.type(await screen.findByLabelText('Site adı'), 'Yeni Dokümanlar');
    await user.type(screen.getByLabelText('Alan adı'), 'docs.example.test');
    await user.click(screen.getByRole('button', { name: 'Siteyi oluştur' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/portal/yeni-dokumanlar'));
    expect(await screen.findByRole('list', { name: 'Site durumu' })).toBeInTheDocument();
    expect(screen.queryByText('Bu sayfa bulunamadı')).not.toBeInTheDocument();
  });

  it('autosaves a doc with its base revision and asks to reload on a conflict', async () => {
    signedInAs(USER.bugra);
    const quick = doc('1.0.1', 'en', 'milvaion/quick-start');
    const bodies: { baseRev?: number; content?: unknown }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH' && request.url.includes(`/portal/docs/${quick.id}`)) {
        bodies.push((await request.clone().json()) as { baseRev?: number });
      }
    });
    renderApp(`${SITE}/docs?g=${quick.groupId}`);
    const user = userEvent.setup();
    const tree = await screen.findByRole('tree', { name: 'Doküman ağacı' });
    expect(within(tree).getAllByText('Quick Start').length).toBeGreaterThan(0);
    const editor = await screen.findByRole('textbox', { name: 'editor' });
    const rev = quick.rev;
    await user.type(editor, ' more');
    await waitFor(() => expect(doc('1.0.1', 'en', 'milvaion/quick-start').rev).toBe(rev + 1), {
      timeout: 4000,
    });
    expect(bodies[0]?.baseRev).toBe(rev);
    expect(await screen.findByText(/^Kaydedildi \d\d:\d\d$/)).toBeInTheDocument();

    // Someone else saves in between: the next autosave gets 409 portal_doc_conflict.
    doc('1.0.1', 'en', 'milvaion/quick-start').rev += 5;
    await user.type(editor, ' again');
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('başka biri tarafından kaydedildi');
    await user.click(within(alert).getByRole('button', { name: 'Yeniden yükle' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    server.events.removeAllListeners();
  }, 15_000);

  it('offers to start a missing translation', async () => {
    signedInAs(USER.bugra);
    const intro = doc('1.0.1', 'en', 'milvaion/your-first-worker');
    renderApp(`${SITE}/docs?g=${intro.groupId}&l=tr`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Çeviriyi başlat' }));
    await waitFor(() =>
      expect(
        portalState(db()).docs.some((d) => d.groupId === intro.groupId && d.locale === 'tr'),
      ).toBe(true),
    );
  });

  it('publishes the selected changes and shows the result', async () => {
    signedInAs(USER.bugra);
    renderApp(SITE);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Site durumu' });
    await user.click(await screen.findByRole('button', { name: /^Yayınla/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Yayınla' });
    const list = within(dialog).getByRole('list', { name: 'Yayınlanacak değişiklikler' });
    await within(list).findByText('Quick Start');
    await user.click(within(list).getByRole('checkbox', { name: /Multi Tenancy/ }));
    const total = within(list).getAllByRole('checkbox').length;
    await user.click(
      within(dialog).getByRole('button', { name: `${total - 1} değişikliği yayınla` }),
    );
    expect(
      await screen.findByRole('heading', { name: /Yayınlandı/ }, { timeout: 4000 }),
    ).toBeInTheDocument();
    const quick = doc('1.0.1', 'en', 'milvaion/quick-start');
    expect(quick.published?.rev).toBe(quick.rev);
    const multi = doc('1.0.1', 'en', 'milvasoft-helpers/multi-tenancy');
    expect(multi.published?.rev).not.toBe(multi.rev);
    expect(portalState(db()).publishes.some((p) => p.number === 130)).toBe(true);
  });

  it('filters blog posts by status', async () => {
    signedInAs(USER.bugra);
    renderApp(`${SITE}/blog`);
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Blog yazıları' });
    await within(table).findByText('UnitsNet');
    await user.click(screen.getByRole('button', { name: /^Zamanlanmış/ }));
    await waitFor(() => expect(within(table).queryByText('UnitsNet')).toBeNull());
    expect(within(table).getByText('Milvaion 1.4: Workflows and Alert Rules')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Taslak/ }));
    expect(
      await within(table).findByText('How We Moved the Portal to Crewhall'),
    ).toBeInTheDocument();
    expect(within(table).queryByText('Milvaion 1.4: Workflows and Alert Rules')).toBeNull();
  });

  it('lets system navbar items be hidden but not deleted', async () => {
    signedInAs(USER.bugra);
    renderApp(`${SITE}/navigation`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Language işlemleri' }));
    let menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Sil' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'GitHub işlemleri' }));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Sil' })).toBeInTheDocument();
  });

  it('hides settings from editors who do not manage the site', async () => {
    const can = db().members.find((m) => m.userId === USER.can)!;
    can.permissions = ['portal.edit', 'portal.publish'];
    signedInAs(USER.can);
    renderApp(`${SITE}/settings`);
    expect(await screen.findByText('Bu sayfa site yöneticileri içindir')).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Portal menüsü' });
    expect(within(sidebar).queryByRole('link', { name: /Ayarlar/ })).toBeNull();
    expect(within(sidebar).getByRole('link', { name: /Dokümanlar/ })).toBeInTheDocument();
  });

  it('keeps Portal off the rail and out of reach without portal permissions', async () => {
    signedInAs(USER.mert);
    renderApp(`${SITE}`);
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Modüller' });
    expect(within(rail).queryByRole('link', { name: 'Portal' })).toBeNull();
  });
});
