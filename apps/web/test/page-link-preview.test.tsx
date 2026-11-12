import { pagePath } from '@crewhall/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { SPACE, USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** The card about the page a link leads to. */

async function openParent() {
  signedInAs(USER.bugra);
  const { items } = await api.call('listPageTree', { params: { spaceId: SPACE.milvasoft } });
  const parent = items.find((p) => p.name === 'Onboarding')!;
  const child = items.find((p) => p.parentId === parent.id)!;
  renderApp(pagePath(parent));
  const footer = await waitFor(() => {
    const el = document.querySelector('.wk-page footer');
    if (!el) throw new Error('no footer yet');
    return el as HTMLElement;
  });
  const link = await within(footer).findByRole('link', { name: new RegExp(child.name) });
  return { parent, child, link };
}

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe('page link preview', () => {
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('opens after a pause over a link and closes when the pointer leaves', async () => {
    const { child, link } = await openParent();
    fireEvent.mouseOver(link);
    expect(screen.queryByRole('tooltip')).toBeNull();

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText(child.name)).toBeInTheDocument();
    expect(within(card).getByText(/düzenledi/)).toBeInTheDocument();

    fireEvent.mouseOut(link);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('shows the beginning of the page, cut when it is long', async () => {
    signedInAs(USER.bugra);
    const { items } = await api.call('listPageTree', { params: { spaceId: SPACE.milvasoft } });
    const parent = items.find((p) => p.name === 'Onboarding')!;
    const long = 'Uzun bir açıklama. '.repeat(30);
    await api.call('createPage', {
      params: { spaceId: SPACE.milvasoft },
      body: { parentId: parent.id, name: 'Özetli', markdown: `# Başlık\n\n${long}` },
    });
    renderApp(pagePath(parent));
    const footer = await waitFor(() => {
      const el = document.querySelector('.wk-page footer');
      if (!el) throw new Error('no footer yet');
      return el as HTMLElement;
    });
    const link = await within(footer).findByRole('link', { name: 'Özetli' });
    fireEvent.mouseOver(link);
    const card = await screen.findByRole('tooltip');
    const text = await waitFor(() => {
      const el = card.querySelector('.wk-link-preview-text');
      if (!el) throw new Error('no excerpt yet');
      return el.textContent ?? '';
    });
    expect(text.startsWith('Başlık')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(230);
  });

  it('does not open when the pointer only passes over the link', async () => {
    const { link } = await openParent();
    fireEvent.mouseOver(link);
    fireEvent.mouseOut(link);
    await sleep(600);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays open while the pointer is on the card', async () => {
    const { link } = await openParent();
    fireEvent.mouseOver(link);
    const card = await screen.findByRole('tooltip');
    fireEvent.mouseOut(link);
    fireEvent.mouseEnter(card);
    await sleep(300);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('opens on keyboard focus and closes on Escape', async () => {
    const { link } = await openParent();
    fireEvent.focusIn(link);
    await screen.findByRole('tooltip');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('shows nothing for a page that cannot be read, or an outside link', async () => {
    const { link } = await openParent();
    link.setAttribute('href', '/p/gizli-0190f0a0-0000-7000-8000-00000000dead');
    fireEvent.mouseOver(link);
    await sleep(600);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseOut(link);

    link.setAttribute('href', 'https://example.com/p/a-0190f0a0-0000-7000-8000-00000000dead');
    fireEvent.mouseOver(link);
    await sleep(600);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
