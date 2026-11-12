import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DesktopTitleBarRow,
  DesktopTitleBarSync,
  THIN_TITLE_ROW,
  useDesktopTitleBar,
  useLendTitleBarColors,
} from '@/lib/desktop-titlebar';

function Bar() {
  const ref = useRef<HTMLElement>(null);
  const on = useDesktopTitleBar(ref);
  return (
    <header ref={ref} data-titlebar={on ? '' : undefined} style={{ background: '#141516' }}>
      bar
    </header>
  );
}

function installBridge() {
  const set = vi.fn();
  (window as { crewhallDesktop?: unknown }).crewhallDesktop = {
    isDesktop: true,
    platform: 'win32',
    features: ['titleBar'],
    titleBar: { overlay: true, set },
  };
  return set;
}

// jsdom draws nothing: colours are passed on as computed.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { crewhallDesktop?: unknown }).crewhallDesktop;
  delete document.documentElement.dataset.titlebarOwned;
  delete document.documentElement.dataset.desktopTitlebar;
});

describe('desktop title bar', () => {
  it('changes nothing in a browser', () => {
    const { container } = render(<Bar />);
    expect(container.querySelector('[data-titlebar]')).toBeNull();
    expect(document.documentElement.dataset.titlebarOwned).toBeUndefined();
  });

  it('makes the bar the window title bar while it is on screen, then hands back to the strip', async () => {
    const set = installBridge();
    const { container, unmount } = render(<Bar />);
    expect(container.querySelector('header')?.hasAttribute('data-titlebar')).toBe(true);
    expect(document.documentElement.dataset.titlebarOwned).toBe('');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ owned: true }));
    const state = set.mock.calls.at(-1)?.[0] as { height: number; bg: string; fg: string };
    // jsdom has no layout: the bar's default height.
    expect(state.height).toBe(56);
    expect(state.bg).toMatch(/141516|20, 21, 22/);

    unmount();
    await waitFor(() => expect(document.documentElement.dataset.titlebarOwned).toBeUndefined());
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ owned: false, height: 32 }));
  });

  it('keeps the bar owned when one page bar replaces another', async () => {
    const set = installBridge();
    const { rerender } = render(<Bar key="a" />);
    rerender(<Bar key="b" />);
    await new Promise((r) => setTimeout(r, 5));
    expect(document.documentElement.dataset.titlebarOwned).toBe('');
    expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ owned: false }));
  });

  it('reports the page colours for pages without a bar', () => {
    const set = installBridge();
    render(<DesktopTitleBarSync />);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ owned: false, height: 32 }));
  });
});

describe('pages without a bar of their own (chat start page)', () => {
  it('get an empty title bar in the desktop app and nothing in a browser', () => {
    const browser = render(<DesktopTitleBarRow />);
    expect(browser.container.innerHTML).toBe('');
    browser.unmount();

    installBridge();
    const { container } = render(<DesktopTitleBarRow />);
    expect(container.querySelector('[data-titlebar]')).not.toBeNull();
    expect(document.documentElement.dataset.titlebarOwned).toBe('');
  });

  it('marks the desktop app so the shell can leave room for its strip', () => {
    installBridge();
    const { unmount } = render(<DesktopTitleBarSync />);
    expect(document.documentElement.dataset.desktopTitlebar).toBe('');
    unmount();
    expect(document.documentElement.dataset.desktopTitlebar).toBeUndefined();
  });
});

describe('shell height under the desktop strip (chat page overflow)', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');

  it('subtracts the strip, not the keyboard variable the web sets inline', () => {
    expect(src('routes/_app.tsx')).toContain(
      'h-[calc(100dvh-var(--kb,0px)-var(--desktop-strip,0px))]',
    );
    expect(src('index.css')).toContain(
      'html[data-desktop-titlebar]:not([data-titlebar-owned]) {\n  --desktop-strip: 32px;',
    );
  });

  it('makes every chat top bar the window title bar', () => {
    for (const file of ['ConversationHeader', 'ChatSearch', 'NewChat']) {
      expect(src(`components/chat/${file}.tsx`), file).toContain('{...titleBar}');
    }
    expect(src('components/chat/ChatHome.tsx')).toContain('<DesktopTitleBarRow />');
  });
});

describe('views over the desktop title bar (the AI panel, Drive preview, the call room)', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');

  it('starts the panel under the window buttons, with colours of its own', () => {
    const panel = src('components/ai/AskPanel.tsx');
    expect(panel).toContain('data-desktop-side-panel=""');
    expect(panel).not.toContain('useLendTitleBarColors');
  });

  it('does the same for full-screen views: Drive preview, the call room in chat, the ringing screen', () => {
    const preview = src('features/drive/Previewer.tsx');
    expect(preview).toContain('data-desktop-overlay=""');
    expect(preview).toContain('data-desktop-band=""');
    // Its bar is lower than the window buttons: it starts under them.
    expect(src('components/chat/ConversationPane.tsx')).toContain('data-desktop-overlay="below"');
    expect(src('components/meet/IncomingCall.tsx')).toContain(
      'useLendTitleBarColors(screenRef, true)',
    );
  });
});

describe('a panel over the title bar row lends its colours', () => {
  function Panel({ open }: { open: boolean }) {
    const ref = useRef<HTMLElement>(null);
    useLendTitleBarColors(ref, open);
    return (
      <aside ref={ref} style={{ background: 'rgb(255, 255, 255)', color: 'rgb(1, 2, 3)' }}>
        panel
      </aside>
    );
  }

  it('gives the window buttons the panel colours while open, then the bar ones again', async () => {
    const set = installBridge();
    const { rerender } = render(
      <>
        <Bar />
        <Panel open={false} />
      </>,
    );
    const last = () => set.mock.calls.at(-1)?.[0] as { owned: boolean; bg: string; fg: string };
    await waitFor(() => expect(last().bg).toMatch(/141516|20, 21, 22/));
    rerender(
      <>
        <Bar />
        <Panel open />
      </>,
    );
    await waitFor(() => expect(last()).toMatchObject({ owned: true, bg: 'rgb(255, 255, 255)' }));
    expect(last().fg).toBe('rgb(1, 2, 3)');
    rerender(
      <>
        <Bar />
        <Panel open={false} />
      </>,
    );
    await waitFor(() => expect(last().bg).toMatch(/141516|20, 21, 22/));
  });

  it('can make the row thin while it is open, then gives the bar its height back', async () => {
    const set = installBridge();
    function Thin({ open }: { open: boolean }) {
      const ref = useRef<HTMLElement>(null);
      useLendTitleBarColors(ref, open, THIN_TITLE_ROW);
      return <aside ref={ref}>view</aside>;
    }
    const { rerender } = render(
      <>
        <Bar />
        <Thin open />
      </>,
    );
    const last = () => set.mock.calls.at(-1)?.[0] as { height: number };
    await waitFor(() => expect(last().height).toBe(THIN_TITLE_ROW));
    rerender(
      <>
        <Bar />
        <Thin open={false} />
      </>,
    );
    await waitFor(() => expect(last().height).toBe(56));
  });

  it('does nothing in a browser', () => {
    render(<Panel open />);
    expect(window.crewhallDesktop).toBeUndefined();
  });
});

describe('the bar at the top of the window is the title bar (meeting strip above the page bar)', () => {
  function Lower() {
    const ref = useRef<HTMLElement>(null);
    const on = useDesktopTitleBar(ref);
    return (
      <header
        ref={ref}
        data-testid="lower"
        data-titlebar={on ? '' : undefined}
        style={{ background: '#141516' }}
      >
        page bar
      </header>
    );
  }

  it('gives the window buttons to the strip and takes them back when it goes', async () => {
    const set = installBridge();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      // The page bar sits 36 px down while the strip is shown.
      const down = this.dataset.testid === 'lower' && !!document.querySelector('[role=status]');
      return {
        x: 0,
        y: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        top: down ? 36 : 0,
        height: down ? 56 : 36,
      } as DOMRect;
    });
    function Strip() {
      const ref = useRef<HTMLDivElement>(null);
      const on = useDesktopTitleBar(ref);
      return (
        <div ref={ref} role="status" data-titlebar={on ? '' : undefined}>
          strip
        </div>
      );
    }
    const { rerender, getByTestId } = render(
      <>
        <Strip />
        <Lower />
      </>,
    );
    await waitFor(() => expect(getByTestId('lower').hasAttribute('data-titlebar')).toBe(false));
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ owned: true, height: 36 }));
    rerender(<Lower />);
    await waitFor(() => expect(getByTestId('lower').hasAttribute('data-titlebar')).toBe(true));
  });
});

describe('chat panes without a header of their own (plugin tab)', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');

  it('gives the chat plugin tab a desktop title row with the tab name', () => {
    const route = src('routes/_app.chat.plugins.$installationId.$tabId.tsx');
    expect(route).toContain('<DesktopTitleBarRow>');
    expect(route).toContain('localize(tab.title, locale)');
  });

  it('keeps the title row on screen while another bar is on top (meeting strip)', async () => {
    installBridge();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({ x: 0, y: 0, left: 0, right: 0, bottom: 0, width: 0, top: 36, height: 56 }) as DOMRect,
    );
    const { container } = render(<DesktopTitleBarRow>WhatsApp</DesktopTitleBarRow>);
    await waitFor(() =>
      expect(container.firstElementChild?.hasAttribute('data-titlebar')).toBe(false),
    );
    // Not the top bar right now, but still drawn: no jump when the strip goes away.
    expect(container.textContent).toBe('WhatsApp');
  });
});
