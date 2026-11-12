import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toCurrentPath } from '@crewhall/shared';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Backend prefixes the proxy (Traefik) matches as plain string prefixes. */
const RESERVED = [
  '/api',
  '/ws',
  '/mcp',
  '/dav',
  '/caldav',
  '/carddav',
  '/collab',
  '/healthz',
  '/readyz',
  '/.well-known',
  '/oauth/authorize',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
];

describe('English URLs', () => {
  it('maps the old Turkish paths to today’s', () => {
    expect(toCurrentPath('/yonetim/genel')).toBe('/admin/general');
    expect(toCurrentPath('/yonetim/entegrasyonlar/kimlik/yeni')).toBe(
      '/admin/integrations/identity/new',
    );
    expect(toCurrentPath('/yonetim/uyeler/abc')).toBe('/admin/members/abc');
    expect(toCurrentPath('/hesap/mcp/istemci/g1')).toBe('/account/mcp/client/g1');
    expect(toCurrentPath('/drive/milvasoft/k/f1')).toBe('/drive/milvasoft/folder/f1');
    expect(toCurrentPath('/drive/son')).toBe('/drive/recent');
    expect(toCurrentPath('/chat/c/c1/sabitlenenler')).toBe('/chat/c/c1/pinned');
    expect(toCurrentPath('/kasa/v1/erisim')).toBe('/vault/v1/access');
    expect(toCurrentPath('/kasa/gunluk')).toBe('/vault/log');
    expect(toCurrentPath('/otomasyonlar/milvasoft/yeni')).toBe('/automations/milvasoft/new');
    expect(toCurrentPath('/formlar/y/f1')).toBe('/forms/edit/f1');
    expect(toCurrentPath('/toplantilar/oda/daily')).toBe('/meetings/room/daily');
    expect(toCurrentPath('/rehber/sema')).toBe('/contacts/org-chart');
    expect(toCurrentPath('/davet/tok')).toBe('/invite/tok');
    expect(toCurrentPath('/guvenlik/2fa-kur')).toBe('/security/2fa-setup');
    expect(toCurrentPath('/login/2fa/yedek')).toBe('/login/2fa/backup');
    expect(toCurrentPath('/sayfalar/urun')).toBe('/pages/urun');
    // Today's paths, and the ones that never changed, stay as they are.
    for (const p of ['/admin/general', '/drive/milvasoft/folder/f1', '/p/abc', '/', '/chat']) {
      expect(toCurrentPath(p)).toBe(p);
    }
  });

  it('sends an old link to the new page, keeping the query and the hash', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/yonetim/genel?x=1#policies');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/general'));
    expect(router.state.location.searchStr).toBe('?x=1');
    expect(router.state.location.hash).toBe('policies');
    expect(await screen.findByRole('heading', { name: 'Genel' })).toBeInTheDocument();
  });

  it('turns old query keys and values into today’s (calendar, vault category)', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/takvim?gorunum=hafta&tarih=2026-10-22');
    await waitFor(() => expect(router.state.location.pathname).toBe('/calendar'));
    expect(router.state.location.search).toMatchObject({ view: 'week', date: '2026-10-22' });
    expect(toCurrentPath('/kasa/v1/tumu')).toBe('/vault/v1/all');
    expect(toCurrentPath('/toplantilar?yeni=hemen')).toBe('/meetings?new=now');
  });

  it('opens an old invitation link (it used to fall under the /dav proxy prefix)', async () => {
    const { router } = renderApp('/davet/abc123');
    await waitFor(() => expect(router.state.location.pathname).toBe('/invite/abc123'));
  });

  it('has no web path under a backend prefix', () => {
    const { router } = renderApp('/login');
    const paths = Object.keys(router.routesByPath);
    expect(paths.length).toBeGreaterThan(50);
    for (const p of paths) {
      for (const prefix of RESERVED) expect(p.startsWith(prefix), `${p} vs ${prefix}`).toBe(false);
      // No Turkish segment left in any route.
      expect(toCurrentPath(p), p).toBe(p);
    }
  });
});
