import { describe, expect, it } from 'vitest';
import { isLegacyPath, LEGACY_PATH_RULES, paths, toCurrentPath, withQuery } from './paths';

/** Backend prefixes the proxy sends to the API (docs/contracts/ingilizce-url.md). */
const BACKEND_PREFIXES = [
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

describe('paths', () => {
  it('builds English paths and encodes their parameters', () => {
    expect(paths.invite('a b/c')).toBe('/invite/a%20b%2Fc');
    expect(paths.chatConversation('c1')).toBe('/chat/c/c1');
    expect(paths.meetingRoom('team-sync')).toBe('/meetings/room/team-sync');
    expect(paths.meetingJoin('team-sync')).toBe('/m/team-sync');
    expect(paths.driveFolder('ops', 'f1')).toBe('/drive/ops/folder/f1');
    expect(paths.vaultCategory('v1', 'api-keys')).toBe('/vault/v1/api-keys');
    expect(paths.admin('members')).toBe('/admin/members');
    expect(paths.adminMember('u1')).toBe('/admin/members/u1');
    expect(paths.account('approvals')).toBe('/account/approvals');
    expect(paths.module('meet')).toBe('/meetings');
    expect(paths.module('pages', 'ops')).toBe('/pages/ops');
  });

  it('adds a query string, leaving out empty values', () => {
    expect(withQuery(paths.resetPassword(), { t: 'x y' })).toBe('/reset-password?t=x%20y');
    expect(withQuery('/calendar', { event: 'e1', day: undefined })).toBe('/calendar?event=e1');
    expect(withQuery('/chat/c/1?seq=3', { q: 1 })).toBe('/chat/c/1?seq=3&q=1');
    expect(withQuery('/mail', {})).toBe('/mail');
  });

  it('never starts a web path with a backend prefix', () => {
    const samples = Object.entries(paths).map(([name, build]) =>
      name === 'module'
        ? paths.module('chat', 'x')
        : (build as (...a: string[]) => string)('x', 'y'),
    );
    for (const path of samples) {
      for (const prefix of BACKEND_PREFIXES) {
        expect(path === prefix || path.startsWith(`${prefix}/`), `${path} vs ${prefix}`).toBe(
          false,
        );
      }
      expect(path).toMatch(/^\/[a-z0-9/._~%-]*$/i);
      expect(isLegacyPath(path), path).toBe(false);
    }
  });
});

describe('toCurrentPath', () => {
  it.each([
    ['/davet/abc', '/invite/abc'],
    ['/bildirimler', '/notifications'],
    ['/chat/ara', '/chat/search'],
    ['/chat/c/c1/dosyalar', '/chat/c/c1/files'],
    ['/chat/c/c1/sabitlenenler', '/chat/c/c1/pinned'],
    ['/drive/ops/cop-kutusu', '/drive/ops/trash'],
    ['/drive/ops/k/f1', '/drive/ops/folder/f1'],
    ['/drive/son', '/drive/recent'],
    ['/duyurular/a1', '/announcements/a1'],
    ['/formlar/ops', '/forms/ops'],
    ['/formlar/f/x/sonuclar', '/forms/f/x/results'],
    ['/formlar/y/x', '/forms/edit/x'],
    ['/hesap', '/account'],
    ['/hesap/webdav', '/account/webdav'],
    ['/hesap/mcp/api', '/account/mcp/api'],
    ['/hesap/mcp/belgeler', '/account/mcp/docs'],
    ['/hesap/mcp/istemci/g1', '/account/mcp/client/g1'],
    ['/hesap/onaylar/o1', '/account/approvals/o1'],
    ['/kasa/v1/erisim', '/vault/v1/access'],
    ['/kasa/v1/api-anahtarlari', '/vault/v1/api-keys'],
    ['/kasa/ice-aktar', '/vault/import'],
    ['/kisiler/u1', '/people/u1'],
    ['/rehber/sema', '/contacts/org-chart'],
    ['/otomasyonlar/ops/yeni', '/automations/ops/new'],
    ['/otomasyonlar/k/r1', '/automations/rule/r1'],
    ['/panolar/ops', '/boards/ops'],
    ['/b/b1/ayarlar', '/b/b1/settings'],
    ['/posta/ayarlar', '/mail/settings'],
    ['/sayfalar/ara', '/pages/search'],
    ['/spaces/ops/ayarlar', '/spaces/ops/settings'],
    ['/takvim', '/calendar'],
    ['/toplantilar/oda/team', '/meetings/room/team'],
    ['/toplantilar/ozet/s1', '/meetings/summary/s1'],
    ['/yonetim', '/admin'],
    ['/yonetim/uyeler/u1', '/admin/members/u1'],
    ['/yonetim/entegrasyonlar/kimlik/yeni', '/admin/integrations/identity/new'],
    ['/yonetim/yapay-zeka', '/admin/ai'],
    ['/yonetim/mcp', '/admin/mcp'],
    ['/guvenlik/2fa-kur', '/security/2fa-setup'],
    ['/kasa-paylasim/t1', '/vault-share/t1'],
    ['/kurulum', '/setup'],
    ['/login/2fa/yedek', '/login/2fa/backup'],
    ['/mobil-giris', '/mobile-login'],
    ['/oauth/onay', '/oauth/consent'],
    ['/oauth/tamam', '/oauth/done'],
    ['/sifre-yenile', '/reset-password'],
    ['/sifremi-unuttum', '/forgot-password'],
    ['/sso/onay', '/sso/consent'],
  ])('%s → %s', (from, to) => {
    expect(toCurrentPath(from)).toBe(to);
  });

  it('keeps the origin, query and hash', () => {
    expect(toCurrentPath('/sifre-yenile?t=abc#x')).toBe('/reset-password?t=abc#x');
    expect(toCurrentPath('https://hub.example.com/davet/tok?from=mail')).toBe(
      'https://hub.example.com/invite/tok?from=mail',
    );
    expect(toCurrentPath('/toplantilar/oda/x?arama=1')).toBe('/meetings/room/x?call=1');
  });

  it('turns old query keys and enum values into the current ones', () => {
    expect(toCurrentPath('/takvim?etkinlik=e1&tarih=2026-10-23&gorunum=hafta')).toBe(
      '/calendar?event=e1&date=2026-10-23&view=week',
    );
    expect(toCurrentPath('/toplantilar/oda/x?arama=c1')).toBe('/meetings/room/x?call=c1');
    expect(toCurrentPath('/posta?klasor=INBOX&uid=7&filtre=okunmamis')).toBe(
      '/mail?folder=INBOX&uid=7&filter=unread',
    );
    expect(toCurrentPath('/panolar/ops?gorunum=bana')).toBe('/boards/ops?view=mine');
    expect(toCurrentPath('/yonetim/mcp?sekme=webhooklar')).toBe('/admin/mcp?tab=webhooks');
    // Current paths with old keys (a page comment link) and values under current keys.
    expect(toCurrentPath('/p/page-1?yorum=c9&panel=yorumlar')).toBe(
      '/p/page-1?comment=c9&panel=comments',
    );
    expect(toCurrentPath('/calendar?view=ay')).toBe('/calendar?view=month');
    // Board filters; Drive's old grid view, while portal docs keep their own `g`.
    expect(toCurrentPath('/b/b1?kisi=ben&grup=etiket&tarih=gecmis&gorunum=liste')).toBe(
      '/b/b1?person=me&group=tag&date=overdue&view=list',
    );
    expect(toCurrentPath('/drive/ops/k/f1?g=izgara&onizle=n1&detay=1')).toBe(
      '/drive/ops/folder/f1?view=grid&preview=n1&detail=1',
    );
    expect(toCurrentPath('/portal/site/docs?g=guide')).toBe('/portal/site/docs?g=guide');
    expect(toCurrentPath('/p/page-1?aktarim=x1')).toBe('/p/page-1?export=x1');
    // Values stay encoded as they were; unknown keys stay.
    expect(toCurrentPath('/posta?klasor=A%2FB&x=1#top')).toBe('/mail?folder=A%2FB&x=1#top');
  });

  it('leaves current and foreign paths alone', () => {
    for (const p of [
      '/',
      '/chat',
      '/chat/c/c1',
      '/drive/ops',
      '/p/page-1',
      '/m/slug',
      '/s/tok',
      '/f/tok',
      '/portal/site/blog',
      '/api/v1/me',
      '/api/v1/x?gorunum=bana',
      'https://example.com/elsewhere?tur=1',
      '/chat/c/c1?seq=3',
      'crewhall://page/1',
      'mailto:a@b.c',
      '',
      '/invite/x',
    ]) {
      expect(toCurrentPath(p)).toBe(p);
    }
  });

  it('keeps every rule target current (no chains)', () => {
    for (const [, to] of LEGACY_PATH_RULES) {
      expect(isLegacyPath(to.replaceAll(':', 'x')), to).toBe(false);
    }
  });
});
