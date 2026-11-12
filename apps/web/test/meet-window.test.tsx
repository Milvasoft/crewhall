import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/queryClient';
import { MeetingElsewhereBar } from '@/components/meet/openMeeting';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import {
  focusMeetingWindow,
  isMeetingWindow,
  MEET_WINDOW_PREFIX,
  meetingWindowName,
  openMeetingWindow,
  resetMeetingWindowsForTests,
} from '@/lib/meet/window';
import { resetMeetMock } from '@/mocks/meet';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** A window.open result: about:blank until navigated. */
function fakeTab() {
  return { location: { href: 'about:blank' }, focus: vi.fn(), close: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.crewhallDesktop;
  window.name = '';
  sessionStorage.clear();
  resetMeetingWindowsForTests();
});

describe('meetings in their own tab', () => {
  it('opens a named tab once and focuses it the second time', () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    expect(openMeetingWindow('daily', '/meetings/room/daily')).toBe('opened');
    expect(open).toHaveBeenCalledWith('', 'crewhall-meet-daily');
    expect(tab.location.href).toMatch(/\/meetings\/room\/daily\?window=1$/);
    expect(tab.focus).toHaveBeenCalled();
    // Already open: focused, not reloaded.
    const before = tab.location.href;
    expect(openMeetingWindow('daily', '/meetings/room/daily')).toBe('focused');
    expect(tab.location.href).toBe(before);
    expect(meetingWindowName('x')).toBe(`${MEET_WINDOW_PREFIX}x`);
  });

  it('hands the meeting to the desktop app when it is there', () => {
    const openMeeting = vi.fn();
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      features: ['openMeeting'],
      openMeeting,
    };
    const open = vi.spyOn(window, 'open');
    expect(openMeetingWindow('daily', '/meetings/room/daily?call=c1')).toBe('desktop');
    expect(open).not.toHaveBeenCalled();
    expect(openMeeting).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/[^/]+\/meetings\/room\/daily\?call=c1&window=1$/),
    );
  });

  it('brings the desktop meeting window up without looking for a named tab', () => {
    const openMeeting = vi.fn();
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      features: ['openMeeting'],
      openMeeting,
    };
    const open = vi.spyOn(window, 'open');
    focusMeetingWindow('daily');
    expect(open).not.toHaveBeenCalled();
    expect(openMeeting).toHaveBeenCalledWith(
      `${window.location.origin}/meetings/room/daily?window=1`,
    );
  });

  it('knows a meeting tab by its name or its flag (kept for the tab)', () => {
    expect(isMeetingWindow()).toBe(false);
    window.name = 'crewhall-meet-daily';
    expect(isMeetingWindow()).toBe(true);
    window.name = '';
    window.history.replaceState(null, '', '/meetings/room/daily?window=1');
    expect(isMeetingWindow()).toBe(true);
    window.history.replaceState(null, '', '/meetings/room/daily');
    expect(isMeetingWindow()).toBe(true);
    window.history.replaceState(null, '', '/');
  });

  it('opens in this tab with a hint when pop-ups are blocked', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Toaster />);
    const { router } = renderApp('/meetings');
    const user = userEvent.setup();
    const join = await screen.findAllByRole('link', { name: /Milvasoft Daily/ });
    await user.click(join[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    expect(await screen.findByText(/açılır pencerelere izin ver/)).toBeInTheDocument();
  });

  it('shows only the meeting in its own tab (no rail)', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    window.name = 'crewhall-meet-milvasoft-daily';
    renderApp('/meetings/room/milvasoft-daily');
    expect(await screen.findByText('Katılmak üzeresin')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Modüller' })).toBeNull();
  });

  it('keeps the meeting in this tab on touch screens (back returns)', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const open = vi.spyOn(window, 'open');
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('coarse'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { router } = renderApp('/meetings');
    const user = userEvent.setup();
    const room = await screen.findAllByRole('link', { name: /Milvasoft Daily/ });
    await user.click(room[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    expect(open).not.toHaveBeenCalled();
    // Inside the app: the rail is there, and back returns to the meetings page.
    expect(screen.getByRole('navigation', { name: 'Modüller' })).toBeInTheDocument();
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'));
    vi.unstubAllGlobals();
  });

  it('always offers a way home from a meeting tab, which then becomes a normal tab', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    window.name = 'crewhall-meet-milvasoft-daily';
    const { router } = renderApp('/meetings/room/milvasoft-daily');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ana sayfa' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(isMeetingWindow()).toBe(false);
    expect(await screen.findByRole('navigation', { name: 'Modüller' })).toBeInTheDocument();
  });

  it('leaves the camera card to its message when there is no camera (nothing overlaps it)', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    // jsdom has no getUserMedia: the plain-http message.
    renderApp('/meetings/room/milvasoft-daily');
    expect(
      await screen.findByText('Kamera ve mikrofon için güvenli bağlantı gerekiyor'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Yalnız sen görüyorsun')).toBeNull();
    expect(screen.queryByText(/^Sen \(/)).toBeNull();
  });

  it('tells the main tab a meeting is open elsewhere', async () => {
    // Only the list of meetings answers; who I am stays loading here.
    vi.spyOn(api, 'call').mockImplementation(((name: string) =>
      name === 'listActiveMeetings'
        ? Promise.resolve({ items: [] })
        : new Promise(() => undefined)) as never);
    render(
      <I18nProvider locale="tr">
        <QueryClientProvider client={createQueryClient()}>
          <MeetingElsewhereBar />
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    const other = new BroadcastChannel('crewhall-meet');
    act(() => other.postMessage({ type: 'alive', meeting: { slug: 'daily', title: 'Daily' } }));
    expect(await screen.findByText('Toplantıdasın · Daily')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sekmeye geç/ })).toBeEnabled();
    act(() => other.postMessage({ type: 'gone', slug: 'daily' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    other.close();
  });
});
