import { describe, expect, it, vi } from 'vitest';
import { createHubClient, HubError, type FetchLike, type HubFetchInit } from '@/lib/hub';

const site = {
  name: 'Example Portal',
  url: 'https://portal.example.com',
  locales: ['en', 'tr'],
  defaultLocale: 'en',
  settings: {
    title: 'Example Portal',
    tagline: null,
    url: 'https://portal.example.com',
    timezone: 'Europe/Istanbul',
    titleTemplate: '{page} | {site}',
    logo: { src: '/media/img/logo.svg', srcDark: null, alt: 'Logo' },
    favicon: null,
    socialImage: null,
    nextPublic: false,
    showUntranslatedNotice: true,
    prism: { light: 'github', dark: 'dracula' },
  },
  versions: [{ name: '1.0.1', label: '1.0.1', status: 'current', showInPicker: true }],
  navigation: {
    navbar: { title: { en: 'Example' }, logo: { src: null, srcDark: null, alt: '' }, items: [] },
    footer: { style: 'dark', columns: [], copyright: { en: '© {year}' } },
  },
  home: { sections: [] },
  publishedAt: null,
  preview: false,
};

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: HubFetchInit }[] = [];
  const fn: FetchLike = vi.fn(async (url: string, init: HubFetchInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fn, calls };
}

describe('hub client', () => {
  it('validates responses and tags cached fetches', async () => {
    const { fn, calls } = mockFetch(200, site);
    const client = createHubClient({ baseUrl: 'http://hub:4201/', token: 'tok', fetch: fn });
    const data = await client.site();
    expect(data.settings.title).toBe('Example Portal');
    expect(calls[0]?.url).toBe('http://hub:4201/api/v1/public/portal/site');
    expect(calls[0]?.init.cache).toBe('force-cache');
    expect(calls[0]?.init.next?.tags).toEqual(['portal:all', 'portal:site']);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('assigns per-content tags and a stable query string', async () => {
    const { fn, calls } = mockFetch(404, { code: 'not_found', message: 'nope' });
    const client = createHubClient({ baseUrl: 'http://hub', fetch: fn });
    expect(await client.page('1.0.1', 'tr', 'a/b')).toBeNull();
    expect(calls[0]?.url).toBe(
      'http://hub/api/v1/public/portal/page?locale=tr&slug=a%2Fb&version=1.0.1',
    );
    expect(calls[0]?.init.next?.tags).toEqual(['portal:all', 'portal:page:1.0.1:tr:a/b']);
    await client.sidebar('1.0.1', 'en');
    expect(calls[1]?.init.next?.tags).toEqual(['portal:all', 'portal:sidebar:1.0.1:en']);
    await client.post('en', 'hello');
    expect(calls[2]?.init.next?.tags).toEqual([
      'portal:all',
      'portal:blog',
      'portal:post:en:hello',
    ]);
    await client.redirect('/old');
    expect(calls[3]?.init.next?.tags).toEqual(['portal:all', 'portal:redirects']);
  });

  it('rejects responses that do not match the contract', async () => {
    const { fn } = mockFetch(200, { ...site, locales: 'en' });
    const client = createHubClient({ baseUrl: 'http://hub', fetch: fn });
    await expect(client.site()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns errors into HubError and 404 of required data into not_found', async () => {
    const { fn } = mockFetch(500, { code: 'internal', message: 'boom' });
    await expect(
      createHubClient({ baseUrl: 'http://hub', fetch: fn }).paths(),
    ).rejects.toBeInstanceOf(HubError);
    const missing = mockFetch(404, { code: 'not_found', message: 'x' });
    await expect(
      createHubClient({ baseUrl: 'http://hub', fetch: missing.fn }).site(),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('sends the preview token and bypasses the cache in preview', async () => {
    const { fn, calls } = mockFetch(200, { ...site, preview: true });
    const client = createHubClient({
      baseUrl: 'http://hub',
      token: 't',
      previewToken: 'p',
      fetch: fn,
    });
    expect(client.preview).toBe(true);
    await client.site();
    expect(calls[0]?.init.cache).toBe('no-store');
    expect(calls[0]?.init.next).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)['X-Portal-Preview']).toBe('p');
  });

  it('never caches search', async () => {
    const { fn, calls } = mockFetch(200, { items: [] });
    await createHubClient({ baseUrl: 'http://hub', fetch: fn }).search({
      q: 'worker',
      locale: 'en',
      limit: 8,
    });
    expect(calls[0]?.init.cache).toBe('no-store');
  });
});
