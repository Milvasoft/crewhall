import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { NODE } from '@/mocks/driveSeed';
import { SPACE, USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** H15: a page or a board opened from a public link shows its content, not a "0 B" file. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

async function linkFor(nodeId: string) {
  const share = await api.call('createShare', { params: { nodeId }, body: { kind: 'link' } });
  return decodeURIComponent(share.url!.split('/s/')[1]!);
}

describe('public link content views (H15)', () => {
  beforeAll(() => {
    // jsdom has no layout; the read-only editor asks for rectangles.
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = noRects;
    Element.prototype.getClientRects = noRects;
    resetWikiMock();
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = layout.rangeRect;
    Range.prototype.getClientRects = layout.rangeRects;
    Element.prototype.getClientRects = layout.elRects;
  });

  it('shows a shared page read-only, without size or download', async () => {
    signedInAs(USER.bugra);
    const tree = await api.call('listPageTree', { params: { spaceId: SPACE.milvasoft } });
    const page = tree.items.find((i) => i.name === 'Milvaion')!;
    const token = await linkFor(page.id);
    renderApp(`/s/${token}`);
    const article = await screen.findByRole('article', { name: 'Milvaion' });
    expect(
      within(article).getByRole('heading', { name: 'Milvaion', level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(article).toHaveTextContent(/Dağıtık iş zamanlayıcısı/));
    expect(article.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByText('Sayfa')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'İndir' })).toBeNull();
    expect(screen.queryByText('Bu dosyanın önizlemesi yok.')).toBeNull();
    expect(screen.queryByText(/^0 B$/)).toBeNull();
  });

  it('lists the headings of a shared page and jumps to them', async () => {
    signedInAs(USER.bugra);
    const page = await api.call('createPage', {
      params: { spaceId: SPACE.milvasoft },
      body: { name: 'Rehber', markdown: '# Kurulum\n\nMetin.\n\n## Ayarlar\n\nMetin.' },
    });
    renderApp(`/s/${await linkFor(page.id)}`);
    const nav = await screen.findByRole('navigation', { name: 'İçindekiler' });
    const article = screen.getByRole('article', { name: 'Rehber' });
    const target = await within(article).findByRole('heading', { name: 'Ayarlar' });
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    fireEvent.click(within(nav).getByRole('button', { name: 'Ayarlar' }));
    expect(scroll).toHaveBeenCalled();
  });

  it('shows no contents for a page with one heading', async () => {
    signedInAs(USER.bugra);
    const page = await api.call('createPage', {
      params: { spaceId: SPACE.milvasoft },
      body: { name: 'Kısa', markdown: '# Tek başlık\n\nMetin.' },
    });
    renderApp(`/s/${await linkFor(page.id)}`);
    await screen.findByRole('article', { name: 'Kısa' });
    await screen.findByRole('heading', { name: 'Tek başlık' });
    expect(screen.queryByRole('navigation', { name: 'İçindekiler' })).toBeNull();
  });

  it('shows a shared board with its columns and cards', async () => {
    signedInAs(USER.bugra);
    const detail = await api.call('getBoard', { params: { boardId: NODE.yolHaritasi } });
    const token = await linkFor(NODE.yolHaritasi);
    renderApp(`/s/${token}`);
    expect(
      await screen.findByRole('heading', { name: 'Milvaion Yol Haritası', level: 1 }),
    ).toBeInTheDocument();
    for (const col of detail.columns) {
      expect(screen.getByRole('region', { name: col.name })).toBeInTheDocument();
    }
    const first = detail.cards[0];
    if (first) expect(screen.getByText(first.title)).toBeInTheDocument();
    expect(screen.getByText('Pano')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'İndir' })).toBeNull();
  });
});
