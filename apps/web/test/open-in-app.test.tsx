import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from '@/lib/external';
import { appOpenUrl, bannerAllowedOn, mobilePlatform } from '@/lib/open-in-app';
import { db } from '@/mocks/db';
import { MOCK_INVITE_TOKEN } from '@/mocks/seed';
import { renderApp } from './support/render';

vi.mock('@/lib/external', () => ({ openExternal: vi.fn() }));

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPAD_DESKTOP_SITE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IOS_STORE = 'https://apps.apple.com/app/id000000';

function onPhone(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(openExternal).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('open in app: helpers', () => {
  it('tells phones from desktops, iPadOS asking for the desktop site included', () => {
    expect(mobilePlatform(IPHONE, 5)).toBe('ios');
    expect(mobilePlatform(ANDROID, 5)).toBe('android');
    expect(mobilePlatform(IPAD_DESKTOP_SITE, 5)).toBe('ios');
    expect(mobilePlatform(IPAD_DESKTOP_SITE, 0)).toBeNull();
    expect(mobilePlatform(DESKTOP_CHROME, 0)).toBeNull();
  });

  it('hands the whole web address to the app as the mobile app reads it', () => {
    const href = 'https://hub.example.com/chat/c/0b0e?seq=12';
    expect(appOpenUrl(href)).toBe(`crewhall://open?url=${encodeURIComponent(href)}`);
    // crewhall-mobile openLinkPath reads `url` back with URLSearchParams.
    expect(new URLSearchParams(appOpenUrl(href).split('?')[1]).get('url')).toBe(href);
  });

  it('leaves the pages the app opens in the browser alone', () => {
    expect(bannerAllowedOn('/chat')).toBe(true);
    expect(bannerAllowedOn('/login')).toBe(true);
    expect(bannerAllowedOn('/mobile-login')).toBe(false);
    expect(bannerAllowedOn('/account/security')).toBe(false);
    expect(bannerAllowedOn('/account/profile')).toBe(true);
    expect(bannerAllowedOn('/vault/settings')).toBe(false);
    expect(bannerAllowedOn('/vault-share/abc')).toBe(false);
    expect(bannerAllowedOn('/f/token')).toBe(false);
    expect(bannerAllowedOn('/forms')).toBe(true);
    expect(bannerAllowedOn(`/invite/${MOCK_INVITE_TOKEN}`)).toBe(true);
  });
});

describe('open in app: banner', () => {
  it('opens this page in the app, then the store when no app answers', async () => {
    onPhone(IPHONE);
    db().storeUrls = { ios: IOS_STORE, android: null, desktop: null };
    renderApp('/login');
    const user = userEvent.setup();
    const banner = await screen.findByRole('region', { name: 'Mobil uygulama' });
    await user.click(within(banner).getByRole('button', { name: 'Aç' }));
    expect(openExternal).toHaveBeenCalledWith(appOpenUrl(`${window.location.origin}/login`));
    await waitFor(() => expect(openExternal).toHaveBeenLastCalledWith(IOS_STORE), {
      timeout: 3000,
    });
  });

  it('stays closed once closed', async () => {
    onPhone(ANDROID);
    const { unmount } = renderApp('/login');
    const user = userEvent.setup();
    const banner = await screen.findByRole('region', { name: 'Mobil uygulama' });
    await user.click(within(banner).getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByRole('region', { name: 'Mobil uygulama' })).toBeNull();
    unmount();
    renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Giriş yap' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mobil uygulama' })).toBeNull();
  });

  it('is not offered on a desktop browser or on the sign-in handoff page', async () => {
    onPhone(DESKTOP_CHROME);
    const { unmount } = renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Giriş yap' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mobil uygulama' })).toBeNull();
    unmount();
    onPhone(IPHONE);
    renderApp('/mobile-login');
    expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Mobil uygulama' })).toBeNull();
  });
});

describe('open in app: after an invitation', () => {
  it('continues in the app on this server, or stays in the browser', async () => {
    onPhone(IPHONE);
    const { router } = renderApp(`/invite/${MOCK_INVITE_TOKEN}`);
    const user = userEvent.setup();
    // Before joining, the banner hands the invitation itself to the app.
    const banner = await screen.findByRole('region', { name: 'Mobil uygulama' });
    await user.click(within(banner).getByRole('button', { name: 'Aç' }));
    expect(openExternal).toHaveBeenLastCalledWith(
      appOpenUrl(`${window.location.origin}/invite/${MOCK_INVITE_TOKEN}`),
    );

    await user.type(screen.getByLabelText('Ad soyad'), 'Ozan Kaya');
    await user.type(screen.getByLabelText('Şifre'), 'deniz-feneri-2026');
    await user.click(screen.getByRole('button', { name: 'Hesabı oluştur ve katıl' }));
    expect(
      await screen.findByRole('heading', { name: /uygulamada devam edin/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Uygulamada devam et' }));
    expect(openExternal).toHaveBeenLastCalledWith(appOpenUrl(`${window.location.origin}/`));

    // Home; this org sends a new member on to the 2FA setup first.
    await user.click(screen.getByRole('button', { name: 'Tarayıcıda devam et' }));
    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/invite/));
  });

  it('goes straight home on a desktop browser', async () => {
    onPhone(DESKTOP_CHROME);
    const { router } = renderApp(`/invite/${MOCK_INVITE_TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Ad soyad'), 'Ozan Kaya');
    await user.type(screen.getByLabelText('Şifre'), 'deniz-feneri-2026');
    await user.click(screen.getByRole('button', { name: 'Hesabı oluştur ve katıl' }));
    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/invite/));
    expect(screen.queryByRole('button', { name: 'Uygulamada devam et' })).toBeNull();
  });
});
