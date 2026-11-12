import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSidebarSizes, setSidebarWidth, sidebarMax } from '@/lib/shell/sidebarSize';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** matchMedia that answers min-/max-width queries for a given viewport width. */
function setViewport(width: number) {
  window.matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches =
      (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && Boolean(min || max);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
}

const original = window.matchMedia;
const handle = () => screen.findByRole('separator', { name: 'Kenar çubuğunu boyutlandır' });
const frame = (el: HTMLElement) => el.closest<HTMLElement>('[data-sidebar-frame]')!;

/** Pointer drag on the handle by `dx` pixels. */
function drag(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 300 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 300 + dx });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 300 + dx });
}

async function openDrive() {
  setViewport(1280);
  const app = renderApp('/drive/milvasoft');
  const el = await handle();
  return { ...app, el, user: userEvent.setup() };
}

describe('resizable module sidebar', () => {
  beforeEach(() => {
    localStorage.removeItem('crewhall.sidebarSizes');
    clearSidebarSizes();
    signedInAs(USER.bugra);
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it('drags within the limits and shows the width live', async () => {
    const { el } = await openDrive();
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuenow', '248');
    expect(frame(el).style.width).toBe('248px');

    // Mid-drag the frame follows the pointer before anything is saved.
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 360 });
    expect(frame(el).style.width).toBe('308px');
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 360 });
    expect(el).toHaveAttribute('aria-valuenow', '308');

    // Never wider than the maximum, never narrower than 200 unless it collapses.
    drag(el, 2000);
    expect(el).toHaveAttribute('aria-valuenow', String(sidebarMax()));
    expect(el).toHaveAttribute('aria-valuemax', String(sidebarMax()));
    drag(el, -(sidebarMax() - 160));
    expect(el).toHaveAttribute('aria-valuenow', '200');
  });

  it('dragging below the minimum collapses it; dragging out or the toggle opens it', async () => {
    const { el, user } = await openDrive();
    drag(el, -150);
    expect(el).toHaveAttribute('aria-valuenow', '0');
    expect(el).toHaveAttribute('aria-valuetext', 'Kapalı');
    expect(frame(el).style.width).toBe('0px');
    expect(screen.getByRole('complementary', { name: 'Space kenar çubuğu' })).toHaveAttribute(
      'inert',
    );

    drag(el, 260);
    expect(el).toHaveAttribute('aria-valuenow', '260');
    expect(frame(el).style.width).toBe('260px');

    drag(el, -200);
    await user.click(await screen.findByRole('button', { name: 'Kenar çubuğunu göster' }));
    // Opens at the width it had before it was collapsed.
    expect(el).toHaveAttribute('aria-valuenow', '260');
  });

  it('double-click goes back to the default width', async () => {
    const { el } = await openDrive();
    drag(el, 100);
    expect(el).toHaveAttribute('aria-valuenow', '348');
    fireEvent.doubleClick(el);
    expect(el).toHaveAttribute('aria-valuenow', '248');
  });

  it('keyboard: arrows change the width by 16 px, Enter collapses and opens', async () => {
    const { el, user } = await openDrive();
    el.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(el).toHaveAttribute('aria-valuenow', '280');
    await user.keyboard('{ArrowLeft}');
    expect(el).toHaveAttribute('aria-valuenow', '264');
    await user.keyboard('{Enter}');
    expect(el).toHaveAttribute('aria-valuenow', '0');
    await user.keyboard('{Enter}');
    expect(el).toHaveAttribute('aria-valuenow', '264');
    // Collapsed, → opens it again.
    await user.keyboard('{Enter}{ArrowRight}');
    expect(el).toHaveAttribute('aria-valuenow', '264');
  });

  it('remembers the width per module and saves it after the drag', async () => {
    const { el, router } = await openDrive();
    drag(el, 72);
    expect(el).toHaveAttribute('aria-valuenow', '320');
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('crewhall.sidebarSizes') ?? '{}')).toEqual({
        widths: { drive: 320 },
        collapsed: [],
      }),
    );

    // Chat keeps its own (wider) default.
    await act(() => router.navigate({ to: '/chat' }));
    await waitFor(async () => expect(await handle()).toHaveAttribute('aria-valuenow', '300'));

    await act(() =>
      router.navigate({ to: '/drive/$spaceSlug', params: { spaceSlug: 'milvasoft' } }),
    );
    await waitFor(async () => expect(await handle()).toHaveAttribute('aria-valuenow', '320'));
  });

  it('no handle on phones: the sidebar is a drawer there', async () => {
    setViewport(390);
    renderApp('/drive/milvasoft');
    await screen.findByRole('button', { name: 'Menüyü aç' });
    expect(screen.queryByRole('separator', { name: 'Kenar çubuğunu boyutlandır' })).toBeNull();
  });

  it('saves the widths to the server (UiPrefs)', async () => {
    const { el } = await openDrive();
    drag(el, 72);
    await waitFor(() =>
      expect(db().uiSidebar?.[USER.bugra]).toEqual({
        sidebarWidths: { drive: 320 },
        sidebarCollapsed: [],
      }),
    );
  });

  it('opens with the widths the server has', async () => {
    db().uiSidebar = {
      [USER.bugra]: { sidebarWidths: { drive: 400 }, sidebarCollapsed: ['chat'] },
    };
    await openDrive();
    await waitFor(async () => expect(await handle()).toHaveAttribute('aria-valuenow', '400'));
  });

  it('sends what this browser had when the server has nothing yet', async () => {
    setSidebarWidth('drive', 280);
    await new Promise((r) => setTimeout(r, 350));
    const { el } = await openDrive();
    expect(el).toHaveAttribute('aria-valuenow', '280');
    await waitFor(() =>
      expect(db().uiSidebar?.[USER.bugra]?.sidebarWidths).toEqual({ drive: 280 }),
    );
  });
});
