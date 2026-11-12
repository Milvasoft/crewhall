import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleClickOpens, newTabLabel, openInNewTab } from '@/lib/newTab';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

afterEach(() => vi.restoreAllMocks());

describe('opening in a new tab', () => {
  it('leaves onMouseDown free for what it is spread over: a card must still drag', () => {
    const props = middleClickOpens('/x');
    expect(props).not.toHaveProperty('onMouseDown');
    const press = (button: number) => {
      const preventDefault = vi.fn();
      props.onMouseDownCapture({ button, preventDefault } as unknown as React.MouseEvent);
      return preventDefault;
    };
    expect(press(1)).toHaveBeenCalled();
    expect(press(0)).not.toHaveBeenCalled();
  });

  it('the rail, chat list and Drive names are real links', async () => {
    signedInAs(USER.bugra);
    renderApp('/chat');
    const rail = await screen.findByRole('navigation', { name: 'Modüller' });
    expect(within(rail).getByRole('link', { name: 'Drive' })).toHaveAttribute('href', '/drive');
    await waitFor(() =>
      expect(
        screen.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/chat/c/')),
      ).toBe(true),
    );
  });

  it('the Drive list opens a row with the middle button and from its menu', async () => {
    signedInAs(USER.bugra);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderApp('/drive/recent');
    const row = (await screen.findAllByRole('row')).find((r) => within(r).queryByRole('link'));
    const link = within(row!).getByRole('link');
    expect(link.getAttribute('href')).toBeTruthy();
    fireEvent.contextMenu(row!);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('menuitem', { name: 'Yeni sekmede aç' }));
    expect(open).toHaveBeenCalledWith(link.getAttribute('href'), '_blank', 'noopener');
  });

  it('in the desktop app opens a further window through its bridge, and says so', async () => {
    const openWindow = vi.fn(async () => true);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      features: ['openWindow'],
      openWindow,
    } as unknown as NonNullable<typeof window.crewhallDesktop>;
    try {
      expect(newTabLabel()).toBe('desktop.menu.openInNewWindow');
      openInNewTab('/chat/c/1');
      expect(openWindow).toHaveBeenCalledWith('/chat/c/1');
      expect(open).not.toHaveBeenCalled();
    } finally {
      delete window.crewhallDesktop;
    }
    // A desktop app from before the bridge, like a browser, gets window.open.
    expect(newTabLabel()).toBe('quick.menu.newTab');
    openInNewTab('/chat/c/1');
    expect(open).toHaveBeenCalledWith('/chat/c/1', '_blank', 'noopener');
  });

  it('middle click opens once and stays out of other buttons', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const handlers = middleClickOpens('/chat/c/1');
    const event = (button: number) =>
      ({ button, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as never;
    handlers.onAuxClick(event(2));
    expect(open).not.toHaveBeenCalled();
    const middle = event(1);
    handlers.onAuxClick(middle);
    expect(open).toHaveBeenCalledTimes(1);
    expect((middle as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
  });
});
